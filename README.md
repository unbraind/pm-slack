# pm-slack

Slack notifications for [pm-cli](https://github.com/unbraind/pm-cli) item lifecycle events.

Fires after `create`, `close`, and `block` operations and posts a formatted message to a Slack incoming webhook.

---

## Installation

```bash
pm install github.com/unbraind/pm-slack --global
```

Or install per-project:

```bash
pm install github.com/unbraind/pm-slack --project
```

---

## Setup

### 1. Create a Slack Incoming Webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an existing one).
2. Under **Features → Incoming Webhooks**, activate incoming webhooks.
3. Click **Add New Webhook to Workspace** and choose a channel.
4. Copy the webhook URL into your shell environment.

### 2. Set environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PM_SLACK_WEBHOOK` | Usually | — | Slack incoming webhook URL (optional if every routing rule carries its own `webhook`) |
| `PM_SLACK_CHANNEL` | No | — | Default channel hint appended to messages (e.g. `#pm-alerts`) |
| `PM_SLACK_MIN_PRIORITY` | No | `1` | Minimum priority to notify (1=critical, 2=high, 3=medium, 4=low) |
| `PM_SLACK_EVENTS` | No | `create,close,block` | Comma-separated list of events to notify on |
| `PM_SLACK_FORMAT` | No | `blockkit` | Default message format: `blockkit` (rich) or `text` (plain mrkdwn) |
| `PM_SLACK_ROUTES` | No | — | JSON array of routing rules (see [Routing](#routing-by-event-type-or-status)) |

Export them in your shell profile or `.env`:

```bash
export PM_SLACK_WEBHOOK="<slack-webhook-url>"
export PM_SLACK_CHANNEL="#pm-alerts"
export PM_SLACK_MIN_PRIORITY=2   # only critical + high
export PM_SLACK_EVENTS="create,close"  # skip block notifications
export PM_SLACK_FORMAT="text"          # plain text instead of Block Kit
```

---

## Event Types

| Event | Trigger commands | Notes |
|---|---|---|
| `create` | `pm add`, `pm create`, `pm new` | Fires when a new item is created |
| `close` | `pm close`, `pm done`, `pm complete` | Fires when an item is closed/resolved |
| `block` | `pm update --status blocked`, `pm set status blocked` | Fires when an item's status changes to blocked |

---

## Message Format

### Item created

```
*[Feature]* Auth system created 🆕
Priority: high • Type: Feature • By: alice
```

### Item closed

```
*[Issue]* Login redirect bug closed ✅
Reason: Fixed in commit abc123
```

### Item blocked

```
*[Epic]* Dashboard redesign is blocked 🚫
Reason: Waiting on design approval
```

When `PM_SLACK_CHANNEL` is set, a channel hint is appended to every message:

```
*[Feature]* Auth system created 🆕
Priority: high • Type: Feature • By: alice
_Channel: #pm-alerts_
```

---

## Filtering

### By priority

Only notify for high-priority and above:

```bash
PM_SLACK_MIN_PRIORITY=2
```

Priority scale: `1` = critical, `2` = high, `3` = medium, `4` = low.  
The filter passes items whose priority number is **less than or equal** to the minimum (i.e. higher priority).

### By event type

Only notify on create and close, not block:

```bash
PM_SLACK_EVENTS="create,close"
```

---

## Message Formats

Notifications render as rich Slack **Block Kit** by default (header, a fields
grid with item id / type / event / priority / status / author, an optional
reason section, and a context footer). Set the format to plain `text` for
minimal/legacy channels:

```bash
export PM_SLACK_FORMAT="text"     # plain mrkdwn, no blocks
```

Per-command, the `--format blockkit|text` flag overrides the env var for
`slack notify`, `slack test`, and `slack digest`.

---

## Routing (by event, type, or status)

`PM_SLACK_ROUTES` is an optional JSON array of rules that send specific events,
item types, or statuses to a different webhook and/or channel. Routing is purely
additive — with no rules configured, behavior is unchanged.

Each rule is `{ "match": "<selector>", "webhook"?: "...", "channel"?: "..." }`.
Selectors:

| Selector | Matches |
|---|---|
| `create` / `close` / `block` | that lifecycle event |
| `type:<itemType>` | items of that type (case-insensitive) |
| `status:<status>` | items in that status (case-insensitive) |
| `*` / `all` | everything (use as a catch-all) |

The **first matching rule wins**; any field a rule omits falls back to the
default `PM_SLACK_WEBHOOK` / `PM_SLACK_CHANNEL`.

```bash
export PM_SLACK_ROUTES='[
  { "match": "block", "channel": "#urgent" },
  { "match": "type:Bug", "webhook": "https://hooks.slack.com/services/AAA/BBB/CCC" }
]'
```

---

## Commands

### `pm slack notify`

Manually post a Block Kit (or text) message for an ad-hoc note.

```bash
pm slack notify --text 'Release shipped :rocket:' --dry-run
pm slack notify --title 'Deploy done' --on close --format text --channel '#releases'
```

### `pm slack test`

Build and **print** a sample notification in the chosen format **without
posting** — fully offline, no webhook required. Great for previewing formatting.

```bash
pm slack test --format blockkit          # rich preview
pm slack test --format text --on close   # plain-text preview of a close event
pm slack test --on block --json          # machine-readable payload (with global --json)
```

Flags: `--format blockkit|text`, `--on create|close|block`, `--title`,
`--channel`, `--json`.

### `pm slack digest`

Produce a single summary of recent activity (created / closed / blocked /
in-progress) over a time window, as Block Kit or text. Reads the pm store
directly. Use `--dry-run` to preview without posting.

```bash
pm slack digest --days 7 --dry-run
pm slack digest --since 2026-06-01 --format text --dry-run
pm slack digest --days 1 --format blockkit          # real post (needs a webhook)
```

Flags: `--since <date>`, `--days <n>` (default 7), `--format blockkit|text`,
`--channel`, `--webhook`, `--dry-run`, `--json`.

A real (non-`--dry-run`) `slack digest` post without a configured webhook fails
with a clear error (exit 1) rather than crashing.

---

## Error Handling

The **lifecycle hook is best-effort** and never breaks your pm command:

- If `PM_SLACK_WEBHOOK` is not set, the hook silently skips all notifications and logs a debug message.
- If the webhook URL is invalid, the hook logs an error and continues without crashing pm-cli.
- HTTP errors from Slack (non-2xx responses), network failures, and timeouts (10s) are logged but never fail the underlying `pm` command.

The **`slack digest` command is strict** when actually posting:

- A real (non-`--dry-run`) `slack digest` post without a webhook fails with a clear `CommandError` (exit 1).
- Use `--dry-run` to build and preview a digest with no webhook and no network call.

---

## Development

```bash
npm install
npm run build        # compile TypeScript → dist/
npm run dev          # watch mode
```

The extension uses only Node.js built-ins (`node:https`) — no external runtime dependencies.

---

## Manifest

```json
{
  "name": "pm-slack",
  "description": "Slack notifications for pm item lifecycle events",
  "author": "@unbraind",
  "entry": "./dist/index.js",
  "priority": 50,
  "capabilities": ["commands", "hooks", "schema"]
}
```

---

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
