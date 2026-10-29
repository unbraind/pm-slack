/** Read-only contracts include the complete command, renderer and after-command hook lifecycle. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { init } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { decode } from "@toon-format/toon";
import extension, { SlackOutbox, migrateSlackDestinations, slackDestination, OutboxError } from "../index.ts";
import { readSlackRoutingEvidence } from "../outbox.ts";
import { seedObservationalOutbox, withObservationalOutbox } from "./helpers/observational-outbox-scenario.ts";

const source = slackDestination("http://127.0.0.1:1/old");
const target = slackDestination("http://127.0.0.1:1/new");

/** Build a real SDK tracker outside git and make git itself unavailable. */
async function fixture(t: TestContext, seeded = true) {
  const directory = mkdtempSync(join(tmpdir(), "slack-observation-")); const pmRoot = join(directory, ".agents", "pm");
  const keys = ["PATH", "GIT_CEILING_DIRECTORIES", "PM_SLACK_WEBHOOK", "PM_SLACK_ROUTES", "PM_SLACK_EVENTS", "PM_SLACK_MIN_PRIORITY", "PM_SLACK_COALESCE"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => { keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); rmSync(directory, { recursive: true, force: true }); });
  process.env.PATH = directory; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  keys.slice(2).forEach((key) => { delete process.env[key]; });
  await init("observation", { defaults: true, agentGuidance: "skip" }, { cwd: directory, pmRoot, noExtensions: true });
  if (seeded) {
    const box = new SlackOutbox(pmRoot); box.enable(); box.close();
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "old", destination: source, channel: null, bindingRevision: 0 });
    migrateSlackDestinations(pmRoot, { action: "bind", alias: "new", destination: target, channel: null, bindingRevision: 1 });
    await seedObservationalOutbox(pmRoot, new URL("../outbox.ts", import.meta.url).href, source);
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => harness.deactivate());
  return { directory, pmRoot, harness };
}

test("every observational CLI handler and complete hook lifecycle preserves a dead-owner attempt in JSON and TOON", async (t) => {
  const { pmRoot, harness } = await fixture(t);
  const cases: [string, Record<string, unknown>][] = [
    ["slack migrate", { from: "old", to: "new" }], ["slack migrate", { action: "preview", from: "old", to: "new" }], ["slack migrate", { action: "bindings" }],
    ["slack coalesce", {}], ["slack coalesce", { action: "preview" }], ["slack coalesce", { action: "receipts" }],
    ["slack outbox", {}], ["slack outbox", { action: "status" }],
    ["slack notify", { text: "Synthetic offline message", dryRun: true }], ["slack digest", { dryRun: true }], ["slack test", {}],
  ];
  await withObservationalOutbox(pmRoot, async (unchanged) => {
    for (const [command, options] of cases) for (const json of [true, false]) await t.test(`${command} ${JSON.stringify(options)} json=${json}`, async () => {
      const { result } = await harness.runCommand({ command, pmRoot, options, global: { json } });
      assert.notEqual((result as { ok?: boolean } | null)?.ok, false);
      unchanged();
      const rendered = await harness.runRendererOverride({ command, format: "toon", result });
      if (["slack migrate", "slack coalesce", "slack outbox"].includes(command)) assert.deepEqual(decode(rendered.rendered!), JSON.parse(JSON.stringify(result)));
      unchanged();
      await harness.runHook({ kind: "after_command", context: { command, args: [], options, pm_root: pmRoot, ok: true, result } });
      unchanged();
    });
    // Enumerate the package's actual command registrations so future commands inherit this hook contract.
    for (const command of ["get", "list", "context", "search", "help", ...harness.activation.registrations.commands.map((entry) => entry.command)]) {
      await harness.runHook({ kind: "after_command", context: { command, args: [], pm_root: pmRoot, ok: true, result: { item: { id: "observational-fixture", status: "open" } } } }); unchanged();
    }
    for (const spelling of ["dry-run", "dryRun"]) for (const command of ["create", "update", "close", "start", "reopen"]) {
      await harness.runHook({ kind: "after_command", context: { command, args: [], options: { [spelling]: true }, pm_root: pmRoot, ok: true, result: { item: { id: "observational-fixture", status: "open" } } } }); unchanged();
    }
    for (const command of ["create", "close", "start"]) {
      await harness.runHook({ kind: "after_command", context: { command, args: [], pm_root: pmRoot, ok: true, result: {} } }); unchanged();
    }
  });
});

