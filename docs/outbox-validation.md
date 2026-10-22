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

Automated reviewer availability is separate from passing CI: Greptile reported an
expired trial, Sourcery reported a budget limit, CodeRabbit skipped automatic
review, and cubic returned neutral. These are missing review evidence. The PM
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
