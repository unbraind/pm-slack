/** Deterministic delivery, durable evidence and no-git acceptance using real SDK trackers. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { init, create } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode } from "@toon-format/toon";
import extension, { planSlackCoalescing, CoalescingError, SlackOutbox, OutboxError, slackDestination } from "../index.ts";
import type { CoalescingEvent, CoalescingOptions, CoalescingReport, OutboxIntent } from "../index.ts";

/** One typed, credential-free planner event. */
function event(key: string, patch: Partial<CoalescingEvent> = {}): CoalescingEvent {
  return { key, item: "task-1", event: "create", revision: key, destination: "route-1", at: 1000, priority: 2, ...patch };
}

/** Enumerate every ordering to prove the summary and manifest do not depend on arrival. */
function permutations<T>(rows: readonly T[]): T[][] {
  return rows.length === 0 ? [[]] : rows.flatMap((row, index) => permutations(rows.filter((_, position) => position !== index)).map((rest) => [row, ...rest]));
}

/** Initialize a real tracker with git unavailable, restoring process state after the test. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-coalescing-"));
  const pmRoot = join(directory, ".agents", "pm");
  const saved = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  process.env.PATH = directory;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  });
  const client = { cwd: directory, pmRoot, noExtensions: true };
  await init("coalescing", { defaults: true, agentGuidance: "skip" }, client);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  box.enable({ events: ["create", "close", "block"], minPriority: 4 });
  return { box, pmRoot, directory, client };
}

/** Frozen outbox intent with deterministic event context. */
function intent(revision: string, patch: Partial<OutboxIntent> = {}): OutboxIntent {
  return { item: "task-1", event: "create", revision, destination: "route-1", payload: { text: "Private original payload" }, at: 1000, priority: 2, ...patch };
}

/** Real extension harness with lifecycle-managed teardown. */
async function harness(t: TestContext) {
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  return ext;
}

test("120 input permutations produce identical bounded summaries and complete item-level receipts", () => {
  const input = [event("a"), event("b", { event: "close" }), event("c", { event: "block" }), event("d", { item: "task-2" }), event("e", { at: 120000 })];
  const original = structuredClone(input);
  const plan = planSlackCoalescing(input, { now: 120000, budget: 1 });
  for (const permutation of permutations(input)) assert.deepEqual(planSlackCoalescing(permutation, { now: 120000, budget: 1 }), plan);
  assert.deepEqual(input, original);
  assert.deepEqual([plan.events, plan.urgent, plan.coalesced, plan.deferred, plan.waiting], [5, 1, 2, 1, 1]);
  assert.equal(plan.notifications[0]!.urgent, true);
  assert.match(plan.notifications[1]!.text, /create:1, close:1/);
  assert.equal(new Set(plan.receipts.map((row) => row.key)).size, input.length);
  assert.equal(plan.receipts.every((row) => row.revision && row.notification), true);
});

test("urgent blockers and critical events bypass zero budget and open windows; groups respect item, route and window", () => {
  const input = [event("critical", { priority: 1, at: 999999 }), event("blocker", { event: "block", priority: 4, at: 999999 }), event("routine")];
  const plan = planSlackCoalescing(input, { now: 0, budget: 0 });
  assert.equal(plan.notifications.length, 2);
  assert.equal(plan.waiting, 1);
  assert.equal(plan.urgent, 2);
  assert.equal(planSlackCoalescing([event("zero", { priority: 0 })], { budget: 0, now: 0 }).urgent, 1);
  const boundary = planSlackCoalescing([event("a"), event("b", { at: 60000 }), event("c", { destination: "route-2" }), event("d", { item: "task-2" })], { now: 120000 });
  assert.equal(boundary.notifications.length, 4);
  assert.equal(planSlackCoalescing([event("a", { item: "z" }), event("b", { item: "a" })], { now: 60000 }).notifications[0]!.text.includes(" a:"), true);
  assert.equal(planSlackCoalescing([], {}).events, 0);
  assert.equal(planSlackCoalescing([event("default")]).notifications.length, 1);
  assert.equal(planSlackCoalescing([event("max")], { budget: 100, windowMs: 86400000, now: 86400000 }).notifications.length, 1);
  const allEvents: CoalescingEvent["event"][] = ["create", "close", "cancel", "open", "start", "unblock", "reopen"];
  const large = planSlackCoalescing(Array.from({ length: 10000 }, (_, index) => event(`key-${index}`, { event: allEvents[index % allEvents.length]! })), { now: 60000 });
  assert.equal(large.notifications.length, 1);
  assert.equal(large.receipts.length, 10000);
  assert.ok(large.notifications[0]!.text.length < 500);
});

