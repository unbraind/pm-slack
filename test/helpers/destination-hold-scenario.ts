/** Reusable adversarial contract for source, native Bun and exact packed outbox consumers. */
import assert from "node:assert/strict";
import type { SlackOutbox } from "../../outbox.ts";
import type { DestinationMigrationInput, DestinationMigrationReport } from "../../destination-migration.ts";

/** Only public SDK operations are needed to reproduce the destination-hold race. */
export type DestinationHoldBox = Pick<SlackOutbox, "enqueue" | "drain" | "drainCoalesced" | "status" | "resolve">;

/** Execute one reviewed migration while a request to its target is already in flight. */
export async function assertMigrationDestinationHold(
  box: DestinationHoldBox,
  migrate: (input: DestinationMigrationInput) => DestinationMigrationReport,
  options: { namespace: string; source: string; target: string; coalesced: boolean; routine?: boolean },
): Promise<void> {
  let bindingRevision = migrate({ action: "bindings" }).binding_revision;
  const from = `${options.namespace}-from`; const to = `${options.namespace}-to`;
  bindingRevision = migrate({ action: "bind", alias: from, destination: options.source, channel: null, bindingRevision }).binding_revision;
  migrate({ action: "bind", alias: to, destination: options.target, channel: null, bindingRevision });
  const priority = options.routine ? 2 : 1;
  const first = box.enqueue({ item: options.namespace, event: "close", revision: "target-first", destination: options.target, payload: { text: "Synthetic target already in flight" }, at: 0, priority });
  const moving = box.enqueue({ item: options.namespace, event: "close", revision: "source-later", destination: options.source, payload: { text: "Synthetic pending source" }, at: 120000, priority });
  const stable = box.enqueue({ item: options.namespace, event: "close", revision: "target-later", destination: options.target, payload: { text: "Synthetic pending target" }, at: 60000, priority });
  const destinations: string[] = [];
  /** Commit the route transition after candidate discovery but before the first ambiguous completion. */
  const send: Parameters<DestinationHoldBox["drain"]>[0] = async (destination, _payload, context) => {
    destinations.push(destination); context.requestDispatched();
    if (destinations.length === 1) {
      assert.equal(destination, options.target);
      const preview = migrate({ action: "preview", from, to });
      assert.equal(preview.counts.movable, 1);
      assert.equal(migrate({ action: "apply", from, to, bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! }).counts.moved, 1);
    }
    return "ambiguous";
  };
  if (options.coalesced) await box.drainCoalesced(send, { now: 180000, budget: 100 });
  else await box.drain(send, 100);
  assert.deepEqual(destinations, [options.target], "a migration into a held destination must never authorize a second send in the same drain");
  const rows = new Map(box.status(100).rows.map((row) => [row.key, row]));
  assert.equal(rows.get(first)!.state, "ambiguous");
  assert.equal(rows.get(first)!.attempts, 1); assert.equal(rows.get(first)!.outcome, "uncertain");
  for (const key of [moving, stable]) {
    assert.equal(rows.get(key)!.state, "pending");
    assert.equal(rows.get(key)!.attempts, 0); assert.equal(rows.get(key)!.outcome, "withheld");
  }
  // Retire only this scenario's receipts; uncertainty remains in the transport journal.
  for (const key of [first, moving, stable]) box.resolve(key, "skip");
}
