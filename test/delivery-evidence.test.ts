/** Real transport/SQLite lifecycles retain delivery uncertainty independently of operator scheduling. */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { init, create, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode } from "@toon-format/toon";
import extension, { SlackOutbox, explainSlackRouting, deriveSlackDeliveryOutcome, slackDestination, __test__ } from "../index.ts";
import type { OutboxOutcome, SlackRoutingIdentity, SlackRoutingExplanation, OutboxReport, CoalescingReport, SlackDeliveryEvidence } from "../index.ts";

type Mode = "ack" | "reject" | "rate" | "timeout" | "before" | "after" | "server_error" | "crash" | "refusal" | "never" | "redirect";
type Call = { accepted: boolean; confirmed: boolean; couldAcceptWithoutConfirmation: boolean };

/** One isolated no-git tracker and a recording Slack whose transport faults do not mock the SDK. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-proof-"));
  const pmRoot = join(directory, ".agents", "pm");
  const keys = [...Object.keys(process.env).filter((key) => key.startsWith("PM_SLACK_")), "PATH", "GIT_CEILING_DIRECTORIES"];
  const saved = { ...process.env };
  keys.forEach((key) => { delete process.env[key]; });
  process.env.PATH = directory; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const client = { cwd: directory, pmRoot, noExtensions: true };
  await init("proof", { defaults: true, agentGuidance: "skip" }, client);
  let mode: Mode = "ack";
  const calls: Call[] = [];
  const activateTimeout = new Map<number, () => void>();
  let requestId = 0;
  const server = http.createServer((request, response) => {
    const requestMode = (request.headers["x-proof-mode"] ?? mode) as Mode;
    request.resume();
    request.on("end", () => {
      const accepted = !["reject", "rate"].includes(requestMode);
      calls.push({ accepted, confirmed: requestMode === "ack", couldAcceptWithoutConfirmation: accepted && requestMode !== "ack" });
      if (requestMode === "timeout") {
        const id = Number(request.headers["x-proof-request"]);
        activateTimeout.get(id)!(); activateTimeout.delete(id); return;
      }
      if (requestMode === "after") { request.socket.destroy(); return; }
      if (requestMode === "rate") response.setHeader("Retry-After", "1");
      response.statusCode = requestMode === "reject" ? 400 : requestMode === "rate" ? 429 : requestMode === "server_error" ? 503 : requestMode === "redirect" ? 307 : 200;
      response.end("synthetic");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const webhook = `http://127.0.0.1:${(server.address() as { port: number }).port}/synthetic`;
  process.env.PM_SLACK_WEBHOOK = webhook; process.env.PM_SLACK_MIN_PRIORITY = "4";
  const originalRequest = http.request;
  // Arm the real timeout after the fake accepted the request; pre-connect faults emit no request.
  http.request = ((...args: Parameters<typeof http.request>) => {
    const nextMode = mode; const id = ++requestId;
    const options = args[0] as http.RequestOptions;
    const enriched = { ...options, headers: { ...options.headers, "x-proof-mode": nextMode, "x-proof-request": String(id) } };
    const request = Reflect.apply(originalRequest, http, [enriched, ...args.slice(1)]) as http.ClientRequest;
    const setTimeout = request.setTimeout;
    request.setTimeout = function (duration, callback) {
      if (nextMode === "timeout") { activateTimeout.set(id, () => { setTimeout.call(request, 1, callback); }); return this; }
      return setTimeout.call(this, duration, callback);
    };
    if (nextMode === "before") queueMicrotask(() => request.destroy(Object.assign(new Error("Synthetic pre-connect refusal"), { code: "ECONNREFUSED" })));
    return request;
  }) as typeof http.request;
  let box = new SlackOutbox(pmRoot); box.enable({ events: ["create"], minPriority: 4 });
  t.after(async () => {
    http.request = originalRequest; box.close(); server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("PM_SLACK_"))) delete process.env[key];
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(directory, { recursive: true, force: true });
  });
  /** Create an SDK event and its immutable outbox intent. */
  async function event(index: number) {
    const created = await create({ title: `Synthetic proof ${index}`, priority: 1 }, client);
    const snapshot = await readHistorySnapshot(join(pmRoot, "history", `${created.item.id}.jsonl`), created.item.id);
    const identity: SlackRoutingIdentity = { item: created.item.id, event: "create", revision: snapshot.entries[0]!.after_hash };
    const intent = { ...identity, destination: slackDestination(webhook), payload: { text: "Synthetic private body" }, priority: 1, at: 0 };
    return { identity, intent, key: box.enqueue(intent) };
  }
  /** Run the package's actual transport and durable completion path. */
  async function send(next: Mode, grouped = false, owner = box) {
    mode = next;
    const transport = next === "refusal" ? (_destination: string, payload: { text: string }) => __test__.sendOutbox("unconfigured", payload) : __test__.sendOutbox;
    if (grouped) await owner.drainCoalesced(transport, { budget: 0 }); else await owner.drain(transport, 1);
  }
  /** Exit a real process after Slack's response but before the durable completion transition. */
  async function crash() {
    mode = "crash";
    const url = new URL("../index.ts", import.meta.url).href;
    const source = `import {SlackOutbox,__test__} from ${JSON.stringify(url)}; const box=new SlackOutbox(process.argv[1]); await box.drain(async(d,p)=>{await __test__.sendOutbox(d,p); process.exit(73);},1);`;
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot], { cwd: directory, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
      child.on("error", reject); child.on("exit", (code) => code === 73 ? done() : reject(new Error(stderr)));
    });
  }
  return { pmRoot, calls, event, send, crash, box: () => box, restart: () => { box.close(); box = new SlackOutbox(pmRoot); } };
}

