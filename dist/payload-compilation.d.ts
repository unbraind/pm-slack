/** Pure Slack wire compilation. Receipts refer to the unchanged input using UTF-16 half-open ranges. */
import type { PmClient, GetResult, PmReadOutputBudgetExceeded } from "@unbrained/pm-cli/sdk";
/** A static block whose type has passed the shared wire schema. */
export interface CompiledSlackBlock extends Record<string, unknown> {
    /** Slack block discriminator. */
    type: string;
}
/** Conservative package budgets, in addition to Slack's individual Block Kit limits. */
export declare const SLACK_PAYLOAD_BOUNDS: Readonly<{
    blocks: 50;
    text: 4000;
    bytes: 65536;
    inputBytes: 2097152;
}>;
/** Supported static Block Kit subset; interactive callbacks and arbitrary attachments are deliberately refused. */
export interface CompiledSlackPayload {
    /** Notification fallback, retained even when all optional blocks are omitted. */
    text: string;
    /** Validated static blocks. */
    blocks?: CompiledSlackBlock[];
    /** Slack formatting switch. */
    mrkdwn?: boolean;
    /** Optional explicit destination override. */
    channel?: string;
    /** Optional Slack thread coordinate. */
    thread_ts?: string;
}
/** One source document supplies the recovery context for every loss in a compilation. */
export interface SlackCompilationInput {
    /** Raw, untruncated Slack payload. */
    payload: CompiledSlackPayload;
    /** Stable item identity for recovery. */
    item: string;
    /** Explicit HTTP(S) URL that recovers the full source item. */
    link: string;
    /** JSON-pointer text paths that must survive byte-for-byte, including identity and status. */
    preserve: string[];
    /** Optional stricter package budgets. */
    bounds?: {
        blocks?: number;
        text?: number;
        bytes?: number;
    };
}
/** Exact excluded source range; markers inserted by the compiler are outside this range. */
export interface SlackLossReceipt {
    /** JSON pointer into the original input payload. */
    path: string;
    /** First excluded UTF-16 unit, inclusive. */
    start: number;
    /** Last excluded UTF-16 unit, exclusive. */
    end: number;
    /** The budget responsible for this exclusion. */
    reason: "text_limit" | "block_limit" | "byte_limit" | "element_limit";
    /** Stable source item identity. */
    item: string;
    /** Full source recovery link. */
    link: string;
}
/** Deterministic, bounded wire payload and a separate exact loss ledger. */
export interface SlackCompilation {
    /** Successful compilation discriminator. */
    ok: true;
    /** Digest of the original schema-validated wire source before clipping; preserves replay identity. */
    source_sha256: string;
    /** Wire payload; receipts must never be added to the Slack request. */
    payload: CompiledSlackPayload;
    /** UTF-8 size of JSON.stringify(payload). */
    bytes: number;
    /** Applied package budgets. */
    bounds: {
        blocks: number;
        text: number;
        bytes: number;
    };
    /** Exact original source exclusions, ordered by traversal. */
    losses: SlackLossReceipt[];
}
/** Typed refusal suitable for SDK callers and the CLI's nonzero result contract. */
export declare class SlackCompilationError extends Error {
    /** Stable refusal code; errors never echo source content. */
    readonly code: "invalid_input" | "protected_overflow";
    /** A usage refusal, before any remote action. */
    readonly exitCode = 2;
    /** Operator action needed before retry. */
    readonly remedy: string;
    /** Create a content-free refusal with an actionable remedy. */
    constructor(code: SlackCompilationError["code"], remedy: string);
}
/** Refuse malformed or oversized wire data before transport opens a socket; no clipping occurs here. */
export declare function validateSlackWirePayload(input: unknown): CompiledSlackPayload;
/** Compile raw static Slack content once; every removed source span has exactly one linked receipt. */
export declare function compileSlackPayload(input: SlackCompilationInput): SlackCompilation;
/** Validate untrusted JSON through the same boundary as typed SDK input. */
export declare function compileSlackPayload(input: unknown): SlackCompilation;
/** Read one item through the host-injected SDK; all identity, lifecycle and relationship fields remain protected. */
export declare function compileSlackItem(client: Pick<PmClient, "get">, id: string, link: string, bounds?: SlackCompilationInput["bounds"]): Promise<SlackCompilation>;
/** Internal full-read adapter; public consumers use compileSlackItem so this package controls the read projection. @internal */
export declare function compileSlackItemRead(source: GetResult | PmReadOutputBudgetExceeded, link: string, bounds?: SlackCompilationInput["bounds"]): SlackCompilation;
/** Compact ledger projection avoids echoing message bodies into agent output. Payload access is explicit in the CLI. */
export declare function slackCompilationSummary(result: SlackCompilation, limit?: number, after?: number): {
    ok: true;
    source_sha256: string;
    bytes: number;
    blocks: number;
    bounds: {
        blocks: number;
        text: number;
        bytes: number;
    };
    losses: SlackLossReceipt[];
    total_losses: number;
    omitted: number;
    next_cursor: number | null;
};
/** Render the compact ledger using the same keys and values as JSON. */
export declare function slackCompilationToon(result: ReturnType<typeof slackCompilationSummary>): string;
//# sourceMappingURL=payload-compilation.d.ts.map