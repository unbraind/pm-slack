/** Offline explanations exercise real SDK history, durable SQLite evidence and configured status roles. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, chmodSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { init, create, update, createHistoryEntry, appendHistoryEntry, resolveRuntimeStatusRegistry, readHistorySnapshot, readSettings, locateItem, readLocatedItem, resolveItemTypeRegistry, getActiveExtensionRegistrations } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode } from "@toon-format/toon";
import extension, { explainSlackRouting, SlackRoutingError, SlackOutbox, OutboxError } from "../index.ts";
import type { SlackRoutingIdentity, SlackRoutingExplanation, OutboxEvent } from "../index.ts";
import { validateSlackRoutingIdentity } from "../routing-explanation.ts";

/** A real tracker with all subprocess git discovery disabled and synthetic notification configuration. */
async function fixture(t: TestContext, priority = 2) {
  const dir = mkdtempSync(join(tmpdir(), "slack-routing-"));
  const pmRoot = join(dir, ".agents", "pm");
  const keys = ["PATH", "GIT_CEILING_DIRECTORIES", "PM_SLACK_WEBHOOK", "PM_SLACK_ROUTES", "PM_SLACK_EVENTS", "PM_SLACK_MIN_PRIORITY"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    rmSync(dir, { force: true, recursive: true });
  });
  process.env.PATH = dir;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  process.env.PM_SLACK_WEBHOOK = "https://example.invalid/SECRET-WEBHOOK";
  process.env.PM_SLACK_ROUTES = "[]";
  process.env.PM_SLACK_EVENTS = "create,close,block,cancel,open,start,unblock,reopen";
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  const client = { cwd: dir, pmRoot, noExtensions: true };
  await init("routing", { defaults: true, agentGuidance: "skip" }, client);
  const created = await create({ title: "PRIVATE-MESSAGE", priority }, client);
  const item = created.item.id;
  /** Discover the actual SDK revision, rather than manufacturing event hashes. */
  async function identity(event: OutboxEvent = "create"): Promise<SlackRoutingIdentity> {
    const snapshot = await readHistorySnapshot(join(pmRoot, "history", `${item}.jsonl`), item);
    return { item, event, revision: snapshot.entries.at(-1)!.after_hash };
  }
  return { dir, pmRoot, client, item, identity };
}

/** Compare authoritative SDK documents around a diagnostic, including native collections and relationships. */
async function document(pmRoot: string, item: string) {
  const settings = await readSettings(pmRoot);
  const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const located = await locateItem(pmRoot, item, settings.id_prefix, settings.item_format, registry.type_to_folder);
  return (await readLocatedItem(located!, { schema: settings.schema })).document;
}

/** Assert a fixed, complete path and finite numeric output, with no private input reflected anywhere. */
function safe(report: SlackRoutingExplanation) {
  assert.deepEqual([...new Set(report.path.map((step) => step.stage))], ["history", "events", "priority", "route", "coalescing", "delivery"]);
  assert.ok(report.path.length <= 106);
  for (const value of [report.eligibility.priority, report.eligibility.min_priority]) if (value !== null) assert.ok(Number.isInteger(value) && value >= 0 && value <= 4);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /SECRET-WEBHOOK|PRIVATE-MESSAGE|private-channel/);
  assert.ok(text.length < 18000);
  for (const step of report.path) if (step.rule !== undefined && step.rule !== null) assert.ok(Number.isSafeInteger(step.rule) && step.rule >= 0 && step.rule < 100);
  if (report.attempts !== undefined) assert.ok(Number.isSafeInteger(report.attempts) && report.attempts >= 0);
}

