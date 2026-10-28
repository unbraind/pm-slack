/** Real non-git outbox tests: reviewed bindings, model-based replay, read-only previews and SQL-boundary races. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { decode } from "@toon-format/toon";
import { init, create, listAllComplete, readHistorySnapshot, update, focus } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { migrateSlackDestinations, SlackOutbox, slackDestination, OutboxError, captureSlackOutbox } from "../index.ts";
import type { DestinationMigrationInput, DestinationMigrationReport, OutboxIntent, OutboxState } from "../index.ts";
import { parseDestinationMigrationInput, destinationMigrationToon, runDestinationMigration } from "../destination-migration.ts";

const oldRoute = slackDestination("http://127.0.0.1:1/old", "#old");
const newRoute = slackDestination("http://127.0.0.1:1/new");

/** Initialize one real tracker with git absent from PATH. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-migration-"));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { cwd: directory, pmRoot, noExtensions: true };
  const keys = ["PATH", "GIT_CEILING_DIRECTORIES", "PM_SLACK_WEBHOOK", "PM_SLACK_CHANNEL", "PM_SLACK_ROUTES", "PM_SLACK_MIN_PRIORITY", "PM_SLACK_EVENTS"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); rmSync(directory, { recursive: true, force: true }); });
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  process.env.PATH = directory;
  keys.slice(2).forEach((key) => { delete process.env[key]; });
  await init("migration", { defaults: true, agentGuidance: "skip" }, client);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  box.enable({ events: ["create", "close", "block", "open", "start", "cancel", "unblock", "reopen"], minPriority: 4 });
  const db = (box as unknown as { db: DatabaseSync }).db;
  /** Run the public migration SDK against this fixture. */
  const run = (input: DestinationMigrationInput) => migrateSlackDestinations(pmRoot, input);
  /** Bind explicit aliases with the current reviewed generation. */
  const bind = (alias: string, destination: string, channel: string | null = null) => run({ action: "bind", alias, destination, channel, bindingRevision: run({ action: "bindings" }).binding_revision });
  return { directory, pmRoot, client, box, db, run, bind };
}

/** Complete prior-release intent, including all native delivery fields and multiline content. */
function intent(revision = "r1", destination = oldRoute): OutboxIntent {
  return { item: "migration-task", event: "close", revision, destination, at: 1000, priority: 1,
    payload: { text: `  event ${revision}\r\nline\n café  `, channel: "#old", mrkdwn: true, blocks: [{ type: "section", text: { type: "mrkdwn", text: "  exact\r\nbody  " } }] } };
}

/** Check typed refusal and its actionable remedy. */
function refusal(code: string) {
  return (error: unknown) => error instanceof OutboxError && error.code === code && error.remedy.length > 0;
}

/** Produce the exact guarded apply request from a public preview. */
function applyInput(preview: DestinationMigrationReport): DestinationMigrationInput {
  return { action: "apply", from: preview.from!, to: preview.to!, bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! };
}

/** Compare the package's two output producers using a real TOON parser, including every emitted number. */
function roundtrip(result: DestinationMigrationReport) {
  assert.deepEqual(decode(destinationMigrationToon(result)), JSON.parse(JSON.stringify(result)));
  /** Recurse through dense arrays and finite counters without normalizing any package state. */
  const visit = (value: unknown): void => {
    if (typeof value === "number") assert.ok(Number.isSafeInteger(value) && value >= 0);
    if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  visit(result);
}

test("a reviewed atomic move keeps one receipt, clears the old channel, preserves original replays and previews write nothing", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.run({ action: "bindings" }).bindings, []);
  f.bind("old", oldRoute, "#old"); f.bind("new", newRoute);
  const original = intent();
  const key = f.box.enqueue(original);
  const file = join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
  const before = readFileSync(file);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  roundtrip(preview);
  assert.equal(preview.counts.movable, 1);
  assert.deepEqual(readFileSync(file), before, "preview opens read-only and does not initialize, chmod, recover, or journal");
  const applied = f.run(applyInput(preview));
  assert.equal(applied.counts.moved, 1);
  assert.equal(f.box.enqueue(original), key);
  assert.equal(f.run(applyInput(preview)).status, "already_applied");
  assert.equal(f.run(applyInput(preview)).counts.moved, 0);
  assert.throws(() => f.box.enqueue({ ...original, payload: { text: "different" } }), refusal("conflict"));
  let sends = 0;
  await f.box.drain(async (destination, payload) => {
    sends += 1;
    assert.equal(destination, newRoute);
    const { channel: _channel, ...expected } = original.payload;
    assert.deepEqual(payload, expected);
    return "acknowledged";
  });
  assert.equal(sends, 1);
  assert.equal(f.box.status().rows[0]!.key, key);
  assert.equal(f.run(applyInput(preview)).status, "superseded", "read current targets on retry, rather than saved input");
  assert.equal(f.box.status().outcomes.delivered, 1);
});

