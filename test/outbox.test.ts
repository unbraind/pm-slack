/** Real non-git trackers and real child-process crashes exercise durable Slack delivery. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { decode } from "@toon-format/toon";
import test, { type TestContext } from "node:test";
import { init, create, update, close, notes } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureSlackOutbox, SlackOutbox, OutboxError, slackDestination, __test__ } from "../index.ts";
import type { OutboxIntent, OutboxReport } from "../index.ts";

/** Create a real tracker outside git and clean up after the owning test. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-outbox-"));
  const pmRoot = join(directory, ".agents", "pm");
  const savedPath = process.env.PATH;
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = directory;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = { pmRoot, cwd: directory, noExtensions: true };
  await init("outbox", { defaults: true, agentGuidance: "skip" }, client);
  return { directory, pmRoot, client };
}

/** Install a localhost-only notification environment and restore every changed key. */
function environment(t: TestContext, webhook = "http://127.0.0.1:1/webhook") {
  const keys = ["PM_SLACK_WEBHOOK", "PM_SLACK_ROUTES", "PM_SLACK_MIN_PRIORITY", "PM_SLACK_EVENTS", "PM_SLACK_ASSIGNEE_MAP", "PM_SLACK_CHANNEL", "PM_SLACK_FORMAT"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  keys.forEach((key) => { delete process.env[key]; });
  process.env.PM_SLACK_WEBHOOK = webhook;
  process.env.PM_SLACK_MIN_PRIORITY = "4";
}

/** Return a frozen synthetic delivery intent without any live credentials. */
function intent(revision = "revision-1"): OutboxIntent {
  return { item: "outbox-task", event: "close", revision, destination: slackDestination("http://127.0.0.1:1/webhook"), payload: { text: "Synthetic closed task" } };
}

/** Match a typed refusal and ensure its safe remedy survives the public error surface. */
function refusal(code: string) {
  return (error: unknown) => error instanceof OutboxError && error.code === code && error.exitCode === 2 && error.remedy.length > 0;
}

/** Register the real extension with the SDK harness. */
async function harness(t: TestContext) {
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  return ext;
}

test("durable intents deduplicate across handles, refuse conflicts and expose bounded credential-free receipts", async (t) => {
  const { pmRoot } = await fixture(t);
  let box = new SlackOutbox(pmRoot);
  assert.equal(box.since(), null);
  assert.equal(box.status().rows.length, 0);
  assert.throws(() => box.enqueue(intent()), refusal("disabled"));
  await assert.rejects(box.drain(async () => "acknowledged"), refusal("disabled"));
  const since = box.enable();
  assert.equal(box.enable(), since);
  assert.throws(() => box.enqueue({ ...intent(), revision: "" }), refusal("invalid_input"));
  assert.throws(() => box.enqueue({ ...intent(), event: "unknown" as "close" }), refusal("invalid_input"));
  const key = box.enqueue(intent());
  assert.equal(box.enqueue(intent()), key);
  assert.equal(box.has("outbox-task", "close", "revision-1"), true);
  assert.equal(box.has("outbox-task", "close", "missing"), false);
  assert.throws(() => box.enqueue({ ...intent(), payload: { text: "Changed body" } }), refusal("conflict"));
  assert.throws(() => box.enqueue({ ...intent(), destination: "different" }), refusal("conflict"));
  box.enqueue(intent("revision-2"));
  assert.equal(box.status(1).omitted, 1);
  const page = box.status(1);
  assert.equal(box.status(1, page.next_cursor!).rows[0]!.sequence, 2);
  assert.equal(box.status(1, 2).rows.length, 0);
  assert.throws(() => box.status(1, -1), refusal("invalid_input"));
  for (const limit of [0, 101, 1.5, NaN]) {
    assert.throws(() => box.status(limit), refusal("invalid_input"));
    await assert.rejects(box.drain(async () => "acknowledged", limit), refusal("invalid_input"));
  }
  box.close();
  box = new SlackOutbox(pmRoot);
  let sends = 0;
  await box.drain(async () => { sends += 1; return "retry"; }, 1);
  assert.equal(box.status().counts.pending, 2);
  await box.drain(async () => { sends += 1; return "acknowledged"; });
  await box.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal(sends, 3, "one explicit refusal then exactly one acknowledged send per intent");
  assert.equal(box.status().counts.acknowledged, 2);
  const report = JSON.stringify(box.status());
  assert.ok(!report.includes("Synthetic") && !report.includes("webhook") && !report.includes("destination"));
  assert.throws(() => box.resolve(key, "retry"), refusal("not_ambiguous"));
  assert.throws(() => box.resolve("missing", "retry"), refusal("not_found"));
  assert.throws(() => box.resolve(key, "invalid" as "retry"), refusal("invalid_input"));
  box.close();
  assert.equal(slackDestination("a"), slackDestination("a"));
  assert.notEqual(slackDestination("a"), slackDestination("a", "channel"));
});

test("uncertainty is held, active senders refuse reconciliation and changed destinations retain pending work", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  box.enable();
  const key = box.enqueue(intent());
  const other = new SlackOutbox(pmRoot);
  t.after(() => other.close());
  await box.drain(async () => {
    assert.throws(() => other.resolve(key, "retry"), refusal("in_flight"));
    assert.equal((await other.drain(async () => "acknowledged")).counts.sending, 1);
    throw new Error("Remote accepted but connection dropped");
  });
  assert.equal(box.status().counts.ambiguous, 1);
  let sends = 0;
  await box.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal(sends, 0);
  box.resolve(key, "acknowledged");
  const second = box.enqueue(intent("retry"));
  await assert.rejects(box.drain(async () => { throw new OutboxError("destination_changed", "Restore the original route."); }), refusal("destination_changed"));
  assert.equal(box.status().rows[1]!.attempts, 0);
  await box.drain(async () => "rejected");
  box.resolve(second, "retry");
  await box.drain(async () => "ambiguous");
  box.resolve(second, "retry");
  assert.equal((await box.drain(async () => "acknowledged")).counts.acknowledged, 2);
  box.enqueue(intent("concurrent-first")); box.enqueue(intent("concurrent-second"));
  await box.drain(async () => {
    await other.drain(async () => "acknowledged");
    return "acknowledged";
  });
  assert.equal(box.status().counts.acknowledged, 4);
});

