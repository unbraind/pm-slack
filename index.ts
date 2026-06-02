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

import https from "node:https";
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

const ALL_EVENTS: EventKind[] = ["create", "close", "block"];

function parseEvents(spec: string | undefined): Set<EventKind> {
  if (!spec) return new Set(ALL_EVENTS);
  const parsed = spec
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e): e is EventKind => ALL_EVENTS.includes(e as EventKind));
  return parsed.length > 0 ? new Set(parsed) : new Set(ALL_EVENTS);
}

// ---------------------------------------------------------------------------
// Format parsing
// ---------------------------------------------------------------------------

const ALL_FORMATS: MessageFormat[] = ["blockkit", "text"];

/**
 * Normalize a format spec to a known MessageFormat. Accepts a few friendly
 * aliases ("block"/"blocks" → blockkit, "plain"/"txt" → text). Falls back to
 * the supplied default when the spec is empty or unrecognized.
 */
function parseFormat(spec: string | undefined, fallback: MessageFormat = "blockkit"): MessageFormat {
  if (!spec) return fallback;
  const v = spec.trim().toLowerCase();
  if (v === "blockkit" || v === "block" || v === "blocks" || v === "rich") return "blockkit";
  if (v === "text" || v === "plain" || v === "txt") return "text";
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
// Config helpers
// ---------------------------------------------------------------------------

interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  minPriority: Priority;
  events: Set<EventKind>;
  format: MessageFormat;
  routes: RouteRule[];
}

