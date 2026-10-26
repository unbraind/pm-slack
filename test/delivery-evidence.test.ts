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
import extension, { SlackOutbox, OutboxError, explainSlackRouting, deriveSlackDeliveryOutcome, slackDestination, __test__ } from "../index.ts";
import type { OutboxOutcome, SlackRoutingIdentity, SlackRoutingExplanation, OutboxReport, CoalescingReport, SlackDeliveryEvidence, OutboxSendContext } from "../index.ts";

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
    const enriched = { ...options, agent: false, headers: { ...options.headers, "x-proof-mode": nextMode, "x-proof-request": String(id) } };
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
    const transport = next === "refusal" ? (_destination: string, payload: { text: string }, context: OutboxSendContext) => __test__.sendOutbox("unconfigured", payload, context) : __test__.sendOutbox;
    if (grouped) await owner.drainCoalesced(transport, { budget: 0 }); else await owner.drain(transport, 1);
  }
  /** Exit a real process after Slack's response but before the durable completion transition. */
  async function crash() {
    mode = "crash";
    const url = new URL("../index.ts", import.meta.url).href;
    const source = `import {SlackOutbox,__test__} from ${JSON.stringify(url)}; const box=new SlackOutbox(process.argv[1]); await box.drain(async(d,p,c)=>{await __test__.sendOutbox(d,p,{...c,responseConfirmed(){process.exit(73);}});},1);`;
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot], { cwd: directory, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
      child.on("error", reject); child.on("exit", (code) => code === 73 ? done() : reject(new Error(stderr)));
    });
  }
  return { pmRoot, calls, event, send, crash, setMode: (value: Mode) => { mode = value; }, box: () => box, restart: () => { box.close(); box = new SlackOutbox(pmRoot); } };
}