test("uncertainty survives reconciliation, migration, recovery and all terminal scheduling labels", async (t) => {
  const f = await fixture(t);
  f.bind("old", oldRoute, "#old"); f.bind("new", newRoute);
  const uncertain = f.box.enqueue(intent("uncertain"));
  await f.box.drain(async () => "ambiguous");
  f.box.resolve(uncertain, "retry");
  f.box.enqueue(intent("pending"));
  const rejected = f.box.enqueue(intent("rejected"));
  // Real transitions make the attempted event rejected while leaving another pending.
  f.box.resolve(f.box.status().rows.find((row) => row.key !== uncertain && row.key !== rejected)!.key, "skip");
  f.box.resolve(uncertain, "skip");
  await f.box.drain(async () => "rejected");
  f.box.enqueue(intent("last"));
  const preview = f.run({ action: "preview", from: "old", to: "new", limit: 1, after: 1 });
  assert.equal(preview.counts.uncertain, 1);
  assert.equal(preview.counts.held, 2);
  assert.equal(preview.counts.movable, 1);
  assert.equal(preview.next_cursor, 2);
  assert.equal(preview.omitted, 3);
  roundtrip(preview);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  assert.equal(f.box.status().outcomes.uncertain, 1);
  assert.equal(f.box.status().counts.skipped, 2);
  f.box.resolve(uncertain, "retry");
  const again = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(again.counts.movable, 0);
  assert.equal(again.counts.uncertain, 1);
});

test("binding/queue generations fence stale plans, ABA edits, peer success and reverse migrations", async (t) => {
  const f = await fixture(t);
  f.bind("old", oldRoute); f.bind("new", newRoute, "#new");
  f.box.enqueue(intent());
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(f.run({ action: "bind", alias: "new", destination: newRoute, channel: "#new", bindingRevision: 0 }).status, "unchanged");
  assert.throws(() => f.run({ action: "bind", alias: "third", destination: oldRoute, channel: null, bindingRevision: 0 }), refusal("binding_changed"));
  f.db.exec("UPDATE delivery SET owner=owner+1; UPDATE delivery SET owner=owner-1");
  assert.throws(() => f.run(applyInput(preview)), refusal("plan_changed"));
  const current = f.run({ action: "preview", from: "old", to: "new" });
  f.bind("new", slackDestination("http://127.0.0.1:1/changed"));
  f.bind("new", newRoute, "#new");
  assert.throws(() => f.run(applyInput(current)), refusal("binding_changed"));
  const final = f.run({ action: "preview", from: "old", to: "new" });
  f.run(applyInput(final));
  const reverse = f.run({ action: "preview", from: "new", to: "old" });
  f.run(applyInput(reverse));
  assert.equal(f.run(applyInput(final)).status, "superseded");
  assert.equal(f.box.enqueue(intent()), f.box.status().rows[0]!.key);
  await f.box.drain(async (destination, payload) => { assert.equal(destination, oldRoute); assert.equal(payload.channel, undefined); return "acknowledged"; });
});