function loadConfig(): SlackConfig | null {
  const webhookUrl = process.env.PM_SLACK_WEBHOOK ?? "";
  const routes = parseRoutes(process.env.PM_SLACK_ROUTES);

  // A default webhook is not strictly required if routing rules carry their own
  // webhook(s); only bail out when there is no webhook source at all.
  const routesHaveWebhook = routes.some((r) => r.webhook);
  if (!webhookUrl && !routesHaveWebhook) {
    console.error("[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled");
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

  return { webhookUrl, channel, minPriority, events, format, routes };
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
// Plain-text message formatting (fallback)
// ---------------------------------------------------------------------------

function itemTypeLabel(item: PmItem): string {
  return item.type ?? "Item";
}

const EVENT_META: Record<EventKind, { verb: string; emoji: string }> = {
  create: { verb: "created", emoji: "🆕" },
  close: { verb: "closed", emoji: "✅" },
  block: { verb: "is blocked", emoji: "🚫" },
};

function eventReason(item: PmItem, event: EventKind): string | undefined {
  if (event === "close") {
    return item.close_reason?.trim() || item.closedReason?.trim() || undefined;
  }
  if (event === "block") {
    return item.blocked_reason?.trim() || item.blockedReason?.trim() || undefined;
  }
  return undefined;
}

function buildTextMessage(item: PmItem, event: EventKind, channel?: string): string {
  const type = itemTypeLabel(item);
  const meta = EVENT_META[event];
  let msg = `*[${type}]* ${item.title} ${meta.verb} ${meta.emoji}`;

  if (event === "create") {
    msg += `\nPriority: ${priorityLabel(item.priority)} • Type: ${type} • By: ${item.author ?? "unknown"}`;
  } else {
    msg += `\nReason: ${eventReason(item, event) ?? "no reason given"}`;
  }

  if (channel) msg += `\n_Channel: ${channel}_`;
  return msg;
}

// ---------------------------------------------------------------------------
// Block Kit rendering
//
// Build a Slack Block Kit `blocks` array (header + section with fields +
// optional reason section + context footer) and a plain-text `fallback` Slack
// renders in notifications and old clients.
// ---------------------------------------------------------------------------

interface BlockKitOptions {
  channel?: string;
  /** Extra free-form body appended as a section (e.g. from `--text`). */
  note?: string;
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
    text: { type: "plain_text", text: `${meta.emoji} ${item.title}`, emoji: true },
  });

  // Fields section: a 2-column grid of mrkdwn key/value pairs.
  const fields: { type: "mrkdwn"; text: string }[] = [
    { type: "mrkdwn", text: `*Item:*\n${item.id}` },
    { type: "mrkdwn", text: `*Type:*\n${type}` },
    { type: "mrkdwn", text: `*Event:*\n${meta.verb}` },
    { type: "mrkdwn", text: `*Priority:*\n${priorityLabel(item.priority)}` },
  ];
  if (item.status) fields.push({ type: "mrkdwn", text: `*Status:*\n${item.status}` });
  if (item.author) fields.push({ type: "mrkdwn", text: `*By:*\n${item.author}` });
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
  if (format === "text") {
    const text = buildTextMessage(item, event, opts.channel);
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

function postToSlack(webhookUrl: string, payload: SlackPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
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
          reject(new Error(`Slack webhook returned HTTP ${status}: ${data.slice(0, 200)}`));
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
    text: { type: "plain_text", text: `📊 pm activity digest`, emoji: true },
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
  const fields = DIGEST_ORDER.map((bucket) => {
    const meta = DIGEST_BUCKET_META[bucket];
    return { type: "mrkdwn" as const, text: `${meta.emoji} *${meta.label}:*\n${summary.counts[bucket]}` };
  });
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
        text: `${meta.emoji} *${meta.label}* (${items.length})\n${digestItemLines(items).join("\n")}`,
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

function detectEvent(ctx: AfterCommandHookContext): EventKind | null {
  const cmd = ctx.command?.toLowerCase() ?? "";

  if (CREATE_COMMANDS.has(cmd)) return "create";
  if (CLOSE_COMMANDS.has(cmd)) return "close";

  if (UPDATE_COMMANDS.has(cmd)) {
    const newStatus =
      (ctx.options?.["status"] as string | undefined) ??
      ((ctx as any).result as { item?: { status?: string } } | undefined)?.item?.status ??
      "";
    if (newStatus.toLowerCase() === "blocked") return "block";

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
  version: "2026.6.3",

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

          const payload = buildItemPayload(item, event, config.format, {
            channel: target.channel,
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
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default) or text. Overrides PM_SLACK_FORMAT." },
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

          // `--on` selects the message template. First event wins for the header verb.
          const events = parseEvents(readStrOption(options, "on") ?? "create");
          const event: EventKind = (ALL_EVENTS.find((e) => events.has(e)) ?? "create") as EventKind;

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
          const item: PmItem = { id: "manual", title, type: "Note" };
          const payload: SlackPayload = {
            ...buildItemPayload(item, event, format, {
              channel,
              note: text && text !== title ? text : undefined,
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
            return { dryRun: true, event, format, channel, thread_ts: threadTs, payload };
          }

          if (!webhookUrl) {
            // Graceful no-op: warn and exit 0 so a missing webhook never blocks
            // a workflow. Use --dry-run to preview without a webhook.
            console.error(
              "[pm-slack] PM_SLACK_WEBHOOK not set and no --webhook provided — posting disabled. " +
                "Use --dry-run to preview the message."
            );
            return { posted: false, disabled: true, reason: "no-webhook" };
          }

          try {
            await postToSlack(webhookUrl, payload);
          } catch (err) {
            // Never throw on network failure: warn and exit 0.
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[pm-slack] Slack post failed (continuing): ${message}`);
            return { posted: false, error: message };
          }

          return { posted: true, event, channel, thread_ts: threadTs };
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
        ],
        flags: [
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default) or text. Overrides PM_SLACK_FORMAT." },
          { long: "--on", value_name: "event", description: "Lifecycle event to preview (create,close,block). Default: create" },
          { long: "--title", value_name: "title", description: "Sample item title (default: a representative example)" },
          { long: "--channel", value_name: "name", description: "Channel hint to show in the preview (overrides PM_SLACK_CHANNEL)" },
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

          // A representative sample item per event so the preview is realistic.
          const sample: Record<EventKind, PmItem> = {
            create: { id: "pm-1a2b", title: readStrOption(options, "title") ?? "Add OAuth login flow", type: "Feature", priority: 2, status: "open", author: "alice" },
            close: { id: "pm-3c4d", title: readStrOption(options, "title") ?? "Fix login redirect bug", type: "Issue", priority: 1, status: "closed", author: "bob", close_reason: "Fixed in commit abc123" },
            block: { id: "pm-5e6f", title: readStrOption(options, "title") ?? "Dashboard redesign", type: "Epic", priority: 2, status: "blocked", author: "carol", blocked_reason: "Waiting on design approval" },
          };
          const item = sample[event];
          const payload = buildItemPayload(item, event, format, { channel });

          // In JSON mode, pm renders the returned object — don't also write to
          // stdout (that would corrupt the JSON stream). In human mode, print a
          // readable preview to stdout/stderr.
          if (!asJson) {
            console.error(`--- PREVIEW (${format}, event=${event}) — nothing posted ---`);
            process.stdout.write(payload.text + "\n");
            console.error(`--- ${format} payload ---`);
            process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
            console.error("--- END ---");
          }
          return { preview: true, event, format, channel, payload };
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
        ],
        flags: [
          { long: "--since", value_name: "date", description: "Only include activity at/after this ISO date (e.g. 2026-06-01)" },
          { long: "--days", value_name: "n", description: "Look back N days from now (default 7; ignored when --since is given)" },
          { long: "--format", value_name: "fmt", description: "Message format: blockkit (default) or text. Overrides PM_SLACK_FORMAT." },
          { long: "--channel", value_name: "name", description: "Channel to post to (overrides PM_SLACK_CHANNEL)" },
          { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK)" },
          { long: "--dry-run", description: "Build and print the digest without posting to Slack" },
          { long: "--json", description: "Emit the digest summary/payload as JSON" },
        ],

        async run(ctx: { args?: string[]; options?: Record<string, unknown>; pm_root?: string; global?: { json?: boolean } }) {
          const options = ctx.options ?? {};
          const dryRun = readBoolOption(options, "dry-run");
          const asJson = ctx.global?.json === true || readBoolOption(options, "json");
          const format = parseFormat(readStrOption(options, "format") ?? process.env.PM_SLACK_FORMAT);
          const channel = (readStrOption(options, "channel") ?? process.env.PM_SLACK_CHANNEL?.trim()) || undefined;
          const webhookUrl = readStrOption(options, "webhook") ?? process.env.PM_SLACK_WEBHOOK ?? "";

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
          const payload = buildDigestPayload(summary, format, channel);

          if (dryRun) {
            if (!asJson) {
              console.error(`--- DRY RUN digest (${format}, ${label}) — nothing posted ---`);
              process.stdout.write(payload.text + "\n");
              console.error(`--- ${format} payload ---`);
              process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
              console.error("--- END ---");
            }
            return { dryRun: true, format, channel, counts: summary.counts, total: summary.total, window: label, payload };
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

          return { posted: true, format, channel, counts: summary.counts, total: summary.total, window: label };
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
  parseEvents,
  parseFormat,
  parseRoutes,
  ruleMatches,
  selectRoute,
  detectEvent,
  extractItem,
  meetsMinPriority,
  parseStoredItem,
  resolveWindow,
  aggregateDigest,
  buildDigestText,
  buildDigestBlockKit,
  buildDigestPayload,
  EXIT_CODE,
  CommandError,
};
