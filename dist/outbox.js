/** Durable, local Slack delivery receipts. Payloads and webhook credentials never appear in inspection output. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { planSlackCoalescing } from "./coalescing.js";
import { deriveSlackDeliveryOutcome, readDeliveryEvidenceRows, isInspectableDeliveryEvidenceRow } from "./delivery-evidence.js";
import { parseDestinationMigrationInput, runDestinationMigration, isOriginalMigrationIntent } from "./destination-migration.js";
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
/** Propagate proof through wrappers that call the package transport without forwarding its context. */
const sendContext = new AsyncLocalStorage();
/** Read this asynchronous attempt's context without exposing or sharing it with another sender. */
export function currentOutboxSendContext() { return sendContext.getStore(); }
/** Derive the stable receipt primary key from one committed lifecycle transition. */
function receiptKey(item, event, revision) {
    return createHash("sha256").update(JSON.stringify([item, event, revision])).digest("hex");
}
/** Hash a destination without persisting a webhook credential. */
export function slackDestination(webhook, channel) {
    return createHash("sha256").update(JSON.stringify([webhook, channel ?? null])).digest("hex");
}
/** Check the complete intent without writing, so recovery can refuse an entire bad item before publishing any of its transitions. */
export function validateOutboxIntent(intent) {
    if (![intent.item, intent.event, intent.revision, intent.destination, intent.payload.text].every((value) => typeof value === "string" && value.length > 0) || !lifecycleEvents.includes(intent.event)) {
        throw new OutboxError("invalid_input", "Provide an item, event, immutable revision, destination and message text.");
    }
    if ((intent.at !== undefined && (!Number.isSafeInteger(intent.at) || intent.at < 0)) || (intent.priority !== undefined && (!Number.isInteger(intent.priority) || intent.priority < 0 || intent.priority > 4))) {
        throw new OutboxError("invalid_input", "Use a nonnegative integer timestamp and priority from 0 to 4.");
    }
}
/** Validate the shared SDK and CLI bound before reading or claiming work. */
function limitValue(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new OutboxError("invalid_input", "Use a limit from 1 to 100.");
    }
    return limit;
}
/** Load the synchronous SQLite API native to Node or Bun through their common statement surface. */
function openDatabase(file, readOnly = false) {
    const [module, constructor] = [["node:sqlite", "DatabaseSync"], ["bun:sqlite", "Database"]][Number(Boolean(process.versions.bun))];
    const sqlite = createRequire(import.meta.url)(module);
    const options = [{ readOnly: true }, { readonly: true }][Number(Boolean(process.versions.bun))];
    return readOnly ? new sqlite[constructor](file, options) : new sqlite[constructor](file);
}
/** Preview or commit a route transition in existing outbox storage; previews open SQLite read-only and never recover or send. */
export function migrateSlackDestinations(pmRoot, input) {
    const parsed = parseDestinationMigrationInput(input);
    const file = join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
    if (!existsSync(file))
        throw new OutboxError("disabled", "Enable the outbox before binding or migrating destinations.");
    let db;
    try {
        db = openDatabase(file, parsed.action === "preview" || parsed.action === "bindings");
    }
    catch {
        throw new OutboxError("storage_unavailable", "Restore readable owned outbox storage and retry the reviewed operation; no notification was posted.");
    }
    let result;
    try {
        result = runDestinationMigration(db, parsed);
    }
    catch (error) {
        if (error instanceof OutboxError)
            throw error;
        throw new OutboxError("storage_unavailable", "Restore readable owned outbox storage and retry the reviewed operation; no notification was posted.");
    }
    finally {
        db.close();
    }
    return result;
}
/** Validate eligibility before enabling storage or recording a future-only policy. */
function recoveryFilterValue(filter) {
    if (!Number.isInteger(filter.minPriority) || filter.minPriority < 1 || filter.minPriority > 4 || !filter.events.every((event) => lifecycleEvents.includes(event))) {
        throw new OutboxError("invalid_input", "Use canonical lifecycle events and a recovery priority from 1 to 4.");
    }
}
/** Inspect one exact revision in a read transaction without creating storage or changing permissions. */
export function readSlackRoutingEvidence(pmRoot, item, event, revision, at) {
    const file = join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
    if (!existsSync(file))
        return { since: null };
    let db;
    try {
        db = openDatabase(file, true);
    }
    catch {
        throw new OutboxError("storage_unavailable", "Restore readable owned outbox evidence; no receipt or tracker state was changed.");
    }
    try {
        try {
            db.exec("PRAGMA busy_timeout=5000; BEGIN");
            const since = db.prepare("SELECT since FROM settings WHERE id=1").get();
            const policy = db.prepare("SELECT events,CAST(min_priority AS TEXT) AS min_priority FROM recovery_policy WHERE since<=? ORDER BY since DESC,rowid DESC LIMIT 1").get(at);
            const journaled = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('delivery_proof','delivery_attempt','delivery_resolution')").get().n) === 3;
            const receipt = readDeliveryEvidenceRows(db, receiptKey(item, event, revision), journaled)[0];
            const result = { since: since ? String(since.since) : null };
            if (policy) {
                let parsed;
                try {
                    parsed = JSON.parse(String(policy.events));
                }
                catch {
                    parsed = null;
                }
                const filter = { events: parsed, minPriority: Number(policy.min_priority) };
                if (Array.isArray(filter.events) && filter.events.length <= 8 && filter.events.every((event) => lifecycleEvents.includes(event)) && Number.isInteger(filter.minPriority) && filter.minPriority >= 1 && filter.minPriority <= 4)
                    result.policy = filter;
                else
                    result.foreign = true;
            }
            if (receipt) {
                const state = String(receipt.state);
                const attempts = Number(receipt.attempts);
                const disposition = receipt.disposition === null ? null : String(receipt.disposition);
                if (receipt.item !== item || receipt.event !== event || receipt.revision !== revision || !isInspectableDeliveryEvidenceRow(receipt) || (disposition !== null && !["bypass", "coalesced", "deferred", "waiting"].includes(disposition))) {
                    result.foreign = true;
                }
                else
                    result.receipt = { state, attempts, disposition, evidence: receipt.evidence };
            }
            db.exec("COMMIT");
            return result;
        }
        finally {
            db.close();
        }
    }
    catch {
        throw new OutboxError("storage_unavailable", "Restore readable owned outbox evidence; no receipt or tracker state was changed.");
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
            this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_context (key TEXT PRIMARY KEY, at INTEGER NOT NULL, priority INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS coalescing_receipt (key TEXT PRIMARY KEY, disposition TEXT NOT NULL, notification TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery_group (key TEXT PRIMARY KEY, notification TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery_proof (key TEXT PRIMARY KEY, legacy_unknown INTEGER NOT NULL, claims INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS delivery_attempt (key TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(key,token));
        CREATE TABLE IF NOT EXISTS delivery_resolution (sequence INTEGER PRIMARY KEY, key TEXT NOT NULL, decision TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS delivery_attempt_token ON delivery_attempt(token);
        CREATE INDEX IF NOT EXISTS delivery_resolution_key ON delivery_resolution(key);
        INSERT OR IGNORE INTO delivery_proof(key,legacy_unknown) SELECT key,CASE WHEN attempts>0 OR state IN ('sending','ambiguous','acknowledged') THEN 1 ELSE 0 END FROM delivery;`);
            this.transaction(() => {
                this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_attempt_start (key TEXT NOT NULL,token TEXT NOT NULL,owner INTEGER NOT NULL,PRIMARY KEY(key,token));
          CREATE TABLE IF NOT EXISTS delivery_request_dispatched (key TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(key,token));
          CREATE TABLE IF NOT EXISTS delivery_attempt_terminal (key TEXT NOT NULL,token TEXT NOT NULL,result TEXT NOT NULL CHECK(result IN ('confirmed','not_sent','rejected','unknown_after_send')),PRIMARY KEY(key,token));
          CREATE INDEX IF NOT EXISTS delivery_start_token ON delivery_attempt_start(token);
          INSERT OR IGNORE INTO delivery_attempt_start SELECT key,token,0 FROM delivery_attempt;
          INSERT OR IGNORE INTO delivery_request_dispatched SELECT key,token FROM delivery_attempt WHERE result!='not_sent';
          INSERT OR IGNORE INTO delivery_attempt_terminal SELECT key,token,CASE result WHEN 'acknowledged' THEN 'confirmed' WHEN 'not_sent' THEN 'not_sent' WHEN 'rejected' THEN 'rejected' WHEN 'retry' THEN 'rejected' ELSE 'unknown_after_send' END FROM delivery_attempt WHERE result!='started';`);
            });
            this.recoverAttempts();
        }
        catch {
            database?.close();
            throw new OutboxError("storage_unavailable", "Restore writable local runtime storage; committed items are unchanged. Then drain again.");
        }
    }
    /** Release the database handle; committed receipts survive process exit. */
    close() { this.db.close(); }
    /** Atomically opt in with initial eligibility; legacy policy adoption starts with future history. */
    enable(filter) {
        if (filter)
            recoveryFilterValue(filter);
        try {
            this.db.exec("BEGIN IMMEDIATE");
            const previous = this.since();
            this.db.prepare("INSERT OR IGNORE INTO settings VALUES (1, ?)").run(new Date().toISOString());
            const since = this.since();
            if (filter)
                this.saveRecoveryPolicy(filter, previous === null ? since : new Date().toISOString(), true);
            this.db.exec("COMMIT");
            return since;
        }
        catch {
            // SQLite may already have rolled back (or refused BEGIN); keep the typed remedy.
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* No transaction may remain to roll back. */ }
            throw new OutboxError("storage_unavailable", "Restore writable local runtime storage and enable again; opt-in and eligibility were not changed.");
        }
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
        validateOutboxIntent(intent);
        const key = receiptKey(intent.item, intent.event, intent.revision);
        const payload = JSON.stringify(intent.payload);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("INSERT OR IGNORE INTO delivery(key,item,event,revision,destination,payload) VALUES (?,?,?,?,?,?)")
                .run(key, intent.item, intent.event, intent.revision, intent.destination, payload);
            const row = this.db.prepare("SELECT destination,payload FROM delivery WHERE key=?").get(key);
            if ((row.destination !== intent.destination || row.payload !== payload) && !isOriginalMigrationIntent(this.db, key, intent.destination, payload)) {
                throw new OutboxError("conflict", "Keep the original intent and configuration; inspect the existing receipt before changing routing or message formatting.");
            }
            this.db.prepare("INSERT OR IGNORE INTO delivery_context VALUES (?,?,?)").run(key, intent.at ?? 0, intent.priority ?? 4);
            this.db.exec("COMMIT");
            return key;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    /** Read a deterministic plan over pending intents; no payload or webhook is returned. */
    planCoalescing(options = {}) {
        if (!this.since())
            throw new OutboxError("disabled", "Run pm slack outbox --action enable before coalescing.");
        const rows = this.db.prepare(`SELECT d.key,d.item,d.event,d.revision,d.destination,COALESCE(c.at,0) AS at,COALESCE(c.priority,4) AS priority
      FROM delivery d LEFT JOIN delivery_context c ON c.key=d.key WHERE d.state='pending' LIMIT 10001`).all();
        return planSlackCoalescing(rows, options);
    }
    /** Page a preview or durable evidence manifest without exposing frozen payloads or destinations. */
    coalescingReport(plan, limit = 20, after = 0, durable = false) {
        limitValue(limit);
        if (!Number.isSafeInteger(after) || after < 0)
            throw new OutboxError("invalid_input", "Use a nonnegative integer coalescing cursor.");
        const observed = readDeliveryEvidenceRows(this.db);
        const evidenceRows = observed.filter(isInspectableDeliveryEvidenceRow);
        let foreignSkipped = observed.length - evidenceRows.length;
        const observedKeys = new Set(observed.map((row) => row.key));
        const byKey = new Map(evidenceRows.map((row) => [row.key, row]));
        const manifest = durable ? evidenceRows.filter((row) => row.disposition !== null).sort((a, b) => a.key.localeCompare(b.key)).map((row) => ({ key: row.key, item: row.item, event: row.event, revision: row.revision, disposition: row.disposition, notification: row.notification })) : plan.receipts;
        const outcomes = { delivered: 0, withheld: 0, uncertain: 0 };
        const all = manifest.flatMap((row) => {
            const proof = byKey.get(row.key);
            if (!proof) {
                if (!observedKeys.has(row.key))
                    foreignSkipped += 1;
                return [];
            }
            const outcome = deriveSlackDeliveryOutcome(proof.evidence);
            outcomes[outcome] += 1;
            return [{ ...row, state: proof.state, outcome }];
        });
        return { summary: { events: plan.events, urgent: plan.urgent, coalesced: plan.coalesced, deferred: plan.deferred, waiting: plan.waiting, notifications: plan.notifications.length }, outcomes, ...(foreignSkipped ? { foreign_skipped: foreignSkipped } : {}), rows: all.slice(after, after + limit),
            omitted: all.length - all.slice(after, after + limit).length, next_cursor: after + limit < all.length ? after + limit : null };
    }
    /**
       * Send urgent originals first and bounded routine summaries after closed windows.
       * Claims fence concurrent plain and coalesced drains. Every original keeps its
       * state and attempt count; crashes leave all claimed members visibly sending.
       */
    async drainCoalesced(send, options = {}) {
        const plan = this.planCoalescing(options);
        for (const receipt of plan.receipts) {
            this.db.prepare("INSERT OR IGNORE INTO coalescing_receipt VALUES (?,?,?)").run(receipt.key, receipt.disposition, receipt.notification);
        }
        const uncertain = new Set();
        for (const notification of plan.notifications) {
            if (uncertain.has(notification.destination))
                continue;
            const claim = this.claim(notification.keys, notification);
            if (!claim)
                continue;
            const { state, refusal } = await this.sendAttempt(claim.token, send, notification.destination, () => {
                const original = JSON.parse(String(claim.members[0].payload));
                return notification.urgent ? original : { text: notification.text, mrkdwn: false, ...(original.channel === undefined ? {} : { channel: original.channel }) };
            });
            if (refusal && (refusal.code !== "destination_changed" || state !== "refused"))
                throw refusal;
            if (state === "ambiguous")
                uncertain.add(notification.destination);
            if (state === "pending")
                break;
        }
        return plan;
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
        const outcomes = { delivered: 0, withheld: 0, uncertain: 0 };
        const observed = readDeliveryEvidenceRows(this.db);
        const evidenceRows = observed.filter(isInspectableDeliveryEvidenceRow);
        const foreignSkipped = observed.length - evidenceRows.length;
        const receipts = evidenceRows.map((row) => {
            const outcome = deriveSlackDeliveryOutcome(row.evidence);
            counts[row.state] += 1;
            outcomes[outcome] += 1;
            return { sequence: row.sequence, key: row.key, item: row.item, event: row.event, state: row.state, attempts: row.attempts, outcome };
        });
        const page = receipts.filter((row) => row.sequence > after).slice(0, limit + 1);
        const rows = page.slice(0, limit);
        return { enabled_since: this.since(), counts, outcomes, ...(foreignSkipped ? { foreign_skipped: foreignSkipped } : {}), rows, omitted: receipts.length - rows.length,
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
        const candidates = this.db.prepare("SELECT key,destination FROM delivery WHERE state='pending' ORDER BY (SELECT COUNT(*) FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=delivery.key AND COALESCE(t.result,'open')!='not_sent'), rowid LIMIT ?").all(limit);
        const uncertain = new Set();
        for (const candidate of candidates) {
            if (uncertain.has(String(candidate.destination)))
                continue;
            const claim = this.claim([String(candidate.key)]);
            if (!claim)
                continue;
            const row = claim.members[0];
            const { state, refusal } = await this.sendAttempt(claim.token, send, row.destination, () => JSON.parse(row.payload));
            if (refusal) {
                if (refusal.code === "destination_changed" && state === "refused")
                    continue;
                throw refusal;
            }
            if (state === "ambiguous")
                uncertain.add(String(candidate.destination));
            if (state === "pending")
                break;
        }
        return this.status(limit);
    }
    /** Run receipt mutations under SQLite's cross-process writer fence, rolling back every partial transition. */
    transaction(action) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = action();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* SQLite can roll back a failed transaction itself. */ }
            throw error;
        }
    }
    /** Claim the complete membership and persist a fresh attempt token before any remote request. */
    claim(keys, notification) {
        const token = randomUUID();
        try {
            return this.transaction(() => {
                const placeholders = keys.map(() => "?").join(",");
                const members = this.db.prepare(`SELECT key,payload,destination FROM delivery WHERE state='pending' AND key IN (${placeholders})`).all(...keys);
                if (members.length !== keys.length)
                    return undefined;
                if (notification && members.some((member) => member.destination !== notification.destination))
                    return undefined;
                // Planner notification keys are stable across retries. Attempt tokens must never be reused.
                for (const key of keys) {
                    this.db.prepare("INSERT OR IGNORE INTO delivery_proof(key,legacy_unknown) SELECT key,CASE WHEN attempts>0 THEN 1 ELSE 0 END FROM delivery WHERE key=?").run(key);
                    this.db.prepare("INSERT INTO delivery_attempt_start VALUES (?,?,?)").run(key, token, process.pid);
                    this.db.prepare("UPDATE delivery SET state='sending',owner=? WHERE key=?").run(process.pid, key);
                    if (notification)
                        this.db.prepare("INSERT OR REPLACE INTO coalescing_receipt VALUES (?,?,?)").run(key, notification.urgent ? "bypass" : "coalesced", notification.key);
                    this.db.prepare("INSERT OR REPLACE INTO delivery_group VALUES (?,?)").run(key, token);
                }
                return { token, members };
            });
        }
        catch {
            this.recordTerminal(token, "ambiguous");
            throw new OutboxError("storage_unavailable", "Restore writable receipt storage, then drain again; the failed group was not sent.");
        }
    }
    /** Record dispatch intent durably before a transport can enter the network API. */
    dispatch(token) {
        this.db.prepare("INSERT OR IGNORE INTO delivery_request_dispatched SELECT key,token FROM delivery_attempt_start WHERE token=? AND NOT EXISTS (SELECT 1 FROM delivery_attempt_terminal t WHERE t.key=delivery_attempt_start.key AND t.token=delivery_attempt_start.token)").run(token);
    }
    /** Always close a cleanly exiting sender, including retired senders and thrown transport errors. */
    async sendAttempt(token, send, destination, payload) {
        let state = "ambiguous";
        let refusal;
        let confirmed = false;
        const context = {
            requestDispatched: () => this.dispatch(token),
            responseConfirmed: () => { confirmed = true; this.recordTerminal(token, "acknowledged"); },
        };
        try {
            const body = payload();
            // Legacy external transports cannot signal dispatch; their invocation remains conservative.
            if (send.length < 3)
                context.requestDispatched();
            const outcome = await sendContext.run(context, () => send(destination, body, context));
            state = confirmed ? "acknowledged" : outcome === "retry" ? "pending" : outcome;
        }
        catch (error) {
            if (error instanceof OutboxError)
                refusal = error;
            const dispatched = !!this.db.prepare("SELECT 1 FROM delivery_request_dispatched WHERE token=?").get(token);
            state = confirmed ? "acknowledged" : dispatched ? "ambiguous" : refusal ? refusal.code === "destination_changed" ? "refused" : "pending" : "ambiguous";
        }
        finally {
            try {
                this.finish(token, state);
            }
            catch (error) {
                this.recordTerminal(token, state);
                throw error;
            }
        }
        return { state, ...(refusal ? { refusal } : {}) };
    }
    /** Recover only dead owners; a live retired sender retains the right to record its actual result. */
    recoverAttempts() {
        this.transaction(() => {
            const owners = this.db.prepare("SELECT DISTINCT s.owner FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE t.token IS NULL").all();
            for (const row of owners) {
                let alive = Number(row.owner) > 0;
                if (alive) {
                    try {
                        process.kill(Number(row.owner), 0);
                    }
                    catch (error) {
                        alive = error.code !== "ESRCH";
                    }
                }
                if (!alive)
                    this.db.prepare("INSERT OR IGNORE INTO delivery_attempt_terminal SELECT s.key,s.token,CASE WHEN x.token IS NULL THEN 'not_sent' ELSE 'unknown_after_send' END FROM delivery_attempt_start s LEFT JOIN delivery_request_dispatched x ON x.key=s.key AND x.token=s.token WHERE s.owner=?").run(row.owner);
            }
        });
    }
    /** Append exactly one terminal fact; repeated cleanup cannot replace an earlier fact. */
    recordTerminal(token, state) {
        this.db.prepare(`INSERT OR IGNORE INTO delivery_attempt_terminal SELECT s.key,s.token,
      CASE WHEN ?='acknowledged' THEN 'confirmed' WHEN x.token IS NULL THEN 'not_sent'
      WHEN ? IN ('pending','rejected') THEN 'rejected' ELSE 'unknown_after_send' END
      FROM delivery_attempt_start s LEFT JOIN delivery_request_dispatched x ON x.key=s.key AND x.token=s.token WHERE s.token=?`).run(state, state, token);
    }
    /** Close the immutable record pair before touching scheduling state, even after a peer retires the claim. */
    finish(token, state) {
        this.recordTerminal(token, state);
        this.transaction(() => {
            const keys = this.db.prepare("SELECT key FROM delivery_group WHERE notification=?").all(token).map((member) => String(member.key));
            if (!keys.length)
                return;
            if (state === "pending")
                this.db.prepare("DELETE FROM delivery_group WHERE notification=?").run(token);
            const placeholders = keys.map(() => "?").join(",");
            this.db.prepare(`UPDATE delivery SET state=?,owner=0 WHERE state='sending' AND key IN (${placeholders})`).run(state, ...keys);
        });
    }
    /** Reconcile uncertainty or refusal; force overrides PID reuse only after an operator verifies sender absence. */
    resolve(key, decision, options = {}) {
        if (decision !== "acknowledged" && decision !== "retry" && decision !== "skip" && decision !== "abandon")
            throw new OutboxError("invalid_input", "Choose acknowledged, retry after verifying absence, skip, or abandon; operator decisions do not prove delivery.");
        // One transaction fences concurrent reconciliation and claims across processes.
        this.transaction(() => {
            const row = this.db.prepare("SELECT state,owner FROM delivery WHERE key=?").get(key);
            if (!row)
                throw new OutboxError("not_found", "Inspect status and use an existing receipt key.");
            if (row.state !== "sending" && row.state !== "ambiguous" && row.state !== "rejected" && row.state !== "refused" && !(row.state === "pending" && (decision === "skip" || decision === "abandon")) && !(row.state === "skipped" && decision === "retry"))
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
            // A grouped HTTP attempt has one outcome: reconcile every member together.
            const group = this.db.prepare("SELECT notification FROM delivery_group WHERE key=?").get(key);
            const keys = group ? this.db.prepare("SELECT key FROM delivery_group WHERE notification=?").all(group.notification).map((member) => String(member.key)) : [key];
            for (const member of keys)
                this.db.prepare("INSERT INTO delivery_resolution(key,decision) VALUES (?,?)").run(member, decision);
            if (group)
                this.db.prepare("DELETE FROM delivery_group WHERE notification=?").run(group.notification);
            // Releasing members is the final mutation; peers see the complete transition at COMMIT.
            for (const member of keys)
                this.db.prepare("UPDATE delivery SET state=?,owner=0 WHERE key=?").run(decision === "retry" ? "pending" : decision === "skip" || decision === "abandon" ? "skipped" : decision, member);
        });
    }
}
//# sourceMappingURL=outbox.js.map