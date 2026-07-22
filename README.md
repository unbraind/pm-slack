# pm-slack

Slack notifications for [pm-cli](https://github.com/unbraind/pm-cli) item lifecycle events.

Fires after `create`, `close`, `block`, `cancel`, `open`, `start`, `unblock`, and `reopen` lifecycle transitions and posts a formatted message to a Slack incoming webhook. Optionally maps assignees to Slack `@mentions` and adds Block Kit action buttons linking to the item / GitHub URL.

Slack posts retry transient delivery failures (`429`, `5xx`, timeout, socket/DNS hiccups) with exponential backoff and honor Slack's `Retry-After` header, so temporary webhook throttling does not immediately drop project context.

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
| `PM_SLACK_EVENTS` | No | all events | Comma-separated list of events to notify on. Status-name aliases (`canceled`, `in_progress`, …) accepted |
| `PM_SLACK_FORMAT` | No | `blockkit` | Default message format: `blockkit` (rich) or `text` (plain mrkdwn) |
| `PM_SLACK_ROUTES` | No | — | JSON array of routing rules (see [Routing](#routing-by-event-type-or-status)) |
| `PM_SLACK_ASSIGNEE_MAP` | No | — | Comma list of `name=slackId` pairs mapping assignees to Slack `@mentions`, e.g. `alice=U123,bob=U456` |
| `PM_SLACK_MENTION_MAP` | No | — | Same format as `PM_SLACK_ASSIGNEE_MAP`; overlays it (same-name entries here win). Accepts `name=@handle` and `name=Uxxxx` forms |
| `PM_SLACK_MENTION_ASSIGNEE` | No | auto | Set `0`/`false` to disable assignee mentions even when a map is set (auto-enabled when a mention map is non-empty) |

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
| `block` | `pm update --status blocked` | Fires when an item's status changes to blocked |
| `cancel` | `pm update --status canceled` | Fires when an item is canceled (reason read from `close_reason`) |
| `open` | `pm update --status open` (e.g. `draft → open`) | Fires when an item is published/opened |
| `start` | `pm claim`, `pm start-task`, `pm update --status in_progress` | Fires when work begins on an item |
| `unblock` | `pm update --status open` from a `blocked` state | Distinguished when the result carries the prior status |
| `reopen` | `pm update --status open` from a `closed`/`canceled` state | Distinguished when the result carries the prior status |

`unblock` / `reopen` are refinements of an `open` transition: when pm's hook
result exposes the previous status, the more specific event is used; otherwise
the transition surfaces as `open`. Status-name aliases (`canceled`,
`in_progress`, `reopened`, …) are accepted anywhere an event name is.

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

## Assignee @mentions

Map a pm item's `assignee` to a Slack user (or group) id (or a human `@handle`)
so notifications @-mention the responsible person. Set `PM_SLACK_ASSIGNEE_MAP`
(or `PM_SLACK_MENTION_MAP`) to a comma list of `name=id` pairs:

```bash
export PM_SLACK_ASSIGNEE_MAP="alice=U0123ABC,bob=@bob,team=<!subteam^S0789GHI>"
```

Mention map value forms:

- A raw id (`U0123ABC`) is wrapped as `<@U0123ABC>`.
- A plain `@handle` (e.g. `@bob`) is kept verbatim (no double-wrapping).
- A pre-wrapped token (e.g. `<!subteam^S0789GHI>` for a group) is used verbatim.

Sources & precedence (later wins for the same name):
`PM_SLACK_ASSIGNEE_MAP` < `PM_SLACK_MENTION_MAP` < the per-command
`--mention-map` flag. With no source set at all, output is byte-identical to
before (no mention rendered).

- Mentions auto-enable in the hook whenever the (env) map is non-empty; set
  `PM_SLACK_MENTION_ASSIGNEE=0` to force them off.
- For ad-hoc posts, pass an inline map without touching the environment:

  ```bash
  pm slack notify --title 'Auth epic' --on create \
    --assignee alice --mention-map 'alice=@alice,bob=U0456DEF' --dry-run
  ```

  The resolved `@mention` appears in both the plain-text fallback and the
  Block Kit `Assignee` field. `pm slack notify --assignee alice --mention-assignee`
  also resolves from the env map. When no mapping exists, the raw assignee name
  is still shown (blockkit).

---

## Action buttons (item / GitHub links)

When a pm item carries a URL, the Block Kit notification adds an action button
linking to it (`View on GitHub` for github.com URLs, otherwise `Open item`). The
URL is read from the first present of these item fields: `github_url`,
`html_url`, `url`, `source_url`, `link` (camelCase variants accepted). The
plain-`text` format is unchanged. For ad-hoc posts:

```bash
pm slack notify --title 'Deploy' --on close --url 'https://github.com/unbraind/pm-slack/pull/3' --dry-run
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

## Webhook preflight gate

The Slack-posting commands (`slack notify`, `slack digest`) run a **fail-fast
preflight** that validates webhook configuration **before** anything is posted:

- The effective webhook is resolved with precedence `--webhook` flag →
  `PM_SLACK_WEBHOOK` → a per-rule webhook in `PM_SLACK_ROUTES`.
- If no webhook is configured, or the configured URL is not a valid `http(s)`
  URL, the command **aborts immediately** with a clear, actionable error and a
  **non-zero exit** (`2`, usage error) — nothing is posted, no network call is
  made.
- On a valid configuration the gate is a **silent pass-through**.

Validation is **purely syntactic/environment-based — no network call**, so it is
cheap and offline-safe. It does *not* verify the webhook actually works; a valid
but dead webhook still passes the gate and surfaces at the network layer.

What is **not** gated:

- `slack test` — an offline preview that never posts and works with no webhook.
- `--dry-run` on `slack notify` / `slack digest` — also an offline preview.

The gate is registered both as a scoped `registerPreflight` override (for the
documented `preflight` capability and a visible warning) and — because the pm
runtime treats errors thrown from a preflight override as non-fatal — enforced in
the command handlers themselves, which throw a `CommandError` that genuinely
aborts the command.

```bash
# no webhook configured:
pm slack notify --text 'hi'        # → error + exit 2, nothing posted
pm slack notify --text 'hi' --dry-run   # → offline preview, exit 0
pm slack test --on close           # → offline preview, exit 0
```

---

## Error Handling

The **lifecycle hook is best-effort** and never breaks your pm command:

- If `PM_SLACK_WEBHOOK` is not set, the hook silently skips all notifications and logs a debug message.
- If the webhook URL is invalid, the hook logs an error and continues without crashing pm-cli.
- HTTP errors from Slack (non-2xx responses), network failures, and timeouts (10s) are logged but never fail the underlying `pm` command.

The **`slack notify` and `slack digest` commands fail fast** on misconfiguration
(see [Webhook preflight gate](#webhook-preflight-gate)):

- A real (non-`--dry-run`) post without a configured webhook, or with an invalid
  webhook URL, fails with a clear `CommandError` and a non-zero exit **before**
  any post is attempted.
- Use `--dry-run` to build and preview with no webhook and no network call.
- Once past the gate, `slack notify` treats a *network/HTTP* failure as
  best-effort (warns, exits 0); `slack digest` reports a post failure as an
  error (exit 1).

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
  "capabilities": ["commands", "hooks", "schema", "preflight"]
}
```

---

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.
