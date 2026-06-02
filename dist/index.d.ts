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
 *   PM_SLACK_EVENTS       (optional) Comma-separated subset of hook events: create,close,block (default: all)
 *   PM_SLACK_FORMAT       (optional) Default notification format: "blockkit" (default) or "text"
 *   PM_SLACK_ROUTES       (optional) JSON array of routing rules to send specific
 *                                    events/types/statuses to different webhooks/channels.
 *                                    Each rule: { "match": "<selector>", "webhook"?: "...", "channel"?: "..." }
 *                                    Selector forms: an event ("create"|"close"|"block"),
 *                                    "type:<itemType>" (case-insensitive), or "status:<status>".
 *                                    First matching rule wins; unset fields fall back to the defaults.
 */
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
    author?: string;
}
type EventKind = "create" | "close" | "block";
type MessageFormat = "blockkit" | "text";
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
declare function parseEvents(spec: string | undefined): Set<EventKind>;
/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text). Falls back to
 * the supplied default when the spec is empty or unrecognized.
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
declare function meetsMinPriority(item: PmItem, minPriority: Priority): boolean;
declare function buildTextMessage(item: PmItem, event: EventKind, channel?: string): string;
interface BlockKitOptions {
    channel?: string;
    /** Extra free-form body appended as a section (e.g. from `--text`). */
    note?: string;
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
declare function detectEvent(ctx: AfterCommandHookContext): EventKind | null;
declare function extractItem(ctx: AfterCommandHookContext): PmItem | null;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
export declare const __test__: {
    buildItemBlockKit: typeof buildItemBlockKit;
    buildItemPayload: typeof buildItemPayload;
    buildTextMessage: typeof buildTextMessage;
    parseEvents: typeof parseEvents;
    parseFormat: typeof parseFormat;
    parseRoutes: typeof parseRoutes;
    ruleMatches: typeof ruleMatches;
    selectRoute: typeof selectRoute;
    detectEvent: typeof detectEvent;
    extractItem: typeof extractItem;
    meetsMinPriority: typeof meetsMinPriority;
    parseStoredItem: typeof parseStoredItem;
    resolveWindow: typeof resolveWindow;
    aggregateDigest: typeof aggregateDigest;
    buildDigestText: typeof buildDigestText;
    buildDigestBlockKit: typeof buildDigestBlockKit;
    buildDigestPayload: typeof buildDigestPayload;
    EXIT_CODE: {
        readonly GENERIC_FAILURE: 1;
        readonly USAGE: 2;
        readonly NOT_FOUND: 3;
    };
    CommandError: typeof CommandError;
};
//# sourceMappingURL=index.d.ts.map