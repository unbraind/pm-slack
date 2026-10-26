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
export declare function deriveSlackDeliveryOutcome(evidence?: SlackDeliveryEvidence, policyExcluded?: boolean): SlackDeliveryOutcome;
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
export declare function readDeliveryEvidenceRows(db: DatabaseSync, key?: string, journaled?: boolean): DeliveryEvidenceRow[];
/** Identify only rows whose domain and immutable key match records the package can write. */
export declare function isInspectableDeliveryEvidenceRow(row: DeliveryEvidenceRow): boolean;
//# sourceMappingURL=delivery-evidence.d.ts.map