/** Destination authorization and ambiguity holds must agree at the writer-fenced claim boundary. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { init } from "@unbrained/pm-cli/sdk";
import http from "node:http";
import { decode } from "@toon-format/toon";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { SlackOutbox, migrateSlackDestinations, slackDestination } from "../index.ts";
import type { OutboxReport, CoalescingReport } from "../index.ts";
import { parseDestinationMigrationInput, runDestinationMigration } from "../destination-migration.ts";
import { assertMigrationDestinationHold } from "./helpers/destination-hold-scenario.ts";

/** Use a real non-git SDK tracker with git discovery and the git executable unavailable. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-destination-claim-"));
  const pmRoot = join(directory, ".agents", "pm");
  const savedPath = process.env.PATH; const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = directory; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    rmSync(directory, { recursive: true, force: true });
  });
  await init("destination-claim", { defaults: true, agentGuidance: "skip" }, { cwd: directory, pmRoot, noExtensions: true });
  const box = new SlackOutbox(pmRoot); box.enable({ events: ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"], minPriority: 4 }); t.after(() => box.close());
  const db = (box as unknown as { db: DatabaseSync }).db;
  return { box, db, pmRoot };
}

for (const command of ["slack outbox", "slack coalesce"]) {
  test(`${command}: real HTTP ambiguity plus migration agrees in SDK, JSON and TOON`, async (t) => {
    const { box, pmRoot } = await fixture(t);
    const saved = ["PM_SLACK_WEBHOOK", "PM_SLACK_ROUTES", "PM_SLACK_CHANNEL", "PM_SLACK_MIN_PRIORITY"].map((key) => [key, process.env[key]] as const);
    t.after(() => saved.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
    const failures: unknown[] = []; const paths: string[] = [];
    const server = http.createServer((request) => {
      request.resume(); request.on("end", () => {
        paths.push(request.url!);
        try {
          if (paths.length === 1) {
            const preview = migrateSlackDestinations(pmRoot, { action: "preview", from: "source", to: "target" });
            assert.equal(migrateSlackDestinations(pmRoot, { action: "apply", from: "source", to: "target", bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! }).counts.moved, 1);
          }
        } catch (error) { failures.push(error); }
        request.socket.destroy();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PM_SLACK_WEBHOOK = `${base}/target`; process.env.PM_SLACK_MIN_PRIORITY = "4";
    process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", webhook: `${base}/source` }]); delete process.env.PM_SLACK_CHANNEL;
    const source = slackDestination(`${base}/source`); const target = slackDestination(`${base}/target`);
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "source", destination: source, channel: null, bindingRevision: 0 });
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "target", destination: target, channel: null, bindingRevision: 1 });
    for (const [revision, destination, at] of [["first", target, 0], ["moving", source, 120000], ["stable", target, 60000]] as const) {
      box.enqueue({ item: "http-hold", event: "close", revision, destination, payload: { text: "Synthetic HTTP notification" }, at, priority: 1 });
    }
    const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
    t.after(() => harness.deactivate());
    const result = (await harness.runCommand({ command, pmRoot, options: { action: "drain", limit: "100" }, global: { json: true } })).result as OutboxReport | CoalescingReport;
    assert.deepEqual(failures, []); assert.deepEqual(paths, ["/target"]);
    assert.deepEqual(result.outcomes, { delivered: 0, uncertain: 1, withheld: 2 });
    if ("counts" in result) { assert.equal(result.counts.ambiguous, 1); assert.equal(result.counts.pending, 2); }
    else { assert.equal(result.rows.filter((row) => row.state === "ambiguous").length, 1); assert.equal(result.rows.filter((row) => row.state === "pending").length, 2); }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.deepEqual(decode((await harness.runRendererOverride({ command, format: "toon", result })).rendered!), result);
    assert.equal(box.status(100).rows.reduce((total, row) => total + row.attempts, 0), 1);
  });
}

for (const kind of ["plain", "coalesced-urgent", "coalesced-routine"] as const) {
  test(`${kind}: migration into an in-flight target cannot bypass that target's ambiguity hold`, async (t) => {
    const { box, pmRoot } = await fixture(t);
    await assertMigrationDestinationHold(box, (input) => migrateSlackDestinations(pmRoot, input), {
      namespace: kind, source: slackDestination("http://127.0.0.1:1/source"), target: slackDestination("http://127.0.0.1:1/target"),
      coalesced: kind !== "plain", routine: kind === "coalesced-routine",
    });
  });
}

/** Observe actual statement completion without mocking storage or any SDK operation. */
function boundaries(db: DatabaseSync, checkpoint: (sql: string) => void): () => void {
  const exec = db.exec; const prepare = db.prepare;
  db.exec = function (sql) { exec.call(this, sql); checkpoint(sql); };
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ["run", "get", "all"] as const) {
      const original = statement[method];
      Object.defineProperty(statement, method, { value: (...args: SQLInputValue[]) => {
        const result: unknown = Reflect.apply(original, statement, args); checkpoint(sql); return result;
      } });
    }
    return statement;
  };
  return () => { db.exec = exec; db.prepare = prepare; };
}

