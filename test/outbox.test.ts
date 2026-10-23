/** Real non-git trackers and real child-process crashes exercise durable Slack delivery. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
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

/** Snapshot the test's explicit recovery filters when enabling its real local outbox. */
function enableRecovery(box: SlackOutbox): string {
  return box.enable({ events: [...__test__.parseEvents(process.env.PM_SLACK_EVENTS)], minPriority: __test__.loadConfig()?.minPriority ?? 1 });
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
  const since = enableRecovery(box);
  assert.equal(enableRecovery(box), since);
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
  enableRecovery(box);
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
  assert.equal((await box.drain(async () => { throw new OutboxError("destination_changed", "Restore the original route."); })).counts.refused, 1);
  assert.equal(box.status().rows[1]!.attempts, 0);
  box.resolve(second, "retry");
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
  enableRecovery(box);
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
  enableRecovery(box); box.enqueue({ ...intent(), destination: slackDestination(webhook) }); box.close();
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
  enableRecovery(box);
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
  assert.ok((await command({ action: "drain" })).counts.refused > 0);
});

test("pre-request route refusals preserve pending receipts and attempts until configuration is repaired", async (t) => {
  let sends = 0;
  const server = http.createServer((_req, response) => { sends += 1; response.end("ok"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  environment(t, `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`);
  const { pmRoot, client } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  enableRecovery(box);
  await create({ title: "Queued before route configuration changed", priority: 1 }, client);
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 1);
  const original = box.status().rows[0]!;
  assert.equal(original.state, "pending");
  assert.equal(original.attempts, 0);
  const ext = await harness(t);
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", webhook: "ftp://invalid.example/webhook" }]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
    assert.equal(response.exitCode, 2);
    assert.equal(response.errorCode, "invalid_input");
    assert.deepEqual(box.status().rows, [original], "pre-request refusals must preserve the pending receipt and zero attempts");
    assert.equal(sends, 0, "invalid unrelated routing must refuse before any HTTP request");
  }
  delete process.env.PM_SLACK_ROUTES;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
    assert.equal(response.exitCode ?? 0, 0);
    assert.deepEqual(box.status().rows.map((row) => ({ ...row })), [{ ...original, state: "acknowledged", attempts: 1 }]);
    assert.equal(sends, 1, "repairing routing must acknowledge exactly one send without manual reconciliation");
  }
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
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  const created = await create({ title: "Keep this committed", priority: 1 }, client);
  const ext = await harness(t);
  const itemFile = resolve(pmRoot, "tasks", `${created.item.id}.toon`);
  const before = readFileSync(itemFile, "utf8");
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(box.status().counts.pending, 1, "connection refused before transmission stays pending");
  assert.equal(box.status().counts.ambiguous, 0);
  assert.equal(readFileSync(itemFile, "utf8"), before);
  const historyFile = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = readFileSync(historyFile, "utf8");
  writeFileSync(historyFile, original.replace(/"after_hash":"[a-f0-9]+"/, '"after_hash":"invalid-hash"'));
  assert.equal((await captureSlackOutbox(pmRoot, box)).failed, 1);
  writeFileSync(historyFile, original);
  const other = await create({ title: "Other valid history", priority: 1 }, client);
  writeFileSync(historyFile, readFileSync(join(pmRoot, "history", `${other.item.id}.jsonl`)));
  assert.equal((await captureSlackOutbox(pmRoot, box, [created.item.id])).failed, 1);
  writeFileSync(historyFile, "{corrupt\n");
  assert.equal((await captureSlackOutbox(pmRoot, box)).failed, 1);
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(readFileSync(itemFile, "utf8"), before);
  box.close();
});

test("history recovery honors priority, event filters, route-only configuration and assignee mentions", async (t) => {
  environment(t);
  const { pmRoot, client } = await fixture(t);
  process.env.PM_SLACK_MIN_PRIORITY = "1";
  process.env.PM_SLACK_EVENTS = "close";
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  t.after(() => box.close());
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
  process.env.PM_SLACK_EVENTS = "create";
  box.configureRecovery({ events: ["create"], minPriority: 1 });
  const next = await create({ title: "Only route", priority: 1 }, client);
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
  const box = new SlackOutbox(pmRoot); enableRecovery(box); box.enqueue(intent()); box.close();
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

/** Read the socket error code preserved on a wrapped webhook rejection. */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === null || typeof error.cause !== "object" || !("code" in error.cause)) return undefined;
  return typeof error.cause.code === "string" ? error.cause.code : undefined;
}

