import type { DatabaseSync } from "node:sqlite";
/** One strict command union; fingerprints come from configured routes, never webhook credentials. */
export type DestinationMigrationInput = {
    action: "bindings";
} | {
    action: "bind";
    alias: string;
    destination: string;
    channel: string | null;
    bindingRevision: number;
} | {
    action: "preview";
    from: string;
    to: string;
    limit?: number;
    after?: number;
} | {
    action: "apply";
    from: string;
    to: string;
    bindingRevision: number;
    planRevision: string;
    limit?: number;
    after?: number;
};
/** Credential-free alias; its fingerprint and channel remain private inside runtime storage. */
export interface DestinationBinding {
    /** Explicit operator-selected name. */
    alias: string;
    /** Monotonic binding write sequence. */
    revision: number;
}
/** One bounded receipt explaining what a transition does to an existing event. */
export interface DestinationMigrationRow {
    /** Existing outbox identity; migration never inserts another delivery. */
    key: string;
    /** Current per-event fencing revision. */
    revision: number;
    /** Safe disposition independent of transport proof. */
    decision: "move" | "retain_uncertain" | "retain_state" | "foreign" | "already_moved" | "superseded";
}
/** Agent-sized preview/apply result, with exact totals and explicit pagination. */
export interface DestinationMigrationReport {
    /** Successful evaluation; operational refusals throw OutboxError. */
    ok: true;
    /** Applying twice never repeats a move; later peer changes are reported. */
    status: "bindings" | "bound" | "unchanged" | "preview" | "applied" | "already_applied" | "superseded";
    /** Global monotonic binding revision to review before applying. */
    binding_revision: number;
    /** Bounded public binding inventory. */
    bindings: DestinationBinding[];
    /** Malformed binding records ignored without interpreting their routing content. */
    foreign_bindings: number;
    /** Explicit source alias, or null for binding operations. */
    from: string | null;
    /** Explicit target alias, or null for binding operations. */
    to: string | null;
    /** Binds the preview to both binding and queue revisions. */
    plan_revision: string | null;
    /** Complete source counts; moved counts only this invocation's mutations. */
    counts: {
        matched: number;
        movable: number;
        uncertain: number;
        held: number;
        foreign: number;
        moved: number;
    };
    /** Dense receipt page with no payload, channel or webhook. */
    rows: DestinationMigrationRow[];
    /** Receipts outside this page. */
    omitted: number;
    /** Offset of the next page, or null at completion. */
    next_cursor: number | null;
}
/** Validate every CLI/SDK input through one closed schema before opening storage. */
export declare function parseDestinationMigrationInput(value: unknown): DestinationMigrationInput;
/** Accept an exact replay of a migrated original without rewriting the existing delivery. */
export declare function isOriginalMigrationIntent(db: DatabaseSync, key: string, destination: string, payload: string): boolean;
/** Execute validated input under a single SQLite snapshot/writer fence, releasing the fence last. */
export declare function runDestinationMigration(db: DatabaseSync, input: DestinationMigrationInput): DestinationMigrationReport;
/** Render the producer's bounded schema without routing credentials or message content. */
export declare function destinationMigrationToon(result: DestinationMigrationReport): string;
//# sourceMappingURL=destination-migration.d.ts.map