test("closed strict schema refuses extreme, sparse and unexpected input before any side effect", async (t) => {
  const f = await fixture(t);
  const valid = { action: "bind", alias: "old", destination: oldRoute, channel: null, bindingRevision: 0 } as const;
  const bad: unknown[] = [null, undefined, [], new Array(5), Object.create(null), 1, "preview", {}, { action: "constructor" }, { action: "__proto__" }, { action: "bindings", extra: true },
    { ...valid, alias: "" }, { ...valid, alias: "UPPER" }, { ...valid, alias: "a".repeat(65) }, { ...valid, destination: "credential" }, { ...valid, channel: "" }, { ...valid, channel: "x".repeat(257) }, { ...valid, channel: "line\r\nbreak" }, { ...valid, channel: 4 }, { ...valid, bindingRevision: "0" },
    ...[NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1].map((bindingRevision) => ({ ...valid, bindingRevision })),
    { action: "preview", from: "old", to: "old" }, { action: "preview", from: "old", to: "new", extra: true }, { action: "preview", from: [], to: "new" }, { action: "preview", from: "old", to: " " },
    ...[NaN, Infinity, -Infinity, 0, 101, 0.1, "20", null].map((limit) => ({ action: "preview", from: "old", to: "new", limit })),
    ...[NaN, Infinity, -Infinity, -1, 10001, 0.1, "0", null].map((after) => ({ action: "preview", from: "old", to: "new", after })),
    { action: "apply", from: "old", to: "new", bindingRevision: 1, planRevision: "x" }, { action: "apply", from: "old", to: "new", planRevision: "a".repeat(64) },
  ];
  const file = join(f.pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
  const before = readFileSync(file);
  for (const input of bad) assert.throws(() => migrateSlackDestinations(f.pmRoot, input as DestinationMigrationInput), refusal("invalid_input"));
  assert.deepEqual(readFileSync(file), before);
  for (const input of [{ action: "bindings" }, valid, { ...valid, alias: "constructor" }, { ...valid, alias: "a_1-2", channel: "#channel" }, { action: "preview", from: "old", to: "new", limit: 100, after: 10000 }, { action: "apply", from: "old", to: "new", bindingRevision: Number.MAX_SAFE_INTEGER, planRevision: "f".repeat(64) }] as const) assert.ok(parseDestinationMigrationInput(input));
});

test("foreign rows are isolated, legacy receipts stay readable, and unsafe counters never return ok", async (t) => {
  const f = await fixture(t);
  f.bind("old", oldRoute); f.bind("new", newRoute);
  const owned = f.box.enqueue(intent());
  f.db.prepare("INSERT INTO delivery(key,item,event,revision,destination,payload) VALUES (?,?,?,?,?,?)").run("foreign", "unknown", "unknown", "unknown", oldRoute, "{}");
  const foreign = f.box.enqueue(intent("foreign"));
  f.db.prepare("DELETE FROM delivery_context WHERE key=?").run(foreign);
  const corrupt = f.box.enqueue(intent("corrupt"));
  f.db.prepare("UPDATE delivery SET payload='not-json' WHERE key=?").run(corrupt);
  const array = f.box.enqueue(intent("array"));
  f.db.prepare("UPDATE delivery SET payload='[]' WHERE key=?").run(array);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.foreign, 4);
  assert.equal(preview.counts.movable, 1);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  f.db.prepare("DELETE FROM delivery WHERE key=?").run(owned);
  assert.equal(f.run(applyInput(preview)).rows[0]!.decision, "superseded");
  const journal = f.db.prepare("SELECT manifest FROM destination_commit").get()!;
  f.db.prepare("UPDATE destination_commit SET manifest=?").run(JSON.stringify([null, ...JSON.parse(String(journal.manifest)) as unknown[]]));
  assert.equal(f.run(applyInput(preview)).counts.foreign, 1);
  f.db.exec("UPDATE destination_epoch SET generation=9007199254740992");
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("storage_unavailable"));
  assert.equal(f.box.status().counts.pending, 3, "legacy inspection remains available");
});

test("missing storage, disabled trackers and unsupported bindings return typed remedies without creating runtime state", async (t) => {
  const f = await fixture(t);
  assert.throws(() => migrateSlackDestinations(join(f.directory, "missing"), { action: "bindings" }), refusal("disabled"));
  assert.equal(existsSync(join(f.directory, "missing")), false);
  const corrupt = join(f.directory, "corrupt");
  mkdirSync(join(corrupt, "runtime", "slack-outbox"), { recursive: true });
  writeFileSync(join(corrupt, "runtime", "slack-outbox", "delivery.sqlite"), "foreign-storage");
  assert.throws(() => migrateSlackDestinations(corrupt, { action: "bindings" }), refusal("storage_unavailable"));
  const directoryStorage = join(f.directory, "directory-storage");
  mkdirSync(join(directoryStorage, "runtime", "slack-outbox", "delivery.sqlite"), { recursive: true });
  assert.throws(() => migrateSlackDestinations(directoryStorage, { action: "bindings" }), refusal("storage_unavailable"));
  f.db.exec("DELETE FROM settings");
  assert.throws(() => f.run({ action: "bindings" }), refusal("disabled"));
  f.box.enable();
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("not_found"));
  f.bind("old", oldRoute); f.bind("new", oldRoute);
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("invalid_input"));
});

