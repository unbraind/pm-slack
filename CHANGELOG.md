# Changelog

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast Slack webhook validation gate ([pm-slack-676l](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-676l.toon))

## 2026.06.04 - 2026-06-04

### Added

- Lifecycle event taxonomy + assignee mentions + action buttons ([pm-slack-c3q7](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-c3q7.toon))

## 2026.06.03 - 2026-06-02

### Added

- Deep feature enhancement 2026-06-03 ([pm-slack-l3ux](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-l3ux.toon))
- Digest reads pm store toon/json files directly \(no new SDK service\) ([pm-slack-06ti](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-06ti.toon))

### Other

- Best-effort hook policy unchanged; strict creds only in test/digest real-post ([pm-slack-b08f](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-b08f.toon))
- Routing model: PM\_SLACK\_ROUTES JSON map + per-event channel override ([pm-slack-i3ir](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/decisions/pm-slack-i3ir.toon))
- Unit tests + README + functional test + release 2026.6.3 ([pm-slack-ffs4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-ffs4.toon))
- Strict missing-creds CommandError for real posts; keep best-effort hook ([pm-slack-7fk4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-7fk4.toon))
- slack digest command: activity summary over --since/--days ([pm-slack-nga4](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-nga4.toon))
- slack test command: offline preview, no network, --json ([pm-slack-36xw](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-36xw.toon))
- Event/type routing to multiple webhooks/channels \(PM\_SLACK\_ROUTES\) ([pm-slack-747x](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-747x.toon))
- Format toggle: --format text\|blockkit for hook + commands ([pm-slack-1fbz](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-1fbz.toon))

## 2026.06.02 - 2026-06-02

### Added

- Add afterCommand notification hook + slack notify command with Block Kit ([pm-slack-b3y5](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/features/pm-slack-b3y5.toon))

## 2026.05.29 - 2026-05-29

### Fixed

- Close/block Slack reasons always show 'no reason given' \(data-shape mismatch\) ([pm-slack-ssby](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/issues/pm-slack-ssby.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-slack-50tg](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-50tg.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-slack-s716](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-s716.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-slack-tw6n](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-tw6n.toon))

### Other

- Release readiness hardening for pm-slack ([pm-slack-uont](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/tasks/pm-slack-uont.toon))
