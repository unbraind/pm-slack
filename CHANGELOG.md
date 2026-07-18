# Changelog

## Unreleased

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-slack-96i1](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-96i1.toon))
- Add --mention-map flag/PM_SLACK_MENTION_MAP env + dedup webhook-unset stderr notice ([pm-slack-dmgv](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-dmgv.toon))

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-slack-bfsb](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-bfsb.toon))

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