/** The oracle uses only recording Slack observations, never receipt labels or production normalization. */
function reference(calls: readonly Call[]) {
  if (calls.some((call) => call.confirmed)) return "delivered";
  return calls.some((call) => call.couldAcceptWithoutConfirmation) ? "uncertain" : "withheld";
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
  const retired = new Set<string>();
  const covered = new Set<Mode>(); const uncertainResolutions = new Set<string>(); let requests = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const start = f.calls.length; const { identity, intent, key } = await f.event(sequence);
    let operation = modes[sequence % modes.length]!; covered.add(operation);
    // Seeded retirement/replacement exercises late clean exits on the same non-git tracker.
    if (sequence % 7 < 4) {
      const kind = ["late_refusal", "exception_before", "exception_after", "cancellation"][sequence % 7]!;
      retired.add(kind);
      let entered!: () => void; const entering = new Promise<void>((done) => { entered = done; });
      let release!: () => void; const releasing = new Promise<void>((done) => { release = done; });
      const old = f.box().drain(async (destination, payload, context) => {
        if (kind === "exception_after") { f.setMode("after"); await __test__.sendOutbox(destination, payload, context); }
        entered(); await releasing;
        if (kind === "late_refusal") throw new OutboxError("destination_changed", "Synthetic pre-request refusal.");
        throw Object.assign(new Error("Synthetic clean exception or cancellation"), { name: kind === "cancellation" ? "AbortError" : "Error" });
      });
      await entering;
      const decision = random() % 2 ? "retry" : "abandon";
      f.box().resolve(key, decision, { force: true });
      if (decision === "abandon") f.box().resolve(key, "retry");
      // A replacement can finish before the retired sender returns or refuses.
      await f.send(sequence % 2 ? "reject" : "ack");
      release(); await old;
      const current = (await explainSlackRouting(f.pmRoot, identity)).state!;
      if (current !== "acknowledged") f.box().resolve(key, "skip");
      const expected = reference(f.calls.slice(start));
      assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, expected, `retirement ${sequence} ${kind}`);
      const journal = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
      try { assert.equal(journal.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=? AND t.token IS NULL").get(key)!.n, 0); } finally { journal.close(); }
      totals[expected] += 1; requests += f.calls.length - start;
      assert.deepEqual(f.box().status(1).outcomes, totals); continue;
    }
    for (let step = 0; step < 4; step++) {
      assert.equal(f.box().enqueue(intent), key, "older input replay must not create another receipt or send");
      if (operation === "never") { f.box().resolve(key, "abandon"); break; }
      if (operation === "crash") await f.crash(); else await f.send(operation, sequence % 2 === 0);
      if (operation !== "crash") {
        const journal = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
        try { assert.equal(journal.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=? AND s.owner=? AND t.token IS NULL").get(key, process.pid)!.n, 0, `clean sender exit ${sequence}/${step}`); } finally { journal.close(); }
      }
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
  assert.deepEqual([...retired].sort(), ["cancellation", "exception_after", "exception_before", "late_refusal"]);
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
  assert.equal(deriveSlackDeliveryOutcome({ ...valid, recorded: 2, confirmed: 1, uncertain: 1 }), "delivered");
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

test("legacy mutable attempt counters cannot change complete journal evidence", async (t) => {
  const f = await fixture(t); const { key, identity } = await f.event(0);
  await f.send("refusal");
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  db.prepare("UPDATE delivery SET attempts=9000 WHERE key=?").run(key);
  const report = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(report.outcome, "withheld"); assert.equal(report.attempts, 0);
  f.box().resolve(key, "retry"); await f.send("ack");
  assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, "delivered");
});

test("a redirect after acceptance is not a definite rejection", async (t) => {
  const f = await fixture(t); const { identity, key } = await f.event(0);
  await f.send("redirect"); f.box().resolve(key, "skip");
  assert.equal(f.calls[0]!.accepted, true);
  assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, "uncertain");
});

test("late pre-request refusal of a retired sender followed by confirmed retry is delivered", async (t) => {
  const f = await fixture(t); const { key, identity } = await f.event(0);
  let release!: () => void; const released = new Promise<void>((done) => { release = done; });
  const retired = f.box().drain(async (_destination, _payload, _context) => {
    await released; throw new OutboxError("destination_changed", "Synthetic pre-request refusal.");
  });
  f.box().resolve(key, "abandon", { force: true });
  release(); await retired;
  assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, "withheld");
  assert.equal((await explainSlackRouting(f.pmRoot, identity)).attempts, 0);
  f.box().resolve(key, "retry"); await f.send("ack");
  const explained = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(explained.outcome, "delivered"); assert.equal(explained.attempts, 1);
  assert.equal(explained.attempt_evidence!.recorded, 2);
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE t.token IS NULL").get()!.n, 0);
});

test("exceptions and real process crashes at every journal step boundary preserve evidence and close clean exits", async (t) => {
  const f = await fixture(t);
  const module = new URL("../index.ts", import.meta.url).href;
  let baseline: string[] = [];
  /** Run a real transport process and fault before or after every observed persistence/transport step. */
  async function run(boundary: number, fault: "trace" | "exception" | "typed" | "crash") {
    const event = await f.event(1000 + boundary);
    const callsBefore = f.calls.length;
    const source = `import {SlackOutbox,OutboxError,__test__} from ${JSON.stringify(module)};
      const box=new SlackOutbox(process.argv[1]); const db=box.db;
      let armed=true,step=0,terminal=false,dispatched=false,returned=false,confirmed=false; const trace=[];
      const point=(name)=>{if(!armed)return;trace.push(name);if(step++===${boundary}){armed=false;${fault === "crash" ? "process.exit(73);" : fault === "exception" ? "throw new Error('Synthetic boundary exception');" : fault === "typed" ? "throw new OutboxError('storage_unavailable','Synthetic typed boundary exception.');" : ""}}};
      const prepare=db.prepare,exec=db.exec;
      db.exec=function(sql){point('before '+sql);const result=exec.call(this,sql);point('after '+sql);return result;};
      db.prepare=function(sql){const statement=prepare.call(this,sql);for(const method of ['run','get','all']){const operation=statement[method];statement[method]=function(...args){point('before '+sql);const result=operation.apply(this,args);if(sql.startsWith('INSERT OR IGNORE INTO delivery_attempt_terminal')){terminal=true;if(args[0]==='acknowledged')confirmed=true;}if(sql.startsWith('INSERT OR IGNORE INTO delivery_request_dispatched'))dispatched=true;point('after '+sql);return result;};}return statement;};
      try {await box.drain(async(d,p,c)=>{point('before transport');const result=await __test__.sendOutbox(d,p,c);point('after response');returned=true;return result;},1);}catch(error){}
      armed=false; console.log(JSON.stringify({trace,terminal,dispatched,returned,confirmed}));box.close();`;
    let output = "";
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.pmRoot], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; child.stdout.on("data", (data: Buffer) => { output += String(data); }); child.stderr.on("data", (data: Buffer) => { stderr += String(data); });
      child.on("error", reject); child.on("exit", (code) => { if (code !== 0 && code !== 73) reject(new Error(stderr)); else done(code); });
    });
    if (code === 0) {
      const beforeRecovery = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
      try { assert.equal(beforeRecovery.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=? AND t.token IS NULL").get(event.key)!.n, 0, `clean exit before recovery ${boundary}`); } finally { beforeRecovery.close(); }
    }
    f.restart(); // Real recovery appends not_sent before dispatch, unknown_after_send after dispatch.
    const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
    const rows = db.prepare("SELECT s.token,t.result,x.token dispatched FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token LEFT JOIN delivery_request_dispatched x ON x.key=s.key AND x.token=s.token WHERE s.key=?").all(event.key);
    assert.ok(rows.every((row) => row.result !== null), `open after ${fault} boundary ${boundary}`);
    const report = await explainSlackRouting(f.pmRoot, event.identity);
    const info = code === 0 ? JSON.parse(output) as { trace: string[]; terminal: boolean; dispatched: boolean; returned: boolean; confirmed: boolean } : undefined;
    // Independent fault schedule: only a persisted confirmed response proves delivery; dispatch can precede a crash before HTTP.
    const observed = f.calls.slice(callsBefore);
    let expected: string;
    if (fault === "trace" || (info?.confirmed && observed.some((call) => call.confirmed))) expected = "delivered";
    else if (info) expected = observed.length > 0 || info.dispatched ? "uncertain" : "withheld";
    else {
      const past = baseline.slice(0, boundary + 1);
      expected = past.some((step) => step.startsWith("after INSERT OR IGNORE INTO delivery_attempt_terminal")) ? "delivered" : past.some((step) => step.startsWith("after INSERT OR IGNORE INTO delivery_request_dispatched")) ? "uncertain" : "withheld";
    }
    assert.equal(report.outcome, expected, `${fault} boundary ${boundary}`);
    db.close();
    if (report.state === "sending" || report.state === "pending" || report.state === "ambiguous") f.box().resolve(event.key, "skip", { force: true });
    return info?.trace ?? [];
  }
  const trace = await run(-1, "trace"); baseline = trace;
  // status() runs after the send; stop after work cleanup's final COMMIT.
  const end = trace.length - [...trace].reverse().indexOf("after COMMIT");
  assert.ok(end > 20);
  for (const fault of ["exception", "typed", "crash"] as const) for (let boundary = 0; boundary < end; boundary++) {
    await t.test(`${fault} boundary ${boundary + 1}`, async () => { await run(boundary, fault); });
  }
  t.diagnostic(JSON.stringify({ seed: "0xc1a551f1", persistenceAndTransportBoundaries: end, exceptions: end, typedExceptions: end, processCrashes: end }));
});

test("retirement and replacement at every step boundary cannot drift from late-refusal evidence", async (t) => {
  const f = await fixture(t); const owner = f.box(); const peer = new SlackOutbox(f.pmRoot); t.after(() => peer.close());
  const db = (owner as unknown as { db: DatabaseSync }).db;
  (peer as unknown as { db: DatabaseSync }).db.exec("PRAGMA busy_timeout=1");
  /** Inject a peer's forced resolution before/after each durable step of a clean refusal path. */
  async function run(at: number, decision: "retry" | "abandon") {
    const { key, identity } = await f.event(2000 + at);
    const exec = db.exec; const prepare = db.prepare; const trace: string[] = [];
    let armed = true; let replaced = false; let replacement: Promise<unknown> | undefined;
    const point = (step: string) => {
      if (!armed) return;
      trace.push(step);
      if (trace.length - 1 !== at) return;
      try {
        peer.resolve(key, decision, { force: true });
        if (decision === "abandon") peer.resolve(key, "retry");
        replaced = true; replacement = f.send("ack", false, peer);
      } catch (error) { assert.match(String(error), /locked|busy|not_ambiguous|in_flight/); }
    };
    db.exec = function (sql) { point(`before ${sql}`); exec.call(this, sql); point(`after ${sql}`); };
    db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      for (const method of ["get", "all", "run"] as const) {
        const operation = statement[method];
        Object.defineProperty(statement, method, { value: (...args: unknown[]) => { point(`before ${sql}`); const result: unknown = Reflect.apply(operation, statement, args); point(`after ${sql}`); return result; } });
      }
      return statement;
    };
    try { await owner.drain(async (_d, _p, _context) => { throw new OutboxError("destination_changed", "Synthetic late pre-request refusal."); }, 1); }
    finally { armed = false; db.exec = exec; db.prepare = prepare; }
    await replacement;
    const report = await explainSlackRouting(f.pmRoot, identity);
    assert.equal(report.outcome, replaced ? "delivered" : "withheld", `${decision} boundary ${at}`);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=? AND t.token IS NULL").get(key)!.n, 0);
    if (report.state === "refused") peer.resolve(key, "skip");
    return trace;
  }
  const baseline = await run(-1, "retry");
  const end = baseline.length - [...baseline].reverse().indexOf("after COMMIT");
  for (const decision of ["retry", "abandon"] as const) for (let at = 0; at < end; at++) {
    await t.test(`${decision} boundary ${at + 1}`, async () => { await run(at, decision); });
  }
  t.diagnostic(JSON.stringify({ retirementBoundaries: end, forcedRetry: end, forcedAbandon: end }));
});

