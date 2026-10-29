# Payload compilation validation

The real-data probe reads Git objects from public `unbraind/pm-slack` main at
`d01c295bb719b74df06d075b4df9d6719cfd3cda`. It extracts only the tracker to a
non-git scratch directory, makes the copy read-only, removes git from PATH and
uses complete certified SDK reads. It checks all copied bytes and permissions
before and after, and repeats every successful compilation.

Command: `node scripts/validate-payload-public.ts . origin/main`.

| Measurement | Result |
| --- | ---: |
| SDK items / successful compilations | 96 / 96 |
| Typed refusals | 0 |
| Exact text clipping receipts | 1 |
| Whole-field/block omissions | 0 |
| Maximum payload bytes / blocks | 3,312 / 4 |
| Total payload bytes | 95,944 |
| Identical repeat compilations | 96 |
| Unchanged copied tracker files | 199 |
| Tracker mutations / Slack posts | 0 / 0 |

The focused test adds oversized text/blocks, exact UTF-16 boundary cases,
malformed and must-allow corpora, nonfinite extreme input, actual transport
refusal before sockets, and 500 seeded compilation/replay sequences. Its SDK
reference state is read back from a real non-git tracker, including custom
status registries, native identity/priority/assignment fields, relationships,
CRLF and whitespace variants. This feature adds no import/sync/apply path.
Repeated-reference inputs that would expand to gigabytes refuse during parsing,
before aggregate JSON serialization can allocate that expansion.

`node scripts/prove-payload-revert.ts` changes only the compiler function or
pre-send guard in a disposable copy: restoring unbounded pass-through behavior
must fail; removing pre-send validation must fail; restoring both must pass.

`npm run acceptance:payload` captures one npm tarball and validates its files and
SHA-256 while reusing those exact bytes through project-local, npm global, Bun
global, npx and bunx hosts at pm 2026.10.28. Each shape exercises SDK acquisition,
TOON/JSON parity, bounded wire output, oversized raw source and receipt paging.
No webhook is configured or contacted.

Full npm and Bun release gates run in CI at unchanged coverage thresholds.
Initial local verification stayed focused. Re-review R1 additionally runs complete npm and Bun gates serially with at most two test workers.

## Re-review R1: bounded work and owned permission changes

The compiler now traverses source leaves once for protection and element trimming,
tracks structural blocks by indexed leaf counts, and encodes each block once for
byte budgeting. Removing a block adjusts exact integer byte/comma costs instead
of filtering and serializing the collection repeatedly. Fallback fitting only
encodes the candidate string. JSON/TOON share this same compilation path.

`test/payload-scale.test.ts` exercises 20,000 and 50,000 one-character fields,
dense context elements, mixed structural blocks, and large byte-budget removals.
It checks collection-callback and serialization-volume budgets proportional to
input size, independently of wall-clock speed. A bounded child lifetime catches
other stalls. Captured npm/Bun consumers repeat all five shapes and the dense
CLI JSON/TOON case using the same helper.

Archive permission setup inventories every entry before its first mutation and
rejects symlinks, shared file inodes and special files. Chmod uses no-follow file
descriptors checked against captured device/inode identity. Cleanup makes only
owned directories writable, treats links as leaves, and never chmods linked
files. Both public-archive probes use the shared implementation, including their
failure cleanup. The outbox constructor and migration write path use the same
descriptor guard and refuse linked runtime components, database files and
SQLite sidecars. Existing read-only inspection remains compatible with valid
legacy stores and does not introduce permission changes.

The audit also checked coalescing, migration/routing reports, CLI renderers,
source walkers and packed consumers. Coalescing's eight event passes are a
constant factor; migration report passes are linear. Read-only fingerprints and
operator-path resolution do not mutate permissions. Package-wide lexer checks
reject new pathname chmod aliases and recursive shell chmod commands.

`node scripts/prove-review-r1.ts` restores each bad behavior in a disposable copy:
global source-leaf rescans, repeated payload serialization, the original archive
permission traversal, and unchecked pathname chmod must all fail. Restoring the
fix must pass. Tests cover real symlinks, hardlinks, dangling/chained/directory
links, replaced inodes, SQLite sidecars and a real linked Git archive, retaining
external sentinel bytes and permissions. A deterministic peer mkdir interleaving
accepts the peer's EEXIST success while real failures refuse.

These checks do not claim filesystem isolation from a process able to replace
the storage hierarchy concurrently. Permission changes act on a checked open
inode; SQLite path checks run immediately before open, leaving a remaining
path-check/open window. Scratch roots are private to each validation run.

Instrumented local R1 measurements (wall time is display evidence, not the work-budget oracle):

| Source | Input bytes | Callback visits | Bytes serialized | Wall ms |
| --- | ---: | ---: | ---: | ---: |
| 200 sections, 20,000 fields | 586,112 | 42,709 | 1,917,870 | 1,880 |
| 500 sections, 50,000 fields | 1,465,112 | 104,209 | 4,743,270 | 2,605 |
| 200 dense context blocks | 586,512 | 42,709 | 1,919,670 | 756 |
| 500 mixed structural/text blocks | 1,518,362 | 2,599 | 7,759,480 | 570 |
| 50 large field grids under byte pressure | 917,612 | 1,361 | 4,735,907 | 232 |
