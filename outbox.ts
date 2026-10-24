/** Durable, local Slack delivery receipts. Payloads and webhook credentials never appear in inspection output. */
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { planSlackCoalescing } from "./coalescing.ts";
import type { CoalescingEvent, CoalescingOptions, CoalescingPlan, CoalescingReceipt } from "./coalescing.ts";

/** Stable refusal codes returned by both the SDK and CLI. */
export type OutboxRefusalCode = "invalid_input" | "disabled" | "conflict" | "not_found" | "in_flight" | "not_ambiguous" | "destination_changed" | "storage_unavailable" | "history_unavailable";

/** Expected failure with a safe message, machine-readable code, and concrete remedy. */
export class OutboxError extends Error {
  /** Host extension runtime's expected-error status. */
  readonly exitCode = 2;
  /** Stable machine-readable refusal category. */
  readonly code: OutboxRefusalCode;
  /** Safe recovery action for callers and agents. */
  readonly remedy: string;
  /** Host-compatible structured recovery field, identical to remedy. */
  readonly remediation: string;
  /** Public expected-error shape consumed by the host's JSON refusal renderer. */
  readonly context: { code: OutboxRefusalCode; required: string; nextSteps: string[] };
  /** Create a refusal without including payloads, credentials, or filesystem paths. */
  constructor(code: OutboxRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "PmCliError";
    this.code = code;
    this.remedy = remedy;
    this.remediation = remedy;
    this.context = { code, required: remedy, nextSteps: [remedy] };
  }
}

/** Persisted lifecycle delivery state; sending after a crash must be reconciled explicitly. */
export type OutboxState = "pending" | "sending" | "acknowledged" | "ambiguous" | "rejected" | "refused" | "skipped";

/** Lifecycle transitions owned by Slack delivery, independent of command aliases. */
export type OutboxEvent = "create" | "close" | "block" | "cancel" | "open" | "start" | "unblock" | "reopen";

const lifecycleEvents: readonly OutboxEvent[] = ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"];

/** Minimal webhook body supported by durable lifecycle delivery. */
export interface OutboxPayload {
  /** Plain-text fallback, already formatted and capped by the Slack builder. */
  text: string;
  /** Optional Block Kit sections. */
  blocks?: { type: string; [key: string]: unknown }[];
  /** Whether Slack parses markdown. */
  mrkdwn?: boolean;
  /** Destination override captured with the intent. */
  channel?: string;
}

/** Immutable delivery intent; revision must identify one committed lifecycle transition. */
export interface OutboxIntent {
  /** Stable item id. */
  item: string;
  /** Canonical lifecycle event. */
  event: OutboxEvent;
  /** Committed history hash; repeated transitions use distinct revisions. */
  revision: string;
  /** Credential-free hash of the resolved webhook and channel. */
  destination: string;
  /** Frozen message body; inspection never returns it. */
  payload: OutboxPayload;
  /** Committed event timestamp; legacy intents use epoch zero. */
  at?: number;
  /** Priority frozen at the transition; legacy blockers still bypass batching. */
  priority?: number;
}

/** Bounded coalescing evidence; notification bodies and destination identities stay private. */
export interface CoalescingReport {
  /** Original event totals and notification counts, without payloads. */
  summary: { events: number; urgent: number; coalesced: number; deferred: number; waiting: number; notifications: number };
  /** Exactly identified source events on this page. */
  rows: (CoalescingReceipt & { state: OutboxState })[];
  /** Evidence rows outside this page, never unreported event loss. */
  omitted: number;
  /** Offset for the next page; null denotes complete evidence. */
  next_cursor: number | null;
}

/** Compact, credential-free delivery receipt. */
export interface OutboxReceipt {
  /** Stable local sequence used for bounded pagination. */
  sequence: number;
  /** Idempotency key derived from item, event and history revision. */
  key: string;
  /** Item owning the notification. */
  item: string;
  /** Canonical lifecycle transition. */
  event: OutboxEvent;
  /** Durable acknowledgment or uncertainty state. */
  state: OutboxState;
  /** Number of claimed remote attempts, including uncertain attempts. */
  attempts: number;
}