test("CLI and TOON expose the same guarded path offline, with typed refusals and no empty guard coercion", async (t) => {
  const f = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => harness.deactivate());
  /** Invoke the real registered command. */
  const command = async (options: Record<string, unknown>) => (await harness.runCommand({ command: "slack migrate", pmRoot: f.pmRoot, options, global: { json: true } })).result as DestinationMigrationReport & { code?: string };
  assert.equal((await command({ action: "bindings" })).binding_revision, 0);
  assert.equal((await command({ action: "bind", alias: "old", route: "default", bindingRevision: "0" })).code, "invalid_input");
  process.env.PM_SLACK_WEBHOOK = "http://127.0.0.1:1/old";
  process.env.PM_SLACK_CHANNEL = "#old";
  assert.equal((await command({ action: "bind", alias: "old", route: "default", bindingRevision: "0" })).status, "bound");
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", webhook: "http://127.0.0.1:1/new", channel: "#new" }]);
  assert.equal((await command({ action: "bind", alias: "new", route: "close", bindingRevision: "1" })).status, "bound");
  f.box.enqueue(intent());
  const preview = await command({ from: "old", to: "new" });
  assert.equal(preview.status, "preview");
  const rendered = await harness.runRendererOverride({ command: "slack migrate", format: "toon", result: preview });
  assert.deepEqual(decode(rendered.rendered!), preview);
  for (const result of [null, {}, { ok: false }]) assert.equal((await harness.runRendererOverride({ command: "slack migrate", format: "toon", result })).overridden, false);
  assert.equal((await command({ action: "apply", from: "old", to: "new", bindingRevision: "2", planRevision: preview.plan_revision })).counts.moved, 1);
  for (const options of [{ action: "bad" }, { action: "apply", from: "old", to: "new", bindingRevision: " " }, { from: "old", to: "new", limit: "1.5" }, { from: "old", to: "new", limit: " " }, { action: "bind", alias: "third", route: "missing", bindingRevision: "2" }, { action: "bind", alias: "third", bindingRevision: "2" }]) assert.equal((await command(options)).code, "invalid_input");
  delete process.env.PM_SLACK_CHANNEL;
  process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "open", channel: "#fallback" }]);
  assert.equal((await command({ action: "bind", alias: "fallback", route: "open", bindingRevision: "2" })).status, "bound");
  assert.equal((await command({ action: "bind", alias: "plain", route: "default", bindingRevision: "3" })).status, "bound");
  process.env.PM_SLACK_WEBHOOK = "ftp://invalid.example/webhook";
  assert.equal((await command({ action: "bind", alias: "invalid", route: "default", bindingRevision: "4" })).code, "invalid_input");
});

