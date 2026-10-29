import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk";
/** Return the same compiled payload as the SDK, with a compact ledger by default and typed refusals. */
export declare function runSlackCompilationCommand(ctx: CommandHandlerContext): Promise<{
    ok: true;
    source_sha256: string;
    bytes: number;
    blocks: number;
    bounds: {
        blocks: number;
        text: number;
        bytes: number;
    };
    losses: import("./payload-compilation.ts").SlackLossReceipt[];
    total_losses: number;
    omitted: number;
    next_cursor: number | null;
} | {
    ok: true;
    source_sha256: string;
    bytes: number;
    blocks: number;
    bounds: {
        blocks: number;
        text: number;
        bytes: number;
    };
    losses: import("./payload-compilation.ts").SlackLossReceipt[];
    total_losses: number;
    omitted: number;
    next_cursor: number | null;
    payload: import("./payload-compilation.ts").CompiledSlackPayload;
    exit_code?: undefined;
    code?: undefined;
    remediation?: undefined;
} | {
    ok: boolean;
    exit_code: number;
    code: "invalid_input" | "protected_overflow";
    remediation: string;
}>;
//# sourceMappingURL=payload-command.d.ts.map