/** Bounded inspection with exact state totals and an explicit omission count. */
export interface OutboxReport {
  /** Persisted opt-in start; null means delivery has not been enabled. */
  enabled_since: string | null;
  /** Exact durable state counts. */
  counts: Record<OutboxState, number>;
  /** Oldest matching receipts, bounded by the requested limit. */
  rows: OutboxReceipt[];
  /** Rows omitted from this inspection. */
  omitted: number;
  /** Resume status after this sequence, or null when the page is complete. */
  next_cursor: number | null;
}

/** Credential-free eligibility snapshot for future lifecycle recovery. */
export interface OutboxRecoveryFilter {
  /** Lifecycle events enabled at the snapshot boundary. */
  events: readonly OutboxEvent[];
  /** Least urgent eligible priority, from one to four. */
  minPriority: number;
}

/** Persisted eligibility epoch; changing environment variables does not rewrite older decisions. */
export interface OutboxRecoveryPolicy extends OutboxRecoveryFilter {
  /** First eligible history timestamp for this policy. */
  since: string;
}

/** Complete recovery totals; failed item histories never authorize partial intents. */
export interface OutboxRecoveryReport {
  /** Verified history entries inspected. */
  inspected: number;
  /** New delivery intents queued. */
  queued: number;
  /** Item-history or global recovery failures, without exposing contents or local paths. */
  failed: number;
}

/** Explicit reconciliation decisions; skipping never claims remote acknowledgment. */
export type OutboxDecision = "acknowledged" | "retry" | "skip";

/** HTTP transport outcome; only an explicit remote acknowledgment permits ack. */
export type OutboxOutcome = "acknowledged" | "retry" | "ambiguous" | "rejected";

/** Derive the stable receipt primary key from one committed lifecycle transition. */
function receiptKey(item: string, event: OutboxEvent, revision: string): string {
  return createHash("sha256").update(JSON.stringify([item, event, revision])).digest("hex");
}

/** Hash a destination without persisting a webhook credential. */
export function slackDestination(webhook: string, channel?: string): string {
  return createHash("sha256").update(JSON.stringify([webhook, channel ?? null])).digest("hex");
}

/** Validate the shared SDK and CLI bound before reading or claiming work. */
function limitValue(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OutboxError("invalid_input", "Use a limit from 1 to 100.");
  }
  return limit;
}

/** Load the synchronous SQLite API native to Node or Bun through their common statement surface. */
function openDatabase(file: string): DatabaseSync {
  const [module, constructor] = ([ ["node:sqlite", "DatabaseSync"], ["bun:sqlite", "Database"] ] as const)[Number(Boolean(process.versions.bun))]!;
  const sqlite = createRequire(import.meta.url)(module) as Record<string, typeof DatabaseSync>;
  return new sqlite[constructor]!(file);
}

/** Validate eligibility before enabling storage or recording a future-only policy. */
function recoveryFilterValue(filter: OutboxRecoveryFilter): void {
  if (!Number.isInteger(filter.minPriority) || filter.minPriority < 1 || filter.minPriority > 4 || !filter.events.every((event) => lifecycleEvents.includes(event))) {
    throw new OutboxError("invalid_input", "Use canonical lifecycle events and a recovery priority from 1 to 4.");
  }
}

/** Local SQLite outbox using full synchronous commits and atomic cross-process claims. */
export class SlackOutbox {
  private readonly db: DatabaseSync;

