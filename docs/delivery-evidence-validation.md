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
The HTTP transport appends confirmed evidence before returning to the caller.
`AsyncLocalStorage` carries the per-attempt context through wrappers; unrelated
concurrent senders keep separate contexts. Only absence of a dispatch marker
authorizes `not_sent`, regardless of exception type/code. Exceptions after
dispatch give `unknown_after_send` unless a confirmed response was already
observed. A transient append failure after confirmation retains that fact in
memory for finally/retry.
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

## Shared transition semantics and error-boundary models

`classifySlackTransition` is the single exported transition classifier. The hook
adapter, authoritative recovery capture, read-only explanation and digest buckets all call it
using the SDK status registry from tracker settings and SDK alias normalization. Configured roles override
literal spelling; literal fallback exists only inside this function. Missing or
non-lifecycle roles do not manufacture notifications. A fixed fixture assigns
`done` the blocked role, captures a block receipt, confirms it, and explains it.

A second fixed fixture sends successfully and then throws typed
`OutboxError("storage_unavailable", ...)`; the outcome remains delivered with
one attempt. Seed `0x0d15fac7` generates 500 typed/untyped failures at four
boundaries: before dispatch, after dispatch, after response, and immediately
before terminal append. Error codes vary independently of phase; no clean exit
leaves an open pair. Seed `0x0c1a551f` generates 50 SDK status registries and 500
transitions, including renamed statuses, literal collisions, role-less
and omitted-role definitions. Every captured receipt is read through explanation
and checked against the independent SDK-role model.

Current continuation results, separate behavioral revert proofs and exact-head
CI counts are linked from the pm item and PR; earlier measured gates above remain
historical evidence at their stated heads.

Current targeted measurements: **140/140** classifier/digest/hook and boundary
tests, plus the SDK fallback/alias unit and **3/3** linked fixed cases. The complete
send fault trace has **34 boundaries**, each tested with an untyped exception,
a typed OutboxError and a real process crash. Separate behavioral reverts fail
**1/1 each**: the former attempt functions report withheld after a confirmed
post; the former capture path labels blocked-role done as close. Exact source
bytes are restored after each proof. The 500-case error model measured **250
delivered / 125 withheld / 125 uncertain**; the 50-registry model explained **358
distinct captured receipts** across 500 transitions. CI runs the expanded nine-code
generator (all 36 typed code/phase combinations).

The updated public validator reproduced **90 items / 746 entries / 232 complete
paths / 83 urgent policies**, **zero network calls**, **1415 JSON / 1094 TOON
maximum bytes**, and unchanged tracker bytes on a read-only non-git export of
public main `e23ecfe839fbb85c55e47a1cd325abf153593d4d`.
