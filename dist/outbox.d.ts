/** Stable refusal codes returned by both the SDK and CLI. */
export type OutboxRefusalCode = "invalid_input" | "disabled" | "conflict" | "not_found" | "in_flight" | "not_ambiguous" | "destination_changed" | "storage_unavailable" | "history_unavailable";
/** Expected failure with a safe message, machine-readable code, and concrete remedy. */
export declare class OutboxError extends Error {
    /** Host extension runtime's expected-error status. */
    readonly exitCode = 2;
    /** Stable machine-readable refusal category. */
    readonly code: OutboxRefusalCode;
    /** Safe recovery action for callers and agents. */
    readonly remedy: string;
    /** Host-compatible structured recovery field, identical to remedy. */
    readonly remediation: string;
    /** Public expected-error shape consumed by the host's JSON refusal renderer. */
    readonly context: {
        code: OutboxRefusalCode;
        required: string;
        nextSteps: string[];
    };
    /** Create a refusal without including payloads, credentials, or filesystem paths. */
    constructor(code: OutboxRefusalCode, remedy: string);
}
/** Persisted lifecycle delivery state; sending after a crash must be reconciled explicitly. */
export type OutboxState = "pending" | "sending" | "acknowledged" | "ambiguous" | "rejected" | "refused" | "skipped";
/** Lifecycle transitions owned by Slack delivery, independent of command aliases. */
export type OutboxEvent = "create" | "close" | "block" | "cancel" | "open" | "start" | "unblock" | "reopen";
/** Minimal webhook body supported by durable lifecycle delivery. */
export interface OutboxPayload {
    /** Plain-text fallback, already formatted and capped by the Slack builder. */
    text: string;
    /** Optional Block Kit sections. */
    blocks?: {
        type: string;
        [key: string]: unknown;
    }[];
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
/** Hash a destination without persisting a webhook credential. */
export declare function slackDestination(webhook: string, channel?: string): string;
/** Local SQLite outbox using full synchronous commits and atomic cross-process claims. */
export declare class SlackOutbox {
    private readonly db;
    /** Open runtime storage in an initialized local tracker, without invoking git. */
    constructor(pmRoot: string);
    /** Release the database handle; committed receipts survive process exit. */
    close(): void;
    /** Opt in once and optionally snapshot eligibility; legacy policy adoption starts with future history. */
    enable(filter?: OutboxRecoveryFilter): string;
    /** Record an explicit future-only filter change; retained history keeps its earlier eligibility. */
    configureRecovery(filter: OutboxRecoveryFilter): void;
    /** Read eligibility epochs newest first; unsnapshotted SDK trackers must opt in explicitly. */
    recoveryPolicies(): OutboxRecoveryPolicy[];
    /** Resolve one entry's policy by its timestamp, including configurations committed during a recovery scan. */
    recoveryPolicyAt(timestamp: string): OutboxRecoveryPolicy | undefined;
    /** Persist a validated policy without storing routing credentials or replacing previous epochs. */
    private saveRecoveryPolicy;
    /** Return the durable opt-in boundary without reading message bodies. */
    since(): string | null;
    /** Persist an intent once; conflicting reuse refuses instead of silently changing a message. */
    enqueue(intent: OutboxIntent): string;
    /** Check whether a verified history transition already has a durable intent. */
    has(item: string, event: OutboxEvent, revision: string): boolean;
    /** Inspect a bounded receipt page while preserving exact totals and omission evidence. */
    status(limit?: number, after?: number): OutboxReport;
    /**
     * Claim pending rows once. Typed OutboxError refusals occur before a remote
     * request starts. Destination changes park a refused row and continue; other
     * typed refusals restore pending without counting an attempt. An ambiguous
     * outcome holds later rows for that destination in this drain. A retry
     * outcome stops this drain so a rate limit is not hit again immediately.
     * The next drain prefers fewer attempts, then older rows, so one refused
     * destination cannot block every other notification.
     */
    drain(send: (destination: string, payload: OutboxPayload) => Promise<OutboxOutcome>, limit?: number): Promise<OutboxReport>;
    /** Reconcile uncertainty or refusal; force overrides PID reuse only after an operator verifies sender absence. */
    resolve(key: string, decision: OutboxDecision, options?: {
        force?: boolean;
    }): void;
}
//# sourceMappingURL=outbox.d.ts.map