test("a suppressed event has one complete offline path with retained filters and current first-match/shadow decisions", async (t) => {
  const f = await fixture(t);
  const box = new SlackOutbox(f.pmRoot); t.after(() => box.close());
  box.enable({ events: ["block"], minPriority: 1 });
  const created = await create({ title: "PRIVATE-MESSAGE", priority: 4 }, f.client);
  const snapshot = await readHistorySnapshot(join(f.pmRoot, "history", `${created.item.id}.jsonl`), created.item.id);
  const input: SlackRoutingIdentity = { item: created.item.id, event: "create", revision: snapshot.entries[0]!.after_hash };
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", channel: "private-channel" }, { match: "type:Task", channel: "private-channel" }, { match: "*", channel: "private-channel" }]);
  const before = await document(f.pmRoot, input.item);
  const report = await explainSlackRouting(f.pmRoot, input);
  safe(report);
  assert.equal(report.outcome, "withheld");
  assert.deepEqual(report.eligibility, { event_enabled: false, priority: 4, min_priority: 1, source: "retained" });
  assert.deepEqual(report.path.filter((step) => step.stage === "route").map((step) => step.decision), ["no_match", "selected", "shadowed", "available"]);
  assert.deepEqual(report.path.filter((step) => step.source === "retained").map((step) => step.decision), ["withhold", "withhold"]);
  assert.deepEqual(await document(f.pmRoot, input.item), before);
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  const result = await ext.runCommand({ command: "slack explain", pmRoot: f.pmRoot, options: { ...input }, global: { json: true } });
  assert.deepEqual(result.result, report);
  const rendered = await ext.runRendererOverride({ command: "slack explain", format: "toon", result: report });
  assert.deepEqual(decode(rendered.rendered!), report);
  for (const value of [null, {}, { ok: false }]) assert.equal((await ext.runRendererOverride({ command: "slack explain", format: "toon", result: value })).overridden, false);
  const receiptFile = join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
  chmodSync(receiptFile, 0o400);
  const bytes = readFileSync(receiptFile);
  await ext.runHook({ kind: "after_command", context: { command: "slack explain", args: [], pm_root: f.pmRoot, ok: true, result: report } });
  assert.deepEqual(readFileSync(receiptFile), bytes);
  assert.equal(statSync(receiptFile).mode & 0o777, 0o400);
  chmodSync(receiptFile, 0o600);
  const versioned = await ext.runCommand({ command: "slack explain", pmRoot: f.pmRoot, options: { ...input, "event-version": "1" } });
  assert.equal((versioned.result as SlackRoutingExplanation).identity.version, 1);
  assert.deepEqual(decode((await ext.runRendererOverride({ command: "slack explain", format: "toon", result: versioned.result })).rendered!), versioned.result);
  const invalid = await ext.runCommand({ command: "slack explain", pmRoot: f.pmRoot, options: {} });
  assert.equal((invalid.result as { code: string }).code, "invalid_routing_input");
  writeFileSync(join(f.pmRoot, "history", `${input.item}.jsonl`), "broken");
  const broken = await ext.runCommand({ command: "slack explain", pmRoot: f.pmRoot, options: { ...input } });
  assert.equal((broken.result as { code: string }).code, "history_unavailable");
});

test("absence of durable evidence is uncertainty; inspection creates no runtime storage", async (t) => {
  const f = await fixture(t); const input = await f.identity();
  const before = await document(f.pmRoot, f.item);
  for (const webhook of ["", "https://example.invalid/SECRET-WEBHOOK"]) {
    process.env.PM_SLACK_WEBHOOK = webhook;
    const report = await explainSlackRouting(f.pmRoot, input); safe(report);
    assert.equal(report.outcome, "uncertain");
    assert.ok(report.uncertainty.includes("delivery_receipt_not_retained"));
  }
  assert.equal(existsSync(join(f.pmRoot, "runtime", "slack-outbox")), false);
  assert.deepEqual(await document(f.pmRoot, f.item), before);
  await assert.rejects(explainSlackRouting(f.pmRoot, { ...input, revision: "a".repeat(64) }), (error: unknown) => error instanceof SlackRoutingError && error.code === "event_not_found");
  await assert.rejects(explainSlackRouting(f.pmRoot, { ...input, event: "block" }), /event_not_found/);
  await update(f.item, { description: "Whitespace\r\n  body ", tags: "fixture,unchanged" }, f.client);
  await assert.rejects(explainSlackRouting(f.pmRoot, await f.identity()), /event_not_found/);
});

