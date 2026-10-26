# pm-slack

Slack notifications for [pm-cli](https://github.com/unbraind/pm-cli) item lifecycle events.

Fires after `create`, `close`, `block`, `cancel`, `open`, `start`, `unblock`, and `reopen` lifecycle transitions and posts a formatted message to a Slack incoming webhook. Optionally maps assignees to Slack `@mentions` and adds Block Kit action buttons linking to the item / GitHub URL.

Slack posts retry transient delivery failures (`429`, `5xx`, timeout, socket/DNS hiccups) with exponential backoff and honor Slack's `Retry-After` header, so temporary webhook throttling does not immediately drop project context.

## Durable lifecycle notifications

Enable the local outbox explicitly after configuring the webhook (PM CLI/SDK
2026.10.15 or newer is required for verified history recovery):

```bash
pm slack outbox --action enable
pm create Task "Check the release" --priority 1
pm slack outbox --action status --limit 20 --json
pm slack outbox --action drain --limit 20 --json
```

`enable` records a durable start time and snapshots `PM_SLACK_EVENTS` and
`PM_SLACK_MIN_PRIORITY` in one atomic transaction. A crash or storage refusal
before completion leaves the previous opt-in and policy intact; retry `enable`
after restoring writable storage. It is idempotent and does not backfill older events.
Changing those environment variables does not change existing recovery eligibility.
Run `pm slack outbox --action configure` before future lifecycle changes to record
an explicit new filter epoch; older history keeps its original policy. Existing
outboxes without saved filters retain their queued receipts; enable or configure
starts their recovery policy with future history rather than guessing old eligibility.

After successful lifecycle mutations, the hook recovers the affected item's
matching transitions and attempts at most one delivery. Reads never drain.
`drain` discovers candidate items through the SDK's cursor-paginated mutation
feed, then reads and verifies authoritative history, including changes
whose process exited before its hook ran, and drains queued receipts. Run it after
a restart or periodically from your scheduler. A failed item history is isolated:
healthy histories and already verified queued receipts still drain, while
`recovered.failed` reports the failure count and the CLI exits 2 with
`history_unavailable`. Repair and retry without duplicating acknowledged receipts.
The feed is discovery-only: cached event rows never authorize a notification.
SDK readers load each candidate's authoritative history and required current item, and
`verifyHistoryEntries` checks both chain integrity and agreement with the current
item before replay, eligibility, deduplication or queuing. Missing streams and
valid-prefix truncations are reported as failures; current item identities are
included so a missing history file cannot disappear from discovery. Page cursors
are used only after verification and never saved as a durable acknowledgement.
If the feed is unavailable (for example, for legacy timestamps), discovery falls
back to retained history. Replay preserves historical payloads and authoritative
stream order. A failed item publishes no new intents; healthy queued receipts
can still drain.
Recovery isolates each candidate: an empty, unreadable, malformed or missing item
document never stops healthy neighbors. Identity discovery reads filenames with
the SDK's folder/format mapping, since metadata inventories either omit unreadable
documents or reject the whole read. A missing document fails even when its
remaining history is a valid prefix. A failed item publishes no buffered intents.
When failures occur, `recovered.failures` lists every candidate's `item`,
`code: history_unavailable` and safe typed `reason`. An unreadable discovery
directory is identified as `_inventory`. Healthy receipts remain unchanged.
Keep history from the enable time; removing or compacting it can prevent recovery
of unqueued transitions. History, tracker items and committed lifecycle commands
are never rolled back by a delivery failure. Queued messages retain their original
payload and destination fingerprint; recovery uses recorded eligibility epochs
and current routing for new intents.

SQLite stores intents, unique history-revision keys, attempt counts and
acknowledgments in `.agents/pm/runtime/slack-outbox/delivery.sqlite` using full
synchronous commits and atomic claims across local processes. Keep this ignored
runtime directory on durable local storage and include it in your private backups.
Do not use the same database from different hosts or over a network filesystem.
The directory is private to its owner; webhook URLs are hashed, never persisted.
Message bodies remain private runtime data. There is no automatic receipt deletion:
retaining acknowledgments prevents old events from being delivered again.

Each intent moves from `pending` to `sending` before a request starts. HTTP success
becomes `acknowledged`; explicit 429 refusals remain `pending` for a later drain;
other 4xx responses become `rejected`. A timeout, reset, dropped response or 5xx
becomes `ambiguous`, including a response body that mentions a DNS failure.
Connection refused and DNS errors that occur before the request is transmitted
stay `pending` for a later drain; classification uses the socket error code, not
the error text. After an ambiguous result, later rows for that destination stay
pending for the remainder of this drain; other destinations can proceed. A retry
stops the current drain. The next drain tries fewer-attempt
intents first, so one refused destination cannot block every other notification.
A crash leaves `sending` visible. Uncertain states are never automatically resent
because incoming webhooks provide no transactional exactly-once guarantee.
Existing immediate retry/backoff for non-outbox commands is unchanged.

Inspect Slack before reconciling an uncertain receipt:

```bash
pm slack outbox --action resolve --key RECEIPT_KEY --decision acknowledged
# Only after verifying absence; explicitly retrying uncertainty can duplicate a post:
pm slack outbox --action resolve --key RECEIPT_KEY --decision retry
pm slack outbox --action drain
```

A pre-request `destination_changed` parks the row as `refused` with zero added
attempts and continues past it. Parked rows are never automatically retried. They
do not block later healthy destinations. Restore the original routing and resolve
with `--decision retry`, or explicitly discard the unsent receipt without claiming
delivery:

```bash
pm slack outbox --action resolve --key RECEIPT_KEY --decision skip
```

`skip` and `abandon` record `skipped`, a terminal work state distinct from
`acknowledged`. They stop retries without proving non-delivery. Even an operator's
`acknowledged` resolution is a work decision, not a retained Slack response. Live or
reused sender PIDs refuse reconciliation by default. After independently verifying
that no sender is active, use `--force-reconcile` to override PID reuse, including
PID 1 in containers. Forcing an active sender can duplicate delivery; it is never
automatic. SDK callers use `resolve(key, decision, { force: true })` for the same
explicit override.

Global configuration/storage refusals still return typed errors; a global
pre-request failure restores the row to pending without counting an attempt.
Command refusals exit nonzero. SDK callers receive `OutboxError` with typed `code`,
`remedy` and `exitCode` fields. Row-level routing refusals are reported by the
`refused` count instead of aborting the drain.

The command returns compact TOON by default or JSON with `--json`: exact counts
for every work state, separate `outcomes` totals (`delivered`, `withheld`,
`uncertain`), at most `--limit` receipts (1–100, default 20), and an explicit
`omitted` count. Continue inspection with `--after <next_cursor>` until
`next_cursor` is null; totals cover the whole outbox on every page. Payloads and
destinations are excluded. A drain inspects history
without truncation, then attempts at most the requested number of pending rows.
`recovered.inspected`, `recovered.queued` and `recovered.failed` describe that scan. A sending receipt
means delivery may have happened; it is not an acknowledgment.

The package root exports `SlackOutbox`, `captureSlackOutbox`, `slackDestination`,
`OutboxError`, `deriveSlackDeliveryOutcome`, and their intent/receipt/report/evidence types. The low-level
`drain(send, limit)` callback must make one attempt and report `acknowledged`
only on explicit success, `retry` only on a confirmed refusal, and `ambiguous`
whenever remote acceptance is uncertain. A `retry` ends the current drain; call
it again later. See the [SDK example](docs/outbox-example.md).
Raise `destination_changed` only before starting a remote request; this parks the
intent as refused without counting a send attempt. Other typed pre-request errors
restore pending and rethrow. Enable SDK history recovery with
`enable({ events: [...], minPriority: 1 })`; `configureRecovery(filter)` records an
explicit future-only filter change. Low-level `enable()` without a filter still
supports direct intent enqueue/drain, while recovery requires a saved policy.

## Without git

Lifecycle delivery, outbox enable/status/drain/resolve, manual notifications,
offline previews and digests work in a plain initialized tracker without git.
Outbox recovery uses the SDK mutation feed with retained-history fallback and
never runs a git subprocess. The feed may rebuild its derived runtime index;
authoritative item and history files stay unchanged.
This outbox needs local durable runtime storage; it does not provide a remote
database backend. No Slack command requires a git repository.

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

### Attention-budgeted lifecycle delivery

`pm slack coalesce` previews pending lifecycle deliveries as bounded same-item,
same-destination bursts, independently of the tracker-state digest and periodic
`pm-slack-standup` reports. Enable the durable outbox, set
`PM_SLACK_COALESCE=1` on lifecycle writers, and schedule
`pm slack coalesce --action drain --budget 5`. Routine events wait for their fixed
window to close. Blockers and priority-0/1 events bypass both the window and the
routine notification budget, retaining their original payloads.

The typed SDK exports `planSlackCoalescing`, event/options/plan/receipt types,
`CoalescingError`, and `SlackOutbox` planning, draining and paged evidence methods.
Default TOON and `--json` output contain bounded evidence pages, exact totals,
omission counts and resume cursors. Every event retains its committed revision
and a coalescing or bypass receipt; over-budget events remain pending. Preview
and receipt inspection need no webhook. All operations work without git.

See the [complete CLI and SDK example](docs/coalescing-example.md) for opt-in,
scheduling, refusals, pagination, transport outcomes and group reconciliation.
[Public-tracker measurements](docs/coalescing-validation.md) record read-only
validation and behavioral revert proofs.

### `pm slack digest`

Produce a single summary of recent activity (created / closed / blocked /
in-progress) over a time window, as Block Kit or text. Requires pm CLI/SDK
2026.10.15 or newer. Reads the complete tracker through the public SDK, including
configured custom item types and terminal items. Unreadable or malformed records
refuse the digest before posting, rather than silently omitting activity. Nested
extension hooks are disabled during the observational read. Use `--dry-run` to
preview without posting; it still requires a complete, readable tracker.

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
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.


## Certification tracker GitHub preview

Install the managed extension in a fresh clone before running its read-only preview:

```sh
npx pm package install npm:pm-github@2026.10.4 --project
npx pm github sync --repo unbraind/pm-slack --dry-run
```

The tracked managed manifest records the extension; installed files are ignored. This preview does not enable scheduled sync. See `docs/certification-2026.10.4.md` for package gates and packed real-tracker command evidence.

## Notification routing explanations

Use `pm slack explain --item <id> --event <event> --revision <after_hash>`
for a single offline diagnosis. Add `--json` for JSON; the default TOON output
contains the same bounded evidence. Discover exact identities with the SDK
mutation feed (`listMutationEvents`): select the lifecycle event's item and
committed history `after_hash` (`full: true` includes the entry). Pass the feed's
one-based `version` as `--event-version` when a state hash repeats. The SDK identity
accepts the same optional `version` field. Without it, a repeated hash produces
`event_ambiguous`; with it, history is diagnosed but a reused hash cannot safely
attribute legacy delivery receipts and remains explicit uncertainty.

The typed SDK export `explainSlackRouting(pmRoot, { item, event, revision })`
verifies the complete item history against the authoritative SDK document,
replays the requested revision through the SDK, and uses the tracker's configured
status registry roles to classify the transition. It reports event and priority
filters (including exact priority operands), every ordered route rule (indices only), first-match shadowing, attention
policy, and exact-revision delivery evidence. Blockers and priority 0/1 events
name their budget/window bypass policy; bypass does not override eligibility
filters. Titles, bodies, selectors, channels and webhook URLs are never returned.

Retained eligibility epochs and receipts are historical evidence. Route evaluation
uses current configuration, which was not historically snapshotted. Coalescing
receipts omit the historical budget/window parameters; this uncertainty is explicit.
They are retained observations and may be stale after retries; absent receipts
never prove delivery or non-delivery. One reducer, `deriveSlackDeliveryOutcome`,
uses immutable `attempt_started` / terminal record pairs and a durable
`request_dispatched` marker written immediately before entering the network API.
Terminal results are `confirmed`, `not_sent`, `rejected`, or `unknown_after_send`.
Open attempts are derived on read. Recovery closes dead senders as `not_sent`
before dispatch and `unknown_after_send` after dispatch; live retired senders
can still append their actual terminal result. Counters do not establish proof.
Any confirmed attempt proves `delivered`. Otherwise an unknown/open dispatched
attempt gives `uncertain`; otherwise the outcome is `withheld`. Operator retry,
skip, abandon and acknowledgment do not change past attempt records. A confirmed
retry can therefore prove delivery after an earlier uncertain attempt.
A retained eligibility exclusion also proves withholding when no receipt exists.
Legacy attempted receipts without a complete journal remain uncertain. Status roles use the current
tracker registry, and this limitation is explicit in every result.

Output has six stages plus at most 100 indexed routing-rule decisions. Identity
validation accepts only item, event, revision and the optional positive safe integer version, a bounded safe item id, a
canonical event and a lowercase 64-character SDK history hash. Routing rules are
strictly bounded to 100 entries and 250000 characters; selectors to 160 and overrides
to 2048 characters. Priority configuration must be an integer 1..4. Invalid input,
invalid routing configuration, unknown/non-lifecycle or ambiguous repeated state hashes, unreadable history
and unreadable storage return typed nonzero refusals with remedies. Foreign
receipt/policy records are skipped with `foreign_evidence_skipped` uncertainty.

The command reads one item's retained history and opens existing outbox storage
read-only in a single SQLite snapshot. It never creates an outbox, captures events,
drains, sends, or changes tracker files. History verification reads the full
selected item stream; work scales with that stream, while output stays bounded.
See the [SDK/CLI example](docs/routing-explanation-example.md) and
[public-tracker measurement](docs/routing-explanation-validation.md).

### Without git

Notification previews, digests, routing explanations, and local durable outbox
inspection work on plain initialized trackers without a git executable. Slack
posting needs an explicitly configured webhook and network connectivity. The
explanation command needs neither. It makes zero network calls.

### Retained delivery proof

Each claim appends an immutable started record and token under the same SQLite writer
transaction as its work claim. Completion records that token's actual transport
result before releasing work. A late completion can settle its own evidence after
operator reconciliation without overwriting a peer's work state. Operator decisions
are journaled separately. Open attempts are derived from started records without a terminal fact;
unknown/foreign results and incomplete legacy history remain uncertain.

`status`, plain/coalesced drain reports, coalescing manifests, and explanations all
call `deriveSlackDeliveryOutcome`. Each report row has an `outcome`; aggregate
`outcomes` counts are separate from compatibility `counts`, which describe work
states only. Digest counts describe tracker activity and are unrelated to delivery.
Neither a skipped nor an operator-acknowledged count proves a delivery result.
Dispatch-aware SDK transports accept a third `OutboxSendContext` argument and
call `context.requestDispatched()` immediately before their network API. Existing
two-argument transports are conservatively marked before callback invocation.
A clean exit always closes its attempt, including cancellation and late refusal;
a process crash leaves recovery to the durable dispatch marker.
The attempt journal contains keys, attempt tokens, result codes and operator
decisions, never webhook URLs or message bodies. The explanation path still opens
existing storage read-only and never creates or migrates it.