test("a real process crash after remote acceptance remains sending and cannot resend until explicitly reconciled", async (t) => {
  const { pmRoot, directory } = await fixture(t);
  let accepted = 0;
  const server = http.createServer((request, response) => { request.resume(); request.on("end", () => { accepted += 1; response.end("ok"); }); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const webhook = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture`;
  const box = new SlackOutbox(pmRoot);
  box.enable();
  const key = box.enqueue({ ...intent(), destination: slackDestination(webhook) });
  box.close();
  const moduleUrl = new URL("../outbox.ts", import.meta.url).href;
  const exit = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {SlackOutbox} from ${JSON.stringify(moduleUrl)}; const box=new SlackOutbox(process.argv[1]); await box.drain(async(_destination,payload)=>{await fetch(process.argv[2],{method:'POST',body:JSON.stringify(payload)});process.exit(73);});`, pmRoot, webhook], {
      cwd: directory, env: { ...process.env, PATH: directory, GIT_CEILING_DIRECTORIES: tmpdir() }, stdio: "pipe",
    });
    child.on("error", reject); child.on("exit", done);
  });
  assert.equal(exit, 73);
  assert.equal(accepted, 1);
  const restarted = new SlackOutbox(pmRoot);
  t.after(() => restarted.close());
  let sends = 0;
  await restarted.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal(sends, 0);
  assert.equal(restarted.status().counts.sending, 1);
  restarted.resolve(key, "acknowledged");
  await restarted.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal(restarted.status().counts.acknowledged, 1);
  assert.equal(sends, 0);
  assert.equal(accepted, 1);
});

test("concurrent process drains acknowledge one local HTTP send after restarting a queued intent", async (t) => {
  const { pmRoot, directory } = await fixture(t);
  let sends = 0;
  const server = http.createServer((_req, res) => { sends += 1; res.end("ok"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as { port: number };
  const webhook = `http://127.0.0.1:${address.port}/webhook`;
  const box = new SlackOutbox(pmRoot);
  box.enable(); box.enqueue({ ...intent(), destination: slackDestination(webhook) }); box.close();
  const moduleUrl = new URL("../outbox.ts", import.meta.url).href;
  const source = `import {SlackOutbox} from ${JSON.stringify(moduleUrl)}; const box=new SlackOutbox(process.argv[1]); await box.drain(async(_destination,payload)=>{const r=await fetch(process.argv[2],{method:'POST',body:JSON.stringify(payload)});return r.ok?'acknowledged':'rejected';});box.close();`;
  const run = () => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot, webhook], { cwd: directory, env: { ...process.env, PATH: directory, GIT_CEILING_DIRECTORIES: tmpdir() }, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? done() : reject(new Error(stderr)));
  });
  await Promise.all([run(), run()]);
  assert.equal(sends, 1);
  const check = new SlackOutbox(pmRoot);
  assert.equal(check.status().counts.acknowledged, 1); check.close();
});