test("500 seeded operation sequences preserve the SDK-read model across old replays, CRLF, relationships, focus and route revisions", async (t) => {
  const f = await fixture(t);
  let seed = 0x516acc28;
  /** Fixed-seed random generator keeps failures reproducible. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const nativeIds: string[] = [];
  for (let i = 0; i < 8; i++) {
    const item = await create({ title: `  Native ${i}\r\nline  `, description: ` whitespace ${i} \n`, body: `  body\r\n${i}\n`, priority: i % 5,
      tags: `native-${i},shared`, parent: i ? nativeIds[0] : "none", goal: "none", objective: "none", sprint: "none", release: "none",
      assignee: "fixture-agent", estimatedMinutes: String(i * 11), comment: [`text=Native comment ${i}`], note: [`text=Native note ${i}`],
      file: [`path=src/native-${i}.ts`], doc: [`path=docs/native-${i}.md`], test: [`command=node native-${i}.ts`] }, f.client);
    nativeIds.push(item.item.id);
  }
  const native = (await listAllComplete({}, f.client)).items;
  f.bind("old", oldRoute, "#old"); f.bind("new", newRoute);
  const actions = new Set<number>();
  for (let sequence = 0; sequence < 500; sequence++) {
    // Only disposable fixture setup uses SQL; every generated operation and every state comparison uses the package/host SDK.
    f.db.exec("DELETE FROM delivery; DELETE FROM delivery_context; DELETE FROM delivery_proof; DELETE FROM delivery_attempt_start; DELETE FROM delivery_request_dispatched; DELETE FROM delivery_attempt_terminal; DELETE FROM delivery_group; DELETE FROM delivery_resolution; DELETE FROM destination_commit; DELETE FROM destination_original; DELETE FROM coalescing_receipt");
    f.bind("old", oldRoute, "#old"); f.bind("new", newRoute);
    let bindingRevision = f.run({ action: "bindings" }).binding_revision;
    let version = 0;
    const routes = new Map([["old", { destination: oldRoute, channel: "#old" as string | null }], ["new", { destination: newRoute, channel: null as string | null }]]);
    type Model = { original: OutboxIntent; destination: string; payload: OutboxIntent["payload"]; state: OutboxState; uncertain: boolean; touched: number };
    const model = new Map<string, Model>();
    for (let i = 0; i < 4; i++) {
      const original = intent(`s${sequence}-r${i}`);
      original.item = nativeIds[random() % nativeIds.length]!;
      original.event = (["create", "close", "block", "cancel", "start", "reopen", "open", "unblock"] as const)[random() % 8]!;
      original.at = random();
      original.payload.mrkdwn = Boolean(random() % 2);
      if (random() % 2) original.payload.text += " \r\n \t";
      const key = f.box.enqueue(original);
      model.set(key, { original, destination: original.destination, payload: structuredClone(original.payload), state: "pending", uncertain: false, touched: 0 });
    }
    const saved: { report: DestinationMigrationReport; version: number; binding: number }[] = [];
    const committed = new Map<string, Map<string, number>>();
    for (let step = 0; step < 8; step++) {
      const action = (random() >>> 8) % 7; actions.add(action);
      if (action === 0) {
        const [key, row] = [...model][random() % model.size]!;
        assert.equal(f.box.enqueue(row.original), key, "old inputs cannot create a second queue entry or restore an old route");
      } else if (action === 1 || !saved.length) {
        const from = random() % 2 ? "old" : "new"; const to = from === "old" ? "new" : "old";
        const preview = f.run({ action: "preview", from, to, limit: 1 + random() % 4, after: random() % 5 });
        const matching = [...model.values()].filter((row) => row.destination === routes.get(from)!.destination);
        assert.equal(preview.counts.movable, matching.filter((row) => row.state === "pending" && !row.uncertain).length);
        assert.equal(preview.counts.uncertain, matching.filter((row) => row.uncertain).length);
        assert.equal(preview.counts.matched, matching.length);
        roundtrip(preview);
        saved.push({ report: preview, version, binding: bindingRevision });
      } else if (action === 2) {
        const previous = saved[random() % saved.length]!;
        if (previous.binding !== bindingRevision) assert.throws(() => f.run(applyInput(previous.report)), refusal("binding_changed"));
        else if (committed.has(previous.report.plan_revision!)) {
          const targets = committed.get(previous.report.plan_revision!)!;
          const superseded = [...targets].some(([key, touched]) => model.get(key)!.touched !== touched);
          const replayed = f.run(applyInput(previous.report));
          assert.equal(replayed.status, superseded ? "superseded" : "already_applied");
          assert.equal(replayed.counts.moved, 0); roundtrip(replayed);
        } else if (previous.version !== version) assert.throws(() => f.run(applyInput(previous.report)), refusal("plan_changed"));
        else {
          const source = routes.get(previous.report.from!)!; const target = routes.get(previous.report.to!)!;
          const movable = [...model].filter(([, row]) => row.destination === source.destination && row.state === "pending" && !row.uncertain);
          const result = f.run(applyInput(previous.report));
          assert.equal(result.counts.moved, movable.length); roundtrip(result);
          const expected = new Map<string, number>();
          for (const [key, row] of movable) {
            row.destination = target.destination;
            delete row.payload.channel;
            if (target.channel !== null) row.payload.channel = target.channel;
            row.touched++; version++; expected.set(key, row.touched);
          }
          committed.set(previous.report.plan_revision!, expected);
        }
      } else if (action === 3) {
        const channel = random() % 2 ? "#new" : null;
        const destination = slackDestination("http://127.0.0.1:1/new", channel ?? undefined);
        const old = routes.get("new")!;
        if (old.destination !== destination) { bindingRevision++; version++; }
        routes.set("new", { destination, channel });
        assert.equal(f.bind("new", destination, channel).binding_revision, bindingRevision);
      } else if (action === 4) {
        const [key, row] = [...model][random() % model.size]!;
        if (row.state === "pending") { f.box.resolve(key, "skip"); row.state = "skipped"; row.touched++; version++; }
        else if (["ambiguous", "rejected", "skipped"].includes(row.state)) { f.box.resolve(key, "retry"); row.state = "pending"; row.touched++; version++; }
      } else if (action === 5) {
        const outcome = (["retry", "ambiguous", "acknowledged", "rejected"] as const)[random() % 4]!;
        await f.box.drain(async (destination, payload) => {
          const row = [...model.values()].find((entry) => entry.payload.text === payload.text)!;
          assert.ok(row); assert.equal(row.state, "pending"); assert.equal(destination, row.destination); assert.deepEqual(payload, row.payload);
          row.state = outcome === "retry" ? "pending" : outcome;
          if (outcome === "ambiguous") row.uncertain = true;
          row.touched++; version++;
          return outcome;
        });
      } else {
        const peer = new SlackOutbox(f.pmRoot);
        try { assert.deepEqual(peer.status(), f.box.status()); } finally { peer.close(); }
      }
      const observed = f.box.status(100);
      assert.equal(observed.rows.length, model.size);
      assert.equal(new Set(observed.rows.map((row) => row.key)).size, model.size);
      for (const row of observed.rows) assert.equal(row.state, model.get(row.key)!.state);
    }
    // Every sequence also compares a fresh preview with exactly what apply actually writes.
    const final = f.run({ action: "preview", from: "old", to: "new" });
    const expected = [...model.values()].filter((row) => row.destination === oldRoute && row.state === "pending" && !row.uncertain).length;
    assert.equal(final.counts.movable, expected);
    const beforeApply = f.box.status(100);
    assert.equal(f.run(applyInput(final)).counts.moved, expected);
    assert.deepEqual(f.box.status(100), beforeApply);
    // Random ambient session focus cannot alter tracker relationships during route-only operations.
    if (sequence % 25 === 0) await focus(nativeIds[random() % nativeIds.length], {}, f.client);
    assert.deepEqual((await listAllComplete({}, f.client)).items, native);
  }
  assert.equal(actions.size, 7);
});

/** Observe actual SQLite operations, injecting only after the real statement completes. */
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

test("apply, preview and replay race a competing drainer at EVERY SQLite step boundary on one non-git tracker", async (t) => {
  for (const action of ["apply", "preview", "replay"] as const) {
    /** Run one real interleaving and return the observed statement count. */
    const race = async (context: TestContext, boundary = -1) => {
      const f = await fixture(context);
      f.bind("old", oldRoute, "#old"); f.bind("new", newRoute);
      for (const revision of ["a", "b"]) f.box.enqueue(intent(revision));
      const preview = f.run({ action: "preview", from: "old", to: "new" });
      if (action === "replay") f.run(applyInput(preview));
      const peer = new SlackOutbox(f.pmRoot); context.after(() => peer.close());
      (peer as unknown as { db: DatabaseSync }).db.exec("PRAGMA busy_timeout=1");
      let count = 0; let drain: Promise<unknown> | undefined; let releases: (() => void)[] = []; let held = false; const sent: string[] = [];
      /** Hold actual claims across the primary transaction's next boundaries. */
      const send = async (destination: string) => {
        sent.push(destination);
        if (!held) { held = true; await new Promise<void>((done) => releases.push(done)); }
        return "acknowledged" as const;
      };
      const restore = boundaries(f.db, () => {
        if (count++ === boundary) drain = peer.drain(send).catch((error: unknown) => { assert.match(String(error), /locked|busy|storage_unavailable/); });
      });
      try {
        const input = action === "preview" ? { action: "preview" as const, from: "old", to: "new" } : applyInput(preview);
        try { roundtrip(runDestinationMigration(f.db, parseDestinationMigrationInput(input))); }
        catch (error) { assert.ok(error instanceof OutboxError && error.code === "plan_changed"); }
      } finally { restore(); }
      // Complete held sends one at a time, including the next member in the same drain.
      while (releases.length) { const pending = releases; releases = []; pending.forEach((done) => done()); await Promise.resolve(); await Promise.resolve(); }
      await drain;
      await peer.drain(async (destination) => { sent.push(destination); return "acknowledged"; });
      assert.equal(sent.length, 2, "each original gets exactly one claim across the competing operations");
      assert.equal(new Set(sent).size, 1, "the atomic route transition cannot split its movable set across old and new destinations");
      assert.equal(f.box.status().counts.acknowledged, 2);
      if (boundary >= 0) assert.ok(count > boundary);
      return count;
    };
    let count = 0;
    await t.test(`${action}: discover executed steps`, async (context) => { count = await race(context); });
    for (let boundary = 0; boundary < count; boundary++) await t.test(`${action}: competing drain at step ${boundary}`, async (context) => { await race(context, boundary); });
  }
});

test("binding races a peer's identical binding at EVERY SQLite step and reports the peer's success truthfully", async (t) => {
  /** One binding interleaving; both database handles execute real transactions. */
  const race = async (context: TestContext, boundary = -1) => {
    const f = await fixture(context); f.bind("old", oldRoute);
    const peer = new SlackOutbox(f.pmRoot); context.after(() => peer.close());
    const peerDb = (peer as unknown as { db: DatabaseSync }).db;
    const originalExec = peerDb.exec;
    peerDb.exec = function (sql) { originalExec.call(this, sql.replace("busy_timeout=5000", "busy_timeout=1")); };
    const input = parseDestinationMigrationInput({ action: "bind", alias: "new", destination: newRoute, channel: null, bindingRevision: 1 });
    let count = 0;
    const restore = boundaries(f.db, () => {
      if (count++ !== boundary) return;
      try { const result = runDestinationMigration(peerDb, input); assert.ok(["bound", "unchanged"].includes(result.status)); }
      catch (error) { assert.match(String(error), /locked|busy/); }
    });
    try { assert.ok(["bound", "unchanged"].includes(runDestinationMigration(f.db, input).status)); }
    finally { restore(); }
    assert.equal(f.run({ action: "bindings" }).binding_revision, 2, "one binding write, including when the peer wins");
    return count;
  };
  let count = 0;
  await t.test("discover executed steps", async (context) => { count = await race(context); });
  for (let boundary = 0; boundary < count; boundary++) await t.test(`peer binding at step ${boundary}`, async (context) => { await race(context, boundary); });
});

test("failure at EVERY apply step leaves either the whole move or none, and exact retries re-read the targets", async (t) => {
  /** Emulate a lost process at an actual statement boundary; SQLite rollback is the recovery coordinator. */
  const crash = async (context: TestContext, boundary = -1) => {
    const f = await fixture(context); f.bind("old", oldRoute); f.bind("new", newRoute);
    f.box.enqueue(intent("a")); f.box.enqueue(intent("b"));
    const preview = f.run({ action: "preview", from: "old", to: "new" });
    let count = 0;
    const restore = boundaries(f.db, () => { if (count++ === boundary) throw new Error("Injected process boundary"); });
    try { runDestinationMigration(f.db, parseDestinationMigrationInput(applyInput(preview))); }
    catch (error) { assert.match(String(error), /Injected process boundary/); }
    finally { restore(); }
    const after = f.run({ action: "preview", from: "old", to: "new" });
    assert.ok([0, 2].includes(after.counts.movable), "no partially published target set");
    const recovered = f.run(applyInput(preview));
    assert.ok(["applied", "already_applied"].includes(recovered.status));
    assert.equal(f.run({ action: "preview", from: "new", to: "old" }).counts.movable, 2);
    assert.equal(f.box.status().rows.length, 2);
    return count;
  };
  let count = 0;
  await t.test("discover executed steps", async (context) => { count = await crash(context); });
  for (let boundary = 0; boundary < count; boundary++) await t.test(`interruption after step ${boundary}`, async (context) => { await crash(context, boundary); });
});

test("a coalesced drain revalidates a previewed destination under its claim fence", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  f.box.enqueue({ ...intent("a"), priority: 2 }); f.box.enqueue({ ...intent("b"), priority: 2 });
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  let injected = false; let sends = 0;
  const restore = boundaries(f.db, (sql) => {
    if (!injected && sql.includes("INSERT OR IGNORE INTO coalescing_receipt")) { injected = true; f.run(applyInput(preview)); }
  });
  try { await f.box.drainCoalesced(async () => { sends++; return "acknowledged"; }, { now: 120000 }); }
  finally { restore(); }
  assert.equal(injected, true); assert.equal(sends, 0);
  await f.box.drainCoalesced(async (destination, payload) => { assert.equal(destination, newRoute); assert.equal(payload.channel, undefined); sends++; return "acknowledged"; }, { now: 120000 });
  assert.equal(sends, 1);
});

test("a force-retired live sender with no dispatch proof cannot be routed somewhere else", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  const key = f.box.enqueue(intent());
  let release!: () => void;
  const sending = f.box.drain(async (_destination, _payload, context) => { await new Promise<void>((done) => { release = done; }); context.requestDispatched(); return "ambiguous"; });
  f.box.resolve(key, "retry", { force: true });
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.uncertain, 1); assert.equal(preview.counts.movable, 0);
  assert.equal(f.run(applyInput(preview)).counts.moved, 0);
  release(); await sending;
  assert.equal(f.box.status().outcomes.uncertain, 1);
});