test("exact receipt identity wins over later configuration; urgent bypasses name blocker and critical policies", async (t) => {
  const f = await fixture(t, 1); const input = await f.identity();
  const box = new SlackOutbox(f.pmRoot); t.after(() => box.close()); box.enable();
  box.enqueue({ ...input, destination: "synthetic", payload: { text: "PRIVATE-MESSAGE" }, priority: 1, at: 0 });
  await box.drainCoalesced(async () => "acknowledged", { budget: 0, now: 0 });
  const report = await explainSlackRouting(f.pmRoot, input); safe(report);
  assert.equal(report.outcome, "delivered"); assert.equal(report.attempts, 1);
  assert.equal(report.path.find((step) => step.stage === "coalescing")!.decision, "bypass");
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  assert.deepEqual(decode((await ext.runRendererOverride({ command: "slack explain", format: "toon", result: report })).rendered!), report);
  await update(f.item, { priority: 1, status: "blocked", blockedReason: "Synthetic blocker" }, f.client);
  const block = await explainSlackRouting(f.pmRoot, await f.identity("block"));
  assert.equal(block.path.find((step) => step.stage === "coalescing")!.policy, "blocker_bypasses_budget_and_window");
  await update(f.item, { status: "open" }, f.client);
  const critical = await explainSlackRouting(f.pmRoot, await f.identity("unblock"));
  assert.equal(critical.path.find((step) => step.stage === "coalescing")!.policy, "critical_priority_bypasses_budget_and_window");
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  for (const state of ["pending", "sending", "ambiguous", "rejected", "refused", "skipped"]) {
    db.prepare("UPDATE delivery SET state=?").run(state);
    for (const disposition of ["waiting", "deferred", "coalesced", "bypass"]) {
      db.prepare("UPDATE coalescing_receipt SET disposition=?").run(disposition);
      const value = await explainSlackRouting(f.pmRoot, input); safe(value);
      assert.equal(value.state, state);
      assert.equal(value.outcome, ["rejected", "refused", "skipped"].includes(state) ? "withheld" : "uncertain");
    }
  }
  for (const sql of ["UPDATE delivery SET state='foreign'", "UPDATE delivery SET state='pending',attempts=-1", "UPDATE delivery SET attempts=1.5", "UPDATE delivery SET attempts=1,revision='foreign'"]) {
    db.exec(sql);
    const value = await explainSlackRouting(f.pmRoot, input); safe(value);
    assert.ok(value.uncertainty.includes("foreign_evidence_skipped")); assert.equal(value.state, undefined);
  }
});

