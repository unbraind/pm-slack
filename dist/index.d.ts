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
interface SlackBlock {
    type: string;
    [key: string]: unknown;
}
declare function parseEvents(spec: string | undefined): Set<EventKind>;
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
    buildTextMessage: typeof buildTextMessage;
    parseEvents: typeof parseEvents;
    detectEvent: typeof detectEvent;
    extractItem: typeof extractItem;
    meetsMinPriority: typeof meetsMinPriority;
    EXIT_CODE: {
        readonly GENERIC_FAILURE: 1;
        readonly USAGE: 2;
        readonly NOT_FOUND: 3;
    };
    CommandError: typeof CommandError;
};
//# sourceMappingURL=index.d.ts.map