/** Accept both permanent and temporary resolver failures without permitting uncertain sends to retry. */
function retryableLookupFailure(error: unknown): boolean {
  assert.ok(["ENOTFOUND", "EAI_AGAIN"].includes(causeCode(error) ?? ""), String(causeCode(error)));
  assert.equal(__test__.classifyOutboxSendError(error), "retry");
  return true;
}

test("DNS lookup assertions accept transient resolver failures", async () => {
  const previousAgent = http.globalAgent;
  let lookups = 0;
  const agent = new http.Agent({ lookup(_hostname, _options, callback) {
    lookups += 1;
    callback(Object.assign(new Error("Temporary resolver failure"), { code: "EAI_AGAIN" }), "", 4);
  } });
  http.globalAgent = agent;
  try {
    await assert.rejects(__test__.postToSlackOnce("http://pm-slack-outbox.invalid/webhook", { text: "DNS fixture" }), retryableLookupFailure);
    assert.equal(lookups, 1, "the real HTTP client must exercise the temporary DNS failure fixture");
  } finally {
    http.globalAgent = previousAgent;
    agent.destroy();
  }
});

/** Open a localhost sink and return its webhook URL. */
async function listen(t: TestContext, onRequest: http.RequestListener): Promise<string> {
  const server = http.createServer(onRequest);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;
}

test("pre-request transport codes stay pending and response text cannot force a retry", async (t) => {
  const { classifyOutboxSendError, SlackHttpError, postToSlackOnce } = __test__;
  assert.equal(classifyOutboxSendError(new SlackHttpError(429, "limited")), "retry");
  assert.equal(classifyOutboxSendError(new SlackHttpError(400, "body mentions ENOTFOUND")), "rejected");
  assert.equal(classifyOutboxSendError(new SlackHttpError(503, "upstream ENOTFOUND")), "ambiguous");
  assert.equal(classifyOutboxSendError("not-an-error"), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("getaddrinfo ENOTFOUND example.invalid")), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: null })), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: "ENOTFOUND" })), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: { errno: 1 } })), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: { code: 429 } })), "ambiguous");
  assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: { code: "ECONNRESET" } })), "ambiguous");
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
    assert.equal(classifyOutboxSendError(new Error("wrapped", { cause: { code } })), "retry");
  }

  let failureRequests = 0;
  let healthyRequests = 0;
  const failureUrl = await listen(t, (_req, response) => {
    failureRequests += 1;
    response.writeHead(503);
    response.end("upstream ENOTFOUND");
  });
  const healthyUrl = await listen(t, (_req, response) => { healthyRequests += 1; response.end("ok"); });
  const partialUrl = await listen(t, (_req, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.write("partial");
    setImmediate(() => response.destroy());
  });
  await assert.rejects(postToSlackOnce(partialUrl, { text: "probe" }), (error: unknown) => {
    assert.equal(causeCode(error), "ECONNRESET");
    assert.equal(classifyOutboxSendError(error), "ambiguous");
    return true;
  });
  const refused = http.createServer();
  await new Promise<void>((done) => refused.listen(0, "127.0.0.1", done));
  const refusedUrl = `http://127.0.0.1:${(refused.address() as { port: number }).port}/webhook`;
  await new Promise<void>((done) => refused.close(() => done()));
  const missingUrl = "http://pm-slack-outbox.invalid/webhook";
  await assert.rejects(postToSlackOnce(refusedUrl, { text: "probe" }), (error: unknown) => {
    assert.equal(causeCode(error), "ECONNREFUSED");
    return true;
  });
  await assert.rejects(postToSlackOnce(missingUrl, { text: "probe" }), retryableLookupFailure);

  environment(t, healthyUrl);
  process.env.PM_SLACK_ROUTES = JSON.stringify([
    { match: "close", webhook: refusedUrl },
    { match: "block", webhook: missingUrl },
    { match: "cancel", webhook: failureUrl },
    { match: "start", webhook: partialUrl },
  ]);
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  enableRecovery(box);
  const ext = await harness(t);
  const drain = async (limit = "20") => {
    const response = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain", limit }, global: { json: true } });
    assert.equal(response.exitCode ?? 0, 0, JSON.stringify(response.result));
    return response.result as OutboxReport;
  };
  const refusedKey = box.enqueue({ ...intent("refused"), destination: slackDestination(refusedUrl) });
  assert.equal((await drain("1")).rows.find((row) => row.key === refusedKey)?.state, "pending");
  assert.equal(box.status().rows.find((row) => row.key === refusedKey)?.attempts, 1);
  const missingKey = box.enqueue({ ...intent("missing"), destination: slackDestination(missingUrl) });
  await drain("1");
  assert.equal(box.status().rows.find((row) => row.key === missingKey)?.state, "pending");
  assert.equal(box.status().rows.find((row) => row.key === missingKey)?.attempts, 1);
  const failureKey = box.enqueue({ ...intent("failure"), destination: slackDestination(failureUrl) });
  const partialKey = box.enqueue({ ...intent("partial"), destination: slackDestination(partialUrl) });
  const healthyKey = box.enqueue({ ...intent("healthy"), destination: slackDestination(healthyUrl) });
  await drain("20");
  assert.equal(failureRequests, 1, "a sent 5xx is one uncertain attempt, not a pre-request retry");
  assert.equal(healthyRequests, 1, "an ambiguous response must not stop later destinations in the same drain");
  assert.equal(box.status().rows.find((row) => row.key === failureKey)?.state, "ambiguous");
  assert.equal(box.status().rows.find((row) => row.key === partialKey)?.state, "ambiguous");
  assert.equal(box.status().rows.find((row) => row.key === healthyKey)?.state, "acknowledged");
});

