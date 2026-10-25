# SDK lifecycle recovery validation

Tracker: [pm-slack-3so4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-3so4.toon), related to [pm-slack-fitn](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-fitn.toon).

| Audit finding | Result | Evidence |
| --- | --- | --- |
| `index.ts:1931`: enumerate history to discover lifecycle events | Primary discovery uses `listMutationEvents({ full: true, limit: 1000 })` and follows opaque `next_cursor` values. Full entries are grouped by item and replayed in stream-version order. | `test/sdk-recovery.test.ts`; differential proof below |
| Retained events outside canonical feed coverage | Keep the explicit verified-history fallback when the strict feed is unavailable or its normalized projection fails integrity verification. A malformed stream remains isolated; healthy receipts still drain. | Legacy and sealed-offset timestamp regressions; existing corrupt-history, storage-fault and uncertainty tests |
| `index.ts:1982-1994`: renderer shape checks | Already uses SDK command-owned `registerRenderer`; retain local checks as the audit requests. No missing SDK API. | Existing renderer and CLI TOON tests |

The replacement removes six original lines from `index.ts`, including the primary file-enumeration loop. Enumeration exists only in the required fallback. No SDK dependency version or coverage threshold changes.

## Differential proof

`scripts/verify-sdk-adoption.ts` compiles the baseline from git objects with the package's pinned dependencies, builds the candidate, and exports only committed public tracker files from supplied repositories' `origin/main`. It probes independent copies in non-git directories with no git executable. Copied authoritative files are read only, and their hashes must remain unchanged. Runtime indexes and disposable delivery databases are writable. The disposable outbox's opt-in boundary is set before the retained events, so historical notifications are exercised without changing the source histories.

Example invocation, with the second public checkout supplied by the caller:

```bash
node scripts/verify-sdk-adoption.ts 5c0bd37fa16a42956c6b2e33e491163f04a3d9a9 . "$PUBLIC_STANDUP_CHECKOUT"
```

| Public tracker snapshot | Inspected entries | Queued intents | Failed streams | Exact payload/receipt matches |
| --- | ---: | ---: | ---: | ---: |
| pm-slack `5c0bd37fa16a42956c6b2e33e491163f04a3d9a9` | 700 | 230 | 0 | 230 |
| pm-slack-standup `f1d1187f4b5c447f4d6f03c24353298cabaa598c` | 881 | 237 | 0 | 237 |

Both runs compare complete frozen payloads, revision keys, delivery ordering, eligibility contexts, repeated captures, item-filtered captures and ambiguous-destination holds. All outputs matched; all authoritative bytes remained unchanged; no network sends occurred. There are zero intentional output differences. The SDK can rebuild its disposable derived event index, unlike the old implementation.

## Revert proof

With only `captureSlackOutbox` replaced by its baseline implementation, the pagination test in `node --test test/sdk-recovery.test.ts` fails because the canonical SDK projection was not rebuilt. The retained-history fallback tests still pass. Restoring the function gives three passes. This proof is also recorded in the adoption item's comments.

The sealed-offset regression separately failed before adding the per-item authoritative fallback: the SDK projection reported zero inspected entries, zero queued intents and one failed stream, instead of two inspected entries, two intents and zero failures. The corrected function preserves the baseline behavior. SDK gap for upstream follow-up: `listMutationEvents({ full: true })` normalizes a sealed entry's `+00:00` timestamp to `Z`, invalidating its immutable record hash. A byte-faithful authoritative full-entry projection would remove this fallback need. No upstream issue was filed.

## Checks

The linked tracker test runs typecheck, test typecheck, the docstring gate and the recovery/outbox regressions: 39 passes. The tracker disables persisted test-result recording, so `pm test --run --progress` returned a local success receipt; the item comments retain the result without changing policy.

The full suite reports 477 passes and 100% lines, branches and functions across all three shipped source files. The release checks enforce these unchanged thresholds, production dependency audit, package contents, changelog consistency and release-workflow verification. CI runs both complete npm and Bun gates on Node 22 and 26, plus native Bun outbox acceptance.

No lint script is configured; typecheck and the docstring gate provide the package's configured static checks. Clean-home strict tracker health passes. Historical provenance has an existing advisory; history is left append-only.
