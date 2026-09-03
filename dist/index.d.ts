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
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { AfterCommandHookContext } from "@unbrained/pm-cli/sdk";
declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
type Priority = 1 | 2 | 3 | 4;
interface PmItem {
    id: string;
    title: string;
    type?: string;
    priority?: Priority;
    status?: string;
    close_reason?: string;
    blocked_reason?: string;
    closedReason?: string;
    blockedReason?: string;
    cancel_reason?: string;
    cancelReason?: string;
    author?: string;
    assignee?: string;
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
declare function normalizeEvent(token: string): EventKind | null;
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
declare function parseEvents(spec: string | undefined): Set<EventKind>;
/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text, "template"/"tmpl"
 * → custom). Falls back to the supplied default when the spec is empty or
 * unrecognized.
 */
declare function parseFormat(spec: string | undefined, fallback?: MessageFormat): MessageFormat;
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
declare function parseRoutes(spec: string | undefined): RouteRule[];
/**
 * Does a single route rule match this event/item? Selector forms:
 *   - bare event name: "create" | "close" | "block"
 *   - "type:<itemType>"   (case-insensitive on item.type)
 *   - "status:<status>"   (case-insensitive on item.status)
 *   - "*" / "all"         (matches everything — useful as a catch-all)
 */
declare function ruleMatches(rule: RouteRule, event: EventKind, item: PmItem): boolean;
/**
 * Resolve the destination (webhook + channel) for an event/item given the
 * configured routes and the default webhook/channel. First matching rule wins;
 * any field a rule omits falls back to the default. Returns null only when no
 * webhook can be resolved at all.
 */
declare function selectRoute(event: EventKind, item: PmItem, routes: RouteRule[], defaultWebhook: string, defaultChannel?: string): RouteTarget | null;
/** Parse a --filter spec into an array of selector strings. */
declare function parseFilter(spec: string | undefined): string[];
/**
 * Check if an item/event matches a single filter selector.
 */
declare function filterMatches(filter: string, event: EventKind, item: PmItem): boolean;
/**
 * Check if an item/event matches ALL filter selectors (AND logic). An empty
 * filter list matches everything (no filtering applied).
 */
declare function matchesFilter(filters: string[], event: EventKind, item: PmItem): boolean;
/** Parse a --channel-override spec into a map of EventKind → channel. */
declare function parseChannelOverride(spec: string | undefined): Map<EventKind, string>;
/**
 * Resolve the effective webhook for a posting command from an explicit
 * `--webhook` flag (highest precedence) or PM_SLACK_WEBHOOK. PM_SLACK_ROUTES
 * may also carry per-rule webhooks; a present route webhook is accepted as a
 * valid source so route-only configurations are not falsely rejected.
 */
declare function resolveEffectiveWebhook(webhookFlag: string | undefined): {
    webhookUrl: string;
    source: "flag" | "env" | "route" | "none";
};
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
export declare const SLACK_POSTING_COMMANDS: readonly ["slack notify", "slack digest"];
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
export declare const SLACK_OFFLINE_COMMANDS: readonly ["slack test"];
/**
 * Whether `command` is one this package gates a webhook on.
 *
 * @param command - Normalized (lower-cased) full command path, e.g. `slack notify`.
 * @returns `true` only for a declared posting command.
 */
export declare function isSlackPostingCommand(command: string): boolean;
/**
 * Whether `command` is a declared pm-slack path that is deliberately ungated.
 *
 * @param command - Normalized (lower-cased) full command path.
 * @returns `true` only for a declared offline command.
 */
export declare function isSlackOfflineCommand(command: string): boolean;
/**
 * Validate webhook configuration for a Slack-posting command. Throws a
 * CommandError (exit 2 / USAGE) with an actionable message when no webhook is
 * configured or the configured webhook URL is syntactically invalid. Returns
 * silently (pass-through) on a valid config. Performs NO network I/O.
 *
 * `commandLabel` is woven into the message (e.g. "slack digest") so the user
 * sees exactly which command was gated.
 */
declare function assertWebhookConfigured(webhookFlag: string | undefined, commandLabel: string): void;
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
declare function warnWebhookUnsetOnce(): void;
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
declare function loadConfig(): SlackConfig | null;
declare function meetsMinPriority(item: PmItem, minPriority: Priority): boolean;
/** Parse PM_SLACK_ASSIGNEE_MAP into a case-insensitive name→id lookup. */
declare function parseAssigneeMap(spec: string | undefined): Map<string, string>;
/**
 * Format a mapped value into a ready-to-embed Slack mention token. Accepts:
 *   - a pre-wrapped token (`<@U123>`, `<!subteam^S123>`) — used verbatim,
 *   - a plain `@handle` (e.g. `@alice`) — kept verbatim (Slack resolves the
 *     human-readable handle in mrkdwn),
 *   - a raw Slack user/group id (`U123`) — wrapped as `<@U123>`.
 */
