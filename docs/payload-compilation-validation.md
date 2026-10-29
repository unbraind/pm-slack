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

`node scripts/prove-payload-revert.ts` changes only the compiler function or
pre-send guard in a disposable copy: restoring unbounded pass-through behavior
must fail; removing pre-send validation must fail; restoring both must pass.

`npm run acceptance:payload` captures one npm tarball and validates its files and
SHA-256 while reusing those exact bytes through project-local, npm global, Bun
global, npx and bunx hosts at pm 2026.10.28. Each shape exercises SDK acquisition,
TOON/JSON parity, bounded wire output, oversized raw source and receipt paging.
No webhook is configured or contacted.

Full npm and Bun release gates run in CI at unchanged coverage thresholds.
Local verification stays focused to avoid saturating the shared host.
