# Destination migration validation

Measured against the public pm-slack tracker at main
`911d78a8ac5bc5782513631c5fe6da70429cf37e`, exported into a non-git directory.
Source files and directories were read-only. The public SDK read the complete
tracker, verified each history stream and replayed lifecycle snapshots with the
configured status registry. A separate disposable tracker owned the writable
delivery outbox. No hosted tracker or live webhook was accessed.

| Measurement | Result |
| --- | ---: |
| Items / verified history streams | 94 / 94 |
| Verified history entries | 849 |
| Lifecycle events / unique queue entries | 240 / 240 |
| Reviewed binding revision | 2 |
| Movable events / events moved | 237 / 237 |
| Retained uncertain events | 3 |
| Preview rows / explicitly omitted rows | 20 / 220 |
| Replay moves / duplicate queue entries | 0 / 0 |
| Remote posts | 0 |

Three synthetic ambiguous transport results were applied to real public event
identities; one was explicitly retried before preview. All three retained their
original route and uncertainty. Other events moved once, while original-input
replays preserved their queue identities. The full SDK-read native state and
all source tracker bytes stayed identical; preview also preserved the writable
outbox database bytes. Source SHA-256:
`ede8219db3a0cd30d13e9d3dd0e8f4819359115c37f19be71e040cd026f170d0`.

The measurement uses SDK history version plus `after_hash` for each synthetic
intent revision. Existing production recovery's repeated-state-hash limitation
is tracked separately by `pm-slack-rjb1`; this change does not alter that identity
contract. No external API delivery or hosted backend claim follows from these
local measurements.

Reproduce with `node scripts/validate-destination-migration.ts <exported-pm-root>`.
The argument is an explicitly exported public tracker, not a live operational
tracker. The helper reports aggregate counts only and removes its scratch outbox.

`test/destination-migration.test.ts` includes 500 fixed-seed operation sequences
(4000 generated operations) with old-input and old-plan replays, CRLF/whitespace,
all payload fields, native tracker metadata and parent relationships, random
ambient focus, queue/binding ABA, refusal inputs, output codec round trips and
current state read through the real package/host SDK. Existing role-registry
property tests cover 500 transitions across 50 arbitrary status configurations.
SQLite-boundary tests inject peer claims/bindings and interruptions at every
executed step. There are no SDK mocks. Packed acceptance is reproducible with
`npm run acceptance:migration`; it captures one artifact and exercises npm
global, Bun global, npx, bunx and project-local pm hosts. Native Bun acceptance
also exercises a move, old-input replay and committed-plan retry with zero posts.