declare function formatMention(value: string): string;
/**
 * Resolve an item's assignee to a Slack mention token using the map. Returns a
 * ready-to-embed mention string (e.g. `<@U123>`) or undefined when there's no
 * assignee or no mapping. See {@link formatMention} for accepted value forms.
 */
declare function resolveAssigneeMention(item: PmItem, map: Map<string, string>): string | undefined;
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
declare function buildMentionMap(flagSpec: string | undefined, env?: {
    assigneeMap?: string;
    mentionMap?: string;
}): Map<string, string>;
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
declare function isHttpUrl(value: unknown): value is string;
/** Resolve a primary URL for the item, plus whether it points at GitHub. */
declare function resolveItemUrl(item: PmItem, override?: string): {
    url: string;
    isGithub: boolean;
} | undefined;
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
declare function buildTextMessage(item: PmItem, event: EventKind, channel?: string, mention?: string): string;
/**
 * Render a custom template by replacing {placeholder} tokens with values
 * from the item/event context. Unknown tokens are kept verbatim so typos are
 * visible. Returns the rendered string.
 */
declare function buildCustomMessage(item: PmItem, event: EventKind, template: string, opts?: BlockKitOptions): string;
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
declare function truncate(text: string, max: number): string;
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
declare function sectionFields(texts: string[]): {
    type: "mrkdwn";
    text: string;
}[];
interface BlockKitOptions {
    channel?: string;
    /** Extra free-form body appended as a section (e.g. from `--text`). */
    note?: string;
    /** Pre-resolved Slack mention token for the assignee (e.g. `<@U123>`). */
    mention?: string;
    /** Resolved item/GitHub URL for an action button. */
    link?: {
        url: string;
        isGithub: boolean;
    };
    /** Custom template string used when format is "custom". */
    template?: string;
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
declare function buildItemBlockKit(item: PmItem, event: EventKind, opts?: BlockKitOptions): {
    blocks: SlackBlock[];
    fallback: string;
};
/**
 * Build a ready-to-post SlackPayload for an item event in the requested format.
 * - "blockkit": rich Block Kit blocks + plain-text fallback in `text`.
 * - "text":     plain mrkdwn only (no `blocks`), for minimal/legacy channels.
 */
declare function buildItemPayload(item: PmItem, event: EventKind, format: MessageFormat, opts?: BlockKitOptions): SlackPayload;
/**
 * Resolve after at most {@link SLACK_SLEEP_MAX_MS} milliseconds.
 *
 * The argument is clamped at the anchor (here) rather than at every call site:
 * bounding one caller leaves the path reachable for every other, which is why
 * the prior Retry-After clamp alone did not close the alert. `ms` is also floored
 * at zero so a negative value schedules an immediate tick rather than being
 * treated as a relative schedule by `setTimeout`.
 */
declare const sleep: (ms: number) => Promise<void>;
declare class SlackHttpError extends Error {
    status: number;
    retryAfterMs?: number;
    constructor(status: number, message: string, retryAfterMs?: number);
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
declare function parseRetryAfterMs(header: string | string[] | undefined): number | undefined;
declare function slackRetryDelayMs(attempt: number, retryAfterMs?: number): number;
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
declare function isRetryableSlackError(err: unknown): boolean;
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
declare function postToSlackOnce(webhookUrl: string, payload: SlackPayload): Promise<void>;
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
declare function parseStoredItem(content: string, ext: string): DigestItem | null;
/**
 * Resolve a `--since <date>` / `--days <n>` window into an epoch-ms cutoff.
 * `since` (ISO date or datetime) wins when both are given; otherwise `days`
 * back from `now`. Defaults to 7 days. Returns the cutoff in ms.
 */
declare function resolveWindow(since: string | undefined, days: number | undefined, now?: number): {
    cutoffMs: number;
    label: string;
};
type DigestBucket = "created" | "closed" | "blocked" | "in_progress";
interface DigestSummary {
    windowLabel: string;
    cutoffMs: number;
    counts: Record<DigestBucket, number>;
    buckets: Record<DigestBucket, DigestItem[]>;
    total: number;
}
/**
 * Aggregate store items into digest buckets for the window. An item counts as:
 *   - created     if created_at >= cutoff
 *   - closed      if it is in a closed/done status AND updated_at >= cutoff
 *   - blocked     if status === blocked AND updated_at >= cutoff
 *   - in_progress if status === in_progress AND updated_at >= cutoff
 * An item may appear in multiple buckets (e.g. created and blocked).
 */
declare function aggregateDigest(items: DigestItem[], cutoffMs: number, windowLabel: string): DigestSummary;
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
declare function buildDigestText(summary: DigestSummary, channel?: string): string;
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
declare function buildDigestBlockKit(summary: DigestSummary, channel?: string): {
    blocks: SlackBlock[];
    fallback: string;
};
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
declare function buildDigestPayload(summary: DigestSummary, format: MessageFormat, channel?: string): SlackPayload;
/** Map a (normalized) status string to the EventKind for a transition into it. */
declare function statusToEvent(status: string | undefined): EventKind | null;
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
declare function detectEvent(ctx: AfterCommandHookContext): EventKind | null;
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
declare function extractItem(ctx: AfterCommandHookContext): PmItem | null;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
/**
 * Internal helpers and builders exported only for the unit-test suite.
 *
 * Bundling them under one `__test__` object keeps the public surface (the
 * default extension export) clean while letting tests exercise the pure
 * formatting, parsing, and routing logic directly. Nothing here is part of the
 * supported extension API.
 */
export declare const __test__: {
    buildItemBlockKit: typeof buildItemBlockKit;
    buildItemPayload: typeof buildItemPayload;
    buildTextMessage: typeof buildTextMessage;
    buildCustomMessage: typeof buildCustomMessage;
    truncate: typeof truncate;
    sectionFields: typeof sectionFields;
    SLACK_SECTION_TEXT_MAX: number;
    SLACK_SECTION_FIELD_TEXT_MAX: number;
    SLACK_SECTION_FIELDS_MAX: number;
    SLACK_HEADER_TEXT_MAX: number;
    parseEvents: typeof parseEvents;
    normalizeEvent: typeof normalizeEvent;
    parseFormat: typeof parseFormat;
    parseRoutes: typeof parseRoutes;
    ruleMatches: typeof ruleMatches;
    selectRoute: typeof selectRoute;
    detectEvent: typeof detectEvent;
    statusToEvent: typeof statusToEvent;
    extractItem: typeof extractItem;
    meetsMinPriority: typeof meetsMinPriority;
    parseAssigneeMap: typeof parseAssigneeMap;
    resolveAssigneeMention: typeof resolveAssigneeMention;
    formatMention: typeof formatMention;
    buildMentionMap: typeof buildMentionMap;
    loadConfig: typeof loadConfig;
    warnWebhookUnsetOnce: typeof warnWebhookUnsetOnce;
    __resetWarnState: () => void;
    resolveItemUrl: typeof resolveItemUrl;
    isHttpUrl: typeof isHttpUrl;
    EVENT_META: Record<EventKind, {
        verb: string;
        emoji: string;
    }>;
    parseStoredItem: typeof parseStoredItem;
    resolveWindow: typeof resolveWindow;
    aggregateDigest: typeof aggregateDigest;
    buildDigestText: typeof buildDigestText;
    buildDigestBlockKit: typeof buildDigestBlockKit;
    buildDigestPayload: typeof buildDigestPayload;
    resolveEffectiveWebhook: typeof resolveEffectiveWebhook;
    assertWebhookConfigured: typeof assertWebhookConfigured;
    slackRetryDelayMs: typeof slackRetryDelayMs;
    SLACK_SLEEP_MAX_MS: number;
    sleep: typeof sleep;
    parseRetryAfterMs: typeof parseRetryAfterMs;
    isRetryableSlackError: typeof isRetryableSlackError;
    postToSlackOnce: typeof postToSlackOnce;
    SlackHttpError: typeof SlackHttpError;
    EXIT_CODE: {
        readonly GENERIC_FAILURE: 1;
        readonly USAGE: 2;
        readonly NOT_FOUND: 3;
    };
    CommandError: typeof CommandError;
    parseFilter: typeof parseFilter;
    filterMatches: typeof filterMatches;
    matchesFilter: typeof matchesFilter;
    parseChannelOverride: typeof parseChannelOverride;
};
//# sourceMappingURL=index.d.ts.map