/** Delivery proof is independent of scheduling labels and operator decisions. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OutboxState } from "./outbox.ts";

/** What retained transport evidence proves about a notification's delivery. */
export type SlackDeliveryOutcome = "delivered" | "withheld" | "uncertain";

/** Bounded sufficient statistics over the entire retained attempt/resolution journal. */
export interface SlackDeliveryEvidence {
  /** Historical attempts lack a complete journal, so non-delivery cannot be proved. */
  legacy_unknown: boolean;
  /** Number of durable attempt records, including pre-request refusals. */
  recorded: number;
  /** Explicit successful Slack transport responses. */
  confirmed: number;
  /** Unfinished or ambiguous attempts, including unknown/foreign result values. */
  uncertain: number;
  /** Definite rejections, rate limits and pre-request refusals. */
  definitive: number;
  /** Operator decisions retained independently from transport evidence. */
  resolutions: number;
}

/** Reduce full-lifecycle evidence; operator labels can never turn uncertainty into proof. */
export function deriveSlackDeliveryOutcome(evidence?: SlackDeliveryEvidence, policyExcluded = false): SlackDeliveryOutcome {
  if (evidence === undefined) return policyExcluded ? "withheld" : "uncertain";
  if (typeof evidence !== "object" || evidence === null) return "uncertain";
  const values = [evidence.recorded, evidence.confirmed, evidence.uncertain, evidence.definitive, evidence.resolutions];
  if (typeof evidence.legacy_unknown !== "boolean" || !values.every((value) => Number.isSafeInteger(value) && value >= 0) || evidence.confirmed + evidence.uncertain + evidence.definitive !== evidence.recorded) return "uncertain";
  // A later ack proves at least one delivery, but does not settle another unknown attempt.
  if (evidence.legacy_unknown || evidence.uncertain > 0) return "uncertain";
  return evidence.confirmed > 0 ? "delivered" : "withheld";
}

/** Private-content-free receipt and its lifecycle proof, from one SQLite statement snapshot. */
export interface DeliveryEvidenceRow {
  /** Durable sequence used by status cursors. */
  sequence: number;
  /** Exact receipt key. */
  key: string;
  /** Item identity, not its title or body. */
  item: string;
  /** Canonical event retained by the outbox. */
  event: string;
  /** Committed state revision. */
  revision: string;
  /** Workflow label, independent of delivery proof. */
  state: OutboxState;
  /** Compatibility attempt count; unsafe foreign numbers remain detectable. */
  attempts: number;
  /** Last retained coalescing observation. */
  disposition: string | null;
  /** Credential-free coalescing group identity. */
  notification: string | null;
  /** Complete lifecycle sufficient statistics. */
  evidence: SlackDeliveryEvidence;
}

/** Read legacy or journaled receipts without creating tables, changing state or exposing private payloads. */
export function readDeliveryEvidenceRows(db: DatabaseSync, key?: string, journaled = true): DeliveryEvidenceRow[] {
  const where = key === undefined ? "" : " WHERE d.key=?";
  const journalWhere = key === undefined ? "" : " WHERE key=?";
  const journal = journaled ? `,CASE WHEN COALESCE(p.legacy_unknown,0)=0 AND COALESCE(p.claims,0)=COALESCE(a.recorded,0) THEN 0 ELSE 1 END AS legacy_unknown,
    COALESCE(a.recorded,0) AS recorded,COALESCE(a.confirmed,0) AS confirmed,
    COALESCE(a.uncertain,0) AS uncertain,COALESCE(a.definitive,0) AS definitive,COALESCE(a.not_sent,0) AS not_sent,COALESCE(r.resolutions,0) AS resolutions` : ",0 AS legacy_unknown,0 AS recorded,0 AS confirmed,0 AS uncertain,0 AS definitive,0 AS not_sent,0 AS resolutions";
  const joins = journaled ? ` LEFT JOIN delivery_proof p ON p.key=d.key
    LEFT JOIN (SELECT key,COUNT(*) AS recorded,SUM(result='acknowledged') AS confirmed,
      SUM(result NOT IN ('acknowledged','rejected','retry','not_sent')) AS uncertain,
      SUM(result IN ('rejected','retry','not_sent')) AS definitive,SUM(result='not_sent') AS not_sent FROM delivery_attempt${journalWhere} GROUP BY key) a ON a.key=d.key
    LEFT JOIN (SELECT key,COUNT(*) AS resolutions FROM delivery_resolution${journalWhere} GROUP BY key) r ON r.key=d.key` : "";
  const query = db.prepare(`SELECT CAST(d.rowid AS TEXT) AS sequence,d.key,d.item,d.event,d.revision,d.state,CAST(d.attempts AS TEXT) AS attempts,c.disposition,c.notification${journal}
    FROM delivery d LEFT JOIN coalescing_receipt c ON c.key=d.key${joins}${where} ORDER BY d.rowid`);
  const parameters: string[] = [];
  if (key !== undefined) { if (journaled) parameters.push(key, key); parameters.push(key); }
  const rows = query.all(...parameters);
  return rows.map((row) => {
    const recorded = Number(row.recorded);
    const attempts = Number(row.attempts);
    return { sequence: Number(row.sequence), key: String(row.key), item: String(row.item), event: String(row.event), revision: String(row.revision), state: row.state as OutboxState, attempts,
      disposition: row.disposition as string | null, notification: row.notification as string | null,
      evidence: { legacy_unknown: row.legacy_unknown !== 0 || attempts > recorded - Number(row.not_sent) || (!journaled && ["sending", "ambiguous", "acknowledged"].includes(String(row.state))),
        recorded, confirmed: Number(row.confirmed), uncertain: Number(row.uncertain), definitive: Number(row.definitive), resolutions: Number(row.resolutions) } };
  });
}

/** Identify only rows whose domain and immutable key match records the package can write. */
export function isInspectableDeliveryEvidenceRow(row: DeliveryEvidenceRow): boolean {
  return Number.isSafeInteger(row.sequence) && row.sequence > 0 && Number.isSafeInteger(row.attempts) && row.attempts >= 0 &&
    ["pending", "sending", "acknowledged", "ambiguous", "rejected", "refused", "skipped"].includes(row.state) &&
    row.key === createHash("sha256").update(JSON.stringify([row.item, row.event, row.revision])).digest("hex");
}