test("capacity, corrupt journal records and extreme persisted counters refuse safely and isolate foreign bindings", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  const key = f.box.enqueue(intent());
  f.db.exec("UPDATE destination_epoch SET generation=-1");
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("storage_unavailable"));
  f.db.exec("UPDATE destination_epoch SET generation=0; UPDATE destination_version SET generation=-1");
  assert.equal(f.run({ action: "preview", from: "old", to: "new" }).counts.foreign, 1);
  f.db.exec("UPDATE destination_version SET generation=1");
  f.db.prepare("INSERT INTO destination_binding(alias,destination,channel) VALUES ('UPPER',?,NULL)").run(oldRoute);
  assert.equal(f.run({ action: "bindings" }).foreign_bindings, 1);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  f.run(applyInput(preview));
  f.db.exec("UPDATE destination_commit SET from_alias='other'");
  assert.throws(() => f.run(applyInput(preview)), refusal("plan_changed"));
  f.db.exec("UPDATE destination_commit SET from_alias='old',manifest='{}'");
  assert.throws(() => f.run(applyInput(preview)), refusal("storage_unavailable"));
  f.db.exec("DELETE FROM destination_binding WHERE alias='UPPER'; DELETE FROM destination_commit;");
  f.db.prepare("UPDATE delivery SET destination=? WHERE key=?").run(oldRoute, key);
  f.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO delivery(key,item,event,revision,destination,payload) SELECT 'foreign-'||i,'foreign','unknown','unknown','${oldRoute}','{}' FROM n;`);
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("capacity_exceeded"));
  f.db.exec("DELETE FROM delivery WHERE item='foreign'");
  f.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<98)
    INSERT INTO destination_binding(alias,destination,channel) SELECT 'alias'||i,'${oldRoute}',NULL FROM n;`);
  const full = f.run({ action: "bindings" });
  assert.equal(full.bindings.length, 100);
  assert.throws(() => f.run({ action: "bind", alias: "extra", destination: newRoute, channel: null, bindingRevision: full.binding_revision }), refusal("capacity_exceeded"));
  f.db.prepare("INSERT INTO destination_binding(alias,destination,channel) VALUES ('extra',?,NULL)").run(newRoute);
  assert.throws(() => f.run({ action: "bindings" }), refusal("capacity_exceeded"));
});

