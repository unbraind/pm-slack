# Public-tracker validation

Source: public `unbraind/pm-slack` main commit
`0e4c89e6212bb3e3d8a8cbdc6c95af871714fb8c`. Only its tracked `.agents/pm`
directory was exported into a non-git scratch directory and made read-only.
Validation used the pinned SDK with extensions disabled and a git discovery
ceiling at the scratch parent. No webhook was contacted.

Run `node scripts/validate-coalescing.ts <exported-tracker-root>` to repeat the
measurement. The script uses `listAllComplete`, `readHistoryEntries`,
`verifyHistoryEntries`, and `replayHistoryToTarget`, with the existing package
lifecycle detector. It checks every history stream before planning and hashes
all exported tracker bytes before and after.

| Measurement | Result |
| --- | ---: |
| Items / verified streams | 87 / 87 |
| History entries | 658 |
| Lifecycle delivery events | 222 |
| Fixed window | 60000 ms |
| Routine notification budget | 5 |
| Notifications selected | 86 |
| Urgent notifications outside budget | 81 |
| Routine summaries / represented events | 5 / 8 |
| Deferred events retained pending | 133 |
| Waiting events | 0 |
| Item-level evidence receipts | 222 |
| Longest selected summary | 58 characters |
| Budget 100: notifications / represented routine events / deferred | 180 / 141 / 0 |
| Equal input-order variants | 3 |

All urgent events still bypass with budget zero. Original, reversed, and rotated
event orders produce identical plans and manifests. Tracker fingerprint stayed
`3dac2e16b2c7efcca5508ba8a3c1effdf7ff2799241a6ba5c27c7e967617088f`.
The observation clock was fixed one day after the last public event so all
historical windows were closed. This is a history replay, not live delivery or
a benchmark. Priority 0 present in the public history is treated as urgent.

`test/coalescing.test.ts` separately exercises all 120 permutations of a
five-event burst, 10000-event bounds, urgent bypass, route/window separation,
complete manifests, real no-git SDK trackers, local HTTP delivery, SQLite claim
refusals, concurrent drains, process death, and whole-group reconciliation.
Behavioral reversions independently disabled grouping, urgent classification,
and complete member receipts. Each reverted scenario failed its targeted test
(one test, zero passes, one failure); the original source was restored after
each proof. Native Bun acceptance also exercises the compiled package entry
against a real no-git tracker and a local HTTP sink.

## Outbox transition consistency (review 151)

The outbox uses SQLite `BEGIN IMMEDIATE` transactions as its cross-process
writer fence. The SDK's workspace/item transaction primitives protect tracker
mutations; they do not transact this runtime SQLite database. Delivery therefore
uses SQLite's own durable transaction and rollback primitives, without requiring
git or holding a tracker lock across a remote request.

| Transition | Consistency boundary |
| --- | --- |
| Enqueue / history recovery | Intent and event context commit together; immutable keys deduplicate replay. |
| Plain or coalesced claim | All members, attempts, PID and group mappings commit before transport. |
| Group identity | Each attempt gets a new token; planner notification IDs remain stable evidence. |
| Send / typed refusal / transport failure | Completion selects only its attempt token, then changes the complete membership in one transaction. |
| Retry cleanup | Delete only that attempt's mappings first; release members last; commit exposes both together. |
| Storage failure | Roll back membership, attempt counts and state together; no partial release. |
| Process death | SQLite rolls back uncommitted work; committed sending groups require explicit reconciliation. |
| Reconcile / force | Select the complete owned group, delete its mappings, then update members under one transaction. |
| Late sender completion | A retired token matches no members, so it cannot update or erase a newer claim. |

`test/outbox-interleaving.test.ts` injects a second drainer after every actual SQL
operation in retry/failure completion and in retry/acknowledge/skip recovery
from ambiguous, rejected, refused and real dead-sender states. It holds the
peer's new two-event group through the older cleanup, loses its response, and
reconciles its sibling, requiring whole-group recovery and zero leftover
ambiguity or duplicate acceptance. Separate cases terminate real processes at
every retry-cleanup and crash-recovery boundary, inject native SQLite ABORT and
ROLLBACK faults at mapping deletion and member release, and return stale plain
and grouped senders after forced reconciliation. No SDK or SQLite state is
mocked. Native Bun acceptance also covers retry cleanup and a stale completion
while a peer owns the next group.
