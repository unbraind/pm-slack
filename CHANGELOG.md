# Changelog

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-slack-e5gh](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-e5gh.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-slack-j7ia](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-j7ia.toon))

## 2026.7.28 - 2026-07-28

### Other

- Adopt pm-cli 2026.7.28 ([pm-slack-rhci](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-rhci.toon))
- Eliminate the last source any with real SDK handler context types ([pm-slack-1nns](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-1nns.toon))

## 2026.7.27 - 2026-07-27

### Fixed

- slack notify, slack test, and slack digest fail to register on pm-cli 2026.7.27 because they redeclare the host-owned --json global ([pm-slack-e78x](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-e78x.toon))

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([pm-slack-5il8](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-5il8.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-slack-lnly](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-lnly.toon))

## 2026.7.25 - 2026-07-25

### Fixed

- Block Kit section fields are never truncated and use the wrong limit constant (2000 not 3000) ([pm-slack-mkeb](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-mkeb.toon))

### Other

- Adopt --respect-item-release in changelog scripts and close the shipped-but-stale Block Kit truncation tracker ([pm-slack-v524](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-v524.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-slack-nyfb](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-nyfb.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-slack-zi5t](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-zi5t.toon))

## 2026.7.19 - 2026-07-19

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-slack-96i1](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-96i1.toon))
- Add --mention-map flag/PM_SLACK_MENTION_MAP env + dedup webhook-unset stderr notice ([pm-slack-dmgv](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-dmgv.toon))

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-slack-bfsb](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-bfsb.toon))

## 2026.7.10 - 2026-07-10

### Other

- Full-cycle hardening wave: pm-slack ([pm-slack-r3pz](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-r3pz.toon))

## 2026.7.7 - 2026-07-07

### Other

- Production-readiness audit 2026-05-28 ([pm-slack-v7nq](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-v7nq.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-slack-4w14](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-4w14.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-slack-wyhk](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-wyhk.toon))
- Regenerate CHANGELOG after pm close item ([pm-slack-xhc9](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-xhc9.toon))

## 2026.6.13 - 2026-06-13

### Other

- Daily Release publish step runs prepublishOnly post-tag: align npm publish with --ignore-scripts ([pm-slack-bff1](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-bff1.toon))

## 2026.6.7 - 2026-06-07

### Added

- Retry transient Slack webhook delivery failures ([pm-slack-bfa8](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-bfa8.toon))

### Fixed

- Block Kit messages aren't truncated to Slack limits → oversized content is silently rejected (HTTP 400) ([pm-slack-gx2h](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-gx2h.toon))

### Other

- Harden release readiness checks ([pm-slack-8rob](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-8rob.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-slack-yj5o](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-yj5o.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast Slack webhook validation gate ([pm-slack-676l](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-676l.toon))

## 2026.6.4 - 2026-06-04

### Added

- Lifecycle event taxonomy + assignee mentions + action buttons ([pm-slack-c3q7](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-c3q7.toon))

## 2026.6.3 - 2026-06-02

### Added

- Deep feature enhancement 2026-06-03 ([pm-slack-l3ux](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-l3ux.toon))
- Digest reads pm store toon/json files directly (no new SDK service) ([pm-slack-06ti](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-06ti.toon))

### Other

- Best-effort hook policy unchanged; strict creds only in test/digest real-post ([pm-slack-b08f](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-b08f.toon))
- Routing model: PM_SLACK_ROUTES JSON map + per-event channel override ([pm-slack-i3ir](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-i3ir.toon))
- Unit tests + README + functional test + release 2026.6.3 ([pm-slack-ffs4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-ffs4.toon))
- Strict missing-creds CommandError for real posts; keep best-effort hook ([pm-slack-7fk4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-7fk4.toon))
- slack digest command: activity summary over --since/--days ([pm-slack-nga4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-nga4.toon))
- slack test command: offline preview, no network, --json ([pm-slack-36xw](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-36xw.toon))
- Event/type routing to multiple webhooks/channels (PM_SLACK_ROUTES) ([pm-slack-747x](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-747x.toon))
- Format toggle: --format text\|blockkit for hook + commands ([pm-slack-1fbz](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-1fbz.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add afterCommand notification hook + slack notify command with Block Kit ([pm-slack-b3y5](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-b3y5.toon))

## 2026.5.29 - 2026-05-29

### Fixed

- Close/block Slack reasons always show 'no reason given' (data-shape mismatch) ([pm-slack-ssby](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-ssby.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-slack-50tg](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-50tg.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-slack-s716](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-s716.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-slack-tw6n](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-tw6n.toon))

### Other

- Release readiness hardening for pm-slack ([pm-slack-uont](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-uont.toon))