for (const coalesced of [false, true]) {
  test(`${coalesced ? "coalesced" : "plain"}: a destination changed after candidate discovery is deferred without claiming it`, async (t) => {
    const { box, db, pmRoot } = await fixture(t);
    const source = slackDestination("http://127.0.0.1:1/source"); const target = slackDestination("http://127.0.0.1:1/target");
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "source", destination: source, channel: null, bindingRevision: 0 });
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "target", destination: target, channel: null, bindingRevision: 1 });
    box.enqueue({ item: "changed-after-discovery", event: "close", revision: "r1", destination: source, payload: { text: "Synthetic pending event" }, at: 0, priority: 1 });
    const preview = migrateSlackDestinations(pmRoot, { action: "preview", from: "source", to: "target" });
    let changed = false; let sends = 0;
    const restore = boundaries(db, (sql) => {
      const candidateRead = coalesced ? sql.includes("FROM delivery d LEFT JOIN delivery_context") : sql.startsWith("SELECT key,destination FROM delivery");
      if (changed || !candidateRead) return;
      changed = true;
      assert.equal(migrateSlackDestinations(pmRoot, { action: "apply", from: "source", to: "target", bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! }).counts.moved, 1);
    });
    try {
      if (coalesced) await box.drainCoalesced(async () => { sends++; return "acknowledged"; });
      else await box.drain(async () => { sends++; return "acknowledged"; });
    } finally { restore(); }
    assert.ok(changed); assert.equal(sends, 0);
    assert.equal(box.status().rows[0]!.state, "pending"); assert.equal(box.status().rows[0]!.attempts, 0);
    await box.drain(async (destination) => { sends++; assert.equal(destination, target); return "acknowledged"; });
    assert.equal(sends, 1, "the next drain discovers and authorizes the reviewed current destination");
  });
}

for (const coalesced of [false, true]) {
  test(`${coalesced ? "coalesced" : "plain"}: a competing migration at EVERY drain statement cannot bypass a destination hold`, async (t) => {
    /** One real SQLite interleaving; writer contention is an expected refusal, never a simulated transition. */
    const race = async (context: TestContext, boundary = -1) => {
      const { box, db, pmRoot } = await fixture(context);
      const source = slackDestination("http://127.0.0.1:1/source"); const target = slackDestination("http://127.0.0.1:1/target");
      migrateSlackDestinations(pmRoot, { action: "bind", alias: "source", destination: source, channel: null, bindingRevision: 0 });
      migrateSlackDestinations(pmRoot, { action: "bind", alias: "target", destination: target, channel: null, bindingRevision: 1 });
      const first = box.enqueue({ item: "boundary-hold", event: "close", revision: "first", destination: target, payload: { text: "Synthetic first" }, at: 0, priority: 1 });
      const moving = box.enqueue({ item: "boundary-hold", event: "close", revision: "moving", destination: source, payload: { text: "Synthetic moving" }, at: 120000, priority: 1 });
      box.enqueue({ item: "boundary-hold", event: "close", revision: "stable", destination: target, payload: { text: "Synthetic stable" }, at: 60000, priority: 1 });
      const peer = new SlackOutbox(pmRoot); context.after(() => peer.close());
      const peerDb = (peer as unknown as { db: DatabaseSync }).db;
      const peerExec = peerDb.exec;
      peerDb.exec = function (sql) { peerExec.call(this, sql.replace("busy_timeout=5000", "busy_timeout=1")); };
      let count = 0; let moved = 0; const destinations: string[] = [];
      const restore = boundaries(db, () => {
        if (count++ !== boundary) return;
        try {
          const preview = runDestinationMigration(peerDb, parseDestinationMigrationInput({ action: "preview", from: "source", to: "target" }));
          moved = runDestinationMigration(peerDb, parseDestinationMigrationInput({ action: "apply", from: "source", to: "target", bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! })).counts.moved;
        } catch (error) { assert.match(String(error), /locked|busy/); }
      });
      /** Mark actual dispatch and return uncertainty so each current destination permits at most one send. */
      const send: Parameters<SlackOutbox["drain"]>[0] = async (destination, _payload, context) => {
        destinations.push(destination); context.requestDispatched(); return "ambiguous";
      };
      try {
        if (coalesced) await box.drainCoalesced(send, { now: 180000, budget: 100 }); else await box.drain(send, 100);
      } finally { restore(); }
      assert.equal(destinations[0], target);
      assert.equal(destinations.filter((destination) => destination === target).length, 1);
      assert.equal(new Set(destinations).size, destinations.length, "uncertainty holds follow the actual claimed destination across every interleaving");
      const rows = new Map(box.status(100).rows.map((row) => [row.key, row]));
      assert.equal(rows.get(first)!.state, "ambiguous");
      if (moved) { assert.equal(rows.get(moving)!.state, "pending"); assert.equal(rows.get(moving)!.attempts, 0); }
      if (boundary >= 0) assert.ok(count > boundary);
      return count;
    };
    let count = 0;
    await t.test("discover executed steps", async (context) => { count = await race(context); });
    for (let boundary = 0; boundary < count; boundary++) await t.test(`competing migration at step ${boundary}`, async (context) => { await race(context, boundary); });
  });
}
