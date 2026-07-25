/**
 * pm-slack — Slack notifications for pm-cli item lifecycle events
 *
 * Two surfaces:
 *   1. afterCommand hook — posts a Slack notification when an item is created,
 *      closed, or blocked (only if PM_SLACK_WEBHOOK is set; otherwise a silent
 *      no-op). The hook NEVER throws and NEVER blocks the command: all work is
 *      wrapped in try/catch and Slack posting is fire-and-forget.
 *   2. `pm slack notify` command — manual posting of a rich Slack Block Kit
 *      message (sections, fields, context) with a plain-text fallback.
 *
 * Env vars:
 *   PM_SLACK_WEBHOOK      (required) Slack incoming webhook URL
 *   PM_SLACK_CHANNEL      (optional) Override channel, e.g. #pm-alerts
 *   PM_SLACK_MIN_PRIORITY (optional) Minimum priority to notify (1=critical … 4=low), default 1 (critical only; set 4 for all)
 *   PM_SLACK_EVENTS       (optional) Comma-separated subset of hook events:
 *                                    create,close,block,cancel,open,start,unblock,reopen (default: all).
 *                                    Status-name aliases (e.g. "canceled","in_progress") are accepted.
 *   PM_SLACK_FORMAT       (optional) Default notification format: "blockkit" (default) or "text"
 *   PM_SLACK_ASSIGNEE_MAP (optional) Comma list of "name=slackId" pairs mapping a pm item's
 *                                    assignee to a Slack @mention, e.g. "alice=U123,bob=U456".
 *   PM_SLACK_MENTION_ASSIGNEE (optional) Set to 0/false to disable assignee @mentions even when a map is set
 *                                    (mentions auto-enable in the hook whenever PM_SLACK_ASSIGNEE_MAP is non-empty).
 *   PM_SLACK_ROUTES       (optional) JSON array of routing rules to send specific
 *                                    events/types/statuses to different webhooks/channels.
 *                                    Each rule: { "match": "<selector>", "webhook"?: "...", "channel"?: "..." }
 *                                    Selector forms: an event ("create"|"close"|"block"),
 *                                    "type:<itemType>" (case-insensitive), or "status:<status>".
 *                                    First matching rule wins; unset fields fall back to the defaults.
 */

import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type {
  defineExtension as defineExtensionType,
  AfterCommandHookContext,
  BeforeCommandHookContext,
} from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// EXIT_CODE / CommandError (re-implemented locally)
//
// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property.
// A plain `Error` makes the runtime fall through to its "unhandled" path, which
// re-invokes the handler and exits with a generic code. Standalone-installed
// extensions only load their own `dist/`, so `@unbrained/pm-cli` is not
// resolvable at runtime — mirror the SDK contract here instead of importing it.
// ---------------------------------------------------------------------------

const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Priority = 1 | 2 | 3 | 4;

interface PmItem {
  id: string;
  title: string;
  type?: string;
  priority?: Priority;
  status?: string;
  // pm emits reason fields in snake_case (close_reason / blocked_reason).
  // camelCase variants are kept for forward-compatibility / defensive reads.
  close_reason?: string;
  blocked_reason?: string;
  closedReason?: string;
  blockedReason?: string;
  // pm stores cancel reasons in close_reason (no dedicated field); cancel_reason
  // variants are read defensively in case a future pm version splits them out.
  cancel_reason?: string;
  cancelReason?: string;
  author?: string;
  // Assignee mapping (Feature 2). pm stores the assignee as a scalar string.
  assignee?: string;
  // Optional URL the item links to (Feature 3). pm has no canonical URL field,
  // so a defensive set of common field names is read; first non-empty wins.
  url?: string;
  github_url?: string;
  githubUrl?: string;
  html_url?: string;
  htmlUrl?: string;
  source_url?: string;
  sourceUrl?: string;
  link?: string;
}

type EventKind = "create" | "close" | "block" | "cancel" | "open" | "start" | "unblock" | "reopen";

type MessageFormat = "blockkit" | "text" | "custom";

/** A single routing rule parsed from PM_SLACK_ROUTES. */
interface RouteRule {
  /** Raw selector string, e.g. "block", "type:Bug", "status:blocked". */
  match: string;
  webhook?: string;
  channel?: string;
}

/** Resolved destination for a notification after applying routing rules. */
interface RouteTarget {
  webhookUrl: string;
  channel?: string;
}

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackPayload {
  text: string;
  blocks?: SlackBlock[];
  mrkdwn?: boolean;
  channel?: string;
  thread_ts?: string;
}

// ---------------------------------------------------------------------------
// Option helpers
//
// pm normalizes CLI flags to camelCase at runtime (e.g. `--dry-run` becomes
// `dryRun`), so reading only the kebab-case key silently misses the value.
// Read both forms to be robust.
// ---------------------------------------------------------------------------

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function readBoolOption(options: Record<string, unknown>, key: string): boolean {
  for (const candidate of [key, camelCase(key)]) {
    const value = options[candidate];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    }
  }
  return false;
}

function readStrOption(options: Record<string, unknown>, key: string): string | undefined {
  for (const candidate of [key, camelCase(key)]) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

const ALL_EVENTS: EventKind[] = [
  "create",
  "close",
  "block",
  "cancel",
  "open",
  "start",
  "unblock",
  "reopen",
];

/**
 * Friendly aliases accepted in PM_SLACK_EVENTS / `--on` so callers can write the
 * status name they think in (e.g. "canceled"/"cancelled" → cancel,
 * "in_progress" → start). Aliases normalize to a canonical EventKind.
 */
const EVENT_ALIASES: Record<string, EventKind> = {
  created: "create",
  closed: "close",
  done: "close",
  complete: "close",
  completed: "close",
  resolved: "close",
  blocked: "block",
  canceled: "cancel",
  cancelled: "cancel",
  opened: "open",
  in_progress: "start",
  "in-progress": "start",
  started: "start",
  unblocked: "unblock",
  reopened: "reopen",
};

function normalizeEvent(token: string): EventKind | null {
  const t = token.trim().toLowerCase();
  if (ALL_EVENTS.includes(t as EventKind)) return t as EventKind;
  return EVENT_ALIASES[t] ?? null;
}

function parseEvents(spec: string | undefined): Set<EventKind> {
  if (!spec) return new Set(ALL_EVENTS);
  const parsed = spec
    .split(",")
    .map((e) => normalizeEvent(e))
    .filter((e): e is EventKind => e !== null);
  return parsed.length > 0 ? new Set(parsed) : new Set(ALL_EVENTS);
}

// ---------------------------------------------------------------------------
// Format parsing
// ---------------------------------------------------------------------------

const ALL_FORMATS: MessageFormat[] = ["blockkit", "text", "custom"];

/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text, "template"/"tmpl"
 * → custom). Falls back to the supplied default when the spec is empty or
 * unrecognized.
 */
function parseFormat(spec: string | undefined, fallback: MessageFormat = "blockkit"): MessageFormat {
  if (!spec) return fallback;
  const v = spec.trim().toLowerCase();
  if (v === "blockkit" || v === "block" || v === "blocks" || v === "rich") return "blockkit";
  if (v === "text" || v === "plain" || v === "txt") return "text";
  if (v === "custom" || v === "template" || v === "tmpl") return "custom";
  return fallback;
}

// ---------------------------------------------------------------------------
// Routing
//
// PM_SLACK_ROUTES is an optional JSON array of rules that send specific events,
// item types, or statuses to a different webhook/channel. Routing is purely
// additive: with no rules configured, behavior is identical to before.
// ---------------------------------------------------------------------------

function parseRoutes(spec: string | undefined): RouteRule[] {
  if (!spec || !spec.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(spec);
  } catch {
    console.error("[pm-slack] PM_SLACK_ROUTES is not valid JSON — routing disabled");
    return [];
  }
  if (!Array.isArray(raw)) {
    console.error("[pm-slack] PM_SLACK_ROUTES must be a JSON array — routing disabled");
    return [];
  }
  const rules: RouteRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const match = typeof e.match === "string" ? e.match.trim() : "";
    if (!match) continue;
    const webhook = typeof e.webhook === "string" && e.webhook.trim() ? e.webhook.trim() : undefined;
    const channel = typeof e.channel === "string" && e.channel.trim() ? e.channel.trim() : undefined;
    if (!webhook && !channel) continue; // a rule with no override is meaningless
    rules.push({ match, webhook, channel });
  }
  return rules;
}

/**
 * Does a single route rule match this event/item? Selector forms:
 *   - bare event name: "create" | "close" | "block"
 *   - "type:<itemType>"   (case-insensitive on item.type)
 *   - "status:<status>"   (case-insensitive on item.status)
 *   - "*" / "all"         (matches everything — useful as a catch-all)
 */
function ruleMatches(rule: RouteRule, event: EventKind, item: PmItem): boolean {
  const sel = rule.match.toLowerCase();
  if (sel === "*" || sel === "all") return true;
  if (sel.startsWith("type:")) {
    return (item.type ?? "").toLowerCase() === sel.slice("type:".length).trim();
  }
  if (sel.startsWith("status:")) {
    return (item.status ?? "").toLowerCase() === sel.slice("status:".length).trim();
  }
  return sel === event;
}