test("a retry outcome stops the current drain and the next drain is not stuck behind it", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  enableRecovery(box);
  const first = box.enqueue({ ...intent("first"), payload: { text: "first" } });
  const second = box.enqueue({ ...intent("second"), payload: { text: "second" } });
  const seen: string[] = [];
  await box.drain(async (_destination, payload) => { seen.push(payload.text); return "retry"; });
  assert.deepEqual(seen, ["first"], "a retry must not post later rows in the same drain");
  assert.equal(box.status().rows.find((row) => row.key === first)?.attempts, 1);
  assert.equal(box.status().rows.find((row) => row.key === second)?.attempts, 0);
  const next: string[] = [];
  await box.drain(async (_destination, payload) => { next.push(payload.text); return "acknowledged"; }, 1);
  assert.deepEqual(next, ["second"], "the next drain must prefer the intent that has not yet been attempted");
  assert.equal(box.status().rows.find((row) => row.key === second)?.state, "acknowledged");
  assert.equal(box.status().rows.find((row) => row.key === first)?.state, "pending");
  const thrown: string[] = [];
  box.enqueue({ ...intent("dropped"), payload: { text: "dropped" } });
  box.enqueue({ ...intent("kept"), destination: "other-destination", payload: { text: "kept" } });
  await box.drain(async (_destination, payload) => {
    thrown.push(payload.text);
    if (payload.text === "dropped") throw new Error("connection dropped after accept");
    return "acknowledged";
  }, 2);
  assert.deepEqual(thrown, ["dropped", "kept"], "uncertain transmission must not stop later rows");
});

/** Run the published SDK example in a child process so its exit status is observable. */
function runPublishedExample(directory: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const markdown = readFileSync(new URL("../docs/outbox-example.md", import.meta.url), "utf8");
  const fenced = markdown.match(/```ts\r?\n([\s\S]*?)```/);
  assert.ok(fenced?.[1], "docs/outbox-example.md must contain a TypeScript example");
  const source = fenced[1].replaceAll('from "pm-slack"', `from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)}`);
  writeFileSync(join(directory, "example.mts"), source);
  const child = spawn(process.execPath, [join(directory, "example.mts")], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`example hung: ${stderr}`)); }, 15_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (status) => { clearTimeout(timer); resolve({ code: status ?? 1, stdout, stderr }); });
  });
}

/** Child environment for the published example, without inherited notification routing. */
function exampleEnv(directory: string, webhook?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory, GIT_CEILING_DIRECTORIES: tmpdir() };
  for (const key of ["PM_SLACK_WEBHOOK", "PM_SLACK_ROUTES", "PM_SLACK_CHANNEL", "PM_SLACK_EVENTS"]) delete env[key];
  if (webhook) env.PM_SLACK_WEBHOOK = webhook;
  return env;
}