test("strict input boundary rejects extreme values and invalid configuration with safe remedies", async (t) => {
  const f = await fixture(t); const input = await f.identity();
  const invalid: unknown[] = [null, undefined, [], {}, 0, Infinity, { ...input, extra: true }, { ...input, event: ["create"] }, { ...input, event: { toString: () => "create" } }];
  for (const value of [null, undefined, 1, NaN, Infinity, -Infinity, "", " ", "\r\n", "../secret", "a".repeat(10000)]) {
    invalid.push({ ...input, item: value }, { ...input, revision: value }, { ...input, event: value });
  }
  for (const version of [undefined, null, 0, -1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid.push({ ...input, version });
  for (const value of invalid) assert.throws(() => validateSlackRoutingIdentity(value), (error: unknown) => error instanceof SlackRoutingError && error.exitCode === 2 && error.remedy.length > 0 && error.code === "invalid_routing_input");
  for (const raw of ["broken", "null", "{}", "[null]", "[[]]", '[{"match":1}]', '[{"match":"x"}]', '[{"match":"","channel":"x"}]', '[{"match":"x","channel":1}]', '[{"match":"x","channel":"x","extra":1}]', JSON.stringify([{ match: "a".repeat(161), channel: "x" }]), JSON.stringify([{ match: "x", webhook: "x".repeat(2049) }]), JSON.stringify(Array.from({ length: 101 }, () => ({ match: "*", channel: "x" })))]) {
    process.env.PM_SLACK_ROUTES = raw;
    await assert.rejects(explainSlackRouting(f.pmRoot, input), (error: unknown) => error instanceof SlackRoutingError && error.code === "routing_config_invalid");
  }
  process.env.PM_SLACK_ROUTES = JSON.stringify(Array.from({ length: 100 }, () => ({ match: "*", channel: "private-channel" })));
  const bounded = await explainSlackRouting(f.pmRoot, input); safe(bounded);
  assert.equal(bounded.path.length, 106);
});

test("random custom status registries classify lifecycle by SDK roles and preserve old revision diagnoses", async (t) => {
  const f = await fixture(t);
  let seed = 0x53ac;
  /** Reproducible identifiers prevent accidentally relying on built-in status names. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 12; sequence++) {
    const names = Array.from({ length: 6 }, () => `s${random().toString(16)}`);
    writeFileSync(join(f.pmRoot, "schema", "statuses.json"), JSON.stringify({ statuses: [
      { id: names[0], roles: ["active", "default_open"] }, { id: names[1], roles: ["active"] },
      { id: names[2], roles: ["blocked"] }, { id: names[3], roles: ["terminal", "terminal_done", "default_close"] },
      { id: names[4], roles: ["terminal", "terminal_canceled", "default_cancel"] }, { id: names[5], roles: ["draft"] },
    ] }));
    const created = await create({ title: `Synthetic model ${sequence}`, priority: 2 }, f.client);
    const item = created.item.id;
    const revisions: SlackRoutingIdentity[] = [];
    // SDK canonical in-progress selection is authoritative even with custom active names.
    const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
    for (const [status, event] of [[names[1], registry.in_progress_status === names[1] ? "start" : "open"], [names[2], "block"], [names[0], "unblock"], [names[2], "block"], [names[1], registry.in_progress_status === names[1] ? "start" : "unblock"], [names[3], "close"], [names[0], "reopen"], [names[4], "cancel"], [names[0], "reopen"], [names[1], registry.in_progress_status === names[1] ? "start" : "open"], [names[0], "open"]] as const) {
      await update(item, { status, closeReason: "Synthetic terminal transition", blockedReason: "Synthetic blocked transition" }, f.client);
      const snapshot = await readHistorySnapshot(join(f.pmRoot, "history", `${item}.jsonl`), item);
      const input: SlackRoutingIdentity = { item, event, revision: snapshot.entries.at(-1)!.after_hash };
      const report = await explainSlackRouting(f.pmRoot, input); safe(report); revisions.push(input);
    }
    await update(item, { status: names[5] }, f.client);
    const draft = await readHistorySnapshot(join(f.pmRoot, "history", `${item}.jsonl`), item);
    await assert.rejects(explainSlackRouting(f.pmRoot, { item, event: "open", revision: draft.entries.at(-1)!.after_hash }), /event_not_found/);
    for (const input of revisions.slice().reverse()) safe(await explainSlackRouting(f.pmRoot, input));
  }
});

test("500 seeded policy operation sequences replay older SDK revisions and whitespace variants without changing native state", async (t) => {
  const f = await fixture(t);
  const parent = await create({ title: "Synthetic related item" }, f.client);
  await update(f.item, { parent: parent.item.id, description: "native\r\n whitespace ", body: " native body \n", tags: "seeded,relation", estimatedMinutes: "23", assignee: "synthetic-agent" }, f.client);
  const first = await f.identity(); // This native field edit is not a lifecycle event.
  const all = (await readHistorySnapshot(join(f.pmRoot, "history", `${f.item}.jsonl`), f.item)).entries;
  const original: SlackRoutingIdentity = { ...first, revision: all[0]!.after_hash };
  await update(f.item, { status: "blocked", blockedReason: "synthetic" }, f.client);
  const blocked = await f.identity("block");
  const before = await document(f.pmRoot, f.item);
  let seed = 0x52f00d;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const filters = ["create", "block", "close", "create,block"][seed % 4]!;
    process.env.PM_SLACK_EVENTS = filters;
    process.env.PM_SLACK_MIN_PRIORITY = String(seed % 4 + 1);
    const rules = [{ match: seed % 2 ? "block" : "create", channel: "private-channel" }, { match: "*", webhook: "https://example.invalid/SECRET-WEBHOOK" }];
    process.env.PM_SLACK_ROUTES = seed % 3 ? JSON.stringify(rules, null, 2).replace(/\n/g, "\r\n") : JSON.stringify(rules);
    const input = seed % 2 ? original : blocked;
    const report = await explainSlackRouting(f.pmRoot, input); safe(report);
    assert.equal(report.outcome, "uncertain");
    assert.equal(report.path.find((step) => step.stage === "events")!.decision, filters.split(",").includes(input.event) ? "pass" : "withhold");
    assert.deepEqual(report.identity, input);
    assert.deepEqual(await document(f.pmRoot, f.item), before);
  }
});

test("read-only receipt snapshot stays consistent at every SQL boundary of a competing delivery transition", async (t) => {
  const f = await fixture(t); const input = await f.identity();
  const box = new SlackOutbox(f.pmRoot); t.after(() => box.close()); box.enable({ events: ["create"], minPriority: 4 });
  box.enqueue({ ...input, destination: "synthetic", payload: { text: "PRIVATE-MESSAGE" } });
  const peer = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => peer.close()); peer.exec("PRAGMA busy_timeout=1");
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  for (let at = 0; at < 6; at++) {
    peer.exec("UPDATE delivery SET state='pending',attempts=0");
    let boundary = 0; let injected = false;
    /** Competing transition commits before/after the read snapshot, or loses to its read lock. */
    const checkpoint = () => {
      if (boundary++ !== at) return;
      injected = true;
      try { originalPrepare.call(peer, "UPDATE delivery SET state='acknowledged',attempts=1").run(); }
      catch (error) { assert.match(String(error), /locked|busy/); }
    };
    DatabaseSync.prototype.exec = function (sql) { originalExec.call(this, sql); checkpoint(); };
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = originalPrepare.call(this, sql);
      const get = statement.get;
      Object.defineProperty(statement, "get", { value: (...args: Parameters<typeof get>) => { const row = get.apply(statement, args); checkpoint(); return row; } });
      return statement;
    };
    let report: SlackRoutingExplanation;
    try { report = await explainSlackRouting(f.pmRoot, input); }
    finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.prepare = originalPrepare; }
    // BEGIN, since, policy, receipt, COMMIT: all actual boundaries are covered.
    if (at < 5) assert.equal(injected, true);
    assert.ok((report.state === "pending" && report.attempts === 0) || (report.state === "acknowledged" && report.attempts === 1));
    safe(report);
  }
});