/**
 * Resolve the destination (webhook + channel) for an event/item given the
 * configured routes and the default webhook/channel. First matching rule wins;
 * any field a rule omits falls back to the default. Returns null only when no
 * webhook can be resolved at all.
 */
function selectRoute(
  event: EventKind,
  item: PmItem,
  routes: RouteRule[],
  defaultWebhook: string,
  defaultChannel?: string
): RouteTarget | null {
  for (const rule of routes) {
    if (ruleMatches(rule, event, item)) {
      const webhookUrl = rule.webhook ?? defaultWebhook;
      if (!webhookUrl) return null;
      return { webhookUrl, channel: rule.channel ?? defaultChannel };
    }
  }
  if (!defaultWebhook) return null;
  return { webhookUrl: defaultWebhook, channel: defaultChannel };
}

// ---------------------------------------------------------------------------
// Event filtering (--filter)
//
// The --filter flag accepts a comma-separated list of selector expressions.
// Only events/items matching ALL selectors (AND logic) trigger a notification.
// An empty filter list (flag omitted) matches everything — zero regression.
// Selector forms:
//   "type:<itemType>"   case-insensitive on item.type
//   "status:<status>"  case-insensitive on item.status
//   "event:<event>"     canonical event name or alias
//   bare event name      e.g. "create", "close" (same as event: prefix)
// ---------------------------------------------------------------------------

