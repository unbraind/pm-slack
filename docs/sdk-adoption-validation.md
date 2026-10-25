# SDK lifecycle recovery validation

Tracker: [pm-slack-3so4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-3so4.toon), related to [pm-slack-fitn](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-fitn.toon).

| Audit finding | Result | Evidence |
| --- | --- | --- |
| `index.ts:1931`: enumerate history to discover lifecycle events | Primary candidate discovery uses compact `listMutationEvents` pages and opaque `next_cursor` values. SDK authoritative readers and `verifyHistoryEntries(history, currentDocument)` verify each candidate before cursor continuation or any recovery decision. Cached event payloads are never consumed. | `test/sdk-recovery.test.ts`; corruption properties and differential proof below |
| Retained events outside canonical feed coverage | Keep isolated verified SDK history reads and retained-history discovery fallback. Current item identities also nominate candidates, so a deleted history file cannot disappear from the feed. | Legacy/offset timestamp regressions; missing-file, valid-prefix, corrupt-history and uncertainty tests |
| `index.ts:1982-1994`: renderer shape checks | Already uses SDK command-owned `registerRenderer`; retain local checks as the audit requests. No missing SDK API. | Existing renderer and CLI TOON tests |

Enumeration exists only in the required discovery fallback. The SDK feed replaces discovery, while authoritative SDK history verification remains mandatory. No SDK dependency version or coverage threshold changes.

## Authoritative verification boundary

`readVerifiedOutboxHistory` uses SDK `readHistoryEntries`, `locateItem`, `readLocatedItem` and `verifyHistoryEntries` against authoritative files. It verifies the whole retained stream and compares its newest hash with the current item before replay, eligibility, revision deduplication or intent publication. A failure is represented by a typed `OutboxError(history_unavailable)`, counted once in `recovered.failed`; that item queues nothing. Current-item comparison rejects deleted/empty history and valid-prefix truncation, even if the SDK rebuilds its index from the shortened stream.

Every candidate in a page is verified or recorded as a typed failure before continuing the discovery cursor. Cursors are local to one complete discovery pass; none is persisted or acknowledged. The next recovery starts from the beginning, including previously failed items. Candidate metadata from the complete-list inventory contributes identities only; authoritative item bytes are read separately before acting.

Audit of all replacements in this PR: recovery is the only direct-read replacement. Digest `listAllComplete` and command-owned SDK renderer registration predate this PR and remain unchanged. The newly used candidate inventory is not trusted for item contents or history integrity.

The seeded corruption property primes the real SDK index, then tests eight operators (same-size record-hash edit, same-size attribution-byte edit, partial-tail truncation, valid-prefix truncation, record reorder, deleted file, duplicated record and empty file), three seeds and both in-process/fresh-process recovery: 48 cases. Every case requires zero inspected entries, zero queued intents, one reported failure, unchanged opt-in and eligibility, and the same refusal on a filtered retry. A separate CLI regression verifies an authoritative item mismatch returns exit 2 with `history_unavailable` and queues nothing. The fixtures have real state-changing records, and all run without a git executable.

Explicit SDK-hashed historical fixtures also cover temporarily invalid identity/title fields followed by a valid current snapshot: recovery reports failure without publishing even an earlier buffered intent. A historical snapshot without priority retains the documented default of 4 in its persisted delivery context. These cases make legacy-field coverage independent of incidental fixtures or timing. Failed coverage gates print zero-hit LCOV source branches without changing thresholds or failure status.

SDK gap: after priming, same-size authoritative edits can still yield `source: derived_index` rows whose cached chain verifies, including after process restart. The page exposes no authoritative history integrity or completeness receipt. `source`, cursor and `has_more` do not attest that the bytes remain valid. Therefore cached event rows cannot replace authoritative SDK reads and verification. No upstream issue was filed.

## Differential proof

`scripts/verify-sdk-adoption.ts` compiles the baseline from git objects with the package's pinned dependencies, builds the candidate, and exports only committed public tracker files from supplied repositories' `origin/main`. It probes independent copies in non-git directories with no git executable. Copied authoritative files are read only, and their hashes must remain unchanged. Runtime indexes and disposable delivery databases are writable. The disposable outbox's opt-in boundary is set before the retained events, so historical notifications are exercised without changing the source histories.

Example invocation, with the second public checkout supplied by the caller:

```bash
node scripts/verify-sdk-adoption.ts 5c0bd37fa16a42956c6b2e33e491163f04a3d9a9 . "$PUBLIC_STANDUP_CHECKOUT"
```

| Public tracker snapshot | Inspected entries | Queued intents | Failed streams | Exact payload/receipt matches |
| --- | ---: | ---: | ---: | ---: |
| pm-slack `5c0bd37fa16a42956c6b2e33e491163f04a3d9a9` | 700 | 230 | 0 | 230 |
| pm-slack-standup `523c0786f085db52d585a7714598c90d38eeb3d0` | 900 | 243 | 0 | 243 |

Both runs compare 473 complete frozen payloads, revision keys, delivery ordering, eligibility contexts, repeated captures, item-filtered captures and ambiguous-destination holds. All outputs matched; all authoritative bytes remained unchanged; no network sends occurred. There are zero intentional output differences on healthy trackers. Corruption now intentionally fails closed even when a cached chain still verifies. The SDK can rebuild its disposable derived event index, unlike the original implementation.

## Revert proof

The original SDK-adoption proof replaced only `captureSlackOutbox` with its baseline implementation: the pagination regression failed because the canonical SDK projection was not rebuilt, while the two retained-history compatibility regressions passed. Restoring the function passed those original three regressions. This proof remains recorded in the adoption item's comments.

For the blocking review fix, reverting only `readOutboxMutationStreams` and `captureSlackOutbox` to the blocked PR head reproduces unsafe recovery in the seeded property, including same-size corruption after a real process restart. The authoritative verification helper remains present but unused in this behavioral revert. Restoring the functions makes all 48 cases refuse corrupt history.

The sealed-offset regression originally failed before adding authoritative reads: the SDK projection reported zero inspected entries, zero queued intents and one failed stream, instead of two inspected entries, two intents and zero failures. Authoritative reads are now unconditional, preserving the original sealed timestamps as well as proving source integrity. The earlier SDK normalization gap remains: `listMutationEvents({ full: true })` changes a sealed entry's `+00:00` timestamp to `Z`, invalidating its record hash. Byte-faithful entries alone would still need an authoritative integrity/completeness receipt to replace direct verification safely. No upstream issue was filed.

## Checks

The linked tracker test runs typecheck, test typecheck, the docstring gate and the recovery/outbox regressions: 93 passes. The tracker disables persisted test-result recording, so `pm test --run --progress` returned a local success receipt; the item comments retain the result without changing policy.

The full suite reports 531 passes and 100% lines, branches and functions across all three shipped source files. The release checks enforce these unchanged thresholds, production dependency audit, package contents, changelog consistency and release-workflow verification. CI runs both complete npm and Bun gates on Node 22 and 26, plus native Bun outbox acceptance.

No lint script is configured; typecheck and the docstring gate provide the package's configured static checks. Clean-home strict tracker health passes. Historical provenance has an existing advisory; history is left append-only.
