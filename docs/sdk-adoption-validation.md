# SDK lifecycle recovery validation

Tracker: [pm-slack-3so4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-3so4.toon), related to [pm-slack-fitn](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-fitn.toon).

| Audit finding | Result | Evidence |
| --- | --- | --- |
| `index.ts:1931`: enumerate history to discover lifecycle events | Primary candidate discovery uses compact `listMutationEvents` pages and opaque `next_cursor` values. SDK authoritative readers and `verifyHistoryEntries(history, currentDocument)` verify each candidate before cursor continuation or any recovery decision. Cached event payloads are never consumed. | `test/sdk-recovery.test.ts`; corruption properties and differential proof below |
| Retained events outside canonical feed coverage | Keep isolated verified SDK history reads and retained-history discovery fallback. Filename identities, using SDK folder/format mapping, nominate malformed or unreadable candidates too. | Legacy/offset timestamp regressions; mixed-input properties and missing-file/valid-prefix tests |
| `index.ts:1982-1994`: renderer shape checks | Already uses SDK command-owned `registerRenderer`; retain local checks as the audit requests. No missing SDK API. | Existing renderer and CLI TOON tests |

The SDK feed supplies event discovery. Retained-history fallback and filename identity discovery remain necessary where SDK coverage or unreadable-inclusive inventory APIs are missing. Authoritative verification remains SDK-owned. No SDK dependency version or coverage threshold changes.

## Authoritative verification boundary

`readVerifiedOutboxHistory` uses SDK `readHistorySnapshot`, `locateItem`, `readLocatedItem`, `isTimestampLiteral` and `verifyHistoryEntries` against authoritative files. Missing histories, empty entry sequences, invalid wire shapes, and missing/unreadable/malformed current documents return typed refusals. The current document is mandatory: `undefined` never reaches SDK verification. A verified chain must match that authoritative document. Each failure is counted once and included in `recovered.failures` with `item`, `code: history_unavailable` and a safe `reason`; that item queues nothing.

Identity discovery does not parse documents or invoke a strict whole-corpus metadata read. `resolveItemTypeRegistry` and `getItemPath` supply SDK folders and extensions; filename enumeration retains malformed, zero-length and unreadable candidates. Directory errors are reported as `_inventory` failures while other folders continue. Absent empty type directories are not verification inputs; known candidates still require their documents and histories. A missing entire history directory produces per-item failures whenever current candidates are known.

Missing pinned SDK API: an unreadable-inclusive identity/path iterator with typed per-row failures. Strict inventories abort, while lenient candidate APIs omit malformed documents. This narrow filename enumeration remains necessary; document parsing, history parsing and verification stay SDK-owned. The minimal wire-shape guard is needed because the authoritative reader returns parsed JSONL without a public runtime entry-shape validator. Hash verification remains the SDK's responsibility.

All projected intents for one item are prevalidated through the same pure validator used by outbox enqueue before the first write. An invalid historical priority, routing value or delivery context cannot leak an earlier buffered intent or block a healthy neighbor. Receipt-storage and destination configuration errors retain their operational refusal behavior.

Every candidate in a page is verified or recorded as a typed failure before continuing the discovery cursor. Cursors are local to one complete discovery pass; none is persisted or acknowledged. The next recovery starts from the beginning, including previously failed items. Discovery contributes filename identities only; authoritative item bytes are read separately before acting.

Audit of all replacements in this PR: recovery is the only direct-read replacement. Digest `listAllComplete` and command-owned SDK renderer registration predate this PR and remain unchanged. The newly used candidate inventory is not trusted for item contents or history integrity.

The seeded corruption property primes the real SDK index, then tests eight operators (same-size record-hash edit, same-size attribution-byte edit, partial-tail truncation, valid-prefix truncation, record reorder, deleted file, duplicated record and empty file), three seeds and both in-process/fresh-process recovery: 48 cases. Every case requires zero inspected entries, zero queued intents, one reported failure, unchanged opt-in and eligibility, and the same refusal on a filtered retry. A separate CLI regression verifies an authoritative item mismatch returns exit 2 with `history_unavailable` and queues nothing. The fixtures have real state-changing records, and all run without a git executable.