test("SDK read-only opens preserve uncertainty and bytes while explicit writable recovery still closes the dead attempt", async (t) => {
  const { pmRoot } = await fixture(t);
  await withObservationalOutbox(pmRoot, async (unchanged) => {
    const box = new SlackOutbox(pmRoot, { readOnly: true });
    try {
      assert.equal(box.status().counts.sending, 1); assert.equal(box.status().counts.pending, 1);
      assert.equal(box.status().outcomes.uncertain, 1);
      box.coalescingReport(box.planCoalescing());
      readSlackRoutingEvidence(pmRoot, "observational-fixture", "close", "dead-owner", new Date().toISOString());
      assert.equal(migrateSlackDestinations(pmRoot, { action: "preview", from: "old", to: "new" }).counts.uncertain, 1);
      migrateSlackDestinations(pmRoot, { action: "bindings" }); unchanged();
    } finally { box.close(); }
    unchanged();
  });
  const file = join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"); const before = readFileSync(file);
  const recovered = new SlackOutbox(pmRoot); recovered.close();
  assert.notDeepEqual(readFileSync(file), before, "an explicit writer still performs durable dead-owner recovery");
});

test("inspection of absent storage retains empty status and disabled preview without creating runtime files", async (t) => {
  const { pmRoot, harness } = await fixture(t, false);
  for (const options of [{}, { action: "status" }]) {
    const { result } = await harness.runCommand({ command: "slack outbox", pmRoot, options });
    assert.equal((result as { enabled_since: unknown }).enabled_since, null);
  }
  for (const command of ["slack coalesce", "slack migrate"]) {
    const { result } = await harness.runCommand({ command, pmRoot, options: { from: "old", to: "new" } });
    assert.equal((result as { code: string }).code, "disabled");
  }
  assert.equal(existsSync(join(pmRoot, "runtime", "slack-outbox")), false);
  const box = new SlackOutbox(pmRoot, { readOnly: true }); assert.equal(box.status().rows.length, 0); box.close();
  assert.equal(existsSync(join(pmRoot, "runtime", "slack-outbox")), false);
});

for (const legacy of ["unpaired", "unjournaled"]) test(`legacy ${legacy} inspection reads retained receipts without schema upgrades`, async (t) => {
  const { pmRoot } = await fixture(t);
  const db = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  // Released unpaired stores retain dispatch in the legacy started row and attempts column.
  db.exec("INSERT INTO delivery_attempt SELECT key,token,'started' FROM delivery_attempt_start; UPDATE delivery SET attempts=(SELECT COUNT(*) FROM delivery_request_dispatched x WHERE x.key=delivery.key)");
  db.exec("DROP TABLE delivery_attempt_terminal; DROP TABLE delivery_request_dispatched; DROP TABLE delivery_attempt_start");
  if (legacy === "unjournaled") db.exec("DROP TABLE delivery_proof; DROP TABLE delivery_attempt; DROP TABLE delivery_resolution; DROP TABLE delivery_context; DROP TABLE coalescing_receipt");
  db.close();
  await withObservationalOutbox(pmRoot, async (unchanged) => {
    const box = new SlackOutbox(pmRoot, { readOnly: true });
    try { assert.equal(box.status().rows.length, 2); assert.equal(box.status().outcomes.uncertain, 1); box.coalescingReport(box.planCoalescing()); unchanged(); }
    finally { box.close(); }
  });
});

test("unreadable foreign storage produces a typed readable-storage remedy without repair", async (t) => {
  const { pmRoot } = await fixture(t, false); const directory = join(pmRoot, "runtime", "slack-outbox"); mkdirSync(directory, { recursive: true });
  const file = join(directory, "delivery.sqlite"); writeFileSync(file, "foreign storage");
  assert.throws(() => new SlackOutbox(pmRoot, { readOnly: true }), (error: unknown) => error instanceof OutboxError && error.code === "storage_unavailable" && error.remedy.includes("readable"));
  const blocked = join(pmRoot, "missing-parent", "child");
  // A directory at the database path exercises the read-only open refusal itself.
  mkdirSync(join(blocked, "runtime", "slack-outbox", "delivery.sqlite"), { recursive: true });
  assert.throws(() => new SlackOutbox(blocked, { readOnly: true }), (error: unknown) => error instanceof OutboxError && error.code === "storage_unavailable" && error.remedy.includes("readable"));
  assert.equal(readFileSync(file, "utf8"), "foreign storage");
});
