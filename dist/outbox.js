import { createRequire } from "node:module";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
/** Expected failure with a safe message, machine-readable code, and concrete remedy. */
export class OutboxError extends Error {
    /** Host extension runtime's expected-error status. */
    exitCode = 2;
    /** Stable machine-readable refusal category. */
    code;
    /** Safe recovery action for callers and agents. */
    remedy;
    /** Host-compatible structured recovery field, identical to remedy. */
    remediation;
    /** Public expected-error shape consumed by the host's JSON refusal renderer. */
    context;
    /** Create a refusal without including payloads, credentials, or filesystem paths. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`);
        this.name = "PmCliError";
        this.code = code;
        this.remedy = remedy;
        this.remediation = remedy;
        this.context = { code, required: remedy, nextSteps: [remedy] };
    }
}
const lifecycleEvents = ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"];
/** Derive the stable receipt primary key from one committed lifecycle transition. */
function receiptKey(item, event, revision) {
    return createHash("sha256").update(JSON.stringify([item, event, revision])).digest("hex");
}
/** Hash a destination without persisting a webhook credential. */
export function slackDestination(webhook, channel) {
    return createHash("sha256").update(JSON.stringify([webhook, channel ?? null])).digest("hex");
}
/** Validate the shared SDK and CLI bound before reading or claiming work. */
function limitValue(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new OutboxError("invalid_input", "Use a limit from 1 to 100.");
    }
    return limit;
}
/** Load the synchronous SQLite API native to Node or Bun through their common statement surface. */
function openDatabase(file) {
    const [module, constructor] = [["node:sqlite", "DatabaseSync"], ["bun:sqlite", "Database"]][Number(Boolean(process.versions.bun))];
    const sqlite = createRequire(import.meta.url)(module);
    return new sqlite[constructor](file);
}
/** Validate eligibility before enabling storage or recording a future-only policy. */
function recoveryFilterValue(filter) {
    if (!Number.isInteger(filter.minPriority) || filter.minPriority < 1 || filter.minPriority > 4 || !filter.events.every((event) => lifecycleEvents.includes(event))) {
        throw new OutboxError("invalid_input", "Use canonical lifecycle events and a recovery priority from 1 to 4.");
    }
}
/** Local SQLite outbox using full synchronous commits and atomic cross-process claims. */
export class SlackOutbox {
    db;
    /** Open runtime storage in an initialized local tracker, without invoking git. */
    constructor(pmRoot) {
        let database;
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
        }
        catch {
            database?.close();
            throw new OutboxError("storage_unavailable", "Restore writable local runtime storage; committed items are unchanged. Then drain again.");
        }
    }
    /** Release the database handle; committed receipts survive process exit. */
    close() { this.db.close(); }
    /** Opt in once and optionally snapshot eligibility; legacy policy adoption starts with future history. */
    enable(filter) {
        if (filter)
            recoveryFilterValue(filter);
        const previous = this.since();
        this.db.prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)").run(new Date().toISOString());
        const since = this.since();
        if (filter)
            this.saveRecoveryPolicy(filter, previous === null ? since : new Date().toISOString(), true);
        return since;
    }
    /** Record an explicit future-only filter change; retained history keeps its earlier eligibility. */
    configureRecovery(filter) {
        if (!this.since())
            throw new OutboxError("disabled", "Enable the outbox before configuring recovery.");
        this.saveRecoveryPolicy(filter, new Date().toISOString(), false);
    }
    /** Read eligibility epochs newest first; unsnapshotted SDK trackers must opt in explicitly. */
    recoveryPolicies() {
        const rows = this.db.prepare("SELECT since,events,min_priority FROM recovery_policy ORDER BY rowid DESC").all();
        if (!rows.length)
            throw new OutboxError("history_unavailable", "Configure recovery filters before future lifecycle changes; existing queued receipts can still drain.");
        return rows.map((row) => ({ since: String(row.since), events: JSON.parse(String(row.events)), minPriority: Number(row.min_priority) }));
    }
    /** Resolve one entry's policy by its timestamp, including configurations committed during a recovery scan. */
    recoveryPolicyAt(timestamp) {
        const row = this.db.prepare("SELECT since,events,min_priority FROM recovery_policy WHERE since<=? ORDER BY since DESC,rowid DESC LIMIT 1").get(timestamp);
        return row ? { since: String(row.since), events: JSON.parse(String(row.events)), minPriority: Number(row.min_priority) } : undefined;
    }
    /** Persist a validated policy without storing routing credentials or replacing previous epochs. */
    saveRecoveryPolicy(filter, since, onlyIfEmpty) {
        recoveryFilterValue(filter);
        this.db.prepare("INSERT INTO recovery_policy SELECT ?,?,? WHERE ?=0 OR NOT EXISTS (SELECT 1 FROM recovery_policy)")
            .run(since, JSON.stringify(filter.events), filter.minPriority, Number(onlyIfEmpty));
    }
    /** Return the durable opt-in boundary without reading message bodies. */
    since() {
        const row = this.db.prepare("SELECT since FROM settings WHERE id=1").get();
        return row ? String(row.since) : null;
    }
    /** Persist an intent once; conflicting reuse refuses instead of silently changing a message. */
    enqueue(intent) {
        if (!this.since())
            throw new OutboxError("disabled", "Run pm slack outbox --action enable before lifecycle changes.");
        if (![intent.item, intent.event, intent.revision, intent.destination, intent.payload.text].every((value) => typeof value === "string" && value.length > 0) || !lifecycleEvents.includes(intent.event)) {
            throw new OutboxError("invalid_input", "Provide an item, event, immutable revision, destination and message text.");
        }
        const key = receiptKey(intent.item, intent.event, intent.revision);
        const payload = JSON.stringify(intent.payload);
        this.db.prepare("INSERT OR IGNORE INTO delivery(key,item,event,revision,destination,payload) VALUES (?,?,?,?,?,?)")
            .run(key, intent.item, intent.event, intent.revision, intent.destination, payload);
        const row = this.db.prepare("SELECT destination,payload FROM delivery WHERE key=?").get(key);
        if (row.destination !== intent.destination || row.payload !== payload) {
            throw new OutboxError("conflict", "Keep the original intent and configuration; inspect the existing receipt before changing routing or message formatting.");
        }
        return key;
    }
    /** Check whether a verified history transition already has a durable intent. */
    has(item, event, revision) {
        return !!this.db.prepare("SELECT 1 FROM delivery WHERE key=?").get(receiptKey(item, event, revision));
    }
    /** Inspect a bounded receipt page while preserving exact totals and omission evidence. */
    status(limit = 20, after = 0) {
        limitValue(limit);
        if (!Number.isSafeInteger(after) || after < 0)
            throw new OutboxError("invalid_input", "Use a nonnegative integer status cursor.");
        const counts = { pending: 0, sending: 0, acknowledged: 0, ambiguous: 0, rejected: 0, refused: 0, skipped: 0 };
        for (const row of this.db.prepare("SELECT state,COUNT(*) AS n FROM delivery GROUP BY state").all())
            counts[row.state] = Number(row.n);
        const page = this.db.prepare("SELECT rowid AS sequence,key,item,event,state,attempts FROM delivery WHERE rowid>? ORDER BY rowid LIMIT ?").all(after, limit + 1);
        const rows = page.slice(0, limit);
        return { enabled_since: this.since(), counts, rows, omitted: Object.values(counts).reduce((sum, n) => sum + n, 0) - rows.length,
            next_cursor: page.length > limit ? rows[rows.length - 1].sequence : null };
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
    async drain(send, limit = 20) {
        limitValue(limit);
        if (!this.since())
            throw new OutboxError("disabled", "Run pm slack outbox --action enable first.");
        const candidates = this.db.prepare("SELECT key,destination FROM delivery WHERE state='pending' ORDER BY attempts, rowid LIMIT ?").all(limit);
        const uncertain = new Set();
        for (const candidate of candidates) {
            if (uncertain.has(String(candidate.destination)))
                continue;
            const row = this.db.prepare("UPDATE delivery SET state='sending',owner=?,attempts=attempts+1 WHERE key=? AND state='pending' RETURNING destination,payload").get(process.pid, candidate.key);
            if (!row)
                continue;
            let state;
            try {
                const outcome = await send(String(row.destination), JSON.parse(String(row.payload)));
                state = outcome === "retry" ? "pending" : outcome;
            }
            catch (error) {
                if (error instanceof OutboxError) {
                    const refused = error.code === "destination_changed";
                    this.db.prepare("UPDATE delivery SET state=?,owner=0,attempts=attempts-1 WHERE key=?").run(refused ? "refused" : "pending", candidate.key);
                    if (refused)
                        continue;
                    throw error;
                }
                state = "ambiguous";
            }
            this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(state, candidate.key);
            if (state === "ambiguous")
                uncertain.add(String(candidate.destination));
            if (state === "pending")
                break;
        }
        return this.status(limit);
    }
    /** Reconcile uncertainty or refusal; force overrides PID reuse only after an operator verifies sender absence. */
    resolve(key, decision, options = {}) {
        if (decision !== "acknowledged" && decision !== "retry" && decision !== "skip")
            throw new OutboxError("invalid_input", "Choose acknowledged, retry after verifying absence, or skip to discard without claiming delivery.");
        // One transaction fences concurrent reconciliation and claims across processes.
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.db.prepare("SELECT state,owner FROM delivery WHERE key=?").get(key);
            if (!row)
                throw new OutboxError("not_found", "Inspect status and use an existing receipt key.");
            if (row.state !== "sending" && row.state !== "ambiguous" && row.state !== "rejected" && row.state !== "refused")
                throw new OutboxError("not_ambiguous", "Only reconcile sending, ambiguous, rejected, or refused receipts.");
            if (row.state === "sending" && options.force !== true) {
                let active = true;
                try {
                    process.kill(Number(row.owner), 0);
                }
                catch (error) {
                    active = error.code !== "ESRCH";
                }
                if (active)
                    throw new OutboxError("in_flight", "Verify that no sender is active; only then use force reconciliation for a reused process id (duplicates are possible).");
            }
            this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(decision === "retry" ? "pending" : decision === "skip" ? "skipped" : decision, key);
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
}
//# sourceMappingURL=outbox.js.map