test("typed safe refusals reject malformed events and bounds before delivery", () => {
  const invalidOptions: CoalescingOptions[] = [{ budget: -1 }, { budget: 101 }, { budget: 0.5 }, { windowMs: 999 }, { windowMs: 86400001 }, { windowMs: NaN }, { now: -1 }, { now: 1.5 }];
  const refuses = (error: unknown) => error instanceof CoalescingError && error.exitCode === 2 && error.code === "invalid_coalescing_input" && error.remediation === error.remedy && error.context.nextSteps.length === 1 && !error.message.includes("secret");
  for (const options of invalidOptions) assert.throws(() => planSlackCoalescing([], options), refuses);
  for (const patch of [{ key: "secret\n" }, { item: "<@everyone>" }, { revision: "" }, { destination: "x".repeat(161) }, { priority: -1 }, { priority: 5 }, { priority: 1.1 }, { at: -1 }, { at: NaN }, { event: "invalid" as "create" }, { revision: 1 as unknown as string }]) {
    assert.throws(() => planSlackCoalescing([event("a", patch)]), refuses);
  }
  assert.throws(() => planSlackCoalescing([event("a"), event("a")]), refuses);
  assert.throws(() => planSlackCoalescing(Array.from({ length: 10001 }, (_, index) => event(`e-${index}`))), refuses);
});

test("coalesced delivery acknowledges every member, retains deferred events and pages durable evidence after restart", async (t) => {
  const { box, pmRoot } = await fixture(t);
  const keys = [box.enqueue(intent("a", { payload: { text: "Original", channel: "#fixture" } })), box.enqueue(intent("b", { event: "close", payload: { text: "Original close", channel: "#fixture" } })), box.enqueue(intent("urgent", { event: "block", at: Date.now() }))];
  box.enqueue(intent("deferred", { item: "task-2" }));
  box.enqueue(intent("waiting", { at: Date.now() + 100000 }));
  const preview = box.planCoalescing({ budget: 1 });
  const sent: string[] = [];
  const plan = await box.drainCoalesced(async (_destination, payload) => {
    sent.push(payload.text); assert.ok(payload.text.length < 500);
    if (payload.text.startsWith("pm lifecycle")) { assert.equal(payload.channel, "#fixture"); assert.equal(payload.mrkdwn, false); }
    return "acknowledged";
  }, { budget: 1 });
  assert.deepEqual(plan, preview);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], "Private original payload");
  assert.equal(box.status().counts.acknowledged, 3);
  assert.equal(box.status().counts.pending, 2);
  const report = box.coalescingReport(plan, 2);
  assert.equal(report.rows.length, 2);
  assert.equal(report.omitted, 3);
  assert.equal(report.next_cursor, 2);
  assert.equal(box.coalescingReport(plan, 100, 100).next_cursor, null);
  assert.throws(() => box.coalescingReport(plan, 20, -1), OutboxError);
  assert.throws(() => box.coalescingReport(plan, 0), OutboxError);
  for (const patch of [{ at: -1 }, { at: NaN }, { priority: -1 }, { priority: 5 }, { priority: 1.5 }]) assert.throws(() => box.enqueue(intent("invalid", patch)), OutboxError);
  const restarted = new SlackOutbox(pmRoot);
  t.after(() => restarted.close());
  const durable = restarted.coalescingReport(plan, 100, 0, true);
  assert.equal(durable.rows.length, 5);
  for (const key of keys) assert.equal(durable.rows.find((row) => row.key === key)!.state, "acknowledged");
  assert.ok(!JSON.stringify(durable).includes("Private"));
  const emptyRoot = join(pmRoot, "empty");
  const disabled = new SlackOutbox(emptyRoot);
  try { assert.throws(() => disabled.planCoalescing(), OutboxError); } finally { disabled.close(); }
});