test("old journals migrate as record pairs and recovery leaves live or inaccessible owners alone", async (t) => {
  const f = await fixture(t); const event = await f.event(0); await f.send("ack");
  const db = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite")); t.after(() => db.close());
  db.prepare("INSERT INTO delivery_attempt VALUES (?,'legacy','acknowledged')").run(event.key);
  db.exec("DROP TABLE delivery_attempt_start; DROP TABLE delivery_request_dispatched; DROP TABLE delivery_attempt_terminal");
  assert.equal((await explainSlackRouting(f.pmRoot, event.identity)).outcome, "delivered");
  f.restart(); assert.equal((await explainSlackRouting(f.pmRoot, event.identity)).outcome, "delivered");
  const pending = await f.event(1);
  db.prepare("INSERT INTO delivery_attempt_start VALUES (?,'live',?)").run(pending.key, process.pid);
  db.prepare("INSERT INTO delivery_request_dispatched VALUES (?,'live')").run(pending.key);
  f.restart(); assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_attempt_terminal WHERE key=?").get(pending.key)!.n, 0);
  const kill = process.kill;
  try {
    process.kill = (() => { throw Object.assign(new Error("Synthetic access refusal"), { code: "EPERM" }); }) as typeof process.kill;
    f.restart(); assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_attempt_terminal WHERE key=?").get(pending.key)!.n, 0);
    process.kill = (() => { throw Object.assign(new Error("Synthetic dead owner"), { code: "ESRCH" }); }) as typeof process.kill;
    f.restart(); assert.equal((await explainSlackRouting(f.pmRoot, pending.identity)).outcome, "uncertain");
  } finally { process.kill = kill; }
  const before = await f.event(2);
  db.prepare("INSERT INTO delivery_attempt_start VALUES (?,'dead-before',0)").run(before.key);
  f.restart(); assert.equal((await explainSlackRouting(f.pmRoot, before.identity)).outcome, "withheld");
  assert.equal(db.prepare("SELECT result FROM delivery_attempt_terminal WHERE key=?").get(before.key)!.result, "not_sent");
});

