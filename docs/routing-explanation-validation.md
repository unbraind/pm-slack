# Public-tracker routing explanation validation

Source: public `unbraind/pm-slack` main commit
`e23ecfe839fbb85c55e47a1cd325abf153593d4d`. Only tracked `.agents/pm`
files were exported to a non-git scratch directory and made read-only.
The pinned SDK ran with extensions disabled, a git discovery ceiling, and a
PATH containing no git executable. HTTP, HTTPS and fetch were instrumented to
reject and count any attempted network call.

Run `node scripts/validate-routing-explanations.ts <exported-tracker-root>`
against the same public snapshot to repeat the measurement.

| Measurement | Result |
| --- | ---: |
| Public tracker items | 90 |
| History entries inspected | 746 |
| Complete verified event paths | 232 |
| Named urgent policies | 83 |
| Uncertain without retained runtime receipts | 232 |
| Network calls | 0 |
| Maximum JSON bytes | 1287 |
| Maximum TOON bytes | 964 |
| Tracker bytes unchanged | true |

Before/after fingerprint:
`7d705863b3bbf648d5ea326dc84dfc3c7e5e33f70760d2265a5f42c97d6ca731`.
Public tracked data contains no runtime receipts, so all retrospective delivery
outcomes correctly remain uncertain. This validates explanation and privacy
behavior; it is not a live Slack delivery claim.

`test/routing-explanation.test.ts` covers retained suppression, route ordering
and shadowing, all durable transport states, named urgent policies, typed safe
refusals, foreign evidence, numeric extremes, 12 randomized configured status
registries, and 500 seeded policy sequences. Each sequence replays an older
SDK revision with JSON/CRLF policy variants and compares the current document
read back through the SDK, including native fields and a parent relationship.
No import/export/sync implementation or journaled plan is changed or introduced.

The read-only receipt path injects a competing delivery transition after every
actual SQL step boundary on the same non-git tracker. A report observes either
whole committed state, never a partial state/attempt pair. The existing package's
claim/retry/reconcile interleaving suite remains the release gate for unchanged
mutating outbox paths. Native Bun acceptance exercises the compiled SDK and CLI
explanation against acknowledged lifecycle evidence with no extra HTTP sends.

Behavioral reversion proofs force suppression to `uncertain` and remove urgent
policy selection independently. Each targeted regression fails (1 test, 0 pass,
1 fail); sources are restored before validation and build.
