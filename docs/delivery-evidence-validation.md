# Delivery proof across complete receipt lifecycles

Review of PR 160 identified a false non-delivery claim: Slack can accept a
request, its response can time out, and an operator can subsequently skip it.
The receipt label is then `skipped`, but the delivery outcome remains uncertain.

`deriveSlackDeliveryOutcome` is the single outcome reducer for explanations,
outbox status/plain drain reports, and coalescing preview/retained manifests.
Both JSON and TOON expose per-row outcomes and independent aggregate `outcomes`.
Compatibility `counts` describe work states only. Tracker digest counters describe
item activity; the package has no separate receipt doctor/metrics classifier.

The reducer consumes sufficient statistics over the complete attempt journal.
Any unfinished/ambiguous attempt or incomplete legacy journal gives `uncertain`,
including after retry, skip, abandon, operator acknowledgment or another attempt's
success. With no unresolved attempts, a retained transport success gives
`delivered`; no attempts or exclusively definite rejection/pre-request refusal
gives `withheld`. Redirect and 5xx responses after sending remain uncertain.
Operator decisions are retained separately and never supply transport proof.

Claims, monotonic coverage counters and attempt tokens commit together under the
existing SQLite writer transaction. Completion records only its immutable token,
even if an operator already retired the work claim. It cannot release or overwrite
a peer's claim. Resolution records precede release. Missing attempts are detected
by the independent claim counter. The network counter also discounts known
pre-request refusals, so those records cannot mask an unjournaled older attempt.
Read-only explanations never create or migrate
these tables; old attempted receipts without a journal stay conservative.

`test/delivery-evidence.test.ts` drives 500 seeded operation sequences on one real
non-git SDK tracker through actual HTTP sending and resolve/drain paths. The
recording fake Slack covers success, definite rejection, 429 with Retry-After,
timeout after acceptance, pre-connect and post-send errors, 5xx, real child-process
death before durable completion, pre-request refusal and no-attempt abandonment.
It exercises plain/coalesced sends, skip/retry/abandon, input replays and restarts.
The independent oracle uses the fake's recorded acceptance/response observations,
never final receipt labels. Every sequence checks explanation and aggregate
outcomes. The real ClientRequest timeout is armed after the fake accepted the
request, preventing scheduler timing from changing the modeled fault.

Measured seeded run: **500 sequences, 870 HTTP requests, 79 delivered, 114
withheld, 307 uncertain**. The linked targeted run passed **18 tests**, including
all ten claim-publication SQL boundaries. Existing targeted outbox, coalescing,
routing and finish/reconciliation interleaving regressions passed **245 tests**.
The final CI gate includes additional CLI-abandon and redirect regressions.
The new evidence source measured **100% lines / branches / functions** locally.

Behavioral revert proof restored only the skipped-to-withheld mapping in the
explanation, retaining the new journal and reducer. The accepted-request/timeout/
skip test failed: **1 test, 0 passed, 1 failed**. After exact source restoration,
the same command passed **1/1**. Sources were restored before building.

Native compiled Bun acceptance verifies two uncertain proofs survive operator
acknowledgment, alongside recovered/coalesced HTTP delivery and peer ownership.
The complete unchanged npm/Bun release gates run in CI on Node 22 and 26; the PR
records exact-head run URLs, source coverage and final counts.