test("whole-group uncertainty and retries remain explicit across concurrent drains and reconciliation", async (t) => {
  const { box, pmRoot } = await fixture(t);
  const a = box.enqueue(intent("a")); box.enqueue(intent("b"));
  const other = new SlackOutbox(pmRoot); t.after(() => other.close());
  await box.drainCoalesced(async () => {
    assert.throws(() => other.resolve(a, "retry"), OutboxError);
    assert.equal((await other.drain(async () => { assert.fail("claimed originals cannot send"); })).counts.sending, 2);
    throw new Error("Transport lost after request");
  });
  assert.equal(box.status().counts.ambiguous, 2);
  box.resolve(a, "retry");
  assert.equal(box.status().counts.pending, 2);
  await box.drainCoalesced(async () => "retry");
  assert.equal(box.status().counts.pending, 2);
  await box.drainCoalesced(async () => "rejected");
  box.resolve(a, "acknowledged");
  assert.equal(box.status().counts.acknowledged, 2);
  box.enqueue(intent("c")); box.enqueue(intent("d"));
  await box.drainCoalesced(async (_destination, _payload, _context) => { throw new OutboxError("destination_changed", "Restore the original route."); });
  assert.equal(box.status().counts.refused, 2);
  const c = box.status().rows.find((row) => row.state === "refused")!;
  assert.equal(c.attempts, 0);
  box.resolve(c.key, "skip");
  assert.equal(box.status().counts.skipped, 2);
  box.enqueue(intent("e"));
  await assert.rejects(box.drainCoalesced(async (_destination, _payload, _context) => { throw new OutboxError("invalid_input", "Restore configuration."); }), OutboxError);
  assert.equal(box.status().counts.pending, 1);
  assert.equal(box.status().rows.find((row) => row.state === "pending")!.attempts, 0);
});

test("SQLite refusal of event context rolls back the intent instead of dropping urgency", async (t) => {
  const { box, pmRoot } = await fixture(t);
  const database = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  t.after(() => database.close());
  database.exec("CREATE TRIGGER refuse_context BEFORE INSERT ON delivery_context BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END;");
  assert.throws(() => box.enqueue(intent("critical", { priority: 0 })), /synthetic refusal/);
  assert.equal(box.status().counts.pending, 0);
  database.exec("DROP TRIGGER refuse_context;");
  box.enqueue(intent("critical", { priority: 0 }));
  assert.equal(box.planCoalescing({ budget: 0 }).urgent, 1);
  database.exec("CREATE TRIGGER refuse_group BEFORE INSERT ON delivery_group BEGIN SELECT RAISE(ABORT, 'synthetic group refusal'); END;");
  await assert.rejects(box.drainCoalesced(async () => { assert.fail("failed claims cannot send"); }), (error: unknown) => error instanceof OutboxError && error.code === "storage_unavailable");
  assert.equal(box.status().counts.pending, 1);
  assert.equal(box.status().counts.sending, 0);
  database.exec("DROP TRIGGER refuse_group;");
  await box.drainCoalesced(async () => "acknowledged");
  assert.equal(box.status().counts.acknowledged, 1);
});

test("ambiguous routes pause subsequent batches, retries stop drains, and concurrent claims do not duplicate", async (t) => {
  const { box, pmRoot } = await fixture(t);
  for (const item of ["task-1", "task-2", "task-3"]) box.enqueue(intent(item, { item }));
  let sends = 0;
  await box.drainCoalesced(async () => { sends += 1; return "ambiguous"; });
  assert.equal(sends, 1);
  assert.equal(box.status().counts.pending, 2);
  const other = new SlackOutbox(pmRoot); t.after(() => other.close());
  await box.drainCoalesced(async () => { await other.drain(async () => "acknowledged"); return "acknowledged"; });
  assert.equal(box.status().counts.acknowledged, 2);
  box.enqueue(intent("retry-1", { item: "task-4" })); box.enqueue(intent("retry-2", { item: "task-5" }));
  await box.drainCoalesced(async () => "retry");
  assert.equal(box.status().counts.pending, 2);
});

