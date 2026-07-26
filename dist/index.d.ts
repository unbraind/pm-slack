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
declare function parseEvents(spec: string | undefined): Set<EventKind>;
/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text, "template"/"tmpl"
 * → custom). Falls back to the supplied default when the spec is empty or
 * unrecognized.
 */
declare function parseFormat(spec: string | undefined, fallback?: MessageFormat): MessageFormat;
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
declare function isHttpUrl(value: unknown): value is string;
/** Resolve a primary URL for the item, plus whether it points at GitHub. */
declare function resolveItemUrl(item: PmItem, override?: string): {
    url: string;
    isGithub: boolean;
} | undefined;
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
declare class SlackHttpError extends Error {
    status: number;
    retryAfterMs?: number;
    constructor(status: number, message: string, retryAfterMs?: number);
}
declare function parseRetryAfterMs(header: string | string[] | undefined): number | undefined;
declare function slackRetryDelayMs(attempt: number, retryAfterMs?: number): number;
declare function isRetryableSlackError(err: unknown): boolean;
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
declare function buildDigestText(summary: DigestSummary, channel?: string): string;
declare function buildDigestBlockKit(summary: DigestSummary, channel?: string): {
    blocks: SlackBlock[];
    fallback: string;
};
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
declare function extractItem(ctx: AfterCommandHookContext): PmItem | null;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
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