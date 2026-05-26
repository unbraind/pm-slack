/**
 * pm-slack — Slack notifications for pm-cli item lifecycle events
 *
 * Env vars:
 *   PM_SLACK_WEBHOOK      (required) Slack incoming webhook URL
 *   PM_SLACK_CHANNEL      (optional) Override channel, e.g. #pm-alerts
 *   PM_SLACK_MIN_PRIORITY (optional) Minimum priority to notify (1=critical … 4=low), default 1 (all)
 *   PM_SLACK_EVENTS       (optional) Comma-separated subset: create,close,block  (default: all)
 */

import https from "node:https";
import type { defineExtension as defineExtensionType, AfterCommandHookContext, BeforeCommandHookContext  } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

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
  closedReason?: string;
  blockedReason?: string;
  author?: string;
}

type EventKind = "create" | "close" | "block";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  minPriority: Priority;
  events: Set<EventKind>;
}

function loadConfig(): SlackConfig | null {
  const webhookUrl = process.env.PM_SLACK_WEBHOOK ?? "";
  if (!webhookUrl) {
    console.error("[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled");
    return null;
  }

  // Validate URL
  try {
    new URL(webhookUrl);
  } catch {
    console.error("[pm-slack] PM_SLACK_WEBHOOK is not a valid URL — notifications disabled");
    return null;
  }

  const channel = process.env.PM_SLACK_CHANNEL?.trim() || undefined;

  const rawPriority = parseInt(process.env.PM_SLACK_MIN_PRIORITY ?? "1", 10);
  const minPriority: Priority =
    rawPriority >= 1 && rawPriority <= 4 ? (rawPriority as Priority) : 1;

  const rawEvents = process.env.PM_SLACK_EVENTS;
  const allEvents: EventKind[] = ["create", "close", "block"];
  let events: Set<EventKind>;
  if (rawEvents) {
    const parsed = rawEvents
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e): e is EventKind => allEvents.includes(e as EventKind));
    events = parsed.length > 0 ? new Set(parsed) : new Set(allEvents);
  } else {
    events = new Set(allEvents);
  }

  return { webhookUrl, channel, minPriority, events };
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

function meetsMinPriority(
  item: PmItem,
  minPriority: Priority
): boolean {
  // Lower number = higher priority; 1 = critical
  if (item.priority === undefined) return true; // unknown priority always passes
  return item.priority <= minPriority;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function itemTypeLabel(item: PmItem): string {
  return item.type ?? "Item";
}

function buildCreateMessage(item: PmItem, channel?: string): string {
  const type = itemTypeLabel(item);
  const pri = priorityLabel(item.priority);
  const author = item.author ?? "unknown";

  let msg =
    `*[${type}]* ${item.title} created 🆕\n` +
    `Priority: ${pri} • Type: ${type} • By: ${author}`;

  if (channel) msg += `\n_Channel: ${channel}_`;
  return msg;
}

function buildCloseMessage(item: PmItem, channel?: string): string {
  const type = itemTypeLabel(item);
  const reason = item.closedReason?.trim() || "no reason given";

  let msg =
    `*[${type}]* ${item.title} closed ✅\n` + `Reason: ${reason}`;

  if (channel) msg += `\n_Channel: ${channel}_`;
  return msg;
}

function buildBlockMessage(item: PmItem, channel?: string): string {
  const type = itemTypeLabel(item);
  const reason = item.blockedReason?.trim() || "no reason given";

  let msg =
    `*[${type}]* ${item.title} is blocked 🚫\n` + `Reason: ${reason}`;

  if (channel) msg += `\n_Channel: ${channel}_`;
  return msg;
}

// ---------------------------------------------------------------------------
// Slack HTTP POST
// ---------------------------------------------------------------------------

function postToSlack(
  webhookUrl: string,
  text: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, mrkdwn: true });
    const parsed = new URL(webhookUrl);

    const options: https.RequestOptions = {
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
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(
            new Error(
              `Slack webhook returned HTTP ${status}: ${data.slice(0, 200)}`
            )
          );
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

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

/** Commands that create a new item */
const CREATE_COMMANDS = new Set(["add", "create", "new"]);

/** Commands that close/complete an item */
const CLOSE_COMMANDS = new Set(["close", "done", "complete", "finish", "resolve"]);

/** Commands that update an item's status or attributes */
const UPDATE_COMMANDS = new Set(["update", "edit", "set", "status"]);

function detectEvent(ctx: AfterCommandHookContext): EventKind | null {
  const cmd = ctx.command?.toLowerCase() ?? "";

  if (CREATE_COMMANDS.has(cmd)) return "create";
  if (CLOSE_COMMANDS.has(cmd)) return "close";

  if (UPDATE_COMMANDS.has(cmd)) {
    // Detect a block status being set via options or result
    const newStatus =
      (ctx.options?.["status"] as string | undefined) ??
      ((ctx as any).result as { item?: { status?: string } } | undefined)?.item?.status ??
      "";
    if (newStatus.toLowerCase() === "blocked") return "block";

    // Also check result item for blocked status transition
    const resultItem = ((ctx as any).result as { item?: { status?: string } } | undefined)?.item;
    if (resultItem?.status?.toLowerCase() === "blocked") return "block";
  }

  return null;
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
  version: "2026.5.26",

  activate(api) {
    // ---------------------------------------------------------------------------
    // afterCommand hook — fires after every pm-cli command completes
    // ---------------------------------------------------------------------------
    if (typeof api.hooks?.afterCommand === "function") {
      api.hooks.afterCommand(async (ctx: AfterCommandHookContext) => {
        const config = loadConfig();
        if (!config) return;

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

        let text: string;
        switch (event) {
          case "create":
            text = buildCreateMessage(item, config.channel);
            break;
          case "close":
            text = buildCloseMessage(item, config.channel);
            break;
          case "block":
            text = buildBlockMessage(item, config.channel);
            break;
        }

        try {
          await postToSlack(config.webhookUrl, text);
          console.error(`[pm-slack] Notification sent for event "${event}" on item ${item.id}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[pm-slack] Failed to send Slack notification: ${message}`);
        }
      });
    } else {
      // Fallback: use beforeCommand if afterCommand is unavailable
      // (result data will be unavailable, so we can only notify on command name)
      api.hooks.beforeCommand(async (ctx: BeforeCommandHookContext) => {
        console.error(
          "[pm-slack] afterCommand not available — limited event detection active"
        );
        const config = loadConfig();
        if (!config) return;

        const cmd = ctx.command?.toLowerCase() ?? "";
        let event: EventKind | null = null;
        if (CREATE_COMMANDS.has(cmd)) event = "create";
        else if (CLOSE_COMMANDS.has(cmd)) event = "close";

        if (!event || !config.events.has(event)) return;

        // Without result we can only build a generic message
        const cmdArgs = (ctx.args ?? []).join(" ");
        const text = `pm command \`${ctx.command}\` triggered event *${event}*\n${cmdArgs}`;

        try {
          await postToSlack(config.webhookUrl, text);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[pm-slack] Failed to send Slack notification: ${message}`);
        }
      });
    }
  },
});