test("the published SDK example exits nonzero when it catches an outbox refusal", async (t) => {
  const { directory } = await fixture(t);
  const result = await runPublishedExample(directory, exampleEnv(directory));
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /destination_changed/);
});

test("the published SDK example keeps a connection refused before transmission pending", async (t) => {
  const { directory, pmRoot } = await fixture(t);
  const refused = http.createServer();
  await new Promise<void>((done) => refused.listen(0, "127.0.0.1", done));
  const webhook = `http://127.0.0.1:${(refused.address() as { port: number }).port}/webhook`;
  await new Promise<void>((done) => refused.close(() => done()));
  const box = new SlackOutbox(pmRoot);
  enableRecovery(box);
  box.enqueue({ ...intent("example-refused"), destination: slackDestination(webhook) });
  box.close();
  const result = await runPublishedExample(directory, exampleEnv(directory, webhook));
  assert.equal(result.code, 0, result.stderr);
  const check = new SlackOutbox(pmRoot);
  t.after(() => check.close());
  assert.equal(check.status().counts.pending, 1);
  assert.equal(check.status().counts.ambiguous, 0);
  assert.equal(check.status().rows[0]?.attempts, 1);
});


test("receipt existence uses indexed lookup and shares persisted revision keys", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  enableRecovery(box);
  for (let index = 0; index < 64; index += 1) {
    const key = box.enqueue({ ...intent(`indexed-${index}`), event: index % 2 ? "block" : "close" });
    if (index === 0) assert.equal(key, "433b6669d8557bf868294a1070f78a68bb158383695aa580e09ce15a24aa355d");
  }
  const before = box.status(100);
  const prepare = DatabaseSync.prototype.prepare;
  const queries: string[] = [];
  // Observe SQL while delegating every operation to the real SQLite database.
  DatabaseSync.prototype.prepare = function (sql: string) {
    queries.push(sql);
    return prepare.call(this, sql);
  };
  try {
    assert.equal(box.has("outbox-task", "close", "indexed-0"), true);
    assert.equal(box.has("outbox-task", "block", "indexed-63"), true);
    assert.equal(box.has("outbox-task", "close", "missing"), false);
    assert.equal(box.has("missing", "close", "indexed-0"), false);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  assert.equal(queries.length, 4);
  const inspect = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"), { readOnly: true });
  t.after(() => inspect.close());
  for (const query of queries) {
    const parameters = Array.from({ length: (query.match(/\?/g) ?? []).length }, () => null);
    const plan = inspect.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map((row) => String(row.detail)).join("\n");
    assert.match(plan, /\bSEARCH\b/, "receipt existence must use indexed search rather than inspect every retained receipt");
    assert.match(plan, /\bINDEX\b/);
    assert.doesNotMatch(plan, /\bSCAN\b/);
  }
  assert.deepEqual(box.status(100), before, "existence lookup must not alter durable receipts");
});

test("route refusals park ahead of healthy receipts and can be skipped or explicitly retried", async (t) => {
  for (const change of ["channel", "webhook"]) await t.test(change, async (child) => {
    let sends = 0;
    const original = await listen(child, (_request, response) => { sends += 1; response.end("ok"); });
    const rotated = await listen(child, (_request, response) => { sends += 1; response.end("ok"); });
    environment(child, original);
    const { pmRoot } = await fixture(child);
    const box = new SlackOutbox(pmRoot);
    child.after(() => box.close());
    const ext = await harness(child);
    await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
    const refusedKey = box.enqueue({ ...intent("refused"), destination: slackDestination(original) });
    if (change === "channel") process.env.PM_SLACK_CHANNEL = "#eng";
    else process.env.PM_SLACK_WEBHOOK = rotated;
    const webhook = process.env.PM_SLACK_WEBHOOK!;
    const channel = process.env.PM_SLACK_CHANNEL;
    const healthyKey = box.enqueue({ ...intent("healthy"), destination: slackDestination(webhook, channel), payload: { text: "Healthy queued row", channel } });
    for (let drain = 0; drain < 3; drain += 1) {
      const result = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
      assert.equal(result.exitCode ?? 0, 0);
      assert.equal(box.status().counts.refused, 1);
      assert.equal(box.status().rows.find((row) => row.key === refusedKey)?.attempts, 0);
      assert.equal(box.status().rows.find((row) => row.key === healthyKey)?.state, "acknowledged");
      assert.equal(sends, 1, "the refused oldest row must not starve a healthy destination");
    }
    const skipped = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "resolve", key: refusedKey, decision: "skip" } });
    assert.equal(skipped.exitCode ?? 0, 0);
    assert.equal(box.status().counts.skipped, 1);
    const retryKey = box.enqueue({ ...intent("restore-route"), destination: slackDestination(original) });
    await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" } });
    assert.equal(box.status().rows.find((row) => row.key === retryKey)?.state, "refused");
    delete process.env.PM_SLACK_CHANNEL;
    process.env.PM_SLACK_WEBHOOK = original;
    box.resolve(retryKey, "retry");
    await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" } });
    assert.equal(sends, 2);
    assert.equal(box.status().rows.find((row) => row.key === retryKey)?.state, "acknowledged");
  });
});

