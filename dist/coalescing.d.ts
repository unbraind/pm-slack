import type { OutboxEvent } from "./outbox.ts";
/** A committed lifecycle intent; destinations are opaque hashes, never credentials. */
export interface CoalescingEvent {
    /** Original durable outbox key. */
    key: string;
    /** Item whose transitions are related. */
    item: string;
    /** Canonical lifecycle transition. */
    event: OutboxEvent;
    /** Committed item-history revision. */
    revision: string;
    /** Frozen destination identity. */
    destination: string;
    /** Committed timestamp in epoch milliseconds; zero denotes legacy intents. */
    at: number;
    /** Priority at the transition, not the item's current priority. */
    priority: number;
}
/** Explicit attention budget for one drain; urgent events do not consume it. */
export interface CoalescingOptions {
    /** Maximum routine notifications, from zero to one hundred; default five. */
    budget?: number;
    /** Fixed UTC window width in milliseconds, from one second to one day; default one minute. */
    windowMs?: number;
    /** Observation clock; default current time. Fixed clocks make previews reproducible. */
    now?: number;
}
/** Why an original event did or did not get its own notification. */
export type CoalescingDisposition = "bypass" | "coalesced" | "deferred" | "waiting";
/** Complete item-level evidence for one original event. */
export interface CoalescingReceipt {
    /** Original durable event key. */
    key: string;
    /** Original item identity. */
    item: string;
    /** Original lifecycle event. */
    event: OutboxEvent;
    /** Original committed revision. */
    revision: string;
    /** Bypass, grouped, over budget, or still in an open window. */
    disposition: CoalescingDisposition;
    /** Stable group identity, including for deferred and waiting groups. */
    notification: string;
}
/** One bounded notification with a complete list of contributing event keys. */
export interface CoalescedNotification {
    /** Hash of canonical member keys, independent of arrival order. */
    key: string;
    /** Frozen destination; groups never cross route boundaries. */
    destination: string;
    /** All original events, sorted by their durable keys. */
    keys: string[];
    /** True means preserve the original payload and bypass every routine bound. */
    urgent: boolean;
    /** Bounded, credential-free summary; urgent delivery uses the original payload. */
    text: string;
}
/** Complete SDK plan; CLI inspection pages the evidence rather than losing it. */
export interface CoalescingPlan {
    /** Exact number of original lifecycle events. */
    events: number;
    /** Urgent notifications outside the routine budget. */
    urgent: number;
    /** Original events represented by selected routine summaries. */
    coalesced: number;
    /** Original events retained pending because the budget was exhausted. */
    deferred: number;
    /** Original events retained pending until their fixed window closes. */
    waiting: number;
    /** Urgent notifications first, followed by oldest eligible routine groups. */
    notifications: CoalescedNotification[];
    /** Exactly one receipt per input event, sorted by durable key. */
    receipts: CoalescingReceipt[];
}
/** Stable, public refusal with a concrete recovery action and host-compatible shape. */
export declare class CoalescingError extends Error {
    /** Expected usage refusal status. */
    readonly exitCode = 2;
    /** Stable machine-readable refusal category. */
    readonly code = "invalid_coalescing_input";
    /** Operator action without private paths or input content. */
    readonly remedy = "Use unique canonical lifecycle events (at most 10000), safe identifiers, priorities 0..4, budget 0..100, windowMs 1000..86400000 and a nonnegative integer clock.";
    /** Host JSON refusal renderer's recovery field. */
    readonly remediation = "Use unique canonical lifecycle events (at most 10000), safe identifiers, priorities 0..4, budget 0..100, windowMs 1000..86400000 and a nonnegative integer clock.";
    /** Structured expected-error context. */
    readonly context: {
        code: string;
        nextSteps: string[];
    };
    /** Construct a safe refusal without reflecting input data. */
    constructor();
}
/** Plan same-item, same-destination bursts without sending, reading git, or mutating inputs. */
export declare function planSlackCoalescing(input: readonly CoalescingEvent[], options?: CoalescingOptions): CoalescingPlan;
//# sourceMappingURL=coalescing.d.ts.map