Round-2 mixed-input property: six runs (three seeds, with/without actual process restart), 17 items per run, and a primed SDK cache before damage. Each run has 12 randomly assigned damaged inputs and five healthy items. Damage includes zero-length/missing/invalid/unreadable/wrong-identity documents; missing document plus history truncated to its valid create record; partial/reordered/forged/missing/empty/null histories. Each first capture queues exactly ten healthy transitions and reports all 12 damaged IDs with typed reasons. A second capture queues zero and repeats the same failure list. Across runs: 102 item instances, 72 damaged instances refused, 60 healthy transitions recovered exactly once, and zero damaged intents.

Explicit additional cases cover wrong timestamp/operation/patch wire shapes, unreadable inventory directories, a missing whole history directory, and invalid historical projections. These all preserve unrelated healthy recovery. Verification audit: missing snapshot bytes, empty entries, unavailable current documents and invalid entry shapes are explicit failures. Optional filters and discovery fallbacks define request/discovery scope; they never substitute for a required verification input. Historical unknown priority retains the package's documented default, rather than weakening document or history verification.

Explicit SDK-hashed historical fixtures also cover temporarily invalid identity/title fields followed by a valid current snapshot: recovery reports failure without publishing even an earlier buffered intent. A historical snapshot without priority retains the documented default of 4 in its persisted delivery context. These cases make legacy-field coverage independent of incidental fixtures or timing. Failed coverage gates print zero-hit LCOV source branches without changing thresholds or failure status.

SDK gap: after priming, same-size authoritative edits can still yield `source: derived_index` rows whose cached chain verifies, including after process restart. The page exposes no authoritative history integrity or completeness receipt. `source`, cursor and `has_more` do not attest that the bytes remain valid. Therefore cached event rows cannot replace authoritative SDK reads and verification. No upstream issue was filed.

## Current SDK 2026.10.25 reproduction

**Still reproduces: yes.** Tested with exactly version 2026.10.25 installed in an independent temporary project; this repository's pin and lockfile stayed unchanged. In an empty non-git project, create `package.json` with `type: module`, install the named version, copy the script beside that project's `node_modules`, and run it:

```bash
NPM_CONFIG_USERCONFIG=/dev/null npm install --ignore-scripts --no-audit --no-fund @unbrained/pm-cli@2026.10.25
cp "$PACKAGE_CHECKOUT/scripts/reproduce-sdk-event-cache.ts" ./reproduce.ts
node reproduce.ts
```

Exact minimal SDK steps: initialize a tracker, create one item, prime `listMutationEvents({ full: true })`, replace one hex byte of its authoritative `record_hash` without changing file byte length, then read full events both in-process and after a process restart. In both processes, the page returns `source: derived_index` and its cached chain verifies, while `readHistoryEntries` plus `verifyHistoryEntries` on authoritative bytes fails. Returned page fields are `count`, `cursor_mode`, `events`, `has_more`, `next_cursor`, `source`; no integrity/completeness receipt is exposed. The script creates only disposable trackers and prints no paths or content.

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

Round-2 separate reverts retain the new tests and all other fixes. Restoring only the strict whole-corpus inventory makes all six mixed cases abort (seven reported failures including the parent). Restoring only the optional-document reader from head `396cfb5`, plus its required SDK import, makes all six mixed cases queue 13 instead of ten intents: missing documents silently disable current-state comparison. Restoring both fixes passes all six cases. Both proofs are recorded in append-only pm comments.

The sealed-offset regression originally failed before adding authoritative reads: the SDK projection reported zero inspected entries, zero queued intents and one failed stream, instead of two inspected entries, two intents and zero failures. Authoritative reads are now unconditional, preserving the original sealed timestamps as well as proving source integrity. The earlier SDK normalization gap remains: `listMutationEvents({ full: true })` changes a sealed entry's `+00:00` timestamp to `Z`, invalidating its record hash. Byte-faithful entries alone would still need an authoritative integrity/completeness receipt to replace direct verification safely. No upstream issue was filed.

## Checks

The linked tracker test runs typecheck, test typecheck, the docstring gate and the recovery/outbox regressions: 114 passes. The tracker disables persisted test-result recording, so `pm test --run --progress` returns a local receipt; item comments retain results without changing policy.

The full suite reports 552 passes and 100% lines, branches and functions across all three shipped source files. The release checks enforce these unchanged thresholds, production dependency audit, package contents, changelog consistency and release-workflow verification. CI runs both complete npm and Bun gates on Node 22 and 26, plus native Bun outbox acceptance.

No lint script is configured; typecheck and the docstring gate provide the package's configured static checks. Clean-home strict tracker health passes. Historical provenance has an existing advisory; history is left append-only.
