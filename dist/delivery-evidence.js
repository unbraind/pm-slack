/** Delivery proof is independent of scheduling labels and operator decisions. */
import { createHash } from "node:crypto";
/** Reduce full-lifecycle evidence; operator labels can never turn uncertainty into proof. */
export function deriveSlackDeliveryOutcome(evidence, policyExcluded = false) {
    if (evidence === undefined)
        return policyExcluded ? "withheld" : "uncertain";
    if (typeof evidence !== "object" || evidence === null)
        return "uncertain";
    const values = [evidence.recorded, evidence.confirmed, evidence.uncertain, evidence.definitive, evidence.resolutions];
    if (typeof evidence.legacy_unknown !== "boolean" || !values.every((value) => Number.isSafeInteger(value) && value >= 0) || evidence.confirmed + evidence.uncertain + evidence.definitive !== evidence.recorded)
        return "uncertain";
    // Confirmed delivery settles the event even if another request remains uncertain.
    if (evidence.confirmed > 0)
        return "delivered";
    return evidence.legacy_unknown || evidence.uncertain > 0 ? "uncertain" : "withheld";
}
/** Read legacy or journaled receipts without creating tables, changing state or exposing private payloads. */
export function readDeliveryEvidenceRows(db, key, journaled = true) {
    const where = key === undefined ? "" : " WHERE d.key=?";
    const journalWhere = key === undefined ? "" : " WHERE key=?";
    const paired = journaled && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_attempt_start'").get();
    const journal = journaled ? `,COALESCE(p.legacy_unknown,0) AS legacy_unknown,
    COALESCE(a.recorded,0) AS recorded,COALESCE(a.confirmed,0) AS confirmed,
    COALESCE(a.uncertain,0) AS uncertain,COALESCE(a.definitive,0) AS definitive,COALESCE(r.resolutions,0) AS resolutions,
    ${paired ? "COALESCE(a.attempts,0)" : "d.attempts"} AS journal_attempts` : ",0 AS legacy_unknown,0 AS recorded,0 AS confirmed,0 AS uncertain,0 AS definitive,0 AS resolutions,d.attempts AS journal_attempts";
    const aggregate = paired ? `SELECT s.key,COUNT(*) AS recorded,SUM(t.result='confirmed') AS confirmed,
      SUM(CASE WHEN t.result='unknown_after_send' OR (t.result IS NULL AND x.token IS NOT NULL) OR (t.result IS NOT NULL AND t.result NOT IN ('confirmed','not_sent','rejected','unknown_after_send')) THEN 1 ELSE 0 END) AS uncertain,
      SUM(CASE WHEN t.result IN ('not_sent','rejected') OR (t.result IS NULL AND x.token IS NULL) THEN 1 ELSE 0 END) AS definitive,
      SUM(CASE WHEN t.result='not_sent' OR (t.result IS NULL AND x.token IS NULL) THEN 0 ELSE 1 END) AS attempts
      FROM delivery_attempt_start s LEFT JOIN delivery_attempt_terminal t ON t.key=s.key AND t.token=s.token
      LEFT JOIN delivery_request_dispatched x ON x.key=s.key AND x.token=s.token${key === undefined ? "" : " WHERE s.key=?"} GROUP BY s.key` :
        `SELECT key,COUNT(*) AS recorded,SUM(result='acknowledged') AS confirmed,
      SUM(result NOT IN ('acknowledged','rejected','retry','not_sent')) AS uncertain,
      SUM(result IN ('rejected','retry','not_sent')) AS definitive FROM delivery_attempt${journalWhere} GROUP BY key`;
    const joins = journaled ? ` LEFT JOIN delivery_proof p ON p.key=d.key
    LEFT JOIN (${aggregate}) a ON a.key=d.key
    LEFT JOIN (SELECT key,COUNT(*) AS resolutions FROM delivery_resolution${journalWhere} GROUP BY key) r ON r.key=d.key` : "";
    const query = db.prepare(`SELECT CAST(d.rowid AS TEXT) AS sequence,d.key,d.item,d.event,d.revision,d.state,CAST(d.attempts AS TEXT) AS attempts,c.disposition,c.notification${journal}
    FROM delivery d LEFT JOIN coalescing_receipt c ON c.key=d.key${joins}${where} ORDER BY d.rowid`);
    const parameters = [];
    if (key !== undefined) {
        if (journaled)
            parameters.push(key, key);
        parameters.push(key);
    }
    const rows = query.all(...parameters);
    return rows.map((row) => {
        const recorded = Number(row.recorded);
        const attempts = Number(row.attempts);
        return { sequence: Number(row.sequence), key: String(row.key), item: String(row.item), event: String(row.event), revision: String(row.revision), state: row.state, attempts: Number.isSafeInteger(attempts) && attempts >= 0 && paired ? Number(row.journal_attempts) : attempts,
            disposition: row.disposition, notification: row.notification,
            evidence: { legacy_unknown: row.legacy_unknown !== 0 || (!paired && attempts > recorded) || (!journaled && ["sending", "ambiguous", "acknowledged"].includes(String(row.state))),
                recorded, confirmed: Number(row.confirmed), uncertain: Number(row.uncertain), definitive: Number(row.definitive), resolutions: Number(row.resolutions) } };
    });
}
/** Identify only rows whose domain and immutable key match records the package can write. */
export function isInspectableDeliveryEvidenceRow(row) {
    return Number.isSafeInteger(row.sequence) && row.sequence > 0 && Number.isSafeInteger(row.attempts) && row.attempts >= 0 &&
        ["pending", "sending", "acknowledged", "ambiguous", "rejected", "refused", "skipped"].includes(row.state) &&
        row.key === createHash("sha256").update(JSON.stringify([row.item, row.event, row.revision])).digest("hex");
}
//# sourceMappingURL=delivery-evidence.js.map