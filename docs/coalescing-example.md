# Attention-budgeted delivery

Enable the durable outbox once with your existing webhook configuration. Set
`PM_SLACK_MIN_PRIORITY=4` to include routine events; the default remains critical
only. Set `PM_SLACK_COALESCE=1` in the environment of every lifecycle writer to
queue routine events while immediately attempting blockers and priority-0/1 events.

```sh
pm slack outbox --action enable
pm slack coalesce --budget 3 --json
pm slack coalesce --action drain --budget 3 --window-ms 60000
pm slack coalesce --action receipts --limit 20 --after 0 --json
```

Run the drain periodically with your own scheduler. There is no background
daemon. A budget applies to one drain, excludes urgent notifications, and counts
notifications rather than events. Open fixed UTC windows remain pending until
their end. Repeated drains can each spend another budget. `slack outbox --action
drain` sends individual messages and intentionally ignores the attention budget.

Two routine transitions for one item in one window become one bounded message:

```text
pm lifecycle project-task: 2 event(s) (create:1, close:1)
```

An urgent blocker uses its full original payload immediately, including routing
and any configured assignee mention. Routine summaries disable Slack markdown,
omit titles and mentions, and include counts of every represented transition.
Groups never cross items, destinations, or fixed windows. Both the summary and
the group hash are independent of event arrival order. A late event after a
group was sent produces another notification; already acknowledged events never
re-enter a batch. Legacy intents without timestamps use epoch zero and are
eligible immediately; all legacy blockers bypass.

The SDK exposes the same behavior without shelling out:

```ts
import { SlackOutbox, planSlackCoalescing } from "pm-slack";
import type { CoalescingEvent, OutboxOutcome, OutboxPayload } from "pm-slack";

// Supply committed events from an existing event source. Planning has no I/O.
const events: CoalescingEvent[] = [
  { key: "event-a", item: "project-task", event: "create", revision: "revision-a",
    destination: "opaque-route-hash", at: 1000, priority: 2 },
  { key: "event-b", item: "project-task", event: "close", revision: "revision-b",
    destination: "opaque-route-hash", at: 2000, priority: 2 },
];
const plan = planSlackCoalescing(events, { budget: 3, windowMs: 60000, now: 60000 });
console.log(plan.notifications.length); // 1
console.log(plan.receipts.length);      // 2

// Reuse an already enabled outbox, with events captured by lifecycle hooks.
// The transport must acknowledge only an explicit remote success. Return
// ambiguous for uncertain delivery; map rate limits to retry without resending.
async function send(destination: string, payload: OutboxPayload): Promise<OutboxOutcome> {
  return transportWithExplicitAcknowledgment(destination, payload);
}
const outbox = new SlackOutbox(".agents/pm");
try {
  const result = await outbox.drainCoalesced(send, { budget: 3 });
  console.log(outbox.coalescingReport(result, 20));
} finally {
  outbox.close();
}
```

`transportWithExplicitAcknowledgment` represents the application's own transport;
the CLI uses the package's existing routed webhook transport. Resolve destination
hashes through trusted configuration rather than accepting credentials in event
records. Use the CLI for history recovery, or call `captureSlackOutbox` before
SDK draining. Nothing is automatically backfilled from before outbox opt-in.

Every input event has an evidence receipt with key, item, event, committed
revision, disposition, and notification hash. `bypass` retains an individual
urgent message; `coalesced` identifies a summary; `deferred` retains over-budget
work; `waiting` retains events in open windows. These are planning decisions,
not remote acknowledgment. The separate source state reports pending, sending,
acknowledged, ambiguous, rejected, refused, or skipped. These work labels do not
prove delivery. Per-row `outcome` and aggregate `outcomes` use the full retained
attempt lifecycle, with `uncertain` counted separately. Skip/abandon/operator ack
never erase an unresolved attempt. Durable receipts are
written before an HTTP attempt and survive a restart. Preview creates no
delivery decisions and performs no network request or history recovery.

JSON and TOON output contain totals and at most 20 evidence rows by default
(maximum 100), with `omitted` and `next_cursor`. Walk the pages against a stable
queue to export the complete manifest. Preview covers pending events; `--action
receipts` inspects retained decisions. Its summary describes the current pending
plan, while rows include past attempts. No payloads, webhook URLs or destination
hashes appear in CLI receipts. The SDK plan includes opaque destination hashes
so a trusted transport can route messages.

If a grouped request crashes or becomes ambiguous, all its original receipts
retain that uncertainty. Reconcile any member using `slack outbox --action
resolve --key KEY --decision acknowledged|retry|skip|abandon`; the whole HTTP group is
resolved atomically. Verify delivery before retrying: Slack webhooks have no
exactly-once protocol. Concurrent plain and coalesced drains cannot claim the
same original event. A rate limit stops the drain; uncertainty pauses that
destination for the remainder of the drain.

Invalid bounds return `invalid_coalescing_input` with `remediation`. Enable the
outbox for `disabled`; restore original routing for `destination_changed`;
repair history for `history_unavailable`; restore runtime storage for
`storage_unavailable`. More than 10000 pending events refuses planning rather
than silently hiding an urgent event; reduce the queue with individual outbox
drains, then coalesce again. Budgets are 0..100 and windows are 1000..86400000 ms.
All coalescing commands and SDK methods work in a plain tracker without git.