test("transient terminal and post-commit claim exceptions close the pair before returning an error", async (t) => {
  const f = await fixture(t); const first = await f.event(0);
  const db = (f.box() as unknown as { db: DatabaseSync }).db; const prepare = db.prepare;
  let once = true;
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("INSERT OR IGNORE INTO delivery_attempt_terminal")) {
      const run = statement.run;
      statement.run = function (...args) { if (once) { once = false; throw new Error("Synthetic transient terminal fault"); } return Reflect.apply(run, this, args); };
    }
    return statement;
  };
  try { await f.send("ack"); } finally { db.prepare = prepare; }
  assert.equal((await explainSlackRouting(f.pmRoot, first.identity)).outcome, "delivered");
  const next = await f.event(1); const exec = db.exec; once = true;
  db.exec = function (sql) { exec.call(this, sql); if (sql === "COMMIT" && once) { once = false; throw new Error("Synthetic lost commit result"); } };
  try { await assert.rejects(f.send("ack"), /storage_unavailable/); } finally { db.exec = exec; }
  assert.equal((await explainSlackRouting(f.pmRoot, next.identity)).outcome, "withheld");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE t.token IS NULL").get()!.n, 0);
});

test("successful post followed by typed storage error keeps confirmed delivery", async (t) => {
  const f = await fixture(t); const { key, identity } = await f.event(0);
  await assert.rejects(f.box().drain(async (destination, payload) => {
    await __test__.sendOutbox(destination, payload);
    throw new OutboxError("storage_unavailable", "Synthetic callback failure after confirmation.");
  }), OutboxError);
  const explained = await explainSlackRouting(f.pmRoot, identity);
  assert.equal(explained.outcome, "delivered"); assert.equal(explained.attempts, 1);
  assert.equal(explained.attempt_evidence!.confirmed, 1);
  assert.equal(f.calls[0]!.confirmed, true);
  assert.equal(f.box().status().rows.find((row) => row.key === key)!.state, "acknowledged");
});