  /** Open runtime storage in an initialized local tracker, without invoking git. */
  constructor(pmRoot: string) {
    let database: DatabaseSync | undefined;
    try {
      const directory = join(pmRoot, "runtime", "slack-outbox");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const file = join(directory, "delivery.sqlite");
      this.db = openDatabase(file);
      database = this.db;
      chmodSync(file, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), since TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery (
          key TEXT PRIMARY KEY, item TEXT NOT NULL, event TEXT NOT NULL, revision TEXT NOT NULL,
          destination TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, owner INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS delivery_pending ON delivery(state);
        CREATE TABLE IF NOT EXISTS recovery_policy (since TEXT NOT NULL, events TEXT NOT NULL, min_priority INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS recovery_policy_since ON recovery_policy(since);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_context (key TEXT PRIMARY KEY, at INTEGER NOT NULL, priority INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS coalescing_receipt (key TEXT PRIMARY KEY, disposition TEXT NOT NULL, notification TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery_group (key TEXT PRIMARY KEY, notification TEXT NOT NULL);`);
    } catch {
      database?.close();
      throw new OutboxError("storage_unavailable", "Restore writable local runtime storage; committed items are unchanged. Then drain again.");
    }
  }

  /** Release the database handle; committed receipts survive process exit. */
  close(): void { this.db.close(); }

  /** Atomically opt in with initial eligibility; legacy policy adoption starts with future history. */
  enable(filter?: OutboxRecoveryFilter): string {
    if (filter) recoveryFilterValue(filter);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const previous = this.since();
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)").run(new Date().toISOString());
      const since = this.since() as string;
      if (filter) this.saveRecoveryPolicy(filter, previous === null ? since : new Date().toISOString(), true);
      this.db.exec("COMMIT");
      return since;
    } catch {
      // SQLite may already have rolled back (or refused BEGIN); keep the typed remedy.
      try { this.db.exec("ROLLBACK"); } catch { /* No transaction may remain to roll back. */ }
      throw new OutboxError("storage_unavailable", "Restore writable local runtime storage and enable again; opt-in and eligibility were not changed.");
    }
  }

  /** Record an explicit future-only filter change; retained history keeps its earlier eligibility. */
  configureRecovery(filter: OutboxRecoveryFilter): void {
    if (!this.since()) throw new OutboxError("disabled", "Enable the outbox before configuring recovery.");
    this.saveRecoveryPolicy(filter, new Date().toISOString(), false);
  }

  /** Read eligibility epochs newest first; unsnapshotted SDK trackers must opt in explicitly. */
  recoveryPolicies(): OutboxRecoveryPolicy[] {
    const rows = this.db.prepare("SELECT since,events,min_priority FROM recovery_policy ORDER BY rowid DESC").all();
    if (!rows.length) throw new OutboxError("history_unavailable", "Configure recovery filters before future lifecycle changes; existing queued receipts can still drain.");
    return rows.map((row) => ({ since: String(row.since), events: JSON.parse(String(row.events)) as OutboxEvent[], minPriority: Number(row.min_priority) }));
  }

  /** Resolve one entry's policy by its timestamp, including configurations committed during a recovery scan. */
  recoveryPolicyAt(timestamp: string): OutboxRecoveryPolicy | undefined {
    const row = this.db.prepare("SELECT since,events,min_priority FROM recovery_policy WHERE since<=? ORDER BY since DESC,rowid DESC LIMIT 1").get(timestamp);
    return row ? { since: String(row.since), events: JSON.parse(String(row.events)) as OutboxEvent[], minPriority: Number(row.min_priority) } : undefined;
  }

  /** Persist a validated policy without storing routing credentials or replacing previous epochs. */
  private saveRecoveryPolicy(filter: OutboxRecoveryFilter, since: string, onlyIfEmpty: boolean): void {
    recoveryFilterValue(filter);
    this.db.prepare("INSERT INTO recovery_policy SELECT ?,?,? WHERE ?=0 OR NOT EXISTS (SELECT 1 FROM recovery_policy)")
      .run(since, JSON.stringify(filter.events), filter.minPriority, Number(onlyIfEmpty));
  }

  /** Return the durable opt-in boundary without reading message bodies. */
  since(): string | null {
    const row = this.db.prepare("SELECT since FROM settings WHERE id=1").get();
    return row ? String(row.since) : null;
  }

  /** Persist an intent once; conflicting reuse refuses instead of silently changing a message. */
  enqueue(intent: OutboxIntent): string {
    if (!this.since()) throw new OutboxError("disabled", "Run pm slack outbox --action enable before lifecycle changes.");
    if (![intent.item, intent.event, intent.revision, intent.destination, intent.payload.text].every((value) => typeof value === "string" && value.length > 0) || !lifecycleEvents.includes(intent.event)) {
      throw new OutboxError("invalid_input", "Provide an item, event, immutable revision, destination and message text.");
    }
    if ((intent.at !== undefined && (!Number.isSafeInteger(intent.at) || intent.at < 0)) || (intent.priority !== undefined && (!Number.isInteger(intent.priority) || intent.priority < 0 || intent.priority > 4))) {
      throw new OutboxError("invalid_input", "Use a nonnegative integer timestamp and priority from 0 to 4.");
    }
    const key = receiptKey(intent.item, intent.event, intent.revision);
    const payload = JSON.stringify(intent.payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO delivery(key,item,event,revision,destination,payload) VALUES (?,?,?,?,?,?)")
        .run(key, intent.item, intent.event, intent.revision, intent.destination, payload);
      const row = this.db.prepare("SELECT destination,payload FROM delivery WHERE key=?").get(key)!;
      if (row.destination !== intent.destination || row.payload !== payload) {
        throw new OutboxError("conflict", "Keep the original intent and configuration; inspect the existing receipt before changing routing or message formatting.");
      }
      this.db.prepare("INSERT OR IGNORE INTO delivery_context VALUES (?,?,?)").run(key, intent.at ?? 0, intent.priority ?? 4);
      this.db.exec("COMMIT");
      return key;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Read a deterministic plan over pending intents; no payload or webhook is returned. */
  planCoalescing(options: CoalescingOptions = {}): CoalescingPlan {
    if (!this.since()) throw new OutboxError("disabled", "Run pm slack outbox --action enable before coalescing.");
    const rows = this.db.prepare(`SELECT d.key,d.item,d.event,d.revision,d.destination,COALESCE(c.at,0) AS at,COALESCE(c.priority,4) AS priority
      FROM delivery d LEFT JOIN delivery_context c ON c.key=d.key WHERE d.state='pending' LIMIT 10001`).all() as unknown as CoalescingEvent[];
    return planSlackCoalescing(rows, options);
  }

  /** Page a preview or durable evidence manifest without exposing frozen payloads or destinations. */
  coalescingReport(plan: CoalescingPlan, limit = 20, after = 0, durable = false): CoalescingReport {
    limitValue(limit);
    if (!Number.isSafeInteger(after) || after < 0) throw new OutboxError("invalid_input", "Use a nonnegative integer coalescing cursor.");
    const total = durable ? Number(this.db.prepare("SELECT COUNT(*) AS n FROM coalescing_receipt").get()!.n) : plan.receipts.length;
    const rows = durable ? this.db.prepare(`SELECT d.key,d.item,d.event,d.revision,c.disposition,c.notification,d.state
      FROM coalescing_receipt c JOIN delivery d ON d.key=c.key ORDER BY d.key LIMIT ? OFFSET ?`).all(limit, after) as unknown as CoalescingReport["rows"] : plan.receipts.slice(after, after + limit).map((row) => ({ ...row, state: this.db.prepare("SELECT state FROM delivery WHERE key=?").get(row.key)!.state as OutboxState }));
    return { summary: { events: plan.events, urgent: plan.urgent, coalesced: plan.coalesced, deferred: plan.deferred, waiting: plan.waiting, notifications: plan.notifications.length }, rows,
      omitted: total - rows.length, next_cursor: after + rows.length < total ? after + rows.length : null };
  }

  /**
   * Send urgent originals first and bounded routine summaries after closed windows.
   * Claims fence concurrent plain and coalesced drains. Every original keeps its
   * state and attempt count; crashes leave all claimed members visibly sending.
   */
  async drainCoalesced(send: (destination: string, payload: OutboxPayload) => Promise<OutboxOutcome>, options: CoalescingOptions = {}): Promise<CoalescingPlan> {
    const plan = this.planCoalescing(options);
    for (const receipt of plan.receipts) {
      this.db.prepare("INSERT OR IGNORE INTO coalescing_receipt VALUES (?,?,?)").run(receipt.key, receipt.disposition, receipt.notification);
    }
    const uncertain = new Set<string>();
    for (const notification of plan.notifications) {
      if (uncertain.has(notification.destination)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      const placeholders = notification.keys.map(() => "?").join(",");
      let members: { key: string; payload: string }[];
      try {
        members = this.db.prepare(`SELECT key,payload FROM delivery WHERE state='pending' AND key IN (${placeholders})`).all(...notification.keys) as unknown as { key: string; payload: string }[];
        if (members.length !== notification.keys.length) { this.db.exec("ROLLBACK"); continue; }
        for (const key of notification.keys) {
          this.db.prepare("UPDATE delivery SET state='sending',owner=?,attempts=attempts+1 WHERE key=?").run(process.pid, key);
          this.db.prepare("INSERT OR REPLACE INTO coalescing_receipt VALUES (?,?,?)").run(key, notification.urgent ? "bypass" : "coalesced", notification.key);
          this.db.prepare("INSERT OR REPLACE INTO delivery_group VALUES (?,?)").run(key, notification.key);
        }
        this.db.exec("COMMIT");
      } catch {
        this.db.exec("ROLLBACK");
        throw new OutboxError("storage_unavailable", "Restore writable receipt storage, then drain again; the failed group was not sent.");
      }
      const original = JSON.parse(String(members[0]!.payload)) as OutboxPayload;
      const payload = notification.urgent ? original : { text: notification.text, mrkdwn: false, ...(original.channel === undefined ? {} : { channel: original.channel }) };
      let state: OutboxState;
      let refusal: OutboxError | undefined;
      try {
        const outcome = await send(notification.destination, payload);
        state = outcome === "retry" ? "pending" : outcome;
      } catch (error) {
        if (error instanceof OutboxError) { refusal = error; state = error.code === "destination_changed" ? "refused" : "pending"; }
        else state = "ambiguous";
      }
      this.db.prepare(`UPDATE delivery SET state=?,owner=0,attempts=attempts-? WHERE key IN (${placeholders})`).run(state, Number(Boolean(refusal)), ...notification.keys);
      if (state === "pending") this.db.prepare(`DELETE FROM delivery_group WHERE key IN (${placeholders})`).run(...notification.keys);
      if (refusal && refusal.code !== "destination_changed") throw refusal;
      if (state === "ambiguous") uncertain.add(notification.destination);
      if (state === "pending") break;
    }
    return plan;
  }

  /** Check whether a verified history transition already has a durable intent. */
  has(item: string, event: OutboxEvent, revision: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM delivery WHERE key=?").get(receiptKey(item, event, revision));
  }

  /** Inspect a bounded receipt page while preserving exact totals and omission evidence. */
  status(limit = 20, after = 0): OutboxReport {
    limitValue(limit);
    if (!Number.isSafeInteger(after) || after < 0) throw new OutboxError("invalid_input", "Use a nonnegative integer status cursor.");
    const counts: Record<OutboxState, number> = { pending: 0, sending: 0, acknowledged: 0, ambiguous: 0, rejected: 0, refused: 0, skipped: 0 };
    for (const row of this.db.prepare("SELECT state,COUNT(*) AS n FROM delivery GROUP BY state").all()) counts[row.state as OutboxState] = Number(row.n);
    const page = this.db.prepare("SELECT rowid AS sequence,key,item,event,state,attempts FROM delivery WHERE rowid>? ORDER BY rowid LIMIT ?").all(after, limit + 1) as unknown as OutboxReceipt[];
    const rows = page.slice(0, limit);
    return { enabled_since: this.since(), counts, rows, omitted: Object.values(counts).reduce((sum, n) => sum + n, 0) - rows.length,
      next_cursor: page.length > limit ? rows[rows.length - 1]!.sequence : null };
  }

  /**
   * Claim pending rows once. Typed OutboxError refusals occur before a remote
   * request starts. Destination changes park a refused row and continue; other
   * typed refusals restore pending without counting an attempt. An ambiguous
   * outcome holds later rows for that destination in this drain. A retry
   * outcome stops this drain so a rate limit is not hit again immediately.
   * The next drain prefers fewer attempts, then older rows, so one refused
   * destination cannot block every other notification.
   */
  async drain(send: (destination: string, payload: OutboxPayload) => Promise<OutboxOutcome>, limit = 20): Promise<OutboxReport> {
    limitValue(limit);
    if (!this.since()) throw new OutboxError("disabled", "Run pm slack outbox --action enable first.");
    const candidates = this.db.prepare("SELECT key,destination FROM delivery WHERE state='pending' ORDER BY attempts, rowid LIMIT ?").all(limit);
    const uncertain = new Set<string>();
    for (const candidate of candidates) {
      if (uncertain.has(String(candidate.destination))) continue;
      const row = this.db.prepare("UPDATE delivery SET state='sending',owner=?,attempts=attempts+1 WHERE key=? AND state='pending' RETURNING destination,payload").get(process.pid, candidate.key!);
      if (!row) continue;
      let state: OutboxState;
      try {
        const outcome = await send(String(row.destination), JSON.parse(String(row.payload)) as OutboxPayload);
        state = outcome === "retry" ? "pending" : outcome;
      } catch (error) {
        if (error instanceof OutboxError) {
          const refused = error.code === "destination_changed";
          this.db.prepare("UPDATE delivery SET state=?,owner=0,attempts=attempts-1 WHERE key=?").run(refused ? "refused" : "pending", candidate.key!);
          if (refused) continue;
          throw error;
        }
        state = "ambiguous";
      }
      this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(state, candidate.key!);
      if (state === "ambiguous") uncertain.add(String(candidate.destination));
      if (state === "pending") break;
    }
    return this.status(limit);
  }

  /** Reconcile uncertainty or refusal; force overrides PID reuse only after an operator verifies sender absence. */
  resolve(key: string, decision: OutboxDecision, options: { force?: boolean } = {}): void {
    if (decision !== "acknowledged" && decision !== "retry" && decision !== "skip") throw new OutboxError("invalid_input", "Choose acknowledged, retry after verifying absence, or skip to discard without claiming delivery.");
    // One transaction fences concurrent reconciliation and claims across processes.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state,owner FROM delivery WHERE key=?").get(key);
      if (!row) throw new OutboxError("not_found", "Inspect status and use an existing receipt key.");
      if (row.state !== "sending" && row.state !== "ambiguous" && row.state !== "rejected" && row.state !== "refused") throw new OutboxError("not_ambiguous", "Only reconcile sending, ambiguous, rejected, or refused receipts.");
      if (row.state === "sending" && options.force !== true) {
        let active = true;
        try { process.kill(Number(row.owner), 0); } catch (error) { active = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (active) throw new OutboxError("in_flight", "Verify that no sender is active; only then use force reconciliation for a reused process id (duplicates are possible).");
      }
      // A grouped HTTP attempt has one outcome: reconcile every member together.
      const group = this.db.prepare("SELECT notification FROM delivery_group WHERE key=?").get(key);
      const keys = group ? this.db.prepare("SELECT key FROM delivery_group WHERE notification=?").all(group.notification!).map((member) => String(member.key)) : [key];
      for (const member of keys) this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(decision === "retry" ? "pending" : decision === "skip" ? "skipped" : decision, member);
      for (const member of keys) this.db.prepare("DELETE FROM delivery_group WHERE key=?").run(member);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
