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
import https from "node:https";
const defineExtension = ((extension) => extension);
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
const ALL_EVENTS = ["create", "close", "block"];
function parseEvents(spec) {
    if (!spec)
        return new Set(ALL_EVENTS);
    const parsed = spec
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => ALL_EVENTS.includes(e));
    return parsed.length > 0 ? new Set(parsed) : new Set(ALL_EVENTS);
}
function loadConfig() {
    const webhookUrl = process.env.PM_SLACK_WEBHOOK ?? "";
    if (!webhookUrl) {
        console.error("[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled");
        return null;
    }
    // Validate URL
    try {
        new URL(webhookUrl);
    }
    catch {
        console.error("[pm-slack] PM_SLACK_WEBHOOK is not a valid URL — notifications disabled");
        return null;
    }
    const channel = process.env.PM_SLACK_CHANNEL?.trim() || undefined;
    const rawPriority = parseInt(process.env.PM_SLACK_MIN_PRIORITY ?? "1", 10);
    const minPriority = rawPriority >= 1 && rawPriority <= 4 ? rawPriority : 1;
    const events = parseEvents(process.env.PM_SLACK_EVENTS);
    return { webhookUrl, channel, minPriority, events };
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
// Plain-text message formatting (fallback)
// ---------------------------------------------------------------------------
function itemTypeLabel(item) {
    return item.type ?? "Item";
}
const EVENT_META = {
    create: { verb: "created", emoji: "🆕" },
    close: { verb: "closed", emoji: "✅" },
    block: { verb: "is blocked", emoji: "🚫" },
};
function eventReason(item, event) {
    if (event === "close") {
        return item.close_reason?.trim() || item.closedReason?.trim() || undefined;
    }
    if (event === "block") {
        return item.blocked_reason?.trim() || item.blockedReason?.trim() || undefined;
    }
    return undefined;
}
function buildTextMessage(item, event, channel) {
    const type = itemTypeLabel(item);
    const meta = EVENT_META[event];
    let msg = `*[${type}]* ${item.title} ${meta.verb} ${meta.emoji}`;
    if (event === "create") {
        msg += `\nPriority: ${priorityLabel(item.priority)} • Type: ${type} • By: ${item.author ?? "unknown"}`;
    }
    else {
        msg += `\nReason: ${eventReason(item, event) ?? "no reason given"}`;
    }
    if (channel)
        msg += `\n_Channel: ${channel}_`;
    return msg;
}
function buildItemBlockKit(item, event, opts = {}) {
    const type = itemTypeLabel(item);
    const meta = EVENT_META[event];
    const blocks = [];
    blocks.push({
        type: "header",
        text: { type: "plain_text", text: `${meta.emoji} ${item.title}`, emoji: true },
    });
    // Fields section: a 2-column grid of mrkdwn key/value pairs.
    const fields = [
        { type: "mrkdwn", text: `*Item:*\n${item.id}` },
        { type: "mrkdwn", text: `*Type:*\n${type}` },
        { type: "mrkdwn", text: `*Event:*\n${meta.verb}` },
        { type: "mrkdwn", text: `*Priority:*\n${priorityLabel(item.priority)}` },
    ];
    if (item.status)
        fields.push({ type: "mrkdwn", text: `*Status:*\n${item.status}` });
    if (item.author)
        fields.push({ type: "mrkdwn", text: `*By:*\n${item.author}` });
    blocks.push({ type: "section", fields });
    const reason = eventReason(item, event);
    if (reason) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*Reason:* ${reason}` },
        });
    }
    if (opts.note) {
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: opts.note },
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
    const fallback = buildTextMessage(item, event, opts.channel);
    return { blocks, fallback };
}
// ---------------------------------------------------------------------------
// Slack HTTP POST
// ---------------------------------------------------------------------------
function postToSlack(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const parsed = new URL(webhookUrl);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port ? parseInt(parsed.port, 10) : 443,
            path: parsed.pathname + parsed.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        };
        const req = https.request(options, (res) => {
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
                    reject(new Error(`Slack webhook returned HTTP ${status}: ${data.slice(0, 200)}`));
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
// ---------------------------------------------------------------------------
// Event detection (afterCommand hook)
// ---------------------------------------------------------------------------
/** Commands that create a new item */
const CREATE_COMMANDS = new Set(["add", "create", "new"]);
/** Commands that close/complete an item */
const CLOSE_COMMANDS = new Set(["close", "done", "complete", "finish", "resolve"]);
/** Commands that update an item's status or attributes */
const UPDATE_COMMANDS = new Set(["update", "edit", "set", "status"]);
function detectEvent(ctx) {
    const cmd = ctx.command?.toLowerCase() ?? "";
    if (CREATE_COMMANDS.has(cmd))
        return "create";
    if (CLOSE_COMMANDS.has(cmd))
        return "close";
    if (UPDATE_COMMANDS.has(cmd)) {
        const newStatus = ctx.options?.["status"] ??
            ctx.result?.item?.status ??
            "";
        if (newStatus.toLowerCase() === "blocked")
            return "block";
        const resultItem = ctx.result?.item;
        if (resultItem?.status?.toLowerCase() === "blocked")
            return "block";
    }
    return null;
}
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
export default defineExtension({
    name: "pm-slack",
    version: "2026.6.2",
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
                    const { blocks, fallback } = buildItemBlockKit(item, event, {
                        channel: config.channel,
                    });
                    await postToSlack(config.webhookUrl, {
                        text: fallback,
                        blocks,
                        mrkdwn: true,
                        channel: config.channel,
                    });
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
                    "PM_SLACK_WEBHOOK=https://hooks.slack.com/... pm slack notify --text 'hello team'",
                ],
                flags: [
                    { long: "--text", value_name: "message", description: "Free-form message body (mrkdwn). Used when no item context is given." },
                    { long: "--title", value_name: "title", description: "Title shown in the Block Kit header (defaults to the --text first line)" },
                    { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #pm-alerts). Overrides PM_SLACK_CHANNEL." },
                    { long: "--thread", value_name: "ts", description: "Slack thread timestamp (thread_ts) to reply into a thread" },
                    { long: "--on", value_name: "events", description: "Comma list of lifecycle events for the message template (create,close,block). Default: create" },
                    { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
                    { long: "--dry-run", description: "Print the message and Block Kit payload without posting to Slack" },
                ],
                async run(ctx) {
                    const options = ctx.options ?? {};
                    const dryRun = readBoolOption(options, "dry-run");
                    const webhookUrl = readStrOption(options, "webhook") ?? process.env.PM_SLACK_WEBHOOK ?? "";
                    const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
                    const threadTs = readStrOption(options, "thread");
                    // `--on` selects the message template. First event wins for the header verb.
                    const events = parseEvents(readStrOption(options, "on") ?? "create");
                    const event = (ALL_EVENTS.find((e) => events.has(e)) ?? "create");
                    const text = readStrOption(options, "text");
                    const title = readStrOption(options, "title") ?? text?.split("\n")[0];
                    if (!title) {
                        throw new CommandError("Provide a --title or --text to send (e.g. `pm slack notify --text 'hello'`)", EXIT_CODE.USAGE);
                    }
                    // Synthesize a minimal item from the flags so we can reuse the Block
                    // Kit builder. This command is for ad-hoc posts, not item lookups.
                    const item = { id: "manual", title, type: "Note" };
                    const { blocks, fallback } = buildItemBlockKit(item, event, {
                        channel,
                        note: text && text !== title ? text : undefined,
                    });
                    const payload = {
                        text: fallback,
                        blocks,
                        mrkdwn: true,
                        ...(channel ? { channel } : {}),
                        ...(threadTs ? { thread_ts: threadTs } : {}),
                    };
                    if (dryRun) {
                        console.error("--- DRY RUN (message not posted) ---");
                        process.stdout.write(fallback + "\n");
                        console.error("--- Block Kit payload ---");
                        process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
                        console.error("--- END ---");
                        return { dryRun: true, event, channel, thread_ts: threadTs, blocks, fallback };
                    }
                    if (!webhookUrl) {
                        // Graceful no-op: warn and exit 0 so a missing webhook never blocks
                        // a workflow. Use --dry-run to preview without a webhook.
                        console.error("[pm-slack] PM_SLACK_WEBHOOK not set and no --webhook provided — posting disabled. " +
                            "Use --dry-run to preview the message.");
                        return { posted: false, disabled: true, reason: "no-webhook" };
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
                    return { posted: true, event, channel, thread_ts: threadTs };
                },
            });
        }
    },
});
// Exported for unit tests (Block Kit builder + helpers).
export const __test__ = {
    buildItemBlockKit,
    buildTextMessage,
    parseEvents,
    detectEvent,
    extractItem,
    meetsMinPriority,
    EXIT_CODE,
    CommandError,
};
//# sourceMappingURL=index.js.map