/** The oracle uses only recording Slack observations, never receipt labels or production normalization. */
function reference(calls: readonly Call[]) {
  if (calls.some((call) => call.couldAcceptWithoutConfirmation)) return "uncertain";
  return calls.some((call) => call.confirmed) ? "delivered" : "withheld";
}

test("accepted request with a timed-out response remains uncertain after resolve skip", async (t) => {
  const f = await fixture(t); const { identity, key } = await f.event(0);
  await f.send("timeout");
  assert.equal(f.calls[0]!.accepted, true);
  f.box().resolve(key, "skip");
  const report = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(report.state, "skipped"); assert.equal(report.outcome, "uncertain");
  assert.equal(report.attempt_evidence!.uncertain, 1);
  assert.deepEqual(f.box().status().outcomes, { delivered: 0, withheld: 0, uncertain: 1 });
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  const cli = await ext.runCommand({ command: "slack explain", pmRoot: f.pmRoot, options: { ...identity }, global: { json: true } });
  assert.deepEqual(cli.result, report);
  assert.deepEqual(decode((await ext.runRendererOverride({ command: "slack explain", format: "toon", result: report })).rendered!), report);
  const status = (await ext.runCommand({ command: "slack outbox", pmRoot: f.pmRoot, options: { action: "status" } })).result as OutboxReport;
  assert.equal(status.rows[0]!.outcome, "uncertain");
  assert.deepEqual((decode((await ext.runRendererOverride({ command: "slack outbox", format: "toon", result: status })).rendered!) as unknown as OutboxReport).outcomes, status.outcomes);
  const plan = f.box().planCoalescing(); const coalesced = f.box().coalescingReport(plan);
  assert.deepEqual(coalesced.outcomes, { delivered: 0, withheld: 0, uncertain: 0 });
  const pending = await f.event(1);
  const abandoned = (await ext.runCommand({ command: "slack outbox", pmRoot: f.pmRoot, options: { action: "resolve", key: pending.key, decision: "abandon" } })).result as OutboxReport;
  assert.deepEqual(abandoned.outcomes, { delivered: 0, withheld: 1, uncertain: 1 });
});