test("foreign evidence is skipped, storage failures refuse safely, and numeric/config extremes never return ok", async (t) => {
  const f = await fixture(t); const input = await f.identity();
  const box = new SlackOutbox(f.pmRoot); box.enable({ events: ["create"], minPriority: 4 }); box.close();
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  db.prepare("UPDATE recovery_policy SET since='2000-01-01',events=?").run("broken");
  assert.ok((await explainSlackRouting(f.pmRoot, input)).uncertainty.includes("foreign_evidence_skipped"));
  for (const events of ['{}', '["foreign"]', JSON.stringify(Array.from({ length: 9 }, () => "create"))]) {
    db.prepare("UPDATE recovery_policy SET events=?").run(events);
    assert.ok((await explainSlackRouting(f.pmRoot, input)).uncertainty.includes("foreign_evidence_skipped"));
  }
  db.exec("UPDATE recovery_policy SET events='[\"create\"]',min_priority=5");
  assert.ok((await explainSlackRouting(f.pmRoot, input)).uncertainty.includes("foreign_evidence_skipped"));
  db.close();
  for (const priority of ["Infinity", "NaN", "-1", "5", "1.5", "1junk", " "]) {
    process.env.PM_SLACK_MIN_PRIORITY = priority;
    await assert.rejects(explainSlackRouting(f.pmRoot, input), /routing_config_invalid/);
  }
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  process.env.PM_SLACK_ROUTES = " ".repeat(250001);
  await assert.rejects(explainSlackRouting(f.pmRoot, input), /routing_config_invalid/);
  process.env.PM_SLACK_ROUTES = "[]";
  process.env.PM_SLACK_EVENTS = "x".repeat(161);
  await assert.rejects(explainSlackRouting(f.pmRoot, input), /routing_config_invalid/);
  process.env.PM_SLACK_EVENTS = "create";
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "*", webhook: "bad-url" }]);
  assert.equal((await explainSlackRouting(f.pmRoot, input)).path.find((step) => step.policy === "selected_destination")!.decision, "invalid_destination");
  process.env.PM_SLACK_ROUTES = "[]";
  writeFileSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"), "broken database");
  await assert.rejects(explainSlackRouting(f.pmRoot, input), (error: unknown) => error instanceof OutboxError && error.code === "storage_unavailable");
});