test("extreme foreign JSON fails alone while all finite producer payload values survive migration", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  const foreign: string[] = [];
  for (const [index, text] of ['{"text":"extreme","value":1e309}', '{"text":"nested","value":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}', '{"text":""}'].entries()) {
    const key = f.box.enqueue(intent(`extreme-${index}`));
    foreign.push(key);
    f.db.prepare("UPDATE delivery SET payload=? WHERE key=?").run(text, key);
  }
  const original = intent("finite"); original.payload.blocks!.push({ type: "section", values: [0, -1, Number.MAX_VALUE, Number.MIN_VALUE, true, null, "\r\n"] });
  f.box.enqueue(original);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.foreign, 3); assert.equal(preview.counts.movable, 1);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  const { channel: _channel, ...expected } = original.payload;
  foreign.forEach((key) => f.box.resolve(key, "skip"));
  let reads = 0;
  await f.box.drain(async (destination, payload) => { reads++; assert.equal(destination, newRoute); assert.deepEqual(payload, expected); return "acknowledged"; });
  assert.equal(reads, 1);
});

test("oversized SQLite integers and one unreadable foreign proof fail alone, including journal replay", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  const healthy = f.box.enqueue(intent("healthy"));
  const oversized = f.box.enqueue(intent("oversized"));
  const unreadable = f.box.enqueue(intent("unreadable"));
  f.db.prepare("UPDATE destination_version SET generation=9223372036854775807 WHERE key=?").run(oversized);
  f.db.prepare("INSERT INTO delivery_proof(key,legacy_unknown) VALUES (?,9223372036854775807)").run(unreadable);
  f.db.prepare("INSERT INTO delivery(key,item,event,revision,destination,payload) VALUES (x'00','foreign','unknown','foreign',?,'{}')").run(oldRoute);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.movable, 1); assert.equal(preview.counts.foreign, 3); roundtrip(preview);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  f.db.prepare("UPDATE destination_version SET generation=9223372036854775807 WHERE key=?").run(healthy);
  const replayed = f.run(applyInput(preview));
  assert.equal(replayed.status, "superseded"); assert.equal(replayed.counts.foreign, 1); roundtrip(replayed);
});

