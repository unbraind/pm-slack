# Durable Slack outbox validation

Implementation: `0403120189a39ffb76d495324b24ffe4b7334a90`.
PR: [Keep enabled Slack lifecycle notifications across restarts](https://github.com/unbraind/pm-slack/pull/147).

The [implementation CI run](https://github.com/unbraind/pm-slack/actions/runs/39670707658)
passed its complete release gates at unchanged thresholds:

| Node | Command | Passed | Failed / skipped / canceled | Lines / branches / functions |
| --- | --- | ---: | --- | --- |
| 22 | `npm run release:check` | 283 | 0 / 0 / 0 | 100% / 100% / 100% |
| 22 | `bun run release:check` | 283 | 0 / 0 / 0 | 100% / 100% / 100% |
| 26 | `npm run release:check` | 283 | 0 / 0 / 0 | 100% / 100% / 100% |
| 26 | `bun run release:check` | 283 | 0 / 0 / 0 | 100% / 100% / 100% |

Each job also passed native `bun test/bun-outbox.acceptance.ts`: one missed
lifecycle event recovered, one acknowledged localhost send, and zero duplicate
sends after reopening storage. Its plain tracker runs with a git ceiling and a
PATH containing no git executable. The release scripts launch the existing Node
test suite; the separate native acceptance checks Bun's SQLite and SDK execution.
The PR checks record the final head after documentation and tracker handoff.

Local verification used targeted tests because the shared host was CPU saturated:

```bash
npm run typecheck
npm run build:test
npm run docstring
git diff --check
node --test --experimental-test-coverage --test-coverage-include=outbox.ts --test-coverage-include=index.ts test/outbox.test.ts test/coverage.test.ts test/features.test.ts test/smoke.test.ts test/digest-corpus.test.ts
```

All 216 targeted tests passed. Both production modules measured 100% lines,
branches and functions. The docstring gate checked 76 declarations. There is no
standalone lint script. The pinned CLI's
`pm test pm-slack-3e7d --run --progress` also passed all 10 outbox regressions.
Existing policy disables persistent linked-run receipts; item comments retain
the measured result without changing that policy. Changelog generation and its
check passed after tracker writes.

Five independent behavioral reversions failed their regressions: removing
enqueue persistence, forgetting acknowledgment state, removing history recovery,
bypassing durable hook integration, and restoring the Node-only SQLite loader
under native Bun. All source functions and emitted artifacts were restored.
The crash fixture uses a real child process that exits after a real localhost
server accepts the request but before the acknowledgment is stored. Restarting
does not resend its held receipt; explicit reconciliation acknowledges it.
Concurrent processes claim one queued intent and produce one acknowledged send.

A read-only non-git archive of the public `unbraind/pm-slack` tracker at
`f4dce1dcf2b291a99d6c9e3f99fb529b104c707f` supplied the real-data validation:

| Measurement | Result |
| --- | ---: |
| Complete SDK item corpus | 85 |
| Verified history entries inspected | 515 |
| Immutable tracker source files | 177 |
| Pre-enable events incorrectly queued | 0 |
| Snapshot intents derived from public records | 85 |
| Acknowledged localhost sends after reopening | 85 |
| Duplicate sends after a second drain | 0 |
| Immutable source files changed | 0 |
| Inspection rows / explicitly omitted rows | 10 / 75 |

Installed CLI acceptance also verified 217-byte empty-status TOON, 255-byte JSON,
and a structured `disabled` refusal with exit status 2 and an enable remedy.
The package's scoped renderer preserves null fields and empty tables; structured
nonzero results preserve refusal codes across the pinned host's error boundary.
The existing SDK development pin remains 2026.10.15; the declared compatibility
floor now matches that verified API baseline.

Delivery evidence uses localhost sinks, not a live Slack workspace. Incoming
webhooks cannot distinguish every crash or dropped-response outcome. Such
receipts remain visible until explicitly reconciled, and explicitly retrying
uncertainty can duplicate a post. Keep runtime receipts and retained lifecycle
history durable on local storage. Remote tracker backends and network-shared
SQLite files are outside this local outbox contract.

Initial-run reviewer availability (2026-10-21): Greptile reported an expired trial,
Sourcery reported a budget limit, CodeRabbit skipped automatic review, and cubic
returned neutral. Those initial-run outcomes supplied no completed review
evidence. Later rounds on 2026-10-22 include completed CodeRabbit reviews and
findings, with fixes and validation recorded below and on the PM item; the
initial availability statement does not describe those later rounds. The PM
item stays nonterminal and unclaimed for orchestrator verification; this change is not merged or released.

## Review follow-up

The three remaining review findings are valid. The published SDK example now
returns the typed refusal's nonzero exit status. The built-in transport preserves
socket error codes and retries only pre-request DNS/connection refusals; HTTP
response text cannot force a retry. A retry ends the drain, and the next drain
prefers fewer-attempt intents before older rows so another destination can proceed.
The example uses the same pre-request classification. A partial response reset
rejects the transport attempt and retains an ambiguous receipt.

Real non-git trackers and localhost HTTP regressions cover these paths. Individual
behavioral reverts fail for the example exit status, example fetch classification,
transport cause, outcome classification, drain stopping, next-drain ordering, and
partial-response error handling. Every mutation is restored before gates/builds.

Follow-up validation: `npm ci` passed; both `npm run release:check` and
`bun run release:check` passed 288 tests with zero failures, skips or cancellations.
Both production modules retain 100% lines, branches and functions at unchanged
thresholds. The docstring gate covers 77 declarations. All seven tracker-linked
commands pass, including native Bun acceptance with one recovered lifecycle,
one acknowledged send, zero duplicates and no git. Clean-clone strict tracker
health with installed merge drivers passes all ten checks under isolated HOME;
remaining telemetry queue, stale-work and historical provenance notices are
advisory. Local/global extension version skew was isolated from that result.

## Indexed recovery and resolver portability

Receipt existence now derives the same stable primary key as enqueue and searches
that key. A real non-git tracker regression retains 64 receipts, checks the
published key format and present/absent revisions, and measures the query plan of
the actual existence SQL against SQLite. Reverting only `has` reports
`SCAN delivery` and fails the required indexed-search assertion; restored code
passes. Query observation delegates all operations to the real database.

The unresolvable-host assertion accepts either `ENOTFOUND` or `EAI_AGAIN` and
checks retry classification. A real HTTP Agent with a controlled lookup produces
`EAI_AGAIN` deterministically. Restoring only the old strict assertion fails with
`EAI_AGAIN` versus `ENOTFOUND`; restored code passes. Both temporary mutations are
restored before builds and gates. Previous review fixes remain intact.

Latest-round validation: `npm run release:check` and `bun run release:check`
each pass 290 tests with zero failures, skips or cancellations. Both production
modules retain 100% lines, branches and functions at unchanged thresholds. All
eight tracker-linked commands pass, including 17 outbox tests and native Bun
acceptance (one recovered event, one acknowledged send, zero duplicates, no git).
Clean-clone strict tracker health under isolated HOME passes all ten checks with
only the existing stale-work and historical provenance advisories. No gate retry
was needed. Exact installed dependency pins are unchanged and verified.

## Refusal isolation and bounded recovery

This follow-up supersedes the earlier pending-refusal and whole-scan refusal
behavior. Destination mismatches park a `refused` receipt without counting a
network attempt, then continue to healthy pending rows. Explicit `skip` records
`skipped` without claiming delivery; restoring the original route permits retry.
An ambiguous outcome holds subsequent rows for the same destination during that
drain. Reads never drain, and lifecycle hooks attempt at most one delivery.

Explicit force reconciliation supports reused sender PIDs while default
reconciliation still protects active processes. Force requires an operator to
verify that no sender remains active; otherwise duplicate delivery is possible.

Recovery stages each verified history stream before publishing its intents. Bad
streams are counted independently, and existing queued receipts still drain when
history is unavailable. Partial recovery reports `history_unavailable`, failed
counts and exit status 2 in JSON and TOON. SDK examples preserve this signal and
still deliver healthy frozen receipts. Eligibility snapshots recorded at enable
and explicit future-only configuration prevent wider current filters from
backfilling stale history, including before the first recovery scan. Legacy
queues remain drainable; adopting a policy starts future history recovery.

Eleven independent behavioral reverts failed as expected: destination parking,
per-destination ambiguity hold, read-hook suppression, one-attempt hook bound,
SDK force reconciliation, CLI force wiring, per-stream history isolation,
CLI progress despite global history failure, historical eligibility epochs,
and SDK example handling of refused receipts and incomplete history. Every
mutation was restored before builds. Detailed expected/actual outcomes and
regression commands are retained on the package PM item. Tests use real SQLite,
non-git SDK trackers and localhost sinks; no live Slack delivery is claimed.

Final follow-up gates: `npm run release:check` and `bun run release:check`
each passed 302 tests with zero failures, skips or cancellations. Both production
modules retain 100% lines, branches and functions at unchanged thresholds. All
nine tracker-linked commands pass, including 29 outbox tests, 14 focused
regressions and native Bun acceptance (one recovered lifecycle, one acknowledged
send, zero duplicates, no git). The linked full outbox suite timed out twice at
120 seconds during parallel host load; a focused retry with a per-run 300-second
window passed in 83.282 seconds. Assertions, stored test metadata and thresholds
were unchanged. Both full release gates passed without retry. Clean-clone strict
PM health passed all ten checks, with one existing historical provenance
advisory. The docstring gate covers 81 declarations; production audit reports
zero vulnerabilities and package validation includes 14 files. Existing policy
disables persisted linked-run receipts; results are recorded on the PM item.

## Redirect and storage-error follow-up

The SDK example refuses fetch redirects, leaving the original POST ambiguous
even when a redirected endpoint would refuse its connection. A real localhost
307 regression checks the persisted ambiguity, attempt count and absence of an
automatic resend. Recovery now distinguishes receipt database exceptions from
retained-history failures at each database boundary, preserving typed refusals.
Real SQLite missing-table, busy-write and read-only-write regressions require
`storage_unavailable` with a runtime storage remedy. Clearing each storage fault
recovers the same byte-identical retained history.

All five focused tests pass. Four independent behavioral reverts fail: removing
redirect refusal, restoring only the previous recovery function, removing only
the receipt lookup guard, and removing only the enqueue guard. Every mutation
was restored before builds and gates. The initial reviewer-availability paragraph
is dated to its 2026-10-21 introduction and explicitly distinguished from the
completed CodeRabbit reviews and findings on 2026-10-22. Detailed thread mappings,
commands and expected/actual revert outcomes are retained on the PM item.

Final validation after reserving the redirect target port to prevent fixture
port reuse: both `npm run release:check` and `bun run release:check` passed
307 tests with zero failures, skips or cancellations. Both production modules
retain 100% lines, branches and functions at unchanged thresholds. The docstring
gate covers 82 declarations, production audit reports zero vulnerabilities, and
package validation contains 14 files. All ten linked commands passed, including
34 outbox tests and native Bun acceptance; the final five-test linked regression
command passed again after the deterministic fixture change. No test timeout or
failure retry was needed in this round. All four behavioral revert proofs were
rechecked after that fixture change and restored before the final gates.
