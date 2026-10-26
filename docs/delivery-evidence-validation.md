# Delivery proof across complete receipt lifecycles

Review of PR 160 identified a false non-delivery claim: Slack can accept a
request, its response can time out, and an operator can subsequently skip it.
The receipt label is then `skipped`, but the delivery outcome remains uncertain.

`deriveSlackDeliveryOutcome` is the single outcome reducer for explanations,
outbox status/plain drain reports, and coalescing preview/retained manifests.
Both JSON and TOON expose per-row outcomes and independent aggregate `outcomes`.
Compatibility `counts` describe work states only. Tracker digest counters describe
item activity; the package has no separate receipt doctor/metrics classifier.

The reducer consumes read-derived sufficient statistics over immutable
`attempt_started` / terminal record pairs. Terminal facts are `confirmed`,
`not_sent`, `rejected`, or `unknown_after_send`; a primary key permits one terminal
fact per attempt. Any confirmed attempt proves `delivered`. Otherwise any
unknown/open-after-dispatch attempt or incomplete legacy journal gives
`uncertain`; otherwise the event is `withheld`. Operator decisions never supply
transport proof and do not modify past records.

Started records commit with claim ownership under the SQLite writer transaction.
A separate `request_dispatched` marker commits immediately before the HTTP API.
A shared finally path closes senders after normal responses, pre-request
refusals, exceptions, cancellation and retirement/replacement. Terminal records
are durable before scheduling cleanup and are retried after a transient cleanup
fault. Claim failures also close any committed start before propagating failure.
Recovery only closes dead owners: no dispatch marker means `not_sent`; dispatch
without a durable terminal means `unknown_after_send`. Live retired senders keep
the right to append their real terminal result without changing a peer's claim.
Neither the former claims counter nor the compatibility network counter supplies
evidence or scheduling priority. Existing old journals are imported without
rewriting them. Read-only explanations never create or migrate tables.

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

Seed `0xc1a551f1` additionally exercises late refusals, sender retirement and
replacement, forced retry/abandon, exceptions before/after dispatch, cancellation,
and replay. Measured seeded run: **500 sequences, 734 HTTP requests, 201 delivered,
159 withheld, 140 uncertain**. Every clean sender exit has no open attempt.
A separate test discovers every persistence/transport boundary and injects both
an exception and a real process crash before and after each step. Its reference
uses the scheduled dispatch/terminal boundary and recording fake Slack, never
workflow labels or production normalization. The fixed late-refusal/forced-abandon/
confirmed-retry scenario asserts withheld before retry and delivered afterward.
Measured boundary run: **32 exception injections, 32 real process crashes**,
plus **28 forced-retry and 28 forced-abandon replacement boundaries**. Every
clean exit is checked for zero open attempts before running recovery. The complete
linked journal suite passed **144 tests / 0 failures** in 146 seconds.

The current behavioral revert proof and exact-head CI counts are recorded in
the linked pm item and PR. Earlier skipped-to-withheld revert proof remains
recorded there as well.

Native compiled Bun acceptance verifies two uncertain proofs survive operator
acknowledgment, alongside recovered/coalesced HTTP delivery and peer ownership.
The complete unchanged npm/Bun release gates run in CI on Node 22 and 26; the PR
records exact-head run URLs, source coverage and final counts.

Full product-head validation at `229804683b8bb88b9505dd99c7d2809ff112f396`:
[CI run 40334571915](https://github.com/unbraind/pm-slack/actions/runs/40334571915)
passed npm and Bun release gates on Node 22 and 26: **744 passed / 0 failed per
gate**, **100% lines / branches / functions across all five sources**, with
unchanged thresholds. Both native compiled Bun acceptance jobs passed. All four
model runs reproduced the measured sequence/request/outcome totals above.
[CodeQL](https://github.com/unbraind/pm-slack/actions/runs/40334572040) passed.
The PR records the final evidence commit's exact-head CI URL and counts.