test("CLI hooks queue routine events and bypass urgent events; JSON and TOON preserve paged evidence without git", async (t) => {
  const received: string[] = [];
  const server = http.createServer((request, response) => { let body = ""; request.on("data", (chunk: Buffer) => { body += chunk; }); request.on("end", () => { received.push(body); response.end("ok"); }); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
  for (const key of Object.keys(process.env).filter((key) => key.startsWith("PM_SLACK_"))) delete process.env[key];
  const address = server.address(); assert.ok(address && typeof address === "object");
  process.env.PM_SLACK_WEBHOOK = `http://127.0.0.1:${address.port}/fixture`;
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  process.env.PM_SLACK_COALESCE = "1";
  const { box, pmRoot, client } = await fixture(t);
  const ext = await harness(t);
  const created = await create({ title: "Routine lifecycle", priority: 2 }, client);
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: created } });
  assert.equal(received.length, 0);
  // Retire this fixture's routine event before testing CLI delivery, so the
  // wall clock crossing a fixed-window boundary cannot add another summary.
  await box.drain(async () => "acknowledged");
  const critical = await create({ title: "Critical lifecycle", priority: 1 }, client);
  await ext.runHook({ kind: "after_command", context: { command: "create", args: [], pm_root: pmRoot, ok: true, result: critical } });
  assert.equal(received.length, 1);
  box.enqueue(intent("eligible-a", { item: created.item.id, destination: slackDestination(process.env.PM_SLACK_WEBHOOK) }));
  box.enqueue(intent("eligible-b", { item: created.item.id, event: "close", destination: slackDestination(process.env.PM_SLACK_WEBHOOK) }));
  const response = await ext.runCommand({ command: "slack coalesce", pmRoot, options: { limit: "1" }, global: { json: true } });
  const report = response.result as CoalescingReport;
  assert.equal(report.rows.length, 1);
  assert.ok(report.omitted > 0);
  assert.equal(received.length, 1);
  const output = await ext.runRendererOverride({ command: "slack coalesce", format: "toon", result: response.result });
  assert.deepEqual(decode(output.rendered!), response.result);
  for (const result of [null, {}, { summary: {} }]) assert.equal((await ext.runRendererOverride({ command: "slack coalesce", format: "toon", result })).overridden, false);
  const drained = await ext.runCommand({ command: "slack coalesce", pmRoot, options: { action: "drain", windowMs: "1000" }, global: { json: true } });
  assert.equal(drained.exitCode ?? 0, 0);
  assert.equal(received.length, 2);
  assert.ok(received[1]!.includes("pm lifecycle"));
  const manifest = (await ext.runCommand({ command: "slack coalesce", pmRoot, options: { action: "receipts", after: "1" } })).result as CoalescingReport;
  assert.ok(manifest.rows.length > 0);
  for (const options of [{ action: "bad" }, { limit: "0" }, { after: "-1" }, { budget: "101" }, { windowMs: "1" }]) {
    const refusal = await ext.runCommand({ command: "slack coalesce", pmRoot, options, global: { json: true } });
    assert.equal(refusal.exitCode, 2);
    assert.ok((refusal.result as { remediation: string }).remediation.length > 0);
  }
  const historyFile = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const history = readFileSync(historyFile, "utf8");
  writeFileSync(historyFile, "broken\n");
  const refused = await ext.runCommand({ command: "slack coalesce", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(refused.exitCode, 2);
  assert.equal(received.length, 2);
  writeFileSync(historyFile, history);
});

test("crashing a grouped sender after acceptance leaves all originals sending until group reconciliation", async (t) => {
  const { box, pmRoot } = await fixture(t);
  const key = box.enqueue(intent("a")); box.enqueue(intent("b"));
  const source = `import { SlackOutbox } from ${JSON.stringify(new URL("../outbox.ts", import.meta.url).href)}; const box = new SlackOutbox(process.argv[1]); await box.drainCoalesced(async () => { process.stdout.write('accepted'); await new Promise(() => {}); return 'acknowledged'; });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((done, reject) => { child.stdout.once("data", () => { child.kill("SIGKILL"); }); child.once("error", reject); child.once("exit", (_code, signal) => signal === "SIGKILL" ? done() : reject(new Error("Sender did not reach acceptance"))); });
  assert.equal(box.status().counts.sending, 2);
  await box.drainCoalesced(async () => { assert.fail("uncertain attempts must not resend"); });
  box.resolve(key, "acknowledged");
  assert.equal(box.status().counts.acknowledged, 2);
});