test("ambiguous outcomes hold later rows for the same destination but allow another destination", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  t.after(() => box.close());
  const first = box.enqueue({ ...intent("outage-first"), destination: "outage" });
  const held = box.enqueue({ ...intent("outage-later"), destination: "outage" });
  box.enqueue({ ...intent("healthy-other"), destination: "healthy" });
  const attempts: string[] = [];
  await box.drain(async (destination) => {
    attempts.push(destination);
    if (destination === "outage") throw new Error("Remote outcome unknown");
    return "acknowledged";
  });
  assert.deepEqual(attempts, ["outage", "healthy"]);
  assert.equal(box.status().rows.find((row) => row.key === first)?.state, "ambiguous");
  assert.equal(box.status().rows.find((row) => row.key === held)?.state, "pending");
  assert.equal(box.status().rows.find((row) => row.key === held)?.attempts, 0);
});

test("outbox hooks never drain on reads and attempt at most one send per lifecycle command", async (t) => {
  let sends = 0;
  const webhook = await listen(t, (_request, response) => { sends += 1; response.end("ok"); });
  environment(t, webhook);
  const { pmRoot, client } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  t.after(() => box.close());
  for (let index = 0; index < 20; index += 1) box.enqueue({ ...intent(`hook-${index}`), destination: slackDestination(webhook) });
  const created = await create({ title: "Read must not send", priority: 1 }, client);
  const ext = await harness(t);
  await ext.runHook({ kind: "after_command", context: { command: "get", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(sends, 0, "reading an item must never drain an outage backlog");
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(sends, 1, "a lifecycle hook must not spend twenty transport timeouts draining the backlog");
  assert.equal(box.status(100).counts.acknowledged, 1);
  assert.equal(box.status(100).counts.pending, 20);
});

test("reused sender PIDs require explicit force reconciliation through both SDK and CLI", async (t) => {
  const { pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  t.after(() => box.close());
  const database = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  t.after(() => database.close());
  const sdkKey = box.enqueue(intent("reused-sdk"));
  database.prepare("UPDATE delivery SET state='sending',owner=? WHERE key=?").run(process.pid, sdkKey);
  assert.throws(() => box.resolve(sdkKey, "retry"), refusal("in_flight"));
  box.resolve(sdkKey, "skip", { force: true });
  assert.equal(box.status().rows.find((row) => row.key === sdkKey)?.state, "skipped");
  const cliKey = box.enqueue(intent("reused-cli"));
  database.prepare("UPDATE delivery SET state='sending',owner=? WHERE key=?").run(process.pid, cliKey);
  const ext = await harness(t);
  const refused = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "resolve", key: cliKey, decision: "acknowledged" }, global: { json: true } });
  assert.equal(refused.errorCode, "in_flight");
  const reconciled = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "resolve", key: cliKey, decision: "acknowledged", forceReconcile: true }, global: { json: true } });
  assert.equal(reconciled.exitCode ?? 0, 0);
  assert.equal(box.status().rows.find((row) => row.key === cliKey)?.state, "acknowledged");
});

