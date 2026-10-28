/** Measure real public SDK history on a read-only non-git export; only a separate scratch outbox is writable. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, listAllComplete, readHistorySnapshot, readSettings, replayHistoryToTarget, resolveRuntimeStatusRegistry, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import { SlackOutbox, migrateSlackDestinations, slackDestination, classifySlackTransition } from "../index.ts";
import type { OutboxIntent } from "../index.ts";

/** Fingerprint the entire explicitly exported tracker, including relationships and history. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const source = process.argv[2];
assert.ok(source, "Supply a read-only exported public tracker root outside git.");
const before = fingerprint(source);
const client = { cwd: source, pmRoot: source, noExtensions: true };
const corpus = await listAllComplete({}, client);
const registry = resolveRuntimeStatusRegistry((await readSettings(source)).schema);
const intents: OutboxIntent[] = [];
let entries = 0;
const oldRoute = slackDestination("http://127.0.0.1:1/source", "#old");
const newRoute = slackDestination("http://127.0.0.1:1/target", "#new");
for (const item of corpus.items) {
  const snapshot = await readHistorySnapshot(join(source, "history", `${item.id}.jsonl`), item.id);
  assert.equal(verifyHistoryEntries(snapshot.entries).ok, true);
  let prior: string | undefined;
  for (const [index, entry] of snapshot.entries.entries()) {
    entries++;
    const { metadata } = replayHistoryToTarget(snapshot.entries, index);
    const status = typeof metadata.status === "string" ? metadata.status : undefined;
    const event = classifySlackTransition({ command: entry.op === "create" ? "create" : "update", status, previousStatus: prior }, registry);
    if (event && (entry.op === "create" || status !== prior)) intents.push({ item: item.id, event,
      revision: `${index + 1}:${entry.after_hash}`, destination: oldRoute,
      payload: { text: `Public lifecycle ${item.id} ${event}`, channel: "#old", mrkdwn: false }, at: Date.parse(entry.ts), priority: Number(metadata.priority ?? 4) });
    prior = status;
  }
}
const directory = mkdtempSync(join(tmpdir(), "slack-public-migration-"));
const pmRoot = join(directory, ".agents", "pm");
let box: SlackOutbox | undefined;
try {
  await init("migration-validation", { defaults: true, agentGuidance: "skip" }, { cwd: directory, pmRoot, noExtensions: true });
  box = new SlackOutbox(pmRoot); box.enable();
  const keys = intents.map((intent) => box!.enqueue(intent));
  assert.equal(new Set(keys).size, intents.length, "SDK event version and state hash identify each transition");
  migrateSlackDestinations(pmRoot, { action: "bind", alias: "old", destination: oldRoute, channel: "#old", bindingRevision: 0 });
  migrateSlackDestinations(pmRoot, { action: "bind", alias: "new", destination: newRoute, channel: "#new", bindingRevision: 1 });
  for (let i = 0; i < Math.min(3, keys.length); i++) await box.drain(async () => "ambiguous", 1);
  if (keys.length) box.resolve(keys[0]!, "retry");
  const status = box.status(100);
  const bytes = readFileSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"));
  const preview = migrateSlackDestinations(pmRoot, { action: "preview", from: "old", to: "new", limit: 20 });
  assert.deepEqual(readFileSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite")), bytes);
  const apply = { action: "apply" as const, from: "old", to: "new", bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! };
  const result = migrateSlackDestinations(pmRoot, apply);
  assert.equal(result.counts.moved, preview.counts.movable);
  assert.deepEqual(box.status(100), status, "migration cannot rewrite scheduling state or delivery proof");
  for (const intent of intents) box.enqueue(intent);
  assert.equal(migrateSlackDestinations(pmRoot, apply).counts.moved, 0);
  assert.equal(box.status(100).rows.length + box.status(100).omitted, intents.length);
  const pending = box.planCoalescing({ budget: 100 }).notifications;
  assert.ok(pending.every((row) => row.destination === newRoute || row.keys.includes(keys[0]!)), "uncertain retries retain only their original route");
  assert.deepEqual((await listAllComplete({}, client)).items, corpus.items);
  assert.equal(fingerprint(source), before);
  console.log(JSON.stringify({ items: corpus.items.length, verified_streams: corpus.items.length, history_entries: entries, lifecycle_events: intents.length,
    unique_queue_entries: new Set(keys).size, binding_revision: result.binding_revision, movable: preview.counts.movable, retained_uncertain: preview.counts.uncertain,
    moved: result.counts.moved, preview_rows: preview.rows.length, preview_omitted: preview.omitted, replay_moves: 0, duplicate_queue_entries: 0,
    preview_database_bytes_unchanged: true, native_sdk_state_unchanged: true, tracker_bytes_unchanged: true, remote_posts: 0, source_fingerprint: before }, null, 2));
} finally { box?.close(); rmSync(directory, { recursive: true, force: true }); }
