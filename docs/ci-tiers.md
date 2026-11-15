# Fleet CI v2

Required checks remain `test (22)` and `test (26)`. PR/manual CI runs on
GitHub-hosted Ubuntu, cancels superseded PRs, and limits each job to 30 minutes.
CodeQL is optional: docs, tracker, markdown and lockfile changes are filtered;
the weekly Monday 05:45 UTC scan remains and analysis has a 30-minute timeout.

| Check | Code PR 22 | Code PR 26 | Docs/tracker PR, both | Deep 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers / strict pm health | yes | yes | yes | yes |
| Rebuild and verify tracked dist matches | yes | yes | — | yes |
| Build and test typecheck | yes | yes | prepack build | npm + Bun gates |
| Unit, SDK, crash, property tests | quick | quick coverage | identity and executable docs subset | full, npm + Bun gates |
| Docstring gate | — | yes | — | npm + Bun gates |
| Coverage: unchanged 100% lines/branches/functions and source inventory | — | quick | — | full, npm + Bun gates |
| Production dependency audit | — | yes | — | npm + Bun gates |
| Package dry-run / public file list | — | yes | yes | npm + Bun gates |
| Changelog consistency | — | yes | yes | npm + Bun gates |
| Publish attestation and changelog-date verifiers | — | yes | — | npm + Bun gates |
| Commit identities / added home paths | via tests | via tests | yes | npm + Bun gates |
| Published outbox SDK documentation examples | via tests | via tests | yes | npm + Bun gates |
| Bun graph install and bunx CLI smoke | — | yes | — | graph install |
| Native Bun SQLite/outbox acceptance | — | yes | — | both versions |
| Five-host captured payload tarball acceptance | — | — | — | Node 26 |
| CodeQL | separate optional workflow on matching PR/main pushes and weekly scan | same | filtered | weekly scan |

Deep checks `deep (22)` and `deep (26)` run on main pushes, dispatch and nightly
02:37 UTC, separate from release 03:23 UTC. They execute the full npm and Bun
gates at `PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, with per-ref cancellation
and 120-minute limits. The `pm-local` pool is preferred unless `PM_LOCAL_DEEP=off`.
Local npm uses persistent cache; Bun setup downloads only on hosted runners, and
all deep jobs log the Bun version. Release workflows and verifiers are unchanged.

Quick runs the deterministic first 50 operations of each 500-case corpus,
including five ten-operation status registries. Full/unset depth retains all
original sequences. Missing typed-error/phase combinations and custom status
roles have explicit deterministic controls, preserving the complete assertions
without depending on late seeds. Success thresholds derive from generated cases
and transitions. Large payload-size, storage, crash-boundary and product deadline
contracts stay intact. Only child-process harness watchdogs scale; scale is finite,
positive and rounded up before spawn. Operation-count complexity checks remain.

Docs/tracker detection uses a NUL-delimited base/head diff without rename folding;
executable tracker files select the code tier. The cheap path retains the identity
suite, published outbox examples and npm package file enumeration because they
read documentation/tracker inputs. This package has no lint script or installed
ESLint; no existing lint gate is removed. The captured payload acceptance already
proves project/npm-global/Bun-global/npx/bunx host installation paths. It is an
exhaustive acceptance suite rather than a distinct platform contract, so deep CI
keeps it intact while the PR tier uses `bun install`, local bunx and the native
Bun outbox test. The latter exercises Bun SQLite and remains a PR contract.

Baseline main run 43600606377: Node 22 wall 23m42s including queue, execution
7m44s; Node 26 wall 52m35s, execution 6m52s. Full seeded send/resolve tests took
37.85–66.70s, destination migration 44.29–62.70s, and journal crash tests
52.00–64.83s. These are historical hosted timings. No full-depth local run is
performed; the task and PR record quick validation and available PR CI timings.
