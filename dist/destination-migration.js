/** Reviewed route transitions share the durable outbox's SQLite writer fence and immutable event identities. */
import { createHash } from "node:crypto";
import { OutboxError, validateOutboxIntent } from "./outbox.js";
import { readDeliveryEvidenceRows, isInspectableDeliveryEvidenceRow, deriveSlackDeliveryOutcome } from "./delivery-evidence.js";
const aliasPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maximumEvents = 10000;
const maximumBindings = 100;
/** Validate every CLI/SDK input through one closed schema before opening storage. */
export function parseDestinationMigrationInput(value) {
    const fail = () => { throw new OutboxError("invalid_input", "Use bindings, bind, preview or apply with explicit lowercase aliases (1..64), distinct from/to, a reviewed nonnegative binding revision and SHA-256 plan revision; limit 1..100, after 0..10000. Bind requires a SHA-256 destination and explicit channel or null (up to 256 characters)."); };
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
        return fail();
    const row = value;
    const fields = new Map([
        ["bindings", ["action"]], ["bind", ["action", "alias", "destination", "channel", "bindingRevision"]],
        ["preview", ["action", "from", "to", "limit", "after"]], ["apply", ["action", "from", "to", "bindingRevision", "planRevision", "limit", "after"]],
    ]);
    const allowed = fields.get(String(row.action));
    if (!allowed || Object.keys(row).some((key) => !allowed.includes(key)))
        return fail();
    if (row.action === "bindings")
        return { action: "bindings" };
    if (row.action === "bind") {
        if (typeof row.alias !== "string" || !aliasPattern.test(row.alias) || typeof row.destination !== "string" || !hashPattern.test(row.destination) ||
            !(row.channel === null || (typeof row.channel === "string" && row.channel.length > 0 && row.channel.length <= 256 && !/[\r\n\0]/.test(row.channel))) ||
            !Number.isSafeInteger(row.bindingRevision) || Number(row.bindingRevision) < 0)
            return fail();
        return { action: "bind", alias: row.alias, destination: row.destination, channel: row.channel, bindingRevision: row.bindingRevision };
    }
    if (typeof row.from !== "string" || typeof row.to !== "string" || !aliasPattern.test(row.from) || !aliasPattern.test(row.to) || row.from === row.to)
        return fail();
    const limit = row.limit === undefined ? 20 : row.limit;
    const after = row.after === undefined ? 0 : row.after;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(after) || Number(after) < 0 || Number(after) > maximumEvents)
        return fail();
    const common = { from: row.from, to: row.to, limit: limit, after: after };
    if (row.action === "preview")
        return { action: "preview", ...common };
    if (!Number.isSafeInteger(row.bindingRevision) || Number(row.bindingRevision) < 0 || typeof row.planRevision !== "string" || !hashPattern.test(row.planRevision))
        return fail();
    return { action: "apply", ...common, bindingRevision: row.bindingRevision, planRevision: row.planRevision };
}
/** Test table presence without changing a legacy or read-only database. */
function hasSchema(db) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='destination_binding'").get();
}
/** Install fencing generations once; all old and new drainers update them through SQLite triggers. */
function installSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS destination_binding (sequence INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL, destination TEXT NOT NULL, channel TEXT);
    CREATE TABLE IF NOT EXISTS destination_epoch (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO destination_epoch VALUES (1,0);
    CREATE TABLE IF NOT EXISTS destination_version (key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO destination_version SELECT key,1 FROM delivery;
    CREATE TABLE IF NOT EXISTS destination_original (key TEXT PRIMARY KEY, destination TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS destination_commit (plan TEXT PRIMARY KEY, from_alias TEXT NOT NULL, to_alias TEXT NOT NULL, binding_revision INTEGER NOT NULL, manifest TEXT NOT NULL);`);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const record = operation === "DELETE" ? "old" : "new";
        db.exec(`CREATE TRIGGER IF NOT EXISTS destination_${operation.toLowerCase()} AFTER ${operation} ON delivery BEGIN
      UPDATE destination_epoch SET generation=generation+1 WHERE id=1;
      INSERT INTO destination_version VALUES (${record}.key,1) ON CONFLICT(key) DO UPDATE SET generation=generation+1;
      END;`);
    }
}
/** Accept an exact replay of a migrated original without rewriting the existing delivery. */
export function isOriginalMigrationIntent(db, key, destination, payload) {
    return hasSchema(db) && !!db.prepare("SELECT 1 FROM destination_original WHERE key=? AND destination=? AND payload=?").get(key, destination, payload);
}
/** Preserve only bounded JSON values that can be serialized again without silently replacing extreme numbers. */
function preservableJson(value, depth = 0) {
    if (depth > 64)
        return false;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (typeof value === "object" && value !== null)
        return Object.values(value).every((entry) => preservableJson(entry, depth + 1));
    return true;
}
/** Read the latest owned alias revisions inside the caller's transaction, refusing unsafe counters. */
function bindings(db) {
    if (!hasSchema(db))
        return { revision: 0, rows: [], foreign: 0 };
    const revision = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM destination_binding").get().n);
    safeCount(revision);
    const observed = db.prepare("SELECT alias,sequence,destination,channel FROM destination_binding WHERE sequence IN (SELECT MAX(sequence) FROM destination_binding GROUP BY alias) ORDER BY alias LIMIT 101").all();
    if (observed.length > maximumBindings)
        throw new OutboxError("capacity_exceeded", "Keep at most 100 destination aliases; preserve existing runtime evidence.");
    const rows = observed.flatMap((row) => {
        const candidate = { action: "bind", alias: row.alias, destination: row.destination, channel: row.channel, bindingRevision: row.sequence };
        try {
            parseDestinationMigrationInput(candidate);
        }
        catch {
            return [];
        }
        return [{ alias: String(row.alias), revision: Number(row.sequence), destination: String(row.destination), channel: row.channel }];
    });
    return { revision, rows, foreign: observed.length - rows.length };
}
/** Guard all stored and emitted counters against SQLite overflow or malformed foreign state. */
function safeCount(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new OutboxError("storage_unavailable", "Restore valid nonnegative safe-integer outbox revisions; preserve existing evidence.");
    return value;
}
/** Evaluate owned pending events using the outbox's authoritative full-lifecycle proof. Preview and apply call this same function. */
function evaluate(db, source, target) {
    const observed = db.prepare(`SELECT d.key,d.destination,d.payload,CAST(v.generation AS TEXT) AS generation,CAST(c.at AS TEXT) AS at,CAST(c.priority AS TEXT) AS priority,
    EXISTS(SELECT 1 FROM delivery_group g WHERE g.key=d.key) AS grouped,
    EXISTS(SELECT 1 FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token WHERE s.key=d.key AND t.token IS NULL) AS unfinished
    FROM delivery d LEFT JOIN destination_version v ON v.key=d.key LEFT JOIN delivery_context c ON c.key=d.key WHERE d.destination=? ORDER BY d.key LIMIT 10001`).all(source.destination);
    if (observed.length > maximumEvents)
        throw new OutboxError("capacity_exceeded", "Migrate at most 10000 matching events in one atomic plan; drain or reconcile retained events before previewing again.");
    let proof;
    try {
        proof = new Map(readDeliveryEvidenceRows(db).map((row) => [row.key, row]));
    }
    catch {
        proof = new Map();
        for (const row of observed) {
            try {
                const evidence = readDeliveryEvidenceRows(db, String(row.key))[0];
                if (evidence)
                    proof.set(evidence.key, evidence);
            }
            catch { /* A malformed foreign proof must fail alone. */ }
        }
    }
    return observed.map((row) => {
        const key = String(row.key);
        const revision = Number(row.generation);
        const at = Number(row.at ?? NaN);
        const priority = Number(row.priority ?? NaN);
        const base = { key: hashPattern.test(key) ? key : createHash("sha256").update(key).digest("hex"), revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0, decision: "foreign" };
        const evidence = proof.get(key);
        if (!evidence || !isInspectableDeliveryEvidenceRow(evidence) || !Number.isSafeInteger(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER || typeof row.payload !== "string" || Buffer.byteLength(row.payload, "utf8") > 1048576)
            return base;
        let payload;
        try {
            payload = JSON.parse(row.payload);
        }
        catch {
            return base;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.text !== "string" || !preservableJson(payload))
            return base;
        try {
            validateOutboxIntent({ item: evidence.item, event: evidence.event, revision: evidence.revision, destination: String(row.destination), payload: payload, at, priority });
        }
        catch {
            return base;
        }
        if (evidence.evidence.legacy_unknown || evidence.evidence.uncertain > 0 || row.unfinished !== 0 || deriveSlackDeliveryOutcome(evidence.evidence) === "uncertain" || evidence.state === "sending" || evidence.state === "ambiguous")
            return { ...base, decision: "retain_uncertain" };
        if (evidence.state !== "pending" || evidence.evidence.confirmed > 0 || row.grouped !== 0)
            return { ...base, decision: "retain_state" };
        const mapped = payload;
        delete mapped.channel;
        if (target.channel !== null)
            mapped.channel = target.channel;
        const targetPayload = JSON.stringify(mapped);
        if (Buffer.byteLength(targetPayload, "utf8") > 1048576)
            return base;
        return { ...base, decision: "move", payload: row.payload, targetPayload, destination: String(row.destination) };
    });
}
/** Build and bound the public producer output; all numbers are verified before returning ok. */
function report(status, inventory, input, rows = [], plan = null, moved = 0) {
    const limit = "limit" in input ? input.limit : 20;
    const after = "after" in input ? input.after : 0;
    const counts = { matched: rows.length, movable: rows.filter((row) => row.decision === "move").length, uncertain: rows.filter((row) => row.decision === "retain_uncertain").length, held: rows.filter((row) => row.decision === "retain_state").length, foreign: rows.filter((row) => row.decision === "foreign").length, moved };
    const page = rows.slice(after, after + limit).map((row) => ({ key: row.key, revision: safeCount(row.revision), decision: row.decision }));
    Object.values(counts).forEach(safeCount);
    return { ok: true, status, binding_revision: safeCount(inventory.revision), bindings: inventory.rows.map((row) => ({ alias: row.alias, revision: safeCount(row.revision) })), foreign_bindings: safeCount(inventory.foreign), from: "from" in input ? input.from : null, to: "to" in input ? input.to : null, plan_revision: plan, counts, rows: page, omitted: safeCount(rows.length - page.length), next_cursor: after + limit < rows.length ? safeCount(after + limit) : null };
}
/** Re-read every committed target on replay; later changes are superseded, never blindly replayed. */
function replay(db, manifest) {
    const value = JSON.parse(manifest);
    if (!Array.isArray(value) || value.length > maximumEvents)
        throw new OutboxError("storage_unavailable", "Preserve the migration journal and restore its owned receipt schema.");
    return value.map((entry, index) => {
        if (typeof entry !== "object" || entry === null || typeof entry.key !== "string" || !hashPattern.test(String(entry.key)) || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1)
            return { key: createHash("sha256").update(`foreign-journal-${index}`).digest("hex"), revision: 0, decision: "foreign" };
        const saved = entry;
        const current = db.prepare("SELECT CAST(v.generation AS TEXT) AS generation FROM delivery d JOIN destination_version v ON v.key=d.key WHERE d.key=?").get(saved.key);
        const revision = current ? Number(current.generation) : 0;
        if (!Number.isSafeInteger(revision) || revision < 0)
            return { key: saved.key, revision: 0, decision: "foreign" };
        return { key: saved.key, revision, decision: revision === saved.revision ? "already_moved" : "superseded" };
    });
}
/** Execute validated input under a single SQLite snapshot/writer fence, releasing the fence last. */
export function runDestinationMigration(db, input) {
    const writing = input.action === "bind" || input.action === "apply";
    try {
        db.exec(`PRAGMA busy_timeout=5000; BEGIN${writing ? " IMMEDIATE" : ""}`);
        if (!db.prepare("SELECT since FROM settings WHERE id=1").get())
            throw new OutboxError("disabled", "Enable the outbox before binding or migrating destinations.");
        if (input.action === "bind")
            installSchema(db);
        let inventory = bindings(db);
        let result;
        if (input.action === "bindings")
            result = report("bindings", inventory, input);
        else if (input.action === "bind") {
            const current = inventory.rows.find((row) => row.alias === input.alias);
            if (current?.destination === input.destination && current.channel === input.channel)
                result = report("unchanged", inventory, input);
            else {
                if (input.bindingRevision !== inventory.revision)
                    throw new OutboxError("binding_changed", "Read bindings again and review the current binding revision before binding a route.");
                if (!current && inventory.rows.length >= maximumBindings)
                    throw new OutboxError("capacity_exceeded", "Reuse an existing destination alias; at most 100 aliases are supported.");
                safeCount(inventory.revision + 1);
                db.prepare("INSERT INTO destination_binding(alias,destination,channel) VALUES (?,?,?)").run(input.alias, input.destination, input.channel);
                inventory = bindings(db);
                result = report("bound", inventory, input);
            }
        }
        else {
            const from = inventory.rows.find((row) => row.alias === input.from);
            const to = inventory.rows.find((row) => row.alias === input.to);
            if (!from || !to)
                throw new OutboxError("not_found", "Bind both explicitly named aliases to configured routes before previewing a migration.");
            if (from.destination === to.destination)
                throw new OutboxError("invalid_input", "Bind source and target aliases to distinct destinations before migration.");
            if (input.action === "apply" && input.bindingRevision !== inventory.revision)
                throw new OutboxError("binding_changed", "Preview again and review the new binding revision; no event was moved.");
            const committed = input.action === "apply" ? db.prepare("SELECT from_alias,to_alias,binding_revision,manifest FROM destination_commit WHERE plan=?").get(input.planRevision) : undefined;
            if (committed) {
                if (committed.from_alias !== input.from || committed.to_alias !== input.to || committed.binding_revision !== inventory.revision)
                    throw new OutboxError("plan_changed", "Use the exact aliases and binding revision from the reviewed preview.");
                const rows = replay(db, String(committed.manifest));
                result = report(rows.some((row) => row.decision !== "already_moved") ? "superseded" : "already_applied", inventory, input, rows, input.planRevision);
            }
            else {
                const rows = evaluate(db, from, to);
                const epoch = safeCount(Number(db.prepare("SELECT generation FROM destination_epoch WHERE id=1").get().generation));
                if (epoch > Number.MAX_SAFE_INTEGER - rows.filter((row) => row.decision === "move").length)
                    throw new OutboxError("capacity_exceeded", "Preserve the outbox ledger: its monotonic revision capacity is exhausted. Review supported recovery before further route changes; no event was moved.");
                const plan = createHash("sha256").update(JSON.stringify([inventory.revision, epoch, from, to, rows.map(({ key, revision, decision }) => ({ key, revision, decision }))])).digest("hex");
                const moved = [];
                if (input.action === "apply") {
                    if (input.planRevision !== plan)
                        throw new OutboxError("plan_changed", "Preview current queue state again; a peer changed a target revision, so no event was moved.");
                    for (const row of rows) {
                        if (row.decision !== "move")
                            continue;
                        db.prepare("INSERT OR IGNORE INTO destination_original VALUES (?,?,?)").run(row.key, row.destination, row.payload);
                        db.prepare("UPDATE delivery SET destination=?,payload=? WHERE key=?").run(to.destination, row.targetPayload, row.key);
                        const current = db.prepare("SELECT generation FROM destination_version WHERE key=?").get(row.key);
                        row.revision = safeCount(Number(current.generation));
                        moved.push({ key: row.key, revision: row.revision });
                    }
                    db.prepare("INSERT INTO destination_commit VALUES (?,?,?,?,?)").run(plan, input.from, input.to, input.bindingRevision, JSON.stringify(moved));
                }
                result = report(input.action === "apply" ? "applied" : "preview", inventory, input, rows, plan, moved.length);
            }
        }
        db.exec("COMMIT");
        return result;
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* SQLite may already have rolled back; retain the original refusal. */ }
        throw error;
    }
}
/** Render the producer's bounded schema without routing credentials or message content. */
export function destinationMigrationToon(result) {
    return [`ok: true`, `status: ${result.status}`, `binding_revision: ${result.binding_revision}`,
        `bindings[${result.bindings.length}]{alias,revision}:`, ...result.bindings.map((row) => `  ${JSON.stringify(row.alias)},${row.revision}`), `foreign_bindings: ${result.foreign_bindings}`,
        `from: ${JSON.stringify(result.from)}`, `to: ${JSON.stringify(result.to)}`, `plan_revision: ${JSON.stringify(result.plan_revision)}`,
        "counts:", ...Object.entries(result.counts).map(([key, count]) => `  ${key}: ${count}`),
        `rows[${result.rows.length}]{key,revision,decision}:`, ...result.rows.map((row) => `  ${JSON.stringify(row.key)},${row.revision},${row.decision}`),
        `omitted: ${result.omitted}`, `next_cursor: ${result.next_cursor}`].join("\n");
}
//# sourceMappingURL=destination-migration.js.map