test("500 seeded typed and untyped errors at dispatch/response/terminal boundaries follow only retained transport facts", async (t) => {
  const f = await fixture(t); let seed = 0xd15fac7;
  const totals = { delivered: 0, withheld: 0, uncertain: 0 }; const covered = new Set<string>();
  const codes = ["invalid_input", "disabled", "conflict", "not_found", "in_flight", "not_ambiguous", "destination_changed", "storage_unavailable", "history_unavailable"] as const;
  /** Reproducible fault order changes type/code independently of network phase. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 500; sequence++) {
    const { identity, key } = await f.event(3000 + sequence);
    const phase = sequence % 4; const typed = ((sequence >>> 2) % 2) === 0;
    const code = codes[(random() >>> 16) % codes.length]!;
    covered.add(`${phase}/${typed}`);
    const error = typed ? new OutboxError(code, "Synthetic phase fault.") : new Error("Synthetic phase fault.");
    const callsBefore = f.calls.length;
    let confirmedObserved = false;
    const journalDb = (f.box() as unknown as { db: DatabaseSync }).db;
    const prepare = journalDb.prepare;
    let injected = false;
    if (phase === 3) journalDb.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("INSERT OR IGNORE INTO delivery_attempt_terminal")) {
        const run = statement.run;
        statement.run = function (...args) { if (!injected) { injected = true; throw error; } return Reflect.apply(run, this, args); };
      }
      return statement;
    };
    const send = f.box().drain(async (destination, payload, context) => {
      const observedContext = { ...context, responseConfirmed: () => { confirmedObserved = true; context.responseConfirmed(); } };
      if (phase === 0) throw error; // before dispatch
      if (phase === 1) { context.requestDispatched(); throw error; }
      if (phase === 2) { await __test__.sendOutbox(destination, payload, observedContext); throw error; }
      // Fault the first terminal append after the real response; confirmation is already known in memory.
      await __test__.sendOutbox(destination, payload, observedContext);
      throw error;
    });
    try { if (typed && (code !== "destination_changed" || phase !== 0)) await assert.rejects(send, OutboxError); else await send; }
    finally { journalDb.prepare = prepare; }
    if (phase === 3 && confirmedObserved) assert.equal(injected, true);
    const expected = phase === 0 ? "withheld" : confirmedObserved ? "delivered" : "uncertain";
    const observed = f.calls.slice(callsBefore);
    assert.ok(observed.length <= (phase >= 2 ? 1 : 0), `sequence ${sequence}, phase ${phase}`);
    if (confirmedObserved) assert.equal(observed[0]!.confirmed, true);
    assert.equal((await explainSlackRouting(f.pmRoot, identity)).outcome, expected, `${sequence}: phase ${phase}, ${typed ? code : "untyped"}`);
    totals[expected] += 1;
    const journal = new DatabaseSync(join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
    try {
      assert.equal(journal.prepare("SELECT COUNT(*) n FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=? AND t.token IS NULL").get(key)!.n, 0);
      if (expected === "withheld") assert.equal(journal.prepare("SELECT COUNT(*) n FROM delivery_request_dispatched WHERE key=?").get(key)!.n, 0);
    } finally { journal.close(); }
    const state = (await explainSlackRouting(f.pmRoot, identity)).state;
    if (state !== "acknowledged") f.box().resolve(key, "skip");
    assert.deepEqual(f.box().status(1).outcomes, totals);
  }
  assert.equal(covered.size, 8);
  t.diagnostic(JSON.stringify({ seed: "0x0d15fac7", sequences: 500, boundaries: 4, errorKinds: 2, errorCodes: codes.length, requests: f.calls.length, ...totals }));
});
