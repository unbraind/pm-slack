/** Read-only public-tracker measurement. Pass an exported tracker root outside git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listAllComplete, readHistoryEntries, verifyHistoryEntries, replayHistoryToTarget, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { planSlackCoalescing, classifySlackTransition } from "../index.ts";
import type { CoalescingEvent } from "../index.ts";

/** Hash all exported tracker bytes to prove the validation is observational. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const pmRoot = process.argv[2];
assert.ok(pmRoot, "Pass an exported public tracker root.");
const before = fingerprint(pmRoot);
const statusRegistry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
const corpus = await listAllComplete({}, { pmRoot, cwd: pmRoot, noExtensions: true });
const events: CoalescingEvent[] = [];
let entries = 0;
let streams = 0;
for (const item of corpus.items) {
  const history = await readHistoryEntries(join(pmRoot, "history", `${item.id}.jsonl`), item.id);
  assert.equal(verifyHistoryEntries(history).ok, true, "Every public stream must verify before measurement.");
  streams += 1;
  let previous: string | undefined;
  for (const [index, entry] of history.entries()) {
    entries += 1;
    const patch = entry.patch.find((change) => change.path === "/metadata/status" || change.path === "/front_matter/status");
    const status = patch && "value" in patch ? String(patch.value) : undefined;
    const prior = previous;
    if (status) previous = status;
    if ((!status && entry.op !== "create") || (entry.op !== "create" && status === prior)) continue;
    const event = classifySlackTransition({ command: entry.op === "create" ? "create" : "update", status, previousStatus: prior }, statusRegistry);
    if (!event) continue;
    const { metadata } = replayHistoryToTarget(history, index);
    const priority = Number(metadata.priority ?? 4);
    events.push({ key: createHash("sha256").update(JSON.stringify([item.id, event, entry.after_hash])).digest("hex"), item: item.id, event, revision: entry.after_hash, destination: "public-validation", at: Date.parse(entry.ts), priority });
  }
}
const now = Math.max(0, ...events.map((event) => event.at)) + 86400000;
const options = { budget: 5, windowMs: 60000, now };
const plan = planSlackCoalescing(events, options);
assert.deepEqual(planSlackCoalescing([...events].reverse(), options), plan);
const rotated = [...events.slice(17), ...events.slice(0, 17)];
assert.deepEqual(planSlackCoalescing(rotated, options), plan);
assert.equal(plan.receipts.length, events.length);
const zero = planSlackCoalescing(events, { ...options, budget: 0 });
assert.equal(zero.notifications.length, plan.urgent);
assert.equal(zero.notifications.every((notification) => notification.urgent), true);
const unrestricted = planSlackCoalescing(events, { ...options, budget: 100 });
assert.equal(fingerprint(pmRoot), before);
console.log(JSON.stringify({ items: corpus.items.length, verified_streams: streams, history_entries: entries, lifecycle_events: events.length,
  window_ms: options.windowMs, routine_budget: options.budget, notifications: plan.notifications.length, urgent_bypass: plan.urgent,
  coalesced_events: plan.coalesced, deferred_events: plan.deferred, waiting_events: plan.waiting,
  manifest_receipts: plan.receipts.length, max_summary_characters: Math.max(0, ...plan.notifications.map((notification) => notification.text.length)),
  budget_100_notifications: unrestricted.notifications.length, budget_100_coalesced_events: unrestricted.coalesced, budget_100_deferred_events: unrestricted.deferred,
  order_variants_equal: 3, zero_budget_urgent_only: true, tracker_bytes_unchanged: true, fingerprint: before }, null, 2));