test("retained priority exclusion is independently diagnosable and plain receipts need no coalescing record", async (t) => {
  const f = await fixture(t);
  const box = new SlackOutbox(f.pmRoot); t.after(() => box.close()); box.enable({ events: ["create"], minPriority: 1 });
  const created = await create({ title: "PRIVATE-MESSAGE", priority: 2 }, f.client);
  const history = await readHistorySnapshot(join(f.pmRoot, "history", `${created.item.id}.jsonl`), created.item.id);
  const input: SlackRoutingIdentity = { item: created.item.id, event: "create", revision: history.entries[0]!.after_hash };
  assert.equal((await explainSlackRouting(f.pmRoot, input)).outcome, "withheld");
  box.enqueue({ ...input, destination: "synthetic", payload: { text: "PRIVATE-MESSAGE" } });
  const report = await explainSlackRouting(f.pmRoot, input); safe(report);
  assert.equal(report.outcome, "uncertain"); assert.equal(report.state, "pending"); assert.equal(report.attempts, 0);
  assert.equal(report.path.find((step) => step.stage === "coalescing")!.decision, "not_recorded");
  delete process.env.PM_SLACK_ROUTES;
  delete process.env.PM_SLACK_MIN_PRIORITY;
  delete process.env.PM_SLACK_EVENTS;
  safe(await explainSlackRouting(f.pmRoot, input));
});

test("verified legacy snapshots preserve unspecified-priority behavior and refuse nonfinite or out-of-domain priority", async (t) => {
  const f = await fixture(t);
  const before = await document(f.pmRoot, f.item);
  const original = await f.identity();
  const file = join(f.pmRoot, "history", `${f.item}.jsonl`);
  /** Append SDK-generated transitions and restore authoritative state; no normalization is reimplemented. */
  async function historical(metadata: Record<string, unknown>) {
    const old = { ...before, metadata } as unknown as ItemDocument;
    const options = { nowIso: new Date().toISOString(), author: "fixture-agent", op: "update" };
    const entry = createHistoryEntry({ ...options, before, after: old });
    const intermediate = { ...before, body: before.body + JSON.stringify(metadata) };
    const restored = createHistoryEntry({ ...options, before: old, after: intermediate });
    const final = createHistoryEntry({ ...options, before: intermediate, after: before });
    await appendHistoryEntry(file, entry); await appendHistoryEntry(file, restored); await appendHistoryEntry(file, final);
    return [entry, restored];
  }
  const noStatus: Record<string, unknown> = { ...before.metadata }; delete noStatus.status;
  const [missingStatus, restored] = await historical(noStatus);
  await assert.rejects(explainSlackRouting(f.pmRoot, { item: f.item, event: "open", revision: missingStatus!.after_hash }), /event_not_found/);
  safe(await explainSlackRouting(f.pmRoot, { item: f.item, event: "open", revision: restored!.after_hash }));
  await assert.rejects(explainSlackRouting(f.pmRoot, original), (error: unknown) => error instanceof SlackRoutingError && error.code === "event_ambiguous");
  const withVersion = await explainSlackRouting(f.pmRoot, { ...original, version: 1 }); safe(withVersion);
  assert.ok(withVersion.uncertainty.includes("receipt_revision_not_unique"));
  await assert.rejects(explainSlackRouting(f.pmRoot, { ...original, version: 999 }), /event_not_found/);
  const noPriority: Record<string, unknown> = { ...before.metadata, status: "in_progress" }; delete noPriority.priority;
  const [unknownPriority] = await historical(noPriority);
  const report = await explainSlackRouting(f.pmRoot, { item: f.item, event: "start", revision: unknownPriority!.after_hash }); safe(report);
  assert.equal(report.eligibility.priority, null); assert.equal(report.path.find((step) => step.stage === "priority")!.decision, "pass");
  for (const priority of [-1, 5, 1.5, "2", null]) {
    const [invalid] = await historical({ ...before.metadata, status: "in_progress", priority });
    await assert.rejects(explainSlackRouting(f.pmRoot, { item: f.item, event: "start", revision: invalid!.after_hash }), (error: unknown) => error instanceof OutboxError && error.code === "history_unavailable");
  }
  assert.deepEqual(await document(f.pmRoot, f.item), before);
});

test("empty and unopenable outbox storage yield uncertainty or a typed refusal without mutation", async (t) => {
  const f = await fixture(t); const input = await f.identity();
  const box = new SlackOutbox(f.pmRoot); box.close();
  safe(await explainSlackRouting(f.pmRoot, input));
  const file = join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
  rmSync(file); mkdirSync(file);
  await assert.rejects(explainSlackRouting(f.pmRoot, input), (error: unknown) => error instanceof OutboxError && error.code === "storage_unavailable");
});