/** Parse a --filter spec into an array of selector strings. */
function parseFilter(spec: string | undefined): string[] {
  if (!spec || !spec.trim()) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check if an item/event matches a single filter selector.
 */
function filterMatches(filter: string, event: EventKind, item: PmItem): boolean {
  const sel = filter.toLowerCase();
  if (sel.startsWith("type:")) {
    return (item.type ?? "").toLowerCase() === sel.slice("type:".length).trim();
  }
  if (sel.startsWith("status:")) {
    return (item.status ?? "").toLowerCase() === sel.slice("status:".length).trim();
  }
  if (sel.startsWith("event:")) {
    const norm = normalizeEvent(sel.slice("event:".length).trim());
    return norm !== null && norm === event;
  }
  // bare event name — accept canonical names and aliases
  const norm = normalizeEvent(sel);
  return norm !== null && norm === event;
}

/**
 * Check if an item/event matches ALL filter selectors (AND logic). An empty
 * filter list matches everything (no filtering applied).
 */
function matchesFilter(filters: string[], event: EventKind, item: PmItem): boolean {
  if (filters.length === 0) return true;
  return filters.every((f) => filterMatches(f, event, item));
}

// ---------------------------------------------------------------------------
// Channel override (--channel-override)
//
// The --channel-override flag accepts a comma-separated list of
// `event=channel` pairs. When the resolved event matches, the corresponding
// channel is used instead of the default --channel / PM_SLACK_CHANNEL. Event
// tokens accept canonical names and aliases (e.g. "canceled" → cancel).
// ---------------------------------------------------------------------------

/** Parse a --channel-override spec into a map of EventKind → channel. */
function parseChannelOverride(spec: string | undefined): Map<EventKind, string> {
  const map = new Map<EventKind, string>();
  if (!spec || !spec.trim()) return map;
  for (const pair of spec.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const eventToken = pair.slice(0, eq).trim().toLowerCase();
    const channel = pair.slice(eq + 1).trim();
    if (!channel) continue;
    const event = normalizeEvent(eventToken);
    if (event) map.set(event, channel);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Webhook preflight validation gate
//
// A misconfigured webhook used to fail silently (hook) or deep inside the post
// path. This gate validates the webhook config *before* a posting command runs
// and fails fast with a clear, actionable error. Validation is purely
// syntactic/env-based — NO network calls — so it is cheap and offline-safe.
//
// The gate is shared by `slack notify` and `slack digest` (the Slack-posting
// commands) and is invoked at the handler level so the thrown CommandError
// actually aborts (the SDK swallows errors thrown from registerPreflight). It
// is NOT applied to `slack test` (offline preview) nor to --dry-run previews.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective webhook for a posting command from an explicit
 * `--webhook` flag (highest precedence) or PM_SLACK_WEBHOOK. PM_SLACK_ROUTES
 * may also carry per-rule webhooks; a present route webhook is accepted as a
 * valid source so route-only configurations are not falsely rejected.
 */
function resolveEffectiveWebhook(webhookFlag: string | undefined): {
  webhookUrl: string;
  source: "flag" | "env" | "route" | "none";
} {
  const flag = webhookFlag?.trim();
  if (flag) return { webhookUrl: flag, source: "flag" };

  const env = process.env.PM_SLACK_WEBHOOK?.trim();
  if (env) return { webhookUrl: env, source: "env" };

  // A route rule may supply its own webhook; accept that as a valid source so a
  // routes-only setup passes the gate. The default webhook is then empty and
  // per-event routing resolves the real destination at post time.
  const routes = parseRoutes(process.env.PM_SLACK_ROUTES);
  if (routes.some((r) => r.webhook)) return { webhookUrl: "", source: "route" };

  return { webhookUrl: "", source: "none" };
}

/**
 * Validate webhook configuration for a Slack-posting command. Throws a
 * CommandError (exit 2 / USAGE) with an actionable message when no webhook is
 * configured or the configured webhook URL is syntactically invalid. Returns
 * silently (pass-through) on a valid config. Performs NO network I/O.
 *
 * `commandLabel` is woven into the message (e.g. "slack digest") so the user
 * sees exactly which command was gated.
 */
function assertWebhookConfigured(webhookFlag: string | undefined, commandLabel: string): void {
  const { webhookUrl, source } = resolveEffectiveWebhook(webhookFlag);

  if (source === "none") {
    throw new CommandError(
      `No Slack webhook configured for \`${commandLabel}\`. ` +
        "Set the PM_SLACK_WEBHOOK environment variable, pass --webhook <url>, " +
        "or configure PM_SLACK_ROUTES with per-rule webhooks. " +
        "Use --dry-run to preview the message without a webhook.",
      EXIT_CODE.USAGE
    );
  }

  // Route-sourced configs have no default URL to validate here (route webhooks
  // are validated lazily at post time); a present URL must be well-formed.
  if (webhookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new CommandError(
        `Slack webhook for \`${commandLabel}\` is not a valid URL ` +
          `(${source === "flag" ? "--webhook" : "PM_SLACK_WEBHOOK"}=\"${webhookUrl}\"). ` +
          "Expected an https URL, e.g. https://hooks.slack.com/services/...",
        EXIT_CODE.USAGE
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new CommandError(
        `Slack webhook for \`${commandLabel}\` must be an http(s) URL ` +
          `(got protocol "${parsed.protocol}" from ` +
          `${source === "flag" ? "--webhook" : "PM_SLACK_WEBHOOK"}).`,
        EXIT_CODE.USAGE
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  minPriority: Priority;
  events: Set<EventKind>;
  format: MessageFormat;
  routes: RouteRule[];
  assigneeMap: Map<string, string>;
  /** When true, include assignee @mentions in hook notifications by default. */
  mentionAssignee: boolean;
}

// Module-level guard so the "webhook not set" notice is emitted at most ONCE
// per process. The afterCommand hook runs on EVERY pm command, so without this
// guard a webhook-less install would spam stderr on every invocation. Exposed
// via __test__ resets so the once-only behavior is unit-testable.
let warnedWebhookUnset = false;

function warnWebhookUnsetOnce(): void {
  if (warnedWebhookUnset) return;
  warnedWebhookUnset = true;
  console.error("[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled");
}

function loadConfig(): SlackConfig | null {
  const webhookUrl = process.env.PM_SLACK_WEBHOOK ?? "";
  const routes = parseRoutes(process.env.PM_SLACK_ROUTES);

  // A default webhook is not strictly required if routing rules carry their own
  // webhook(s); only bail out when there is no webhook source at all.
  const routesHaveWebhook = routes.some((r) => r.webhook);
  if (!webhookUrl && !routesHaveWebhook) {
    // Emit the "disabled" notice at most once per process (de-spam): the hook
    // fires on every command, so repeating this on each one is noisy for any
    // install without a webhook configured.
    warnWebhookUnsetOnce();
    return null;
  }

  // Validate the default URL when present (route webhooks are validated lazily).
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      console.error("[pm-slack] PM_SLACK_WEBHOOK is not a valid URL — notifications disabled");
      return null;
    }
  }

  const channel = process.env.PM_SLACK_CHANNEL?.trim() || undefined;

  const rawPriority = parseInt(process.env.PM_SLACK_MIN_PRIORITY ?? "1", 10);
  const minPriority: Priority =
    rawPriority >= 1 && rawPriority <= 4 ? (rawPriority as Priority) : 1;

  const events = parseEvents(process.env.PM_SLACK_EVENTS);
  const format = parseFormat(process.env.PM_SLACK_FORMAT);
  // Hook map comes from env only (no per-command flag in the hook path).
  // PM_SLACK_MENTION_MAP is an alias/overlay of PM_SLACK_ASSIGNEE_MAP.
  const assigneeMap = buildMentionMap(undefined);
  // Mentions are auto-enabled in the hook whenever a non-empty map is present;
  // PM_SLACK_MENTION_ASSIGNEE=0/false can force them off even with a map.
  const mentionEnv = (process.env.PM_SLACK_MENTION_ASSIGNEE ?? "").trim().toLowerCase();
  const mentionAssignee =
    mentionEnv === "0" || mentionEnv === "false" || mentionEnv === "no" || mentionEnv === "off"
      ? false
      : assigneeMap.size > 0;

  return { webhookUrl, channel, minPriority, events, format, routes, assigneeMap, mentionAssignee };
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_LABELS: Record<Priority, string> = {
  1: "critical",
  2: "high",
  3: "medium",
  4: "low",
};

function priorityLabel(p: Priority | undefined): string {
  return p !== undefined ? PRIORITY_LABELS[p] ?? "unknown" : "unknown";
}

function meetsMinPriority(item: PmItem, minPriority: Priority): boolean {
  // Lower number = higher priority; 1 = critical
  if (item.priority === undefined) return true; // unknown priority always passes
  return item.priority <= minPriority;
}

// ---------------------------------------------------------------------------
// Assignee → Slack @mention mapping
//
// PM_SLACK_ASSIGNEE_MAP maps a pm item's assignee to a Slack user/group id so
// notifications can @-mention the responsible person. Format is a comma-list of
// `name=id` pairs, e.g. PM_SLACK_ASSIGNEE_MAP="alice=U123,bob=U456". Slack
// renders <@U123> as a user mention and <!subteam^S123> for groups; we accept a
// raw id (wrapped as <@id>) or a pre-wrapped token (kept verbatim). Mapping is
// opt-in and additive — when unset, output is byte-identical to before.
// ---------------------------------------------------------------------------

/** Parse PM_SLACK_ASSIGNEE_MAP into a case-insensitive name→id lookup. */
function parseAssigneeMap(spec: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!spec || !spec.trim()) return map;
  for (const pair of spec.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim().toLowerCase();
    const id = pair.slice(eq + 1).trim();
    if (name && id) map.set(name, id);
  }
  return map;
}

/**
 * Format a mapped value into a ready-to-embed Slack mention token. Accepts:
 *   - a pre-wrapped token (`<@U123>`, `<!subteam^S123>`) — used verbatim,
 *   - a plain `@handle` (e.g. `@alice`) — kept verbatim (Slack resolves the
 *     human-readable handle in mrkdwn),
 *   - a raw Slack user/group id (`U123`) — wrapped as `<@U123>`.
 */
function formatMention(value: string): string {
  const v = value.trim();
  if (v.startsWith("<") || v.startsWith("@")) return v;
  return `<@${v}>`;
}

/**
 * Resolve an item's assignee to a Slack mention token using the map. Returns a
 * ready-to-embed mention string (e.g. `<@U123>`) or undefined when there's no
 * assignee or no mapping. See {@link formatMention} for accepted value forms.
 */
function resolveAssigneeMention(item: PmItem, map: Map<string, string>): string | undefined {
  const assignee = item.assignee?.trim();
  if (!assignee || map.size === 0) return undefined;
  const id = map.get(assignee.toLowerCase());
  if (!id) return undefined;
  return formatMention(id);
}

/**
 * Build the effective mention map for a command by layering, in increasing
 * precedence: PM_SLACK_ASSIGNEE_MAP (env) < PM_SLACK_MENTION_MAP (env) <
 * `--mention-map` (flag). Later sources override earlier ones for the same
 * name. With no map source set at all, the result is empty (output unchanged).
 */
/**
 * Build the layered mention map. Sources merge in increasing precedence:
 * `PM_SLACK_ASSIGNEE_MAP` < `PM_SLACK_MENTION_MAP` < `--mention-map` (flagSpec).
 * The env values are taken as parameters (defaulting to `process.env`) so the
 * function is pure and unit-testable without mutating global state.
 */
function buildMentionMap(
  flagSpec: string | undefined,
  env: { assigneeMap?: string; mentionMap?: string } = {
    assigneeMap: process.env.PM_SLACK_ASSIGNEE_MAP,
    mentionMap: process.env.PM_SLACK_MENTION_MAP,
  },
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const spec of [env.assigneeMap, env.mentionMap, flagSpec]) {
    for (const [name, id] of parseAssigneeMap(spec)) merged.set(name, id);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Item URL extraction (for Block Kit action buttons)
//
// pm has no canonical URL field, so read a defensive set of common field names
// off the item; the first valid http(s) URL wins. Used to render an "Open item"
// / "View on GitHub" action button in the Block Kit notification (Feature 3).
// ---------------------------------------------------------------------------

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolve a primary URL for the item, plus whether it points at GitHub. */
function resolveItemUrl(item: PmItem, override?: string): { url: string; isGithub: boolean } | undefined {
  const candidates = [
    override,
    item.github_url,
    item.githubUrl,
    item.html_url,
    item.htmlUrl,
    item.url,
    item.source_url,
    item.sourceUrl,
    item.link,
  ];
  for (const c of candidates) {
    if (isHttpUrl(c)) {
      const url = c.trim();
      return { url, isGithub: /(^|\.)github\.com$/i.test(new URL(url).hostname) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plain-text message formatting (fallback)
// ---------------------------------------------------------------------------

function itemTypeLabel(item: PmItem): string {
  return item.type ?? "Item";
}

const EVENT_META: Record<EventKind, { verb: string; emoji: string }> = {
  create: { verb: "created", emoji: "🆕" },
  close: { verb: "closed", emoji: "✅" },
  block: { verb: "is blocked", emoji: "🚫" },
  cancel: { verb: "canceled", emoji: "🛑" },
  open: { verb: "opened", emoji: "📂" },
  start: { verb: "started", emoji: "🔄" },
  unblock: { verb: "unblocked", emoji: "🔓" },
  reopen: { verb: "reopened", emoji: "♻️" },
};

function eventReason(item: PmItem, event: EventKind): string | undefined {
  if (event === "close") {
    return item.close_reason?.trim() || item.closedReason?.trim() || undefined;
  }
  if (event === "cancel") {
    // pm persists the cancel reason in close_reason; honor a dedicated
    // cancel_reason first if a future pm version introduces one.
    return (
      item.cancel_reason?.trim() ||
      item.cancelReason?.trim() ||
      item.close_reason?.trim() ||
      item.closedReason?.trim() ||
      undefined
    );
  }
  if (event === "block") {
    return item.blocked_reason?.trim() || item.blockedReason?.trim() || undefined;
  }
  return undefined;
}

function buildTextMessage(item: PmItem, event: EventKind, channel?: string, mention?: string): string {
  const type = itemTypeLabel(item);
  const meta = EVENT_META[event];
  let msg = `*[${type}]* ${item.title} ${meta.verb} ${meta.emoji}`;

  if (event === "create") {
    msg += `\nPriority: ${priorityLabel(item.priority)} • Type: ${type} • By: ${item.author ?? "unknown"}`;
  } else if (event === "close" || event === "cancel" || event === "block") {
    // Terminal/blocked transitions carry a reason field.
    msg += `\nReason: ${eventReason(item, event) ?? "no reason given"}`;
  } else {
    // Status transitions without a reason (open/start/unblock/reopen).
    msg += `\nStatus: ${item.status ?? meta.verb}${item.assignee ? ` • Assignee: ${item.assignee}` : ""}`;
  }

  if (mention) msg += `\nAssignee: ${mention}`;
  if (channel) msg += `\n_Channel: ${channel}_`;
  return msg;
}

// ---------------------------------------------------------------------------
// Custom template message formatting
//
// When --format custom is used, the caller supplies a --template string with
// {placeholder} tokens that are replaced from the item/event context. This
// produces a plain-text (mrkdwn) payload with no Block Kit blocks, giving full
// control over message layout for channels or integrations that need a
// specific format. Unknown placeholders are left as-is (e.g. "{unknown}") so
// typos are visible rather than silently dropped.
// ---------------------------------------------------------------------------

/** Supported template placeholders mapped to their source values. */
function templateReplacements(item: PmItem, event: EventKind, opts: BlockKitOptions): Record<string, string> {
  const meta = EVENT_META[event];
  return {
    title: item.title ?? "",
    id: item.id ?? "",
    event: meta.verb,
    type: itemTypeLabel(item),
    status: item.status ?? meta.verb,
    priority: priorityLabel(item.priority),
    assignee: item.assignee ?? "",
    mention: opts.mention ?? "",
    reason: eventReason(item, event) ?? "",
    channel: opts.channel ?? "",
    emoji: meta.emoji,
    author: item.author ?? "",
  };
}

/**
 * Render a custom template by replacing {placeholder} tokens with values
 * from the item/event context. Unknown tokens are kept verbatim so typos are
 * visible. Returns the rendered string.
 */
function buildCustomMessage(item: PmItem, event: EventKind, template: string, opts: BlockKitOptions = {}): string {
  const replacements = templateReplacements(item, event, opts);
  return template.replace(/\{(\w+)\}/g, (_, key: string) => replacements[key] ?? `{${key}}`);
}

// ---------------------------------------------------------------------------
// Block Kit rendering
//
// Build a Slack Block Kit `blocks` array (header + section with fields +
// optional reason section + context footer) and a plain-text `fallback` Slack
// renders in notifications and old clients.
// ---------------------------------------------------------------------------

/**
 * Slack Block Kit hard limits. A block exceeding these causes Slack to reject
 * the ENTIRE message with HTTP 400, so any caller-controlled text (note, close
 * reason, title/header, digest item lists) must be capped before it is sent.
 * @see https://api.slack.com/reference/block-kit/blocks
 */
const SLACK_SECTION_TEXT_MAX = 3000; // section.text.text
/**
 * `section.fields[].text` has its OWN, smaller cap than `section.text.text`:
 * 2,000 characters per field, not 3,000. Conflating the two silently allows a
 * 2,001–3,000 character field through, and Slack then rejects the whole message
 * with HTTP 400 — the exact failure the section cap exists to prevent.
 * @see https://docs.slack.dev/reference/block-kit/blocks/section-block/
 */
const SLACK_SECTION_FIELD_TEXT_MAX = 2000;
/** `section.fields` accepts at most 10 entries; an 11th rejects the message. */
const SLACK_SECTION_FIELDS_MAX = 10;
const SLACK_HEADER_TEXT_MAX = 150; // header.text.text (plain_text)

/**
 * Truncate `text` to at most `max` characters, appending an ellipsis ("…") when
 * cut so the truncation is visible rather than silently dropped or rejected. The
 * ellipsis counts toward the limit, so the result is always <= `max`. Returns
 * the input unchanged when it already fits (zero regression for normal content).
 *
 * The cap is enforced on UTF-16 length (`String.length`, what Slack measures),
 * so the result is always `<= max` units — but the cut is made on a code-point
 * boundary (iterating with `for…of`), so a surrogate pair (emoji / non-BMP
 * char) at the boundary is never sliced in half into a malformed string Slack
 * would reject. This is conservative: if a multi-unit char doesn't fully fit in
 * the remaining budget it is dropped rather than split.
 */
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  const budget = max - 1; // reserve one UTF-16 unit for the "…"
  let out = "";
  for (const ch of text) { // `for…of` iterates whole code points
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + "…";
}

/**
 * Build a `section.fields` array that Slack will accept.
 *
 * Each entry is capped AFTER formatting, because the label, the newline and the
 * interpolated value all count toward the 2,000-character field budget — capping
 * only the value would let `*Assignee:*\n` push the formatted result over. The
 * array is also capped at 10 entries, Slack's hard maximum.
 *
 * Every caller-controlled string reaching a field (`item.id`, `item.status`,
 * `item.author`, `item.assignee`, `opts.mention`, digest counts) passes through
 * here, so no field can individually reject the message.
 */
function sectionFields(texts: string[]): { type: "mrkdwn"; text: string }[] {
  return texts
    .slice(0, SLACK_SECTION_FIELDS_MAX)
    .map((text) => ({ type: "mrkdwn" as const, text: truncate(text, SLACK_SECTION_FIELD_TEXT_MAX) }));
}

interface BlockKitOptions {
  channel?: string;
  /** Extra free-form body appended as a section (e.g. from `--text`). */
  note?: string;
  /** Pre-resolved Slack mention token for the assignee (e.g. `<@U123>`). */
  mention?: string;
  /** Resolved item/GitHub URL for an action button. */
  link?: { url: string; isGithub: boolean };
  /** Custom template string used when format is "custom". */
  template?: string;
}

function buildItemBlockKit(
  item: PmItem,
  event: EventKind,
  opts: BlockKitOptions = {}
): { blocks: SlackBlock[]; fallback: string } {
  const type = itemTypeLabel(item);
  const meta = EVENT_META[event];
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: truncate(`${meta.emoji} ${item.title}`, SLACK_HEADER_TEXT_MAX),
      emoji: true,
    },
  });

  // Fields section: a 2-column grid of mrkdwn key/value pairs.
  const fieldTexts: string[] = [
    `*Item:*\n${item.id}`,
    `*Type:*\n${type}`,
    `*Event:*\n${meta.verb}`,
    `*Priority:*\n${priorityLabel(item.priority)}`,
  ];
  if (item.status) fieldTexts.push(`*Status:*\n${item.status}`);
  if (item.author) fieldTexts.push(`*By:*\n${item.author}`);
  // Assignee mention (Feature 2): show the @mention when mapped, else the raw
  // assignee name so the field is still useful without a configured map.
  if (opts.mention) fieldTexts.push(`*Assignee:*\n${opts.mention}`);
  else if (item.assignee) fieldTexts.push(`*Assignee:*\n${item.assignee}`);
  blocks.push({ type: "section", fields: sectionFields(fieldTexts) });

  const reason = eventReason(item, event);
  if (reason) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Reason:* ${reason}`, SLACK_SECTION_TEXT_MAX) },
    });
  }

  if (opts.note) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(opts.note, SLACK_SECTION_TEXT_MAX) },
    });
  }

  // Action buttons (Feature 3): a link button to the item / GitHub URL when one
  // is present on the item. Block Kit "actions" with a url-bearing button needs
  // no interactivity backend — it opens the URL directly. Plain-text path is
  // unaffected (this only runs for the blockkit format).
  if (opts.link) {
    const label = opts.link.isGithub ? "View on GitHub" : "Open item";
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: label, emoji: true },
          url: opts.link.url,
          action_id: opts.link.isGithub ? "pm_slack_open_github" : "pm_slack_open_item",
        },
      ],
    });
  }

  const footerBits = [
    `pm item ${item.id} ${meta.verb}`,
    opts.channel ? `channel ${opts.channel}` : null,
  ].filter(Boolean);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `🤖 pm-slack · ${footerBits.join(" · ")}` }],
  });

  const fallback = buildTextMessage(item, event, opts.channel, opts.mention);
  return { blocks, fallback };
}

/**
 * Build a ready-to-post SlackPayload for an item event in the requested format.
 * - "blockkit": rich Block Kit blocks + plain-text fallback in `text`.
 * - "text":     plain mrkdwn only (no `blocks`), for minimal/legacy channels.
 */
function buildItemPayload(
  item: PmItem,
  event: EventKind,
  format: MessageFormat,
  opts: BlockKitOptions = {}
): SlackPayload {
  const template = opts.template ?? process.env.PM_SLACK_TEMPLATE;
  if (format === "custom" && template) {
    const text = buildCustomMessage(item, event, template, opts);
    const body = opts.note && opts.note.trim() ? `${text}\n${opts.note.trim()}` : text;
    return {
      text: body,
      mrkdwn: true,
      ...(opts.channel ? { channel: opts.channel } : {}),
    };
  }
  if (format === "text") {
    const text = buildTextMessage(item, event, opts.channel, opts.mention);
    const body = opts.note && opts.note.trim() ? `${text}\n${opts.note.trim()}` : text;
    return {
      text: body,
      mrkdwn: true,
      ...(opts.channel ? { channel: opts.channel } : {}),
    };
  }
  const { blocks, fallback } = buildItemBlockKit(item, event, opts);
  return {
    text: fallback,
    blocks,
    mrkdwn: true,
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Slack HTTP POST
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SlackHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "SlackHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function slackRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(8000, 500 * 2 ** attempt);
}

function isRetryableSlackError(err: unknown): boolean {
  if (err instanceof SlackHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error) {
    return /timed out|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(err.message);
  }
  return false;
}

function postToSlackOnce(webhookUrl: string, payload: SlackPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(webhookUrl);

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "http:" ? 80 : 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const request = parsed.protocol === "http:" ? http.request : https.request;
    const req = request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(new SlackHttpError(
            status,
            `Slack webhook returned HTTP ${status}: ${data.slice(0, 200)}`,
            parseRetryAfterMs(res.headers["retry-after"])
          ));
        }
      });
    });

    req.on("error", (err: Error) => {
      reject(new Error(`Slack webhook request failed: ${err.message}`));
    });

    req.setTimeout(10_000, () => {
      req.destroy(new Error("Slack webhook request timed out after 10s"));
    });

    req.write(body);
    req.end();
  });
}

async function postToSlack(webhookUrl: string, payload: SlackPayload): Promise<void> {
  const maxRetries = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await postToSlackOnce(webhookUrl, payload);
      return;
    } catch (err: unknown) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryableSlackError(err)) break;
      const retryAfterMs = err instanceof SlackHttpError ? err.retryAfterMs : undefined;
      await sleep(slackRetryDelayMs(attempt, retryAfterMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// Digest: reading the pm store + activity aggregation
//
// The digest reads items directly from the pm store (`<pm_root>/<dir>/*.toon`
// and `*.json`) using a tiny scalar parser — we only need a handful of
// top-level fields (id/title/type/status/priority/timestamps/reasons). This
// avoids a runtime dependency on the pm SDK service layer (registerService is
// limited and corrupts output, #96) and keeps the package dependency-free.
// ---------------------------------------------------------------------------

/** Directories under a pm root that hold items, by convention. */
const ITEM_DIRS = ["tasks", "features", "issues", "epics", "stories", "bugs", "decisions", "items"];

/** Fields we read off each stored item for digest purposes. */
interface DigestItem extends PmItem {
  created_at?: string;
  updated_at?: string;
}

/**
 * Minimal parser for a stored pm item file. Handles the toon scalar form
 * (`key: value`, optionally quoted) and JSON. Only top-level scalar fields are
 * extracted; nested/array sections are ignored. Returns null when no id found.
 */
function parseStoredItem(content: string, ext: string): DigestItem | null {
  if (ext === ".json") {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      const node = (obj.item ?? obj) as Record<string, unknown>;
      if (typeof node.id !== "string") return null;
      return node as unknown as DigestItem;
    } catch {
      return null;
    }
  }
  // toon: line-oriented `key: value`. Stop reading a key when it introduces a
  // block/array (e.g. `notes[1]{...}:`); we only want flat scalars.
  const out: Record<string, unknown> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine;
    if (!line || /^\s/.test(line)) continue; // skip indented (nested) lines
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === "" || value === '""') {
      out[key] = "";
      continue;
    }
    // Strip surrounding double quotes (toon quotes strings with embedded chars).
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    out[key] = value;
  }
  if (typeof out.id !== "string") return null;
  if (typeof out.priority === "string" && /^\d+$/.test(out.priority)) {
    out.priority = parseInt(out.priority, 10);
  }
  return out as unknown as DigestItem;
}

/** Read all items from a pm root. Best-effort: unreadable files are skipped. */
function readStoreItems(pmRoot: string): DigestItem[] {
  const items: DigestItem[] = [];
  for (const dir of ITEM_DIRS) {
    const full = path.join(pmRoot, dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of entries) {
      const ext = path.extname(name);
      if (ext !== ".toon" && ext !== ".json") continue;
      try {
        const content = fs.readFileSync(path.join(full, name), "utf8");
        const item = parseStoredItem(content, ext);
        if (item) items.push(item);
      } catch {
        // skip unreadable item
      }
    }
  }
  return items;
}

/**
 * Resolve a `--since <date>` / `--days <n>` window into an epoch-ms cutoff.
 * `since` (ISO date or datetime) wins when both are given; otherwise `days`
 * back from `now`. Defaults to 7 days. Returns the cutoff in ms.
 */
function resolveWindow(
  since: string | undefined,
  days: number | undefined,
  now: number = Date.now()
): { cutoffMs: number; label: string } {
  if (since) {
    const t = Date.parse(since);
    if (!Number.isNaN(t)) {
      return { cutoffMs: t, label: `since ${since}` };
    }
  }
  const d = days !== undefined && Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  return { cutoffMs: now - d * 24 * 60 * 60 * 1000, label: `last ${d} day${d === 1 ? "" : "s"}` };
}

type DigestBucket = "created" | "closed" | "blocked" | "in_progress";

interface DigestSummary {
  windowLabel: string;
  cutoffMs: number;
  counts: Record<DigestBucket, number>;
  buckets: Record<DigestBucket, DigestItem[]>;
  total: number;
}

function statusIsClosed(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "closed" || s === "done" || s === "resolved" || s === "complete" || s === "completed";
}

/**
 * Aggregate store items into digest buckets for the window. An item counts as:
 *   - created     if created_at >= cutoff
 *   - closed      if it is in a closed/done status AND updated_at >= cutoff
 *   - blocked     if status === blocked AND updated_at >= cutoff
 *   - in_progress if status === in_progress AND updated_at >= cutoff
 * An item may appear in multiple buckets (e.g. created and blocked).
 */
function aggregateDigest(items: DigestItem[], cutoffMs: number, windowLabel: string): DigestSummary {
  const buckets: Record<DigestBucket, DigestItem[]> = {
    created: [],
    closed: [],
    blocked: [],
    in_progress: [],
  };
  for (const item of items) {
    const created = item.created_at ? Date.parse(item.created_at) : NaN;
    const updated = item.updated_at ? Date.parse(item.updated_at) : created;
    const status = (item.status ?? "").toLowerCase();

    if (!Number.isNaN(created) && created >= cutoffMs) buckets.created.push(item);
    if (statusIsClosed(status) && !Number.isNaN(updated) && updated >= cutoffMs) buckets.closed.push(item);
    if (status === "blocked" && !Number.isNaN(updated) && updated >= cutoffMs) buckets.blocked.push(item);
    if (status === "in_progress" && !Number.isNaN(updated) && updated >= cutoffMs) buckets.in_progress.push(item);
  }
  const counts: Record<DigestBucket, number> = {
    created: buckets.created.length,
    closed: buckets.closed.length,
    blocked: buckets.blocked.length,
    in_progress: buckets.in_progress.length,
  };
  const total = counts.created + counts.closed + counts.blocked + counts.in_progress;
  return { windowLabel, cutoffMs, counts, buckets, total };
}

const DIGEST_BUCKET_META: Record<DigestBucket, { label: string; emoji: string }> = {
  created: { label: "Created", emoji: "🆕" },
  closed: { label: "Closed", emoji: "✅" },
  blocked: { label: "Blocked", emoji: "🚫" },
  in_progress: { label: "In progress", emoji: "🔄" },
};

const DIGEST_ORDER: DigestBucket[] = ["created", "closed", "in_progress", "blocked"];

/** A short "id title" line per item, capped so the digest stays readable. */
function digestItemLines(items: DigestItem[], max = 5): string[] {
  const lines = items.slice(0, max).map((i) => `• ${i.id} — ${i.title ?? "(untitled)"}`);
  if (items.length > max) lines.push(`• …and ${items.length - max} more`);
  return lines;
}

function buildDigestText(summary: DigestSummary, channel?: string): string {
  const head = `*pm activity digest* (${summary.windowLabel}) — ${summary.total} update${summary.total === 1 ? "" : "s"}`;
  const parts: string[] = [head];
  for (const bucket of DIGEST_ORDER) {
    const items = summary.buckets[bucket];
    if (items.length === 0) continue;
    const meta = DIGEST_BUCKET_META[bucket];
    parts.push(`\n${meta.emoji} *${meta.label}* (${items.length})`);
    parts.push(digestItemLines(items).join("\n"));
  }
  if (summary.total === 0) parts.push("\n_No activity in this window._");
  if (channel) parts.push(`\n_Channel: ${channel}_`);
  return parts.join("\n");
}

function buildDigestBlockKit(
  summary: DigestSummary,
  channel?: string
): { blocks: SlackBlock[]; fallback: string } {
  const blocks: SlackBlock[] = [];
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: truncate(`📊 pm activity digest`, SLACK_HEADER_TEXT_MAX),
      emoji: true,
    },
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${summary.windowLabel} · ${summary.total} update${summary.total === 1 ? "" : "s"}`,
      },
    ],
  });

  // Counts grid.
  const fields = sectionFields(
    DIGEST_ORDER.map((bucket) => {
      const meta = DIGEST_BUCKET_META[bucket];
      return `${meta.emoji} *${meta.label}:*\n${summary.counts[bucket]}`;
    })
  );
  blocks.push({ type: "section", fields });

  for (const bucket of DIGEST_ORDER) {
    const items = summary.buckets[bucket];
    if (items.length === 0) continue;
    const meta = DIGEST_BUCKET_META[bucket];
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(
          `${meta.emoji} *${meta.label}* (${items.length})\n${digestItemLines(items).join("\n")}`,
          SLACK_SECTION_TEXT_MAX
        ),
      },
    });
  }

  if (summary.total === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No activity in this window._" },
    });
  }

  const footerBits = [`pm digest · ${summary.windowLabel}`, channel ? `channel ${channel}` : null].filter(
    Boolean
  );
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `🤖 pm-slack · ${footerBits.join(" · ")}` }],
  });

  const fallback = buildDigestText(summary, channel);
  return { blocks, fallback };
}

function buildDigestPayload(
  summary: DigestSummary,
  format: MessageFormat,
  channel?: string
): SlackPayload {
  if (format === "text") {
    return {
      text: buildDigestText(summary, channel),
      mrkdwn: true,
      ...(channel ? { channel } : {}),
    };
  }
  const { blocks, fallback } = buildDigestBlockKit(summary, channel);
  return {
    text: fallback,
    blocks,
    mrkdwn: true,
    ...(channel ? { channel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event detection (afterCommand hook)
// ---------------------------------------------------------------------------

/** Commands that create a new item */
const CREATE_COMMANDS = new Set(["add", "create", "new"]);

/** Commands that close/complete an item */
const CLOSE_COMMANDS = new Set(["close", "done", "complete", "finish", "resolve"]);

/** Commands that update an item's status or attributes */
const UPDATE_COMMANDS = new Set(["update", "edit", "set", "status"]);

/** Lifecycle-alias commands that move an item to in_progress (start). */
const START_COMMANDS = new Set(["claim", "start-task", "start", "begin"]);

/** Lifecycle-alias commands that move an item back to open (e.g. pause). */
const OPEN_COMMANDS = new Set(["pause-task", "release", "reopen", "publish"]);

/** Map a (normalized) status string to the EventKind for a transition into it. */
function statusToEvent(status: string | undefined): EventKind | null {
  switch ((status ?? "").toLowerCase()) {
    case "blocked":
      return "block";
    case "canceled":
    case "cancelled":
      return "cancel";
    case "closed":
    case "done":
    case "resolved":
    case "complete":
    case "completed":
      return "close";
    case "in_progress":
    case "in-progress":
      return "start";
    case "open":
      return "open";
    default:
      return null;
  }
}

/**
 * Detect the lifecycle event for a completed command. Strategy:
 *   1. Create/close commands map directly.
 *   2. Status-changing commands (update/set/lifecycle aliases) derive the event
 *      from the *resulting* status (preferring the explicit --status option,
 *      falling back to the result item's status).
 *   3. When the result carries the prior status (`previousStatus`), refine
 *      open→reopen (from a closed/canceled state) and open→unblock (from
 *      blocked) so terminal-recovery transitions are distinguishable.
 */
function detectEvent(ctx: AfterCommandHookContext): EventKind | null {
  const cmd = ctx.command?.toLowerCase() ?? "";

  if (CREATE_COMMANDS.has(cmd)) return "create";
  if (CLOSE_COMMANDS.has(cmd)) return "close";

  const result = (ctx as any).result as
    | { item?: { status?: string }; previousStatus?: string; previous_status?: string }
    | undefined;
  const resultStatus = result?.item?.status;
  const prevStatus = (result?.previousStatus ?? result?.previous_status ?? "").toLowerCase();

  // Lifecycle aliases imply a target status even without --status.
  let event: EventKind | null = null;
  if (START_COMMANDS.has(cmd)) event = "start";
  else if (OPEN_COMMANDS.has(cmd)) event = cmd === "reopen" ? "reopen" : "open";

  if (!event && UPDATE_COMMANDS.has(cmd)) {
    const optStatus = ctx.options?.["status"] as string | undefined;
    event = statusToEvent(optStatus) ?? statusToEvent(resultStatus);
  }

  if (!event) return null;

  // Refine an "open" transition using the prior status when available:
  //   blocked  -> open  => unblock
  //   closed/canceled -> open => reopen
  if (event === "open" && prevStatus) {
    if (prevStatus === "blocked") return "unblock";
    if (["closed", "canceled", "cancelled", "done", "resolved"].includes(prevStatus)) return "reopen";
  }

  return event;
}

function extractItem(ctx: AfterCommandHookContext): PmItem | null {
  const result = (ctx as unknown as Record<string, unknown>).result as
    | { item?: PmItem; items?: PmItem[] }
    | undefined;

  const item = result?.item;
  if (item && item.id) return item;

  // Some commands return a list (e.g. bulk add) — take the first
  const items = result?.items;
  if (Array.isArray(items) && items.length > 0 && items[0].id) {
    return items[0];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-slack",
  version: "2026.7.23",

  activate(api) {
    // -----------------------------------------------------------------------
    // afterCommand hook — fires after every pm-cli command completes.
    // Posts a rich Block Kit notification for create/close/block events.
    // NEVER throws and NEVER blocks: every path returns cleanly and the Slack
    // POST is fire-and-forget (failures are logged, never propagated).
    // -----------------------------------------------------------------------
    if (typeof api.hooks?.afterCommand === "function") {
      api.hooks.afterCommand(async (ctx: AfterCommandHookContext) => {
        try {
          // Only react to successful commands.
          if (ctx && (ctx as any).ok === false) return;

          const config = loadConfig();
          if (!config) return; // no webhook → silent no-op

          const event = detectEvent(ctx);
          if (!event) return;

          if (!config.events.has(event)) {
            console.error(`[pm-slack] Event "${event}" filtered by PM_SLACK_EVENTS`);
            return;
          }

          const item = extractItem(ctx);
          if (!item) {
            console.error("[pm-slack] Could not extract item from result — skipping");
            return;
          }

          if (!meetsMinPriority(item, config.minPriority)) {
            console.error(
              `[pm-slack] Item priority ${item.priority} below minimum ${config.minPriority} — skipping`
            );
            return;
          }

          // Resolve destination via routing rules (falls back to defaults).
          const target = selectRoute(
            event,
            item,
            config.routes,
            config.webhookUrl,
            config.channel
          );
          if (!target) {
            console.error(`[pm-slack] No webhook resolved for event "${event}" — skipping`);
            return;
          }

          const mention = config.mentionAssignee
            ? resolveAssigneeMention(item, config.assigneeMap)
            : undefined;
          const link = resolveItemUrl(item);

          const payload = buildItemPayload(item, event, config.format, {
            channel: target.channel,
            mention,
            link,
          });

          await postToSlack(target.webhookUrl, payload);
          console.error(`[pm-slack] Notification sent for event "${event}" on item ${item.id}`);
        } catch (err) {
          // Hooks must never throw or block the command — swallow everything.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[pm-slack] afterCommand hook error (ignored): ${message}`);
        }
      });
    } else if (typeof api.hooks?.beforeCommand === "function") {
      // Fallback: use beforeCommand if afterCommand is unavailable
      // (result data is unavailable, so we can only notify on command name).
      api.hooks.beforeCommand(async (ctx: BeforeCommandHookContext) => {
        try {
          console.error("[pm-slack] afterCommand not available — limited event detection active");
          const config = loadConfig();
          if (!config) return;

          const cmd = ctx.command?.toLowerCase() ?? "";
          let event: EventKind | null = null;
          if (CREATE_COMMANDS.has(cmd)) event = "create";
          else if (CLOSE_COMMANDS.has(cmd)) event = "close";

          if (!event || !config.events.has(event)) return;

          const cmdArgs = (ctx.args ?? []).join(" ");
          const text = `pm command \`${ctx.command}\` triggered event *${event}*\n${cmdArgs}`;

          await postToSlack(config.webhookUrl, { text, mrkdwn: true, channel: config.channel });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[pm-slack] beforeCommand hook error (ignored): ${message}`);
        }
      });
    }

    // -----------------------------------------------------------------------
    // preflight — fail-fast webhook validation gate for the Slack-posting
    // commands. Scoped to `slack notify` / `slack digest` only (NOT `slack
    // test`, which is an offline preview, and NOT --dry-run previews).
    //
    // NOTE: the pm runtime SWALLOWS errors thrown from a registerPreflight
    // override (runPreflightOverride wraps it in try/catch → non-fatal
    // warning), so a bare throw here would NOT abort the command. The real
    // fail-fast enforcement therefore lives in the command HANDLERS (which
    // throw CommandError and genuinely abort). This override exists to surface
    // the documented "preflight" capability and to return a clean pass-through
    // delta; it performs the same syntactic validation as a defense-in-depth
    // signal and never makes a network call.
    // -----------------------------------------------------------------------
    if (typeof api.registerPreflight === "function") {
      api.registerPreflight((pfCtx) => {
        const command = (pfCtx.command ?? "").toLowerCase();
        // Only gate the actual posting commands.
        if (command !== "slack notify" && command !== "slack digest") return {};

        const options = (pfCtx.options ?? {}) as Record<string, unknown>;
        // Offline previews are never gated.
        if (readBoolOption(options, "dry-run")) return {};

        try {
          assertWebhookConfigured(readStrOption(options, "webhook"), command);
        } catch (err) {
          // The runtime swallows throws here; emit a visible warning so the
          // signal isn't lost. The handler-level gate provides the real abort.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[pm-slack] preflight: ${message}`);
        }
        return {};
      });
    }

    // -----------------------------------------------------------------------
    // command — `pm slack notify` : manual rich Block Kit post.
    // -----------------------------------------------------------------------
    if (typeof api.registerCommand === "function") {
      api.registerCommand({
        name: "slack notify",
        description: "Post a rich Slack Block Kit notification for a pm item or a free-form message",
        intent: "Manually send a Slack notification (Block Kit with plain-text fallback)",
        examples: [
          "pm slack notify --text 'Release shipped :rocket:' --dry-run",
          "pm slack notify --title 'Deploy done' --on close --channel '#releases'",
          "pm slack notify --title 'Auth epic' --on create --thread 1700000000.000100",
          "pm slack notify --title 'Bug fix' --on close --format custom --template '{emoji} {title} ({id}) {event} in {type}' --dry-run",
          "pm slack notify --title 'Deploy' --type Feature --on close --filter 'type:Feature' --dry-run",
          "pm slack notify --title 'Hotfix' --on close --channel-override 'close=#incidents,block=#urgent' --dry-run",
          "PM_SLACK_WEBHOOK=https://hooks.slack.com/... pm slack notify --text 'hello team'",
        ],
        flags: [
          { long: "--text", value_name: "message", description: "Free-form message body (mrkdwn). Used when no item context is given." },
          { long: "--title", value_name: "title", description: "Title shown in the Block Kit header (defaults to the --text first line)" },
          { long: "--type", value_name: "type", description: "Item type used by templates and --filter (default: Note)" },
          { long: "--status", value_name: "status", description: "Item status used by templates and --filter" },
          { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #pm-alerts). Overrides PM_SLACK_CHANNEL." },
          { long: "--thread", value_name: "ts", description: "Slack thread timestamp (thread_ts) to reply into a thread" },
          { long: "--on", value_name: "events", description: "Comma list of lifecycle events for the message template (create,close,block,cancel,open,start,unblock,reopen). Default: create" },
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default), text, or custom (requires --template). Overrides PM_SLACK_FORMAT." },
          { long: "--template", value_name: "tpl", description: "Custom message template with {placeholders} (title, id, event, type, status, priority, assignee, mention, reason, channel, emoji, author). Used with --format custom." },
          { long: "--filter", value_name: "selectors", description: "Comma-separated selectors to filter which events trigger notifications (type:Bug, status:closed, event:create, or bare event name). ALL must match." },
          { long: "--channel-override", value_name: "pairs", description: "Comma list of event=channel pairs to redirect specific event types to different channels (e.g. close=#releases,block=#urgent)" },
          { long: "--assignee", value_name: "name", description: "Assignee name shown on the message (mapped to a Slack @mention via the mention map)" },
          { long: "--mention-assignee", description: "Resolve the assignee to a Slack @mention using the mention map" },
          { long: "--mention-map", value_name: "pairs", description: "Inline mention map, comma list of name=@handle|name=Uxxxx pairs (overrides PM_SLACK_ASSIGNEE_MAP / PM_SLACK_MENTION_MAP for this post)" },
          { long: "--url", value_name: "url", description: "Add a Block Kit action button linking to this URL (e.g. a GitHub item)" },
          { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
          { long: "--dry-run", description: "Print the message and payload without posting to Slack" },
          { long: "--json", description: "Emit the result/payload as JSON (machine-readable)" },
        ],

        async run(ctx: { args?: string[]; options?: Record<string, unknown>; pm_root?: string; global?: { json?: boolean } }) {
          const options = ctx.options ?? {};
          const dryRun = readBoolOption(options, "dry-run");
          const webhookUrl =
            readStrOption(options, "webhook") ?? process.env.PM_SLACK_WEBHOOK ?? "";
          const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
          const threadTs = readStrOption(options, "thread");

          const asJson = ctx.global?.json === true || readBoolOption(options, "json");
          const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);

          // Preflight gate: a real (non-dry-run) post requires a valid webhook.
          // Fail fast with a clear error BEFORE building/attempting any post.
          // --dry-run is an offline preview and is intentionally NOT gated.
          if (!dryRun) {
            assertWebhookConfigured(readStrOption(options, "webhook"), "slack notify");
          }

          // `--on` selects the message template. First event wins for the header verb.
          const events = parseEvents(readStrOption(options, "on") ?? "create");
          const event: EventKind = (ALL_EVENTS.find((e) => events.has(e)) ?? "create") as EventKind;

          // --channel-override: redirect specific event types to different channels.
          const channelOverrides = parseChannelOverride(readStrOption(options, "channel-override"));
          const effectiveChannel = channelOverrides.get(event) ?? channel;

          const text = readStrOption(options, "text");
          const title = readStrOption(options, "title") ?? text?.split("\n")[0];

          if (!title) {
            throw new CommandError(
              "Provide a --title or --text to send (e.g. `pm slack notify --text 'hello'`)",
              EXIT_CODE.USAGE
            );
          }

          // Synthesize a minimal item from the flags so we can reuse the
          // message builder. This command is for ad-hoc posts, not item lookups.
          const assignee = readStrOption(options, "assignee");
          const url = readStrOption(options, "url");
          const item: PmItem = {
            id: "manual",
            title,
            type: readStrOption(options, "type") ?? "Note",
            ...(readStrOption(options, "status") ? { status: readStrOption(options, "status") } : {}),
            ...(assignee ? { assignee } : {}),
          };

          // --filter: skip the notification if the item/event does not match ALL selectors.
          const filters = parseFilter(readStrOption(options, "filter"));
          if (!matchesFilter(filters, event, item)) {
            const reason = `event=${event} did not match filter: ${filters.join(", ")}`;
            if (!asJson) {
              console.error(`[pm-slack] Notification filtered out (${reason})`);
            }
            return { filtered: true, event, filter: filters.join(","), reason };
          }

          // --format custom: require --template
          const customTemplate = readStrOption(options, "template") ?? process.env.PM_SLACK_TEMPLATE;
          if (format === "custom" && !customTemplate) {
            throw new CommandError(
              "--format custom requires --template <template string> with {placeholders} (e.g. --template '{emoji} {title} {event}')",
              EXIT_CODE.USAGE
            );
          }

          // Layer env maps with the inline --mention-map flag (flag wins).
          const assigneeMap = buildMentionMap(readStrOption(options, "mention-map"));
          // Mention when explicitly requested, or implicitly when an assignee
          // maps to a Slack id (so the @mention is opt-in but ergonomic).
          const wantMention = readBoolOption(options, "mention-assignee") || assigneeMap.size > 0;
          const mention = wantMention ? resolveAssigneeMention(item, assigneeMap) : undefined;
          const link = resolveItemUrl(item, url);

          const payload: SlackPayload = {
            ...buildItemPayload(item, event, format, {
              channel: effectiveChannel,
              note: text && text !== title ? text : undefined,
              mention,
              link,
              template: customTemplate,
            }),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          };

          if (dryRun) {
            if (!asJson) {
              console.error("--- DRY RUN (message not posted) ---");
              process.stdout.write(payload.text + "\n");
              console.error(`--- ${format} payload ---`);
              process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
              console.error("--- END ---");
            }
            return { dryRun: true, event, format, channel: effectiveChannel, thread_ts: threadTs, payload };
          }

          if (!webhookUrl) {
            // Unreachable in normal flow: the preflight gate above already
            // aborts when no webhook is configured. Kept as a defensive guard
            // so a missing webhook can never reach the network layer.
            throw new CommandError(
              "No Slack webhook configured for `slack notify`. " +
                "Set PM_SLACK_WEBHOOK or pass --webhook <url> (or use --dry-run to preview).",
              EXIT_CODE.USAGE
            );
          }

          try {
            await postToSlack(webhookUrl, payload);
          } catch (err) {
            // Never throw on network failure: warn and exit 0.
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[pm-slack] Slack post failed (continuing): ${message}`);
            return { posted: false, error: message };
          }

          return { posted: true, event, channel: effectiveChannel, thread_ts: threadTs };
        },
      });

      // ---------------------------------------------------------------------
      // command — `pm slack test` : build and PRINT a sample notification in
      // the chosen format WITHOUT posting. Fully offline; the package is
      // testable with no Slack credentials. Honors --json for machine reads.
      // ---------------------------------------------------------------------
      api.registerCommand({
        name: "slack test",
        description: "Preview a sample pm-slack notification in the chosen format without posting (offline)",
        intent: "Preview Slack notification formatting offline (no webhook, no network)",
        examples: [
          "pm slack test --format blockkit",
          "pm slack test --format text --on close",
          "pm slack test --on block --json",
          "pm slack test --on cancel",
          "pm slack test --format custom --template '{emoji} {title} ({id}) {event}' --on close",
          "pm slack test --on close --filter 'type:Issue'",
          "pm slack test --on close --channel-override 'close=#releases'",
          "PM_SLACK_ASSIGNEE_MAP='alice=U123' pm slack test --on start --mention-assignee",
        ],
        flags: [
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default), text, or custom (requires --template). Overrides PM_SLACK_FORMAT." },
          { long: "--template", value_name: "tpl", description: "Custom message template with {placeholders} (title, id, event, type, status, priority, assignee, mention, reason, channel, emoji, author). Used with --format custom." },
          { long: "--on", value_name: "event", description: "Lifecycle event to preview (create,close,block,cancel,open,start,unblock,reopen). Default: create" },
          { long: "--title", value_name: "title", description: "Sample item title (default: a representative example)" },
          { long: "--channel", value_name: "name", description: "Channel hint to show in the preview (overrides PM_SLACK_CHANNEL)" },
          { long: "--filter", value_name: "selectors", description: "Comma-separated selectors to filter which events trigger notifications (type:Bug, status:closed, event:create, or bare event name). ALL must match." },
          { long: "--channel-override", value_name: "pairs", description: "Comma list of event=channel pairs to redirect specific event types to different channels" },
          { long: "--mention-assignee", description: "Resolve the sample assignee to a Slack @mention via the mention map" },
          { long: "--mention-map", value_name: "pairs", description: "Inline mention map, comma list of name=@handle|name=Uxxxx pairs (overrides PM_SLACK_ASSIGNEE_MAP / PM_SLACK_MENTION_MAP for this preview)" },
          { long: "--url", value_name: "url", description: "Add a Block Kit action button linking to this URL (default: a sample GitHub URL)" },
          { long: "--json", description: "Emit the preview payload as JSON" },
          { long: "--dry-run", description: "Accepted for symmetry; this command never posts." },
        ],

        async run(ctx: { args?: string[]; options?: Record<string, unknown>; global?: { json?: boolean } }) {
          const options = ctx.options ?? {};
          // `--json` is consumed by pm as a global flag, so prefer global.json;
          // also honor a local --json for robustness across runtimes.
          const asJson = ctx.global?.json === true || readBoolOption(options, "json");
          const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);
          const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;

          const events = parseEvents(readStrOption(options, "on") ?? "create");
          const event: EventKind = (ALL_EVENTS.find((e) => events.has(e)) ?? "create") as EventKind;

          // --channel-override: redirect specific event types to different channels.
          const channelOverrides = parseChannelOverride(readStrOption(options, "channel-override"));
          const effectiveChannel = channelOverrides.get(event) ?? channel;

          const t = readStrOption(options, "title");
          // A representative sample item per event so the preview is realistic.
          const sample: Record<EventKind, PmItem> = {
            create: { id: "pm-1a2b", title: t ?? "Add OAuth login flow", type: "Feature", priority: 2, status: "open", author: "alice", assignee: "alice", github_url: "https://github.com/unbraind/pm-slack/issues/1" },
            close: { id: "pm-3c4d", title: t ?? "Fix login redirect bug", type: "Issue", priority: 1, status: "closed", author: "bob", assignee: "bob", close_reason: "Fixed in commit abc123", github_url: "https://github.com/unbraind/pm-slack/issues/2" },
            block: { id: "pm-5e6f", title: t ?? "Dashboard redesign", type: "Epic", priority: 2, status: "blocked", author: "carol", assignee: "carol", blocked_reason: "Waiting on design approval" },
            cancel: { id: "pm-7g8h", title: t ?? "Legacy export pipeline", type: "Task", priority: 3, status: "canceled", author: "dave", assignee: "dave", close_reason: "Superseded by new pipeline" },
            open: { id: "pm-9i0j", title: t ?? "Publish onboarding guide", type: "Task", priority: 3, status: "open", author: "erin", assignee: "erin" },
            start: { id: "pm-1k2l", title: t ?? "Implement rate limiter", type: "Feature", priority: 2, status: "in_progress", author: "frank", assignee: "frank", github_url: "https://github.com/unbraind/pm-slack/pull/3" },
            unblock: { id: "pm-3m4n", title: t ?? "Payment reconciliation", type: "Issue", priority: 1, status: "open", author: "grace", assignee: "grace" },
            reopen: { id: "pm-5o6p", title: t ?? "Flaky integration test", type: "Bug", priority: 2, status: "open", author: "heidi", assignee: "heidi" },
          };
          const item = sample[event];

          // --filter: show whether the notification would be filtered out.
          const filters = parseFilter(readStrOption(options, "filter"));
          const filtered = !matchesFilter(filters, event, item);

          // --format custom: require --template
          const customTemplate = readStrOption(options, "template") ?? process.env.PM_SLACK_TEMPLATE;
          if (format === "custom" && !customTemplate) {
            throw new CommandError(
              "--format custom requires --template <template string> with {placeholders} (e.g. --template '{emoji} {title} {event}')",
              EXIT_CODE.USAGE
            );
          }

          const assigneeMap = buildMentionMap(readStrOption(options, "mention-map"));
          const wantMention = readBoolOption(options, "mention-assignee") || assigneeMap.size > 0;
          const mention = wantMention ? resolveAssigneeMention(item, assigneeMap) : undefined;
          const link = resolveItemUrl(item, readStrOption(options, "url"));

          const payload = buildItemPayload(item, event, format, { channel: effectiveChannel, mention, link, template: customTemplate });

          // In JSON mode, pm renders the returned object — don't also write to
          // stdout (that would corrupt the JSON stream). In human mode, print a
          // readable preview to stdout/stderr.
          if (!asJson) {
            const filterNote = filters.length > 0 ? (filtered ? " [FILTERED OUT]" : " [filter matched]") : "";
            console.error(`--- PREVIEW (${format}, event=${event})${filterNote} — nothing posted ---`);
            process.stdout.write(payload.text + "\n");
            console.error(`--- ${format} payload ---`);
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
            console.error("--- END ---");
          }
          return {
            preview: true,
            event,
            format,
            channel: effectiveChannel,
            ...(filters.length > 0 ? { filtered } : {}),
            payload,
          };
        },
      });

      // ---------------------------------------------------------------------
      // command — `pm slack digest` : summarize recent activity (created /
      // closed / blocked / in-progress) over a --since/--days window into a
      // single notification. Reads the pm store directly; --dry-run prints
      // without posting.
      // ---------------------------------------------------------------------
      api.registerCommand({
        name: "slack digest",
        description: "Post (or preview) a single summary of recent pm activity over a time window",
        intent: "Summarize recent pm activity (created/closed/blocked/in-progress) into one Slack message",
        examples: [
          "pm slack digest --days 7 --dry-run",
          "pm slack digest --since 2026-06-01 --format text --dry-run",
          "pm slack digest --days 1 --format blockkit --json --dry-run",
          "pm slack digest --days 7 --thread 1700000000.000100 --dry-run",
        ],
        flags: [
          { long: "--since", value_name: "date", description: "Only include activity at/after this ISO date (e.g. 2026-06-01)" },
          { long: "--days", value_name: "n", description: "Look back N days from now (default 7; ignored when --since is given)" },
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default) or text. Overrides PM_SLACK_FORMAT." },
          { long: "--channel", value_name: "name", description: "Channel to post to (overrides PM_SLACK_CHANNEL)" },
          { long: "--thread", value_name: "ts", description: "Slack thread timestamp (thread_ts) to reply into a thread" },
          { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK)" },
          { long: "--dry-run", description: "Build and print the digest without posting to Slack" },
          { long: "--json", description: "Emit the digest summary/payload as JSON" },
        ],

        async run(ctx: { args?: string[]; options?: Record<string, unknown>; pm_root?: string; global?: { json?: boolean } }) {
          const options = ctx.options ?? {};
          const dryRun = readBoolOption(options, "dry-run");
          const asJson = ctx.global?.json === true || readBoolOption(options, "json");
          const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);
          if (format === "custom") {
            throw new CommandError("slack digest supports only --format blockkit or --format text", EXIT_CODE.USAGE);
          }
          const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
          const threadTs = readStrOption(options, "thread");
          const webhookUrl = readStrOption(options, "webhook") ?? process.env.PM_SLACK_WEBHOOK ?? "";

          // Preflight gate: a real (non-dry-run) post requires a valid webhook.
          // Fail fast BEFORE reading the store / building the digest. --dry-run
          // is an offline preview and is intentionally NOT gated.
          if (!dryRun) {
            assertWebhookConfigured(readStrOption(options, "webhook"), "slack digest");
          }

          const since = readStrOption(options, "since");
          const daysStr = readStrOption(options, "days");
          const days = daysStr !== undefined ? parseInt(daysStr, 10) : undefined;
          if (daysStr !== undefined && (days === undefined || Number.isNaN(days) || days <= 0)) {
            throw new CommandError(`--days must be a positive integer (got "${daysStr}")`, EXIT_CODE.USAGE);
          }

          const pmRoot = ctx.pm_root ?? path.join(process.cwd(), ".agents", "pm");
          const { cutoffMs, label } = resolveWindow(since, days);
          const items = readStoreItems(pmRoot);
          const summary = aggregateDigest(items, cutoffMs, label);
          const payload = { ...buildDigestPayload(summary, format, channel), ...(threadTs ? { thread_ts: threadTs } : {}) };

          if (dryRun) {
            if (!asJson) {
              console.error(`--- DRY RUN digest (${format}, ${label}) — nothing posted ---`);
              process.stdout.write(payload.text + "\n");
              console.error(`--- ${format} payload ---`);
              process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
              console.error("--- END ---");
            }
            return { dryRun: true, format, channel, thread_ts: threadTs, counts: summary.counts, total: summary.total, window: label, payload };
          }

          // Real post requested: a webhook is mandatory. Fail cleanly (exit 1).
          if (!webhookUrl) {
            throw new CommandError(
              "No Slack webhook configured: set PM_SLACK_WEBHOOK or pass --webhook (or use --dry-run to preview).",
              EXIT_CODE.GENERIC_FAILURE
            );
          }

          try {
            await postToSlack(webhookUrl, payload);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new CommandError(`Failed to post digest to Slack: ${message}`, EXIT_CODE.GENERIC_FAILURE);
          }

          return { posted: true, format, channel, thread_ts: threadTs, counts: summary.counts, total: summary.total, window: label };
        },
      });
    }
  },
});

// Exported for unit tests (Block Kit builder + helpers).
export const __test__ = {
  buildItemBlockKit,
  buildItemPayload,
  buildTextMessage,
  buildCustomMessage,
  truncate,
  sectionFields,
  SLACK_SECTION_TEXT_MAX,
  SLACK_SECTION_FIELD_TEXT_MAX,
  SLACK_SECTION_FIELDS_MAX,
  SLACK_HEADER_TEXT_MAX,
  parseEvents,
  normalizeEvent,
  parseFormat,
  parseRoutes,
  ruleMatches,
  selectRoute,
  detectEvent,
  statusToEvent,
  extractItem,
  meetsMinPriority,
  parseAssigneeMap,
  resolveAssigneeMention,
  formatMention,
  buildMentionMap,
  loadConfig,
  warnWebhookUnsetOnce,
  __resetWarnState: () => {
    warnedWebhookUnset = false;
  },
  resolveItemUrl,
  isHttpUrl,
  EVENT_META,
  parseStoredItem,
  resolveWindow,
  aggregateDigest,
  buildDigestText,
  buildDigestBlockKit,
  buildDigestPayload,
  resolveEffectiveWebhook,
  assertWebhookConfigured,
  slackRetryDelayMs,
  parseRetryAfterMs,
  isRetryableSlackError,
  postToSlackOnce,
  SlackHttpError,
  EXIT_CODE,
  CommandError,
  parseFilter,
  filterMatches,
  matchesFilter,
  parseChannelOverride,
};
