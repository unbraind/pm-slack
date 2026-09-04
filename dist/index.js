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
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
// ---------------------------------------------------------------------------
// Option helpers
//
// pm normalizes CLI flags to camelCase at runtime (e.g. `--dry-run` becomes
// `dryRun`), so reading only the kebab-case key silently misses the value.
// Read both forms to be robust.
// ---------------------------------------------------------------------------
function camelCase(key) {
    return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
/**
 * Read a boolean option under both the kebab-case and camelCase spellings.
 *
 * pm normalizes CLI flags to camelCase at runtime, so reading only one key
 * silently misses the value; this tries `key` then its {@link camelCase} form
 * and accepts either a real boolean or a truthy/falsy string (`true`/`1`/`yes`/
 * `on` vs `false`/`0`/`no`/`off`). A missing or unrecognized option resolves to
 * `false` so an unset flag never blocks behavior.
 *
 * @param options - The raw flag record handed to the command.
 * @param key - The flag name, in its kebab-case form (e.g. `dry-run`).
 * @returns The resolved boolean, or `false` when the option is unset.
 */
function readBoolOption(options, key) {
    for (const candidate of [key, camelCase(key)]) {
        const value = options[candidate];
        if (typeof value === "boolean")
            return value;
        if (typeof value === "string") {
            const v = value.trim().toLowerCase();
            if (v === "true" || v === "1" || v === "yes" || v === "on")
                return true;
            if (v === "false" || v === "0" || v === "no" || v === "off")
                return false;
        }
    }
    return false;
}
/**
 * Read a trimmed, non-empty string option under both flag spellings.
 *
 * Like {@link readBoolOption}, this tries the kebab-case and camelCase keys so a
 * value set under either form is found. A blank or whitespace-only value is
 * treated as absent and skipped, so callers can rely on a non-empty return.
 *
 * @param options - The raw flag record handed to the command.
 * @param key - The flag name, in its kebab-case form.
 * @returns The trimmed value, or `undefined` when the option is unset or blank.
 */
function readStrOption(options, key) {
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
const ALL_EVENTS = [
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
const EVENT_ALIASES = {
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
function normalizeEvent(token) {
    const t = token.trim().toLowerCase();
    if (ALL_EVENTS.includes(t))
        return t;
    return EVENT_ALIASES[t] ?? null;
}
/**
 * Parse a comma-separated event spec into the set of events to notify on.
 *
 * Each token is normalized via {@link normalizeEvent}, which accepts canonical
 * names and friendly aliases (e.g. `canceled` → cancel, `in_progress` → start).
 * A blank spec, or one whose tokens all fail to normalize, falls back to
 * {@link ALL_EVENTS} so an empty `--on` never disables notifications silently.
 *
 * @param spec - The raw `PM_SLACK_EVENTS` / `--on` value, possibly undefined.
 * @returns The resolved set of event kinds to subscribe to.
 */
function parseEvents(spec) {
    if (!spec)
        return new Set(ALL_EVENTS);
    const parsed = spec
        .split(",")
        .map((e) => normalizeEvent(e))
        .filter((e) => e !== null);
    return parsed.length > 0 ? new Set(parsed) : new Set(ALL_EVENTS);
}
// ---------------------------------------------------------------------------
// Format parsing
// ---------------------------------------------------------------------------
const ALL_FORMATS = ["blockkit", "text", "custom"];
/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text, "template"/"tmpl"
 * → custom). Falls back to the supplied default when the spec is empty or
 * unrecognized.
 */
function parseFormat(spec, fallback = "blockkit") {
    if (!spec)
        return fallback;
    const v = spec.trim().toLowerCase();
    if (v === "blockkit" || v === "block" || v === "blocks" || v === "rich")
        return "blockkit";
    if (v === "text" || v === "plain" || v === "txt")
        return "text";
    if (v === "custom" || v === "template" || v === "tmpl")
        return "custom";
    return fallback;
}
// ---------------------------------------------------------------------------
// Routing
//
// PM_SLACK_ROUTES is an optional JSON array of rules that send specific events,
// item types, or statuses to a different webhook/channel. Routing is purely
// additive: with no rules configured, behavior is identical to before.
// ---------------------------------------------------------------------------
/**
 * Parse the `PM_SLACK_ROUTES` JSON spec into validated routing rules.
 *
 * Returns an empty list (with a stderr notice) when the spec is missing, blank,
 * not valid JSON, or not an array, so a malformed config disables routing
 * rather than crashing. Each surviving object entry needs at least a `match`
 * selector and one override (`webhook` or `channel`); entries missing both are
 * dropped as meaningless. Routing is additive — an empty list means "behave as
 * before".
 *
 * @param spec - The raw `PM_SLACK_ROUTES` value, possibly undefined.
 * @returns The validated route rules (possibly empty).
 */
function parseRoutes(spec) {
    if (!spec || !spec.trim())
        return [];
    let raw;
    try {
        raw = JSON.parse(spec);
    }
    catch {
        console.error("[pm-slack] PM_SLACK_ROUTES is not valid JSON — routing disabled");
        return [];
    }
    if (!Array.isArray(raw)) {
        console.error("[pm-slack] PM_SLACK_ROUTES must be a JSON array — routing disabled");
        return [];
    }
    const rules = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object")
            continue;
        const e = entry;
        const match = typeof e.match === "string" ? e.match.trim() : "";
        if (!match)
            continue;
        const webhook = typeof e.webhook === "string" && e.webhook.trim() ? e.webhook.trim() : undefined;
        const channel = typeof e.channel === "string" && e.channel.trim() ? e.channel.trim() : undefined;
        if (!webhook && !channel)
            continue; // a rule with no override is meaningless
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
function ruleMatches(rule, event, item) {
    const sel = rule.match.toLowerCase();
    if (sel === "*" || sel === "all")
        return true;
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
function selectRoute(event, item, routes, defaultWebhook, defaultChannel) {
    for (const rule of routes) {
        if (ruleMatches(rule, event, item)) {
            const webhookUrl = rule.webhook ?? defaultWebhook;
            if (!webhookUrl)
                return null;
            return { webhookUrl, channel: rule.channel ?? defaultChannel };
        }
    }
    if (!defaultWebhook)
        return null;
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
function parseFilter(spec) {
    if (!spec || !spec.trim())
        return [];
    return spec
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * Check if an item/event matches a single filter selector.
 */
function filterMatches(filter, event, item) {
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
function matchesFilter(filters, event, item) {
    if (filters.length === 0)
        return true;
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
function parseChannelOverride(spec) {
    const map = new Map();
    if (!spec || !spec.trim())
        return map;
    for (const pair of spec.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0)
            continue;
        const eventToken = pair.slice(0, eq).trim().toLowerCase();
        const channel = pair.slice(eq + 1).trim();
        if (!channel)
            continue;
        const event = normalizeEvent(eventToken);
        if (event)
            map.set(event, channel);
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
function resolveEffectiveWebhook(webhookFlag) {
    const flag = webhookFlag?.trim();
    if (flag)
        return { webhookUrl: flag, source: "flag" };
    const env = process.env.PM_SLACK_WEBHOOK?.trim();
    if (env)
        return { webhookUrl: env, source: "env" };
    // A route rule may supply its own webhook; accept that as a valid source so a
    // routes-only setup passes the gate. The default webhook is then empty and
    // per-event routing resolves the real destination at post time.
    const routes = parseRoutes(process.env.PM_SLACK_ROUTES);
    if (routes.some((r) => r.webhook))
        return { webhookUrl: "", source: "route" };
    return { webhookUrl: "", source: "none" };
}
/**
 * The command paths whose preflight this package gates: the ones that actually
 * post to Slack.
 *
 * This is the single source of truth for the preflight scope. It feeds both the
 * `commands` array `registerPreflight` is registered with AND the runtime check
 * inside that override's `run`. Those were two independent string literals
 * holding the same knowledge, which is exactly how a command silently loses its
 * gate: adding a posting command to one literal and not the other leaves the
 * override registered for a path it then declines to act on, or acting on a path
 * it was never scoped to.
 *
 * `slack test` is deliberately absent — it is an offline preview that makes no
 * network call, so gating it on a configured webhook would refuse the one
 * command that exists to work without one.
 */
export const SLACK_POSTING_COMMANDS = ["slack notify", "slack digest"];
/**
 * The command paths this package owns that are deliberately NOT gated.
 *
 * Declared explicitly rather than inferred as "everything not in
 * {@link SLACK_POSTING_COMMANDS}". The difference matters: with an inferred
 * complement, a newly declared command is silently classified as offline and
 * loses its gate with nothing to notice. With both classes named, a command in
 * neither is *unclassified*, which the drift test can and does reject.
 *
 * `slack test` is an offline preview that makes no network call, so gating it on
 * a configured webhook would refuse the one command that exists to work without
 * one.
 */
export const SLACK_OFFLINE_COMMANDS = ["slack test"];
/**
 * Whether `command` is one this package gates a webhook on.
 *
 * @param command - Normalized (lower-cased) full command path, e.g. `slack notify`.
 * @returns `true` only for a declared posting command.
 */
export function isSlackPostingCommand(command) {
    return SLACK_POSTING_COMMANDS.includes(command);
}
/**
 * Whether `command` is a declared pm-slack path that is deliberately ungated.
 *
 * @param command - Normalized (lower-cased) full command path.
 * @returns `true` only for a declared offline command.
 */
export function isSlackOfflineCommand(command) {
    return SLACK_OFFLINE_COMMANDS.includes(command);
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
function assertWebhookConfigured(webhookFlag, commandLabel) {
    const { webhookUrl, source } = resolveEffectiveWebhook(webhookFlag);
    if (source === "none") {
        throw new CommandError(`No Slack webhook configured for \`${commandLabel}\`. ` +
            "Set the PM_SLACK_WEBHOOK environment variable, pass --webhook <url>, " +
            "or configure PM_SLACK_ROUTES with per-rule webhooks. " +
            "Use --dry-run to preview the message without a webhook.", EXIT_CODE.USAGE);
    }
    // Route-sourced configs have no default URL to validate here (route webhooks
    // are validated lazily at post time); a present URL must be well-formed.
    if (webhookUrl) {
        let parsed;
        try {
            parsed = new URL(webhookUrl);
        }
        catch {
            throw new CommandError(`Slack webhook for \`${commandLabel}\` is not a valid URL ` +
                `(${source === "flag" ? "--webhook" : "PM_SLACK_WEBHOOK"}=\"${webhookUrl}\"). ` +
                "Expected an https URL, e.g. https://hooks.slack.com/services/...", EXIT_CODE.USAGE);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new CommandError(`Slack webhook for \`${commandLabel}\` must be an http(s) URL ` +
                `(got protocol "${parsed.protocol}" from ` +
                `${source === "flag" ? "--webhook" : "PM_SLACK_WEBHOOK"}).`, EXIT_CODE.USAGE);
        }
    }
}
// Module-level guard so the "webhook not set" notice is emitted at most ONCE
// per process. The afterCommand hook runs on EVERY pm command, so without this
// guard a webhook-less install would spam stderr on every invocation. Exposed
// via __test__ resets so the once-only behavior is unit-testable.
let warnedWebhookUnset = false;
function warnWebhookUnsetOnce() {
    if (warnedWebhookUnset)
        return;
    warnedWebhookUnset = true;
    console.error("[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled");
}
/**
 * Assemble the effective {@link SlackConfig} from the pm-slack environment.
 *
 * Reads the webhook, routes, channel, priority floor, event set, format, and
 * assignee-mention map from their env vars. Returns `null` — after emitting the
 * once-per-process disabled notice via {@link warnWebhookUnsetOnce} — when there
 * is no webhook source at all, or when `PM_SLACK_WEBHOOK` is present but not a
 * valid URL; a routes-only setup with no default webhook is accepted. Mentions
 * auto-enable whenever a non-empty mention map is present unless explicitly
 * turned off.
 *
 * @returns The resolved config, or `null` when notifications are disabled.
 */
function loadConfig() {
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
        }
        catch {
            console.error("[pm-slack] PM_SLACK_WEBHOOK is not a valid URL — notifications disabled");
            return null;
        }
    }
    const channel = process.env.PM_SLACK_CHANNEL?.trim() || undefined;
    const rawPriority = parseInt(process.env.PM_SLACK_MIN_PRIORITY ?? "1", 10);
    const minPriority = rawPriority >= 1 && rawPriority <= 4 ? rawPriority : 1;
    const events = parseEvents(process.env.PM_SLACK_EVENTS);
    const format = parseFormat(process.env.PM_SLACK_FORMAT);
    // Hook map comes from env only (no per-command flag in the hook path).
    // PM_SLACK_MENTION_MAP is an alias/overlay of PM_SLACK_ASSIGNEE_MAP.
    const assigneeMap = buildMentionMap(undefined);
    // Mentions are auto-enabled in the hook whenever a non-empty map is present;
    // PM_SLACK_MENTION_ASSIGNEE=0/false can force them off even with a map.
    const mentionEnv = (process.env.PM_SLACK_MENTION_ASSIGNEE ?? "").trim().toLowerCase();
    const mentionAssignee = mentionEnv === "0" || mentionEnv === "false" || mentionEnv === "no" || mentionEnv === "off"
        ? false
        : assigneeMap.size > 0;
    return { webhookUrl, channel, minPriority, events, format, routes, assigneeMap, mentionAssignee };
}
// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------
const PRIORITY_LABELS = {
    1: "critical",
    2: "high",
    3: "medium",
    4: "low",
};
function priorityLabel(p) {
    return p !== undefined ? PRIORITY_LABELS[p] ?? "unknown" : "unknown";
}
function meetsMinPriority(item, minPriority) {
    // Lower number = higher priority; 1 = critical
    if (item.priority === undefined)
        return true; // unknown priority always passes
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
function parseAssigneeMap(spec) {
    const map = new Map();
    if (!spec || !spec.trim())
        return map;
    for (const pair of spec.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0)
            continue;
        const name = pair.slice(0, eq).trim().toLowerCase();
        const id = pair.slice(eq + 1).trim();
        if (name && id)
            map.set(name, id);
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
function formatMention(value) {
    const v = value.trim();
    if (v.startsWith("<") || v.startsWith("@"))
        return v;
    return `<@${v}>`;
}
/**
 * Resolve an item's assignee to a Slack mention token using the map. Returns a
 * ready-to-embed mention string (e.g. `<@U123>`) or undefined when there's no
 * assignee or no mapping. See {@link formatMention} for accepted value forms.
 */
function resolveAssigneeMention(item, map) {
    const assignee = item.assignee?.trim();
    if (!assignee || map.size === 0)
        return undefined;
    const id = map.get(assignee.toLowerCase());
    if (!id)
        return undefined;
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
function buildMentionMap(flagSpec, env = {
    assigneeMap: process.env.PM_SLACK_ASSIGNEE_MAP,
    mentionMap: process.env.PM_SLACK_MENTION_MAP,
}) {
    const merged = new Map();
    for (const spec of [env.assigneeMap, env.mentionMap, flagSpec]) {
        for (const [name, id] of parseAssigneeMap(spec))
            merged.set(name, id);
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
/**
 * Type guard: whether a value is a non-empty `http` or `https` URL string.
 *
 * Used to validate caller-supplied item links before they reach a Block Kit
 * action button. Parsing through `URL` (rather than a prefix check) rejects
 * malformed strings and non-web schemes; the narrowing return lets the caller
 * treat the value as a string without a further cast.
 *
 * @param value - The candidate field value from an item or flag.
 * @returns True when `value` parses to an http(s) URL (narrowed to `string`).
 */
function isHttpUrl(value) {
    if (typeof value !== "string")
        return false;
    const v = value.trim();
    if (!v)
        return false;
    try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
    }
    catch {
        return false;
    }
}
/** Resolve a primary URL for the item, plus whether it points at GitHub. */
function resolveItemUrl(item, override) {
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
function itemTypeLabel(item) {
    return item.type ?? "Item";
}
const EVENT_META = {
    create: { verb: "created", emoji: "🆕" },
    close: { verb: "closed", emoji: "✅" },
    block: { verb: "is blocked", emoji: "🚫" },
    cancel: { verb: "canceled", emoji: "🛑" },
    open: { verb: "opened", emoji: "📂" },
    start: { verb: "started", emoji: "🔄" },
    unblock: { verb: "unblocked", emoji: "🔓" },
    reopen: { verb: "reopened", emoji: "♻️" },
};
/**
 * Extract the human-readable reason for a terminal or blocking transition.
 *
 * `close` reads `close_reason`/`closedReason`; `cancel` honors a dedicated
 * `cancel_reason` first but falls back to `close_reason` (pm persists the cancel
 * reason there today); `block` reads `blocked_reason`/`blockedReason`. Other
 * events carry no reason and return `undefined`. Whitespace is trimmed and an
 * empty reason collapses to `undefined`.
 *
 * @param item - The item the event applies to.
 * @param event - The lifecycle event kind.
 * @returns The trimmed reason, or `undefined` when none applies.
 */
function eventReason(item, event) {
    if (event === "close") {
        return item.close_reason?.trim() || item.closedReason?.trim() || undefined;
    }
    if (event === "cancel") {
        // pm persists the cancel reason in close_reason; honor a dedicated
        // cancel_reason first if a future pm version introduces one.
        return (item.cancel_reason?.trim() ||
            item.cancelReason?.trim() ||
            item.close_reason?.trim() ||
            item.closedReason?.trim() ||
            undefined);
    }
    if (event === "block") {
        return item.blocked_reason?.trim() || item.blockedReason?.trim() || undefined;
    }
    return undefined;
}
/**
 * Build the plain-text (mrkdwn) Slack message for a single item event.
 *
 * Composes a one-line header from the item type, title, and the event's verb
 * and emoji, then appends a detail line that depends on the event: priority and
 * author for creations, the {@link eventReason} for terminal/blocked events, or
 * status and assignee for plain transitions. An optional assignee mention and
 * channel tag are appended when supplied. This is both the standalone `text`
 * format and the Block Kit fallback produced by {@link buildItemBlockKit}.
 *
 * @param item - The item the event applies to.
 * @param event - The lifecycle event kind.
 * @param channel - Optional resolved channel, echoed as an italic footer line.
 * @param mention - Optional pre-resolved assignee mention token.
 * @returns The composed mrkdwn message string.
 */
function buildTextMessage(item, event, channel, mention) {
    const type = itemTypeLabel(item);
    const meta = EVENT_META[event];
    let msg = `*[${type}]* ${item.title} ${meta.verb} ${meta.emoji}`;
    if (event === "create") {
        msg += `\nPriority: ${priorityLabel(item.priority)} • Type: ${type} • By: ${item.author ?? "unknown"}`;
    }
    else if (event === "close" || event === "cancel" || event === "block") {
        // Terminal/blocked transitions carry a reason field.
        msg += `\nReason: ${eventReason(item, event) ?? "no reason given"}`;
    }
    else {
        // Status transitions without a reason (open/start/unblock/reopen).
        msg += `\nStatus: ${item.status ?? meta.verb}${item.assignee ? ` • Assignee: ${item.assignee}` : ""}`;
    }
    if (mention)
        msg += `\nAssignee: ${mention}`;
    if (channel)
        msg += `\n_Channel: ${channel}_`;
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
function templateReplacements(item, event, opts) {
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
function buildCustomMessage(item, event, template, opts = {}) {
    const replacements = templateReplacements(item, event, opts);
    return template.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? `{${key}}`);
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
function truncate(text, max) {
    if (max <= 0)
        return "";
    if (text.length <= max)
        return text;
    if (max === 1)
        return "…";
    const budget = max - 1; // reserve one UTF-16 unit for the "…"
    let out = "";
    for (const ch of text) { // `for…of` iterates whole code points
        if (out.length + ch.length > budget)
            break;
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
function sectionFields(texts) {
    return texts
        .slice(0, SLACK_SECTION_FIELDS_MAX)
        .map((text) => ({ type: "mrkdwn", text: truncate(text, SLACK_SECTION_FIELD_TEXT_MAX) }));
}
/**
 * Build the Slack Block Kit blocks (plus a plain-text fallback) for an item event.
 *
 * Lays out a header, a two-column field grid (item id, type, event, priority,
 * status, author, assignee/mention), an optional reason or note section, an
 * optional "Open item"/"View on GitHub" action button when a link resolves, and
 * a context footer. Every caller-controlled string is capped through
 * {@link truncate} so no block can exceed Slack's limits and reject the message.
 * The fallback mirrors {@link buildTextMessage}.
 *
 * @param item - The item the event applies to.
 * @param event - The lifecycle event kind.
 * @param opts - Optional channel, note, mention, link, and template overrides.
 * @returns The `blocks` array and the plain-text fallback string.
 */
function buildItemBlockKit(item, event, opts = {}) {
    const type = itemTypeLabel(item);
    const meta = EVENT_META[event];
    const blocks = [];
    blocks.push({
        type: "header",
        text: {
            type: "plain_text",
            text: truncate(`${meta.emoji} ${item.title}`, SLACK_HEADER_TEXT_MAX),
            emoji: true,
        },
    });
    // Fields section: a 2-column grid of mrkdwn key/value pairs.
    const fieldTexts = [
        `*Item:*\n${item.id}`,
        `*Type:*\n${type}`,
        `*Event:*\n${meta.verb}`,
        `*Priority:*\n${priorityLabel(item.priority)}`,
    ];
    if (item.status)
        fieldTexts.push(`*Status:*\n${item.status}`);
    if (item.author)
        fieldTexts.push(`*By:*\n${item.author}`);
    // Assignee mention (Feature 2): show the @mention when mapped, else the raw
    // assignee name so the field is still useful without a configured map.
    if (opts.mention)
        fieldTexts.push(`*Assignee:*\n${opts.mention}`);
    else if (item.assignee)
        fieldTexts.push(`*Assignee:*\n${item.assignee}`);
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
function buildItemPayload(item, event, format, opts = {}) {
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
/**
 * Upper bound on how long a single retry may sleep, in milliseconds.
 *
 * The exponential fallback is already bounded, but a server-supplied
 * `Retry-After` was not — so the delay we control was capped and the delay a
 * remote controls was not, which is exactly backwards. A response carrying
 * `Retry-After: 99999999` would otherwise park the process for weeks. Slack's
 * real rate-limit windows are seconds to a couple of minutes, so a two-minute
 * ceiling never truncates a legitimate wait.
 */
const SLACK_MAX_RETRY_DELAY_MS = 120_000;
/**
 * Resolve after at most {@link SLACK_MAX_RETRY_DELAY_MS} milliseconds.
 *
 * `setTimeout` accepts any non-negative number, so a helper that forwards its
 * argument unchanged lets a server-controlled value — or any future caller —
 * park the process for arbitrarily long. That is the resource-exhaustion path
 * CodeQL anchors on this helper, and it is why the earlier `Retry-After` clamp
 * did not close it: that clamp sits at one call site, while the reachable path
 * the query describes is the helper's own unbounded parameter, which every
 * other caller can still reach.
 *
 * The bound is therefore applied here, at the anchor. It is written as an
 * explicit comparison against a single named ceiling rather than as nested
 * `Math` calls so the bound is legible at the point of use, and it reads the
 * same {@link SLACK_MAX_RETRY_DELAY_MS} the retry policy uses rather than a
 * second constant of its own — two ceilings governing one retry path would
 * drift the moment either were updated alone.
 *
 * `ms` is also floored at zero, and the comparison is ordered so `NaN` takes
 * the floor rather than falling through: every comparison against `NaN` is
 * false, so a `NaN` delay lands on 0 instead of being coerced silently.
 *
 * @param ms - Requested delay in milliseconds; any value, from any caller.
 * @returns A promise resolving after a delay in `[0, SLACK_MAX_RETRY_DELAY_MS]`.
 */
const sleep = (ms) => {
    const bounded = ms > SLACK_MAX_RETRY_DELAY_MS ? SLACK_MAX_RETRY_DELAY_MS : ms > 0 ? ms : 0;
    return new Promise((resolve) => setTimeout(resolve, bounded));
};
class SlackHttpError extends Error {
    status;
    retryAfterMs;
    constructor(status, message, retryAfterMs) {
        super(message);
        this.name = "SlackHttpError";
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}
/**
 * Parse a Slack `Retry-After` header value into a millisecond delay.
 *
 * The header is either a non-negative integer of seconds or an HTTP-date; this
 * returns seconds × 1000 for the numeric form, or the future offset for the
 * date form (clamped at zero so a past date yields "retry now"). An empty,
 * malformed, or negative value yields `undefined`, leaving the caller to fall
 * back to exponential backoff.
 *
 * @param header - The raw `retry-after` header, which Node may give as an array.
 * @returns The delay in milliseconds, or `undefined` when it cannot be parsed.
 */
function parseRetryAfterMs(header) {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw)
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs))
        return Math.max(0, dateMs - Date.now());
    return undefined;
}
function slackRetryDelayMs(attempt, retryAfterMs) {
    if (retryAfterMs !== undefined)
        return Math.min(SLACK_MAX_RETRY_DELAY_MS, retryAfterMs);
    return Math.min(8000, 500 * 2 ** attempt);
}
/**
 * Decide whether a failed Slack POST is worth retrying.
 *
 * Retries HTTP 429 (rate limited) and any 5xx response carried by a
 * {@link SlackHttpError}, plus the transient network errors a request can throw
 * (timeouts, resets, DNS, dropped sockets). Anything else — a 4xx client error
 * like an invalid payload — is not retried, since repeating it cannot succeed.
 *
 * @param err - The error thrown by {@link postToSlackOnce}.
 * @returns True when a retry could plausibly succeed.
 */
function isRetryableSlackError(err) {
    if (err instanceof SlackHttpError) {
        return err.status === 429 || err.status >= 500;
    }
    if (err instanceof Error) {
        return /timed out|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(err.message);
    }
    return false;
}
/**
 * POST a single payload to a Slack webhook URL, with no retry.
 *
 * Opens the request with the stdlib http/https module chosen by the URL scheme,
 * sends a JSON body with a 10-second timeout, and resolves on a 2xx response.
 * A non-2xx status rejects with a {@link SlackHttpError} carrying the status, a
 * snippet of the body, and the parsed `Retry-After`; a transport failure or
 * timeout rejects with a plain `Error`. The single attempt is the building
 * block {@link postToSlack} retries around.
 *
 * @param webhookUrl - The Slack incoming-webhook URL to post to.
 * @param payload - The Slack message payload to JSON-encode and send.
 * @returns Resolves once Slack acknowledges the post with a 2xx status.
 */
function postToSlackOnce(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const parsed = new URL(webhookUrl);
        const options = {
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
            res.on("data", (chunk) => {
                data += chunk.toString();
            });
            res.on("end", () => {
                const status = res.statusCode ?? 0;
                if (status >= 200 && status < 300) {
                    resolve();
                }
                else {
                    reject(new SlackHttpError(status, `Slack webhook returned HTTP ${status}: ${data.slice(0, 200)}`, parseRetryAfterMs(res.headers["retry-after"])));
                }
            });
        });
        req.on("error", (err) => {
            reject(new Error(`Slack webhook request failed: ${err.message}`));
        });
        req.setTimeout(10_000, () => {
            req.destroy(new Error("Slack webhook request timed out after 10s"));
        });
        req.write(body);
        req.end();
    });
}
/**
 * POST a payload to Slack, retrying transient failures up to twice.
 *
 * Wraps {@link postToSlackOnce}: on a {@link isRetryableSlackError} it sleeps
 * for the server's `Retry-After` (when given) or an exponential backoff, then
 * retries — at most two retries after the initial attempt. A 4xx client error
 * or an exhausted retry budget re-throws the last error so the caller can
 * surface it; the final attempt's error is always re-thrown when all retries
 * fail.
 *
 * @param webhookUrl - The Slack incoming-webhook URL to post to.
 * @param payload - The Slack message payload to send.
 * @returns Resolves once a post attempt succeeds.
 */
async function postToSlack(webhookUrl, payload) {
    const maxRetries = 2;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await postToSlackOnce(webhookUrl, payload);
            return;
        }
        catch (err) {
            lastErr = err;
            if (attempt >= maxRetries || !isRetryableSlackError(err))
                break;
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
/**
 * Minimal parser for a stored pm item file. Handles the toon scalar form
 * (`key: value`, optionally quoted) and JSON. Only top-level scalar fields are
 * extracted; nested/array sections are ignored. Returns null when no id found.
 */
function parseStoredItem(content, ext) {
    if (ext === ".json") {
        try {
            const obj = JSON.parse(content);
            const node = (obj.item ?? obj);
            if (typeof node.id !== "string")
                return null;
            return node;
        }
        catch {
            return null;
        }
    }
    // toon: line-oriented `key: value`. Stop reading a key when it introduces a
    // block/array (e.g. `notes[1]{...}:`); we only want flat scalars.
    const out = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine;
        if (!line || /^\s/.test(line))
            continue; // skip indented (nested) lines
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
        if (!m)
            continue;
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
    if (typeof out.id !== "string")
        return null;
    if (typeof out.priority === "string" && /^\d+$/.test(out.priority)) {
        out.priority = parseInt(out.priority, 10);
    }
    return out;
}
/** Read all items from a pm root. Best-effort: unreadable files are skipped. */
function readStoreItems(pmRoot) {
    const items = [];
    for (const dir of ITEM_DIRS) {
        const full = path.join(pmRoot, dir);
        let entries;
        try {
            entries = fs.readdirSync(full);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            const ext = path.extname(name);
            if (ext !== ".toon" && ext !== ".json")
                continue;
            try {
                const content = fs.readFileSync(path.join(full, name), "utf8");
                const item = parseStoredItem(content, ext);
                if (item)
                    items.push(item);
            }
            catch {
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
function resolveWindow(since, days, now = Date.now()) {
    if (since) {
        const t = Date.parse(since);
        if (!Number.isNaN(t)) {
            return { cutoffMs: t, label: `since ${since}` };
        }
    }
    const d = days !== undefined && Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
    return { cutoffMs: now - d * 24 * 60 * 60 * 1000, label: `last ${d} day${d === 1 ? "" : "s"}` };
}
function statusIsClosed(status) {
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
function aggregateDigest(items, cutoffMs, windowLabel) {
    const buckets = {
        created: [],
        closed: [],
        blocked: [],
        in_progress: [],
    };
    for (const item of items) {
        const created = item.created_at ? Date.parse(item.created_at) : NaN;
        const updated = item.updated_at ? Date.parse(item.updated_at) : created;
        const status = (item.status ?? "").toLowerCase();
        if (!Number.isNaN(created) && created >= cutoffMs)
            buckets.created.push(item);
        if (statusIsClosed(status) && !Number.isNaN(updated) && updated >= cutoffMs)
            buckets.closed.push(item);
        if (status === "blocked" && !Number.isNaN(updated) && updated >= cutoffMs)
            buckets.blocked.push(item);
        if (status === "in_progress" && !Number.isNaN(updated) && updated >= cutoffMs)
            buckets.in_progress.push(item);
    }
    const counts = {
        created: buckets.created.length,
        closed: buckets.closed.length,
        blocked: buckets.blocked.length,
        in_progress: buckets.in_progress.length,
    };
    const total = counts.created + counts.closed + counts.blocked + counts.in_progress;
    return { windowLabel, cutoffMs, counts, buckets, total };
}
const DIGEST_BUCKET_META = {
    created: { label: "Created", emoji: "🆕" },
    closed: { label: "Closed", emoji: "✅" },
    blocked: { label: "Blocked", emoji: "🚫" },
    in_progress: { label: "In progress", emoji: "🔄" },
};
const DIGEST_ORDER = ["created", "closed", "in_progress", "blocked"];
/** A short "id title" line per item, capped so the digest stays readable. */
function digestItemLines(items, max = 5) {
    const lines = items.slice(0, max).map((i) => `• ${i.id} — ${i.title ?? "(untitled)"}`);
    if (items.length > max)
        lines.push(`• …and ${items.length - max} more`);
    return lines;
}
/**
 * Build the plain-text (mrkdwn) activity digest message.
 *
 * Opens with a header line naming the window and total update count, then lists
 * each non-empty bucket (created, closed, in progress, blocked) with up to five
 * item lines and an "…and N more" overflow marker. An empty window renders a
 * single "no activity" line. This is both the standalone `text` digest and the
 * Block Kit fallback produced by {@link buildDigestBlockKit}.
 *
 * @param summary - The bucketed digest summary to render.
 * @param channel - Optional resolved channel, echoed as an italic footer line.
 * @returns The composed mrkdwn digest string.
 */
function buildDigestText(summary, channel) {
    const head = `*pm activity digest* (${summary.windowLabel}) — ${summary.total} update${summary.total === 1 ? "" : "s"}`;
    const parts = [head];
    for (const bucket of DIGEST_ORDER) {
        const items = summary.buckets[bucket];
        if (items.length === 0)
            continue;
        const meta = DIGEST_BUCKET_META[bucket];
        parts.push(`\n${meta.emoji} *${meta.label}* (${items.length})`);
        parts.push(digestItemLines(items).join("\n"));
    }
    if (summary.total === 0)
        parts.push("\n_No activity in this window._");
    if (channel)
        parts.push(`\n_Channel: ${channel}_`);
    return parts.join("\n");
}
/**
 * Build the Slack Block Kit blocks (plus a plain-text fallback) for the digest.
 *
 * Renders a header, a window/count context line, a counts field grid across all
 * four buckets, then one section per non-empty bucket listing its items (capped
 * through {@link truncate} and {@link digestItemLines}). An empty window renders
 * a "no activity" section. The fallback mirrors {@link buildDigestText}.
 *
 * @param summary - The bucketed digest summary to render.
 * @param channel - Optional resolved channel, echoed in the footer.
 * @returns The `blocks` array and the plain-text fallback string.
 */
function buildDigestBlockKit(summary, channel) {
    const blocks = [];
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
    const fields = sectionFields(DIGEST_ORDER.map((bucket) => {
        const meta = DIGEST_BUCKET_META[bucket];
        return `${meta.emoji} *${meta.label}:*\n${summary.counts[bucket]}`;
    }));
    blocks.push({ type: "section", fields });
    for (const bucket of DIGEST_ORDER) {
        const items = summary.buckets[bucket];
        if (items.length === 0)
            continue;
        const meta = DIGEST_BUCKET_META[bucket];
        blocks.push({ type: "divider" });
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: truncate(`${meta.emoji} *${meta.label}* (${items.length})\n${digestItemLines(items).join("\n")}`, SLACK_SECTION_TEXT_MAX),
            },
        });
    }
    if (summary.total === 0) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: "_No activity in this window._" },
        });
    }
    const footerBits = [`pm digest · ${summary.windowLabel}`, channel ? `channel ${channel}` : null].filter(Boolean);
    blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `🤖 pm-slack · ${footerBits.join(" · ")}` }],
    });
    const fallback = buildDigestText(summary, channel);
    return { blocks, fallback };
}
/**
 * Build a ready-to-post {@link SlackPayload} for the digest in the requested format.
 *
 * `text` produces a plain-text body; any other format (including the default
 * `blockkit`) builds the rich blocks via {@link buildDigestBlockKit} with the
 * plain text carried as the fallback. The optional channel is attached to the
 * payload so Slack routes the digest correctly.
 *
 * @param summary - The bucketed digest summary to render.
 * @param format - The message format selected via `PM_SLACK_FORMAT` / `--format`.
 * @param channel - Optional resolved channel to post into.
 * @returns The assembled Slack payload.
 */
function buildDigestPayload(summary, format, channel) {
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
function statusToEvent(status) {
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
 * Type guard: confirm `ctx.result` is a structured object before reading its
 * lifecycle fields. The SDK types `result` as `unknown`; this guard keeps the
 * runtime read type-safe (no `any` cast) while preserving the runtime check that
 * a later reader must not "simplify" away — the SDK context is looser at
 * runtime than its declared `unknown` suggests, so the guard survives.
 */
function isCommandLifecycleResult(value) {
    return typeof value === "object" && value !== null;
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
function detectEvent(ctx) {
    const cmd = ctx.command?.toLowerCase() ?? "";
    if (CREATE_COMMANDS.has(cmd))
        return "create";
    if (CLOSE_COMMANDS.has(cmd))
        return "close";
    // `ctx.result` is declared `unknown` by the SDK; narrow with a type guard
    // before reading lifecycle fields (see `isCommandLifecycleResult`).
    const result = isCommandLifecycleResult(ctx.result) ? ctx.result : undefined;
    const resultStatusRaw = result?.item?.status;
    const resultStatus = typeof resultStatusRaw === "string" ? resultStatusRaw : undefined;
    const prevStatusRaw = result?.previousStatus ?? result?.previous_status ?? "";
    const prevStatus = (typeof prevStatusRaw === "string" ? prevStatusRaw : "").toLowerCase();
    // Lifecycle aliases imply a target status even without --status.
    let event = null;
    if (START_COMMANDS.has(cmd))
        event = "start";
    else if (OPEN_COMMANDS.has(cmd))
        event = cmd === "reopen" ? "reopen" : "open";
    if (!event && UPDATE_COMMANDS.has(cmd)) {
        const optStatus = ctx.options?.["status"];
        event = statusToEvent(optStatus) ?? statusToEvent(resultStatus);
    }
    if (!event)
        return null;
    // Refine an "open" transition using the prior status when available:
    //   blocked  -> open  => unblock
    //   closed/canceled -> open => reopen
    if (event === "open" && prevStatus) {
        if (prevStatus === "blocked")
            return "unblock";
        if (["closed", "canceled", "cancelled", "done", "resolved"].includes(prevStatus))
            return "reopen";
    }
    return event;
}
/**
 * Pull the touched item out of an afterCommand hook's result.
 *
 * The SDK types `ctx.result` as `unknown`, so this reads it defensively: a
 * single `result.item` with an id wins, otherwise the first entry of a
 * `result.items` array (bulk commands like `add` return a list). Returns `null`
 * when no item is present, so the hook can short-circuit without posting.
 *
 * @param ctx - The afterCommand hook context to read the result from.
 * @returns The touched item, or `null` when the result carries none.
 */
function extractItem(ctx) {
    const result = ctx.result;
    const item = result?.item;
    if (item && item.id)
        return item;
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
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = (module) => module;
export default defineExtension({
    name: "pm-slack",
    version: "2026.9.4",
    activate(api) {
        // -----------------------------------------------------------------------
        // afterCommand hook — fires after every pm-cli command completes.
        // Posts a rich Block Kit notification for create/close/block events.
        // NEVER throws and NEVER blocks: every path returns cleanly and the Slack
        // POST is fire-and-forget (failures are logged, never propagated).
        // -----------------------------------------------------------------------
        if (typeof api.hooks?.afterCommand === "function") {
            api.hooks.afterCommand(async (ctx) => {
                try {
                    // Only react to successful commands.
                    //
                    // The SDK declares `AfterCommandHookContext.ok` as a required boolean,
                    // so reading `ctx.ok` is type-safe here (no `any` cast). The defensive
                    // `ctx &&` null guard is kept because the host is looser at runtime
                    // than the declared type and may invoke the hook with a falsy/empty
                    // context during early bootstrap; do not simplify it away.
                    if (ctx && ctx.ok === false)
                        return;
                    const config = loadConfig();
                    if (!config)
                        return; // no webhook → silent no-op
                    const event = detectEvent(ctx);
                    if (!event)
                        return;
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
                        console.error(`[pm-slack] Item priority ${item.priority} below minimum ${config.minPriority} — skipping`);
                        return;
                    }
                    // Resolve destination via routing rules (falls back to defaults).
                    const target = selectRoute(event, item, config.routes, config.webhookUrl, config.channel);
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
                }
                catch (err) {
                    // Hooks must never throw or block the command — swallow everything.
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[pm-slack] afterCommand hook error (ignored): ${message}`);
                }
            });
        }
        else if (typeof api.hooks?.beforeCommand === "function") {
            // Fallback: use beforeCommand if afterCommand is unavailable
            // (result data is unavailable, so we can only notify on command name).
            api.hooks.beforeCommand(async (ctx) => {
                try {
                    console.error("[pm-slack] afterCommand not available — limited event detection active");
                    const config = loadConfig();
                    if (!config)
                        return;
                    const cmd = ctx.command?.toLowerCase() ?? "";
                    let event = null;
                    if (CREATE_COMMANDS.has(cmd))
                        event = "create";
                    else if (CLOSE_COMMANDS.has(cmd))
                        event = "close";
                    if (!event || !config.events.has(event))
                        return;
                    const cmdArgs = (ctx.args ?? []).join(" ");
                    const text = `pm command \`${ctx.command}\` triggered event *${event}*\n${cmdArgs}`;
                    await postToSlack(config.webhookUrl, { text, mrkdwn: true, channel: config.channel });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[pm-slack] beforeCommand hook error (ignored): ${message}`);
                }
            });
        }
        // -----------------------------------------------------------------------
        // preflight — fail-fast webhook validation gate for the Slack-posting
        // commands. Scoped to `slack notify` / `slack digest` (the command paths
        // pm-slack owns) so it cannot contend with another package's preflight
        // override: an unscoped/global override collides pairwise with every other
        // installed package's override (pm health reports
        // extension_preflight_override_collision). NOT `slack test`, which is an
        // offline preview, and NOT --dry-run previews.
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
            api.registerPreflight({
                commands: [...SLACK_POSTING_COMMANDS],
                run: (pfCtx) => {
                    const command = (pfCtx.command ?? "").toLowerCase();
                    // Only gate the actual posting commands. Reads the same constant the
                    // scope above is built from, so the registered scope and the runtime
                    // check cannot disagree — they were two separate literals before, and
                    // two literals holding the same knowledge is how a command silently
                    // loses its gate.
                    if (!isSlackPostingCommand(command))
                        return {};
                    const options = (pfCtx.options ?? {});
                    // Offline previews are never gated.
                    if (readBoolOption(options, "dry-run"))
                        return {};
                    try {
                        assertWebhookConfigured(readStrOption(options, "webhook"), command);
                    }
                    catch (err) {
                        // The runtime swallows throws here; emit a visible warning so the
                        // signal isn't lost. The handler-level gate provides the real abort.
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(`[pm-slack] preflight: ${message}`);
                    }
                    return {};
                },
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
                    // `--json` is a host-owned global flag: do not redeclare it (the host
                    // rejects the registration); read it from ctx.global instead.
                ],
                async run(ctx) {
                    const options = ctx.options ?? {};
                    const dryRun = readBoolOption(options, "dry-run");
                    const webhookUrl = readStrOption(options, "webhook") ?? process.env.PM_SLACK_WEBHOOK ?? "";
                    const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
                    const threadTs = readStrOption(options, "thread");
                    // `--json` is a host-owned global flag; read it from ctx.global.
                    const asJson = ctx.global?.json === true;
                    const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);
                    // Preflight gate: a real (non-dry-run) post requires a valid webhook.
                    // Fail fast with a clear error BEFORE building/attempting any post.
                    // --dry-run is an offline preview and is intentionally NOT gated.
                    if (!dryRun) {
                        assertWebhookConfigured(readStrOption(options, "webhook"), "slack notify");
                    }
                    // `--on` selects the message template. First event wins for the header verb.
                    const events = parseEvents(readStrOption(options, "on") ?? "create");
                    const event = (ALL_EVENTS.find((e) => events.has(e)) ?? "create");
                    // --channel-override: redirect specific event types to different channels.
                    const channelOverrides = parseChannelOverride(readStrOption(options, "channel-override"));
                    const effectiveChannel = channelOverrides.get(event) ?? channel;
                    const text = readStrOption(options, "text");
                    const title = readStrOption(options, "title") ?? text?.split("\n")[0];
                    if (!title) {
                        throw new CommandError("Provide a --title or --text to send (e.g. `pm slack notify --text 'hello'`)", EXIT_CODE.USAGE);
                    }
                    // Synthesize a minimal item from the flags so we can reuse the
                    // message builder. This command is for ad-hoc posts, not item lookups.
                    const assignee = readStrOption(options, "assignee");
                    const url = readStrOption(options, "url");
                    const item = {
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
                        throw new CommandError("--format custom requires --template <template string> with {placeholders} (e.g. --template '{emoji} {title} {event}')", EXIT_CODE.USAGE);
                    }
                    // Layer env maps with the inline --mention-map flag (flag wins).
                    const assigneeMap = buildMentionMap(readStrOption(options, "mention-map"));
                    // Mention when explicitly requested, or implicitly when an assignee
                    // maps to a Slack id (so the @mention is opt-in but ergonomic).
                    const wantMention = readBoolOption(options, "mention-assignee") || assigneeMap.size > 0;
                    const mention = wantMention ? resolveAssigneeMention(item, assigneeMap) : undefined;
                    const link = resolveItemUrl(item, url);
                    const payload = {
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
                        throw new CommandError("No Slack webhook configured for `slack notify`. " +
                            "Set PM_SLACK_WEBHOOK or pass --webhook <url> (or use --dry-run to preview).", EXIT_CODE.USAGE);
                    }
                    try {
                        await postToSlack(webhookUrl, payload);
                    }
                    catch (err) {
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
                    // `--json` is a host-owned global flag: do not redeclare it (the host
                    // rejects the registration); read it from ctx.global instead.
                    { long: "--dry-run", description: "Accepted for symmetry; this command never posts." },
                ],
                async run(ctx) {
                    const options = ctx.options ?? {};
                    // `--json` is a host-owned global flag; read it from ctx.global.
                    const asJson = ctx.global?.json === true;
                    const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);
                    const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
                    const events = parseEvents(readStrOption(options, "on") ?? "create");
                    const event = (ALL_EVENTS.find((e) => events.has(e)) ?? "create");
                    // --channel-override: redirect specific event types to different channels.
                    const channelOverrides = parseChannelOverride(readStrOption(options, "channel-override"));
                    const effectiveChannel = channelOverrides.get(event) ?? channel;
                    const t = readStrOption(options, "title");
                    // A representative sample item per event so the preview is realistic.
                    const sample = {
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
                        throw new CommandError("--format custom requires --template <template string> with {placeholders} (e.g. --template '{emoji} {title} {event}')", EXIT_CODE.USAGE);
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
                    // `--json` is a host-owned global flag: do not redeclare it (the host
                    // rejects the registration); read it from ctx.global instead.
                ],
                async run(ctx) {
                    const options = ctx.options ?? {};
                    const dryRun = readBoolOption(options, "dry-run");
                    // `--json` is a host-owned global flag; read it from ctx.global.
                    const asJson = ctx.global?.json === true;
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
                        throw new CommandError("No Slack webhook configured: set PM_SLACK_WEBHOOK or pass --webhook (or use --dry-run to preview).", EXIT_CODE.GENERIC_FAILURE);
                    }
                    try {
                        await postToSlack(webhookUrl, payload);
                    }
                    catch (err) {
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
/**
 * Internal helpers and builders exported only for the unit-test suite.
 *
 * Bundling them under one `__test__` object keeps the public surface (the
 * default extension export) clean while letting tests exercise the pure
 * formatting, parsing, and routing logic directly. Nothing here is part of the
 * supported extension API.
 */
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
    SLACK_MAX_RETRY_DELAY_MS,
    sleep,
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
//# sourceMappingURL=index.js.map