test("corrupt item history is isolated while healthy queued receipts drain with a visible partial refusal", async (t) => {
  let sends = 0;
  const webhook = await listen(t, (_request, response) => { sends += 1; response.end("ok"); });
  environment(t, webhook);
  const { pmRoot, client } = await fixture(t);
  const ext = await harness(t);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  box.enqueue({ ...intent("already-verified"), destination: slackDestination(webhook) });
  const candidates = [await create({ title: "First history", priority: 1 }, client), await create({ title: "Second history", priority: 1 }, client)]
    .sort((left, right) => left.item.id.localeCompare(right.item.id));
  const bad = candidates[0]!;
  const good = candidates[1]!;
  const historyFile = join(pmRoot, "history", `${bad.item.id}.jsonl`);
  const original = readFileSync(historyFile, "utf8");
  writeFileSync(historyFile, "{corrupt\n");
  const result = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(result.errorCode, "history_unavailable");
  const report = result.result as OutboxReport & { recovered: { failed: number } };
  assert.equal(report.recovered.failed, 1);
  assert.equal(report.counts.acknowledged, 2);
  assert.equal(sends, 2, "healthy queued and recovered receipts must drain despite an unrelated corrupt file");
  assert.equal(report.rows.some((row) => row.item === bad.item.id), false);
  assert.equal(report.rows.some((row) => row.item === good.item.id), true);
  const output = await ext.runRendererOverride({ command: "slack outbox", format: "toon", result: result.result });
  const decoded = decode(output.rendered!) as { ok: boolean; code: string; recovered: { failed: number } };
  assert.equal(decoded.ok, false);
  assert.equal(decoded.code, "history_unavailable");
  assert.equal(decoded.recovered.failed, 1);
  writeFileSync(historyFile, original);
  const repaired = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" } });
  assert.equal(repaired.exitCode ?? 0, 0);
  assert.equal(sends, 3, "repairing the history must not duplicate previously acknowledged messages");
});

test("queued receipts drain when history recovery has no readable root or no saved filters", async (t) => {
  let sends = 0;
  const webhook = await listen(t, (_request, response) => { sends += 1; response.end("ok"); });
  environment(t, webhook);
  const { pmRoot, client } = await fixture(t);
  const box = new SlackOutbox(pmRoot); box.enable();
  t.after(() => box.close());
  assert.throws(() => box.recoveryPolicies(), refusal("history_unavailable"));
  box.enqueue({ ...intent("legacy-queue"), destination: slackDestination(webhook) });
  const ext = await harness(t);
  const created = await create({ title: "Legacy recovery needs configuration", priority: 1 }, client);
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(sends, 1, "a missing recovery snapshot must not block existing verified receipts in hooks");
  delete process.env.PM_SLACK_WEBHOOK;
  const missingConfig = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(missingConfig.errorCode, "destination_changed");
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(sends, 1);
  process.env.PM_SLACK_WEBHOOK = webhook;
  box.configureRecovery({ events: ["create"], minPriority: 1 });
  box.enqueue({ ...intent("history-root-missing"), destination: slackDestination(webhook) });
  rmSync(join(pmRoot, "history"), { recursive: true });
  const result = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(result.errorCode, "history_unavailable");
  assert.equal(sends, 2);
  assert.equal(box.status().counts.acknowledged, 2);
});

test("filter widening never backfills stale events and explicit configuration applies only to future history", async (t) => {
  let sends = 0;
  const webhook = await listen(t, (_request, response) => { sends += 1; response.end("ok"); });
  environment(t, webhook);
  process.env.PM_SLACK_EVENTS = "close";
  process.env.PM_SLACK_MIN_PRIORITY = "1";
  const { pmRoot, client } = await fixture(t);
  const ext = await harness(t);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  const high = await create({ title: "Eligible before restart", priority: 1 }, client);
  const stale = await create({ title: "Previously excluded", priority: 4 }, client);
  await close(high.item.id, "Closed", {}, client);
  await close(stale.item.id, "Closed", {}, client);
  process.env.PM_SLACK_EVENTS = "create,close";
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  const first = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(first.exitCode ?? 0, 0);
  assert.equal((first.result as OutboxReport).counts.acknowledged, 1, "widening before the first scan must not flood stale notifications");
  assert.equal(sends, 1);
  const configured = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "configure" } });
  assert.equal(configured.exitCode ?? 0, 0);
  const future = await create({ title: "New policy applies", priority: 4 }, client);
  await close(future.item.id, "Closed", {}, client);
  const second = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" } });
  assert.equal(second.exitCode ?? 0, 0);
  assert.equal(sends, 3);
  const reopened = new SlackOutbox(pmRoot);
  t.after(() => reopened.close());
  assert.equal(reopened.recoveryPolicies().length, 2);
  assert.equal(reopened.status().rows.some((row) => row.item === stale.item.id), false);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  assert.equal(reopened.recoveryPolicies().length, 2, "idempotent enable must not silently reconfigure past eligibility");
});