test("preview and apply share revision-exhaustion decisions without blocking other healthy targets", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute); f.bind("new", newRoute);
  const exhausted = f.box.enqueue(intent("exhausted"));
  f.box.enqueue(intent("healthy"));
  f.db.prepare("UPDATE destination_version SET generation=9007199254740991 WHERE key=?").run(exhausted);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.foreign, 1); assert.equal(preview.counts.movable, 1); roundtrip(preview);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  f.box.enqueue(intent("global-exhaustion"));
  const current = f.run({ action: "preview", from: "old", to: "new" });
  const before = f.box.status(100);
  f.db.exec("UPDATE destination_epoch SET generation=9007199254740991");
  assert.throws(() => f.run({ action: "preview", from: "old", to: "new" }), refusal("capacity_exceeded"));
  assert.throws(() => f.run(applyInput(current)), refusal("capacity_exceeded"));
  assert.deepEqual(f.box.status(100), before);
});

test("every mapped producer payload fits its UTF-8 cap and remains migratable at the exact boundary", async (t) => {
  const f = await fixture(t); f.bind("old", oldRoute, "#old");
  const target = slackDestination("http://127.0.0.1:1/new", "#new");
  f.bind("new", target, "#new");
  const maximum = 1048576;
  const bareOverhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
  const mappedOverhead = Buffer.byteLength(JSON.stringify({ text: "", channel: "#new" }), "utf8");
  const texts = ["x".repeat(maximum - bareOverhead), "🙂".repeat(300000), "x".repeat(maximum - mappedOverhead)];
  const originals = texts.map((text, index): OutboxIntent => ({ item: "payload-boundary", event: "close", revision: `boundary-${index}`, destination: oldRoute, payload: { text }, priority: 1 }));
  const keys = originals.map((original) => f.box.enqueue(original));
  const before = f.box.status(100);
  const preview = f.run({ action: "preview", from: "old", to: "new" });
  assert.equal(preview.counts.foreign, 2); assert.equal(preview.counts.movable, 1); roundtrip(preview);
  assert.equal(f.run(applyInput(preview)).counts.moved, 1);
  assert.deepEqual(f.box.status(100), before);
  const reverse = f.run({ action: "preview", from: "new", to: "old" });
  assert.equal(reverse.counts.movable, 1); assert.equal(reverse.counts.foreign, 0);
  assert.equal(f.run(applyInput(reverse)).counts.moved, 1);
  assert.equal(f.box.enqueue(originals[2]!), keys[2]);
  keys.slice(0, 2).forEach((key) => f.box.resolve(key, "skip"));
  let reads = 0;
  await f.box.drain(async (destination, payload) => {
    reads++; assert.equal(destination, oldRoute); assert.equal(payload.text, texts[2]); assert.equal(payload.channel, "#old");
    assert.equal(Buffer.byteLength(JSON.stringify(payload), "utf8"), maximum);
    return "acknowledged";
  });
  assert.equal(reads, 1);
});
