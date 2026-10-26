/** Public contracts and the single strict request boundary for offline routing diagnosis. */
import type { OutboxEvent, OutboxState } from "./outbox.ts";
/** Exact committed event identity; revisions prevent conflating repeated transitions. */
export interface SlackRoutingIdentity {
    /** Canonical tracker item identifier, at most 160 safe characters. */
    item: string;
    /** Canonical lifecycle transition. */
    event: OutboxEvent;
    /** SDK history after_hash identifying the committed transition. */
    revision: string;
}
/** One ordered policy decision; rule indices expose neither selectors nor destinations. */
export interface SlackRoutingStep {
    /** Policy stage responsible for the decision. */
    stage: "history" | "events" | "priority" | "route" | "coalescing" | "delivery";
    /** Stable, bounded policy name, never a user-provided string. */
    policy: string;
    /** The policy's result, qualified by its evidence source. */
    decision: string;
    /** Whether this is retained evidence or evaluation of current configuration. */
    source: "verified_history" | "retained" | "current_config" | "unknown";
    /** Zero-based configured routing rule index; null for stages without a rule. */
    rule?: number | null;
}
/** Complete bounded diagnostic, containing no webhook, channel, title or message body. */
export interface SlackRoutingExplanation {
    /** Successful diagnosis can still conclude uncertainty about delivery. */
    ok: true;
    /** Exact event being diagnosed. */
    identity: SlackRoutingIdentity;
    /** Delivery conclusions rely on durable evidence, never current routing alone. */
    outcome: "delivered" | "withheld" | "uncertain";
    /** One complete ordered path through filters, routes, coalescing and transport. */
    path: SlackRoutingStep[];
    /** Durable state when an exact receipt was retained. */
    state?: OutboxState;
    /** Count of persisted transport attempts, if known. */
    attempts?: number;
    /** Explicit limits on retrospective knowledge, expressed as stable codes. */
    uncertainty: string[];
}
/** Expected input refusal shared by SDK and CLI without reflecting private inputs. */
export declare class SlackRoutingError extends Error {
    /** Host-compatible nonzero usage status. */
    readonly exitCode = 2;
    /** Machine-readable cause suitable for agent branching. */
    readonly code: "invalid_routing_input" | "event_not_found" | "routing_config_invalid";
    /** Concrete recovery action, free of user input and local paths. */
    readonly remedy: string;
    /** Construct a safe expected refusal. */
    constructor(code: SlackRoutingError["code"], remedy: string);
}
/** Validate the entire identity once, rejecting unknown fields and unsafe or unbounded values. */
export declare function validateSlackRoutingIdentity(input: unknown): asserts input is SlackRoutingIdentity;
/** Render only the fixed diagnostic schema; JSON quoting preserves TOON scalar boundaries. */
export declare function slackRoutingToon(report: SlackRoutingExplanation): string;
//# sourceMappingURL=routing-explanation.d.ts.map