test("recovery configuration validates filters and upgrades legacy enable without backfill", async (t) => {
  environment(t);
  const { pmRoot, client } = await fixture(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  assert.throws(() => box.configureRecovery({ events: ["create"], minPriority: 1 }), refusal("disabled"));
  assert.throws(() => box.enable({ events: ["create"], minPriority: 0 }), refusal("invalid_input"));
  assert.equal(box.since(), null, "invalid eligibility must not enable an outbox");
  box.enable();
  for (const minPriority of [0, 5, 1.5]) assert.throws(() => box.configureRecovery({ events: ["create"], minPriority }), refusal("invalid_input"));
  assert.throws(() => box.configureRecovery({ events: ["unknown" as "create"], minPriority: 1 }), refusal("invalid_input"));
  const old = await create({ title: "Before legacy policy configured", priority: 1 }, client);
  const ext = await harness(t);
  await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  await create({ title: "After legacy policy configured", priority: 1 }, client);
  const recovered = await captureSlackOutbox(pmRoot, box);
  assert.equal(recovered.queued, 1);
  assert.equal(box.status().rows.some((row) => row.item === old.item.id), false);
});

test("the published SDK example exits nonzero for parked routing refusals", async (t) => {
  const { directory, pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  box.enqueue(intent("example-refused"));
  box.close();
  const result = await runPublishedExample(directory, exampleEnv(directory, "http://127.0.0.1:2/rotated"));
  assert.equal(result.code, 2, result.stderr);
  const check = new SlackOutbox(pmRoot);
  t.after(() => check.close());
  assert.equal(check.status().counts.refused, 1);
  assert.equal(check.status().rows[0]?.attempts, 0);
});

test("the published SDK example drains verified receipts while reporting incomplete history", async (t) => {
  let sends = 0;
  const webhook = await listen(t, (_request, response) => { sends += 1; response.end("ok"); });
  const { directory, pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  box.enqueue({ ...intent("example-partial-history"), destination: slackDestination(webhook) });
  box.close();
  rmSync(join(pmRoot, "history"), { recursive: true });
  const result = await runPublishedExample(directory, exampleEnv(directory, webhook));
  assert.equal(result.code, 2, result.stderr);
  assert.equal(sends, 1);
  const check = new SlackOutbox(pmRoot);
  t.after(() => check.close());
  assert.equal(check.status().counts.acknowledged, 1);
});

test("the published SDK example holds redirects as ambiguous even when the target refuses connection", async (t) => {
  const refused = http.createServer();
  await new Promise<void>((done) => refused.listen(0, "127.0.0.1", done));
  const target = `http://127.0.0.1:${(refused.address() as { port: number }).port}/redirected`;
  let sends = 0;
  const webhook = await listen(t, (_request, response) => {
    sends += 1;
    response.writeHead(307, { location: target });
    response.end();
  });
  // Reserve the target until the source binds, so ephemeral port reuse cannot turn this into a redirect loop.
  await new Promise<void>((done) => refused.close(() => done()));
  const { directory, pmRoot } = await fixture(t);
  const box = new SlackOutbox(pmRoot); enableRecovery(box);
  box.enqueue({ ...intent("example-redirect"), destination: slackDestination(webhook) });
  box.close();
  const result = await runPublishedExample(directory, exampleEnv(directory, webhook));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(sends, 1, "the original endpoint received the POST before redirect handling");
  const check = new SlackOutbox(pmRoot);
  t.after(() => check.close());
  assert.equal(check.status().counts.ambiguous, 1);
  assert.equal(check.status().counts.pending, 0, "a redirected connection failure must not authorize safe retry");
  assert.equal(check.status().rows[0]?.attempts, 1);
  await check.drain(async () => { assert.fail("a redirected request must not resend automatically"); });
});

test("recovery reports actual SQLite receipt faults as storage failures without blaming history", async (t) => {
  environment(t);
  for (const fault of ["missing receipt table", "busy receipt write", "read-only receipt write"] as const) await t.test(fault, async (t) => {
    const { pmRoot, client } = await fixture(t);
    const box = new SlackOutbox(pmRoot); enableRecovery(box);
    t.after(() => box.close());
    const created = await create({ title: "Verified history survives storage failure", priority: 1 }, client);
    const historyFile = join(pmRoot, "history", `${created.item.id}.jsonl`);
    const historyBefore = readFileSync(historyFile, "utf8");
    const database = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
    t.after(() => database.close());
    // Faults come from real SQLite operations, not replacement SDK or database methods.
    const connection = (box as unknown as { db: DatabaseSync }).db;
    if (fault === "missing receipt table") database.exec("ALTER TABLE delivery RENAME TO retained_delivery");
    else if (fault === "busy receipt write") database.exec("BEGIN; SELECT * FROM delivery");
    else connection.exec("PRAGMA query_only=ON");
    try {
      await assert.rejects(captureSlackOutbox(pmRoot, box), (error: unknown) => {
        assert.ok(error instanceof OutboxError);
        assert.equal(error.code, "storage_unavailable");
        assert.equal(error.exitCode, 2);
        assert.match(error.remedy, /readable and writable local runtime storage/);
        assert.doesNotMatch(error.remedy, /history/i);
        return true;
      });
    } finally {
      if (fault === "missing receipt table") database.exec("ALTER TABLE retained_delivery RENAME TO delivery");
      else if (fault === "busy receipt write") database.exec("ROLLBACK");
      else connection.exec("PRAGMA query_only=OFF");
    }
    assert.equal(readFileSync(historyFile, "utf8"), historyBefore);
    assert.equal(box.status().counts.pending, 0);
    assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 1, "repairing storage must recover the unchanged history");
  });
});


test("atomic enable rolls back opt-in when SQLite refuses the initial policy, then retries once", async (t) => {
  const { pmRoot, client } = await fixture(t);
  environment(t);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  const db = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER refuse_policy BEFORE INSERT ON recovery_policy BEGIN SELECT RAISE(ABORT, 'fixture policy fault'); END");
  assert.throws(() => enableRecovery(box), refusal("storage_unavailable"));
  assert.equal(box.since(), null, "failed enable must not leave durable opt-in without eligibility");
  db.exec("DROP TRIGGER refuse_policy");
  enableRecovery(box);
  const since = box.since();
  assert.equal(box.recoveryPolicies()[0]?.since, since);
  await create({ title: "Committed after successful enable retry", priority: 1 }, client);
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 1);
  let sends = 0;
  await box.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 0);
  await box.drain(async () => { sends += 1; return "acknowledged"; });
  assert.equal(sends, 1);
  assert.equal(box.status().counts.acknowledged, 1);
});

