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
| `PM_SLACK_WEBHOOK` | **Yes** | — | Slack incoming webhook URL |
| `PM_SLACK_CHANNEL` | No | — | Channel hint appended to messages (e.g. `#pm-alerts`) |
| `PM_SLACK_MIN_PRIORITY` | No | `1` | Minimum priority to notify (1=critical, 2=high, 3=medium, 4=low) |
| `PM_SLACK_EVENTS` | No | `create,close,block` | Comma-separated list of events to notify on |

Export them in your shell profile or `.env`:

```bash
export PM_SLACK_WEBHOOK="<slack-webhook-url>"
export PM_SLACK_CHANNEL="#pm-alerts"
export PM_SLACK_MIN_PRIORITY=2   # only critical + high
export PM_SLACK_EVENTS="create,close"  # skip block notifications
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

## Error Handling

- If `PM_SLACK_WEBHOOK` is not set, the extension silently skips all notifications and logs a debug message.
- If the webhook URL is invalid, the extension logs an error and continues without crashing pm-cli.
- HTTP errors from Slack (non-2xx responses) are logged but do not fail the pm-cli command.
- Network timeouts are set to 10 seconds.

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
  "version": "0.1.0",
  "description": "Slack notifications for pm item lifecycle events",
  "author": "@unbraind",
  "entry": "index.js",
  "priority": 50,
  "capabilities": ["hooks", "services"]
}
```

---

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