test("SDK recovery captures committed changes whose hook never ran, with stable revision deduplication", async (t) => {
  environment(t);
  const { pmRoot, client } = await fixture(t);
  const old = await create({ title: "Before enable", priority: 1 }, client);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  await assert.rejects(captureSlackOutbox(pmRoot, box), refusal("disabled"));
  box.enable();
  const created = await create({ title: "Committed before crash", priority: 1, assignee: "agent" }, client);
  await notes(created.item.id, { add: "Annotation must not notify" }, client);
  await update(created.item.id, { status: "blocked" }, client);
  await update(created.item.id, { status: "open" }, client);
  await close(created.item.id, "Committed completion", {}, client);
  await update(created.item.id, { status: "open" }, client);
  const first = await captureSlackOutbox(pmRoot, box);
  assert.equal(first.queued, 5);
  assert.equal(box.status().rows.some((row) => row.item === old.item.id), false);
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 0);
  assert.ok(box.status().rows.some((row) => row.event === "unblock"));
  assert.ok(box.status().rows.some((row) => row.event === "reopen"));
  const filtered = await captureSlackOutbox(pmRoot, box, ["missing"]);
  assert.equal(filtered.inspected, 0);
  delete process.env.PM_SLACK_WEBHOOK;
  await assert.rejects(captureSlackOutbox(pmRoot, box), refusal("destination_changed"));
});

test("CLI enable, drain, status and resolution use bounded structured receipts and refuse invalid inputs", async (t) => {
  let code = 200;
  let sends = 0;
  const server = http.createServer((_req, response) => { sends += 1; response.writeHead(code); response.end("fixture"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  environment(t, `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`);
  const { pmRoot, client } = await fixture(t);
  const ext = await harness(t);
  const command = async (options: Record<string, unknown> = {}) => {
    const response = await ext.runCommand({ command: "slack outbox", pmRoot, options, global: { json: true } });
    if (response.exitCode) {
      const failure = response.result as { code: OutboxError["code"]; remediation: string };
      assert.equal(response.exitCode, 2);
      assert.equal(response.errorCode, failure.code);
      assert.equal(response.remediation, failure.remediation);
      throw new OutboxError(failure.code, failure.remediation);
    }
    return response.result as OutboxReport;
  };
  assert.equal((await command()).enabled_since, null);
  for (const options of [{ action: "unknown" }, { limit: "0" }, { after: "-1" }, { action: "resolve" }, { action: "resolve", key: "key", decision: "wrong" }]) {
    await assert.rejects(command(options), refusal("invalid_input"));
  }
  delete process.env.PM_SLACK_WEBHOOK;
  await assert.rejects(command({ action: "enable" }), refusal("destination_changed"));
  process.env.PM_SLACK_WEBHOOK = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;
  const validWebhook = process.env.PM_SLACK_WEBHOOK;
  process.env.PM_SLACK_WEBHOOK = "ftp://invalid.example/webhook";
  await assert.rejects(command({ action: "enable" }), refusal("invalid_input"));
  process.env.PM_SLACK_WEBHOOK = validWebhook;
  await command({ action: "enable" });
  const created = await create({ title: "Lifecycle delivery", priority: 1 }, client);
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal((await command({ action: "drain" })).counts.acknowledged, 1);
  assert.equal(sends, 1);
  await ext.runHook({ kind: "after_command", context: { command: "list", args: [], pm_root: pmRoot, ok: true } });
  for (const remoteCode of [429, 400, 503]) {
    code = remoteCode;
    await create({ title: `Response ${code}`, priority: 1 }, client);
    const report = await command({ action: "drain", limit: "100" });
    assert.ok(report.counts[code === 429 ? "pending" : code === 400 ? "rejected" : "ambiguous"] > 0);
  }
  const report = await command();
  const page = await command({ limit: "1" });
  assert.equal((await command({ limit: "1", after: String(page.next_cursor) })).rows.length, 1);
  const ambiguous = report.rows.find((row) => row.state === "ambiguous")!;
  await command({ action: "resolve", key: ambiguous.key, decision: "acknowledged" });
  await create({ title: "Route drift", priority: 1 }, client);
  const box = new SlackOutbox(pmRoot);
  await captureSlackOutbox(pmRoot, box); box.close();
  process.env.PM_SLACK_WEBHOOK += "/changed";
  await assert.rejects(command({ action: "drain" }), refusal("destination_changed"));
});

test("storage and corrupt history refuse safely; notification failure never changes a committed item", async (t) => {
  assert.equal(__test__.outboxFailure(new Error("Opaque underlying storage failure")).code, "storage_unavailable");
  environment(t);
  const { pmRoot, directory, client } = await fixture(t);
  const badRoot = join(directory, "not-directory"); writeFileSync(badRoot, "file");
  assert.throws(() => new SlackOutbox(badRoot), refusal("storage_unavailable"));
  const storage = join(pmRoot, "runtime", "slack-outbox");
  mkdirSync(storage, { recursive: true });
  const database = join(storage, "delivery.sqlite");
  writeFileSync(database, "corrupt database");
  assert.throws(() => new SlackOutbox(pmRoot), refusal("storage_unavailable"));
  rmSync(database);
  const box = new SlackOutbox(pmRoot); box.enable();
  const created = await create({ title: "Keep this committed", priority: 1 }, client);
  const ext = await harness(t);
  const itemFile = resolve(pmRoot, "tasks", `${created.item.id}.toon`);
  const before = readFileSync(itemFile, "utf8");
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(box.status().counts.ambiguous, 1);
  assert.equal(readFileSync(itemFile, "utf8"), before);
  const historyFile = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = readFileSync(historyFile, "utf8");
  writeFileSync(historyFile, original.replace(/"after_hash":"[a-f0-9]+"/, '"after_hash":"invalid-hash"'));
  await assert.rejects(captureSlackOutbox(pmRoot, box), refusal("history_unavailable"));
  writeFileSync(historyFile, original);
  const other = await create({ title: "Other valid history", priority: 1 }, client);
  writeFileSync(historyFile, readFileSync(join(pmRoot, "history", `${other.item.id}.jsonl`)));
  await assert.rejects(captureSlackOutbox(pmRoot, box, [created.item.id]), refusal("history_unavailable"));
  writeFileSync(historyFile, "{corrupt\n");
  await assert.rejects(captureSlackOutbox(pmRoot, box), refusal("history_unavailable"));
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(readFileSync(itemFile, "utf8"), before);
  box.close();
});

test("history recovery honors priority, event filters, route-only configuration and assignee mentions", async (t) => {
  environment(t);
  const { pmRoot, client } = await fixture(t);
  const box = new SlackOutbox(pmRoot); box.enable();
  t.after(() => box.close());
  process.env.PM_SLACK_MIN_PRIORITY = "1";
  process.env.PM_SLACK_EVENTS = "close";
  const high = await create({ title: "High priority", priority: 1, assignee: "agent" }, client);
  const low = await create({ title: "Low priority", priority: 4 }, client);
  await update(high.item.id, { status: "draft" }, client);
  await close(high.item.id, "Ready", {}, client);
  await close(low.item.id, "Low", {}, client);
  process.env.PM_SLACK_ASSIGNEE_MAP = "agent=U123";
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", channel: "#fixture" }, { match: "block", webhook: "http://127.0.0.1:1/block" }]);
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 1);
  const ext = await harness(t);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  const next = await create({ title: "Only route", priority: 1 }, client);
  process.env.PM_SLACK_EVENTS = "create";
  delete process.env.PM_SLACK_WEBHOOK;
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", webhook: "http://127.0.0.1:1/close" }]);
  await assert.rejects(captureSlackOutbox(pmRoot, box, [next.item.id]), refusal("destination_changed"));
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "create", webhook: "ftp://invalid.example/webhook" }]);
  await assert.rejects(captureSlackOutbox(pmRoot, box, [next.item.id]), refusal("invalid_input"));
  // A routes-only enable has no default webhook to include among candidates.
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "create", webhook: "http://127.0.0.1:1/fixture" }]);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
});