test("500 seeded real send/resolve lifecycles preserve evidence through retry, skip, abandon, crashes and replays", async (t) => {
  const f = await fixture(t);
  let seed = 0xc1a551f1;
  /** Deterministic operation choices make every failure replayable. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const modes: Mode[] = ["ack", "reject", "rate", "timeout", "before", "after", "server_error", "crash", "refusal", "never"];
  const totals = { delivered: 0, withheld: 0, uncertain: 0 };
  const covered = new Set<Mode>(); const uncertainResolutions = new Set<string>(); let requests = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const start = f.calls.length; const { identity, intent, key } = await f.event(sequence);
    let operation = modes[sequence % modes.length]!; covered.add(operation);
    for (let step = 0; step < 4; step++) {
      assert.equal(f.box().enqueue(intent), key, "older input replay must not create another receipt or send");
      if (operation === "never") { f.box().resolve(key, "abandon"); break; }
      if (operation === "crash") await f.crash(); else await f.send(operation, sequence % 2 === 0);
      const receipt = f.box().status(100, Number.MAX_SAFE_INTEGER); // totals must cover every page, even an empty one.
      assert.equal(Object.values(receipt.outcomes).reduce((sum, value) => sum + value, 0), sequence + 1);
      const row = f.box().status(1, 0).rows; assert.ok(row.length > 0);
      const current = (await explainSlackRouting(f.pmRoot, identity)).state!;
      if (current === "acknowledged") break;
      const choice = (random() >>> 16) % 4;
      if (choice === 0 || step === 3) {
        const decision = (random() >>> 16) % 2 ? "skip" : "abandon";
        if (reference(f.calls.slice(start)) === "uncertain") uncertainResolutions.add(decision);
        f.box().resolve(key, decision, { force: true }); break;
      }
      if (current !== "pending") {
        if (reference(f.calls.slice(start)) === "uncertain") uncertainResolutions.add("retry");
        f.box().resolve(key, "retry", { force: true });
      }
      operation = modes[(random() >>> 16) % 7]!;
    }
    const report = await explainSlackRouting(f.pmRoot, identity);
    const expected = reference(f.calls.slice(start));
    assert.equal(report.outcome, expected, `sequence ${sequence}`);
    totals[expected] += 1;
    assert.deepEqual(f.box().status(1).outcomes, totals);
    if (sequence % 10 === 0) { f.restart(); assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, expected); }
    requests += f.calls.length - start;
  }
  assert.equal(covered.size, modes.length); assert.ok(requests >= 400);
  assert.deepEqual([...uncertainResolutions].sort(), ["abandon", "retry", "skip"]);
  assert.ok(totals.delivered > 0 && totals.withheld > 0 && totals.uncertain > 0);
  t.diagnostic(JSON.stringify({ sequences: 500, requests, ...totals }));
});

test("operator acknowledged labels never upgrade uncertainty; legacy receipts stay conservative", async (t) => {
  const f = await fixture(t); const first = await f.event(1);
  await f.send("after"); f.box().resolve(first.key, "acknowledged");
  assert.equal((await explainSlackRouting(f.pmRoot, first.identity)).outcome, "uncertain");
  const second = await f.event(2); await f.send("reject"); f.box().resolve(second.key, "acknowledged");
  assert.equal((await explainSlackRouting(f.pmRoot, second.identity)).outcome, "withheld");
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  const third = await f.event(3);
  db.exec("DROP TABLE delivery_attempt; DROP TABLE delivery_resolution; DROP TABLE delivery_proof");
  const legacy = await explainSlackRouting(f.pmRoot, first.identity);
  assert.equal(legacy.outcome, "uncertain"); assert.ok(legacy.uncertainty.includes("attempt_history_incomplete"));
  assert.equal((await explainSlackRouting(f.pmRoot, third.identity)).outcome, "withheld");
  db.prepare("UPDATE delivery SET state='acknowledged' WHERE key=?").run(third.key);
  assert.equal((await explainSlackRouting(f.pmRoot, third.identity)).outcome, "uncertain");
  f.restart(); assert.equal((await explainSlackRouting(f.pmRoot, second.identity)).outcome, "uncertain");
});

test("one outcome reducer rejects malformed proof and never treats operator resolution counts as delivery proof", () => {
  const valid: SlackDeliveryEvidence = { legacy_unknown: false, recorded: 0, confirmed: 0, uncertain: 0, definitive: 0, resolutions: 0 };
  assert.equal(deriveSlackDeliveryOutcome(), "uncertain"); assert.equal(deriveSlackDeliveryOutcome(undefined, true), "withheld");
  assert.equal(deriveSlackDeliveryOutcome(null as unknown as SlackDeliveryEvidence), "uncertain");
  assert.equal(deriveSlackDeliveryOutcome(valid), "withheld");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, resolutions: 99 }), "withheld");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, recorded: 1, confirmed: 1 }), "delivered");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, recorded: 2, confirmed: 1, uncertain: 1 }), "uncertain");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, recorded: 1, definitive: 1, legacy_unknown: true }), "uncertain");
  for (const field of ["recorded", "confirmed", "uncertain", "definitive", "resolutions"]) for (const value of [Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(deriveSlackDeliveryOutcome({ ...valid, [field]: value }), "uncertain");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, recorded: 1 }), "uncertain");
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, legacy_unknown: "foreign" } as unknown as SlackDeliveryEvidence), "uncertain");
});

test("coalesced manifests and both renderers count uncertainty separately and skip foreign records", async (t) => {
  const f = await fixture(t); const { key } = await f.event(0);
  const preview = f.box().planCoalescing();
  await f.send("after", true); f.box().resolve(key, "abandon");
  const report = f.box().coalescingReport(f.box().planCoalescing(), 20, 0, true);
  assert.deepEqual(report.outcomes, { delivered: 0, withheld: 0, uncertain: 1 });
  assert.equal(report.rows[0]!.outcome, "uncertain");
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] }); t.after(() => ext.deactivate());
  assert.deepEqual(decode((await ext.runRendererOverride({ command: "slack coalesce", format: "toon", result: report })).rendered!), report);
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  db.exec("UPDATE delivery SET state='foreign'");
  const status = f.box().status(); assert.equal(status.foreign_skipped, 1);
  const invalid = f.box().coalescingReport(preview); assert.equal(invalid.foreign_skipped, 1);
  const unknown = f.box().coalescingReport({ ...preview, receipts: [{ ...preview.receipts[0]!, key: "foreign-key" }] }); assert.equal(unknown.foreign_skipped, 2);
  const durable = f.box().coalescingReport(preview, 20, 0, true); assert.equal(durable.rows.length, 0);
  for (const sql of ["UPDATE delivery SET state='pending',attempts=-1", "UPDATE delivery SET attempts=1.5", "UPDATE delivery SET attempts=1e999", "UPDATE delivery SET attempts=0,rowid=0", "UPDATE delivery SET rowid=9007199254740992", "UPDATE delivery SET rowid=1,revision='foreign'"]) {
    db.exec(sql); assert.equal(f.box().status().foreign_skipped, 1);
  }
  for (const [command, result] of [["slack coalesce", invalid], ["slack outbox", { ...status, recovered: { inspected: 0, queued: 0, failed: 0 } }]] as const) {
    assert.deepEqual(decode((await ext.runRendererOverride({ command, format: "toon", result })).rendered!), result);
  }
});

test("a retired sender records its real response without overwriting a peer's work state", async (t) => {
  const f = await fixture(t); const { key, identity } = await f.event(0);
  const peer = new SlackOutbox(f.pmRoot); t.after(() => peer.close());
  let accepted!: () => void; const acceptedPromise = new Promise<void>((done) => { accepted = done; });
  let release!: () => void; const releasePromise = new Promise<void>((done) => { release = done; });
  const old = f.box().drain(async (destination, payload) => { const outcome = await __test__.sendOutbox(destination, payload); accepted(); await releasePromise; return outcome; });
  await acceptedPromise;
  peer.resolve(key, "retry", { force: true }); await f.send("reject", false, peer);
  release(); await old;
  const report = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(report.state, "rejected"); assert.equal(report.outcome, "delivered");
  assert.equal(report.attempt_evidence!.confirmed, 1); assert.equal(report.attempt_evidence!.definitive, 1);
});

test("claim publication fences a competing drainer at every SQL boundary", async (t) => {
  /** Execute one real race, recording or injecting at a particular durable step. */
  async function race(t: TestContext, at = -1) {
    const f = await fixture(t); await f.event(0);
    const owner = f.box(); const peer = new SlackOutbox(f.pmRoot); t.after(() => peer.close());
    const db = (owner as unknown as { db: DatabaseSync }).db;
    (peer as unknown as { db: DatabaseSync }).db.exec("PRAGMA busy_timeout=1");
    const exec = db.exec; const prepare = db.prepare; const trace: string[] = [];
    let armed = true; let peerRun: Promise<unknown> | undefined; let sends = 0;
    /** A peer contends through the real SQLite writer fence. */
    const checkpoint = (sql: string) => {
      if (!armed) return;
      trace.push(sql);
      if (trace.length - 1 === at) peerRun = peer.drain(async () => { sends += 1; return "acknowledged"; }).catch((error: unknown) => assert.match(String(error), /locked|busy|storage_unavailable/));
    };
    db.exec = function (sql) { exec.call(this, sql); checkpoint(sql); };
    db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      for (const method of ["get", "all", "run"] as const) {
        const original = statement[method];
        Object.defineProperty(statement, method, { value: (...args: unknown[]) => { const result: unknown = Reflect.apply(original, statement, args); checkpoint(sql); return result; } });
      }
      return statement;
    };
    try { await owner.drain(async () => { armed = false; sends += 1; return "acknowledged"; }); }
    finally { armed = false; db.exec = exec; db.prepare = prepare; }
    await peerRun;
    assert.equal(sends, 1); assert.deepEqual(owner.status().outcomes, { delivered: 1, withheld: 0, uncertain: 0 });
    if (at >= 0) assert.ok(trace.length > at);
    return trace;
  }
  const trace = await race(t);
  for (let at = 0; at < trace.length; at++) await t.test(`claim boundary ${at + 1}`, async (subtest) => { await race(subtest, at); });
});

test("a missing earlier attempt cannot be hidden by a later pre-request refusal", async (t) => {
  const f = await fixture(t); const { key, identity } = await f.event(0);
  await f.send("after"); f.box().resolve(key, "retry"); await f.send("refusal");
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  db.prepare("DELETE FROM delivery_attempt WHERE key=? AND result='ambiguous'").run(key);
  const report = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(report.outcome, "uncertain"); assert.equal(report.attempt_evidence!.legacy_unknown, true);
});


test("a redirect after acceptance is not a definite rejection", async (t) => {
  const f = await fixture(t); const { identity, key } = await f.event(0);
  await f.send("redirect"); f.box().resolve(key, "skip");
  assert.equal(f.calls[0]!.accepted, true);
  assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, "uncertain");
});