test("atomic enable survives process death between opt-in and policy without partial recovery state", async (t) => {
  const { pmRoot, directory } = await fixture(t);
  const moduleUrl = new URL("../outbox.ts", import.meta.url).href;
  // Terminate precisely at the policy boundary; every database operation stays real.
  const source = `import {SlackOutbox} from ${JSON.stringify(moduleUrl)};
    const box=new SlackOutbox(process.argv[1]);
    box.saveRecoveryPolicy=()=>process.exit(73);
    box.enable({events:['create'],minPriority:4});`;
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot], {
      cwd: directory, env: { ...process.env, PATH: directory, GIT_CEILING_DIRECTORIES: tmpdir() }, stdio: "pipe",
    });
    child.on("error", reject); child.on("exit", done);
  });
  assert.equal(code, 73);
  const restarted = new SlackOutbox(pmRoot);
  t.after(() => restarted.close());
  assert.equal(restarted.since(), null, "process death must roll back the opt-in write");
  const since = restarted.enable({ events: ["create"], minPriority: 4 });
  assert.deepEqual(restarted.recoveryPolicies(), [{ since, events: ["create"], minPriority: 4 }]);
  restarted.enqueue(intent("after-enable-crash"));
  await restarted.drain(async () => "acknowledged");
  await restarted.drain(async () => { assert.fail("acknowledged receipt must survive retry"); });
  assert.equal(restarted.status().counts.acknowledged, 1);
});