test("a pre-enable status inspection does not change the legacy hook behavior", async (t) => {
  environment(t);
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); box.close();
  const ext = await harness(t);
  await ext.runHook({ kind: "after_command", context: { command: "list", args: [], pm_root: pmRoot, ok: true } });
});

test("default CLI output is one compact decodable TOON report with all receipt keys", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); box.enable(); box.enqueue(intent()); box.close();
  const ext = await harness(t);
  const response = await ext.runCommand({ command: "slack outbox", pmRoot, options: {}, global: { json: false } });
  const output = await ext.runRendererOverride({ command: "slack outbox", format: "toon", result: response.result });
  assert.equal(output.overridden, true);
  const decoded = decode(output.rendered!) as unknown as OutboxReport;
  assert.equal(decoded.rows.length, 1);
  assert.equal(decoded.counts.pending, 1);
  assert.equal(decoded.rows[0]!.key.length, 64);
  assert.ok(!output.rendered!.includes("Synthetic"));
  assert.equal((await ext.runRendererOverride({ command: "list", format: "toon", result: response.result })).overridden, false);
  await assert.rejects(ext.runRendererOverride({ command: "slack outbox", format: "json", result: response.result }), /Available renderer override formats: toon/);
  for (const result of [null, {}, { rows: [] }]) {
    assert.equal((await ext.runRendererOverride({ command: "slack outbox", format: "toon", result })).overridden, false);
  }
});
