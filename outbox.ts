/** Durable, local Slack delivery receipts. Payloads and webhook credentials never appear in inspection output. */
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
export type OutboxState = "pending" | "sending" | "acknowledged" | "ambiguous" | "rejected";

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

/** HTTP transport outcome; only an explicit remote acknowledgment permits ack. */
export type OutboxOutcome = "acknowledged" | "retry" | "ambiguous" | "rejected";

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
        CREATE INDEX IF NOT EXISTS delivery_pending ON delivery(state);`);
    } catch {
      database?.close();
      throw new OutboxError("storage_unavailable", "Restore writable local runtime storage; committed items are unchanged. Then drain again.");
    }
  }

  /** Release the database handle; committed receipts survive process exit. */
  close(): void { this.db.close(); }

  /** Opt in once; repeated enable calls preserve the original recovery boundary. */
  enable(): string {
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)").run(new Date().toISOString());
    return this.since() as string;
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
    const key = createHash("sha256").update(JSON.stringify([intent.item, intent.event, intent.revision])).digest("hex");
    const payload = JSON.stringify(intent.payload);
    this.db.prepare("INSERT OR IGNORE INTO delivery(key,item,event,revision,destination,payload) VALUES (?,?,?,?,?,?)")
      .run(key, intent.item, intent.event, intent.revision, intent.destination, payload);
    const row = this.db.prepare("SELECT destination,payload FROM delivery WHERE key=?").get(key)!;
    if (row.destination !== intent.destination || row.payload !== payload) {
      throw new OutboxError("conflict", "Keep the original intent and configuration; inspect the existing receipt before changing routing or message formatting.");
    }
    return key;
  }

  /** Check whether a verified history transition already has a durable intent. */
  has(item: string, event: OutboxEvent, revision: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM delivery WHERE item=? AND event=? AND revision=?").get(item, event, revision);
  }

  /** Inspect a bounded receipt page while preserving exact totals and omission evidence. */
  status(limit = 20, after = 0): OutboxReport {
    limitValue(limit);
    if (!Number.isSafeInteger(after) || after < 0) throw new OutboxError("invalid_input", "Use a nonnegative integer status cursor.");
    const counts: Record<OutboxState, number> = { pending: 0, sending: 0, acknowledged: 0, ambiguous: 0, rejected: 0 };
    for (const row of this.db.prepare("SELECT state,COUNT(*) AS n FROM delivery GROUP BY state").all()) counts[row.state as OutboxState] = Number(row.n);
    const page = this.db.prepare("SELECT rowid AS sequence,key,item,event,state,attempts FROM delivery WHERE rowid>? ORDER BY rowid LIMIT ?").all(after, limit + 1) as unknown as OutboxReceipt[];
    const rows = page.slice(0, limit);
    return { enabled_since: this.since(), counts, rows, omitted: Object.values(counts).reduce((sum, n) => sum + n, 0) - rows.length,
      next_cursor: page.length > limit ? rows[rows.length - 1]!.sequence : null };
  }

  /** Claim pending rows once; typed OutboxError refusals must occur before a remote request starts. */
  async drain(send: (destination: string, payload: OutboxPayload) => Promise<OutboxOutcome>, limit = 20): Promise<OutboxReport> {
    limitValue(limit);
    if (!this.since()) throw new OutboxError("disabled", "Run pm slack outbox --action enable first.");
    const candidates = this.db.prepare("SELECT key FROM delivery WHERE state='pending' ORDER BY rowid LIMIT ?").all(limit);
    for (const candidate of candidates) {
      const row = this.db.prepare("UPDATE delivery SET state='sending',owner=?,attempts=attempts+1 WHERE key=? AND state='pending' RETURNING destination,payload").get(process.pid, candidate.key!);
      if (!row) continue;
      let state: OutboxState;
      try {
        const outcome = await send(String(row.destination), JSON.parse(String(row.payload)) as OutboxPayload);
        state = outcome === "retry" ? "pending" : outcome;
      } catch (error) {
        if (error instanceof OutboxError) {
          this.db.prepare("UPDATE delivery SET state='pending',owner=0,attempts=attempts-1 WHERE key=?").run(candidate.key!);
          throw error;
        }
        state = "ambiguous";
      }
      this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(state, candidate.key!);
    }
    return this.status(limit);
  }

  /** Reconcile uncertain remote outcomes explicitly; active senders cannot be reset. */
  resolve(key: string, decision: "acknowledged" | "retry"): void {
    if (decision !== "acknowledged" && decision !== "retry") throw new OutboxError("invalid_input", "Choose acknowledged after verifying delivery, or retry after verifying absence (duplicates are possible).");
    // One transaction fences concurrent reconciliation and claims across processes.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state,owner FROM delivery WHERE key=?").get(key);
      if (!row) throw new OutboxError("not_found", "Inspect status and use an existing receipt key.");
      if (row.state !== "sending" && row.state !== "ambiguous" && row.state !== "rejected") throw new OutboxError("not_ambiguous", "Only reconcile sending, ambiguous, or rejected receipts.");
      if (row.state === "sending") {
        let active = true;
        try { process.kill(Number(row.owner), 0); } catch (error) { active = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (active) throw new OutboxError("in_flight", "Wait for the sending process to exit before reconciling; a live or reused process id is held conservatively.");
      }
      this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(decision === "retry" ? "pending" : decision, key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
