/** Offline compiler command using only the host's injected SDK client. */
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import { compileSlackItem, compileSlackPayload, SlackCompilationError, slackCompilationSummary, SLACK_PAYLOAD_BOUNDS } from "./payload-compilation.js";
/** Supplied CLI values must be usable strings, never silently treated as absent. */
function option(options, name) {
    const camel = name.replace(/-([a-z])/g, (_match, c) => c.toUpperCase());
    const key = Object.hasOwn(options, name) ? name : camel;
    if (!Object.hasOwn(options, key))
        return undefined;
    const value = options[key];
    if (typeof value !== "string" || !value.trim())
        throw new SlackCompilationError("invalid_input", `Supply a nonempty --${name} value.`);
    return value;
}
/** Read at most the documented input budget, including when a file grows during the read. */
function readInput(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!fstatSync(fd).isFile())
            throw new SlackCompilationError("invalid_input", "Supply a regular UTF-8 JSON file, not a directory, pipe or device.");
        const buffer = Buffer.alloc(SLACK_PAYLOAD_BOUNDS.inputBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, null);
            if (!count)
                break;
            length += count;
        }
        if (length > SLACK_PAYLOAD_BOUNDS.inputBytes)
            throw new SlackCompilationError("invalid_input", "Reduce the input file to at most 2 MiB, then retry.");
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    }
    finally {
        closeSync(fd);
    }
}
/** Return the same compiled payload as the SDK, with a compact ledger by default and typed refusals. */
export async function runSlackCompilationCommand(ctx) {
    try {
        const input = option(ctx.options, "input"), item = option(ctx.options, "item"), link = option(ctx.options, "link");
        if (Boolean(input) === Boolean(item) || (input && link) || (item && !link))
            throw new SlackCompilationError("invalid_input", "Choose --input <JSON-file>, or --item <id> --link <stable-item-URL>.");
        const bounds = {};
        /** Pagination never changes the compiler's complete internal loss ledger. */
        const page = (name, fallback) => {
            const value = option(ctx.options, name);
            if (value === undefined)
                return fallback;
            if (!/^(0|[1-9][0-9]*)$/.test(value))
                throw new SlackCompilationError("invalid_input", `Supply --${name} as a nonnegative decimal integer.`);
            return Number(value);
        };
        const limit = page("limit", 20), after = page("after", 0);
        for (const [flag, key] of [["max-bytes", "bytes"], ["max-blocks", "blocks"], ["max-text", "text"]]) {
            const value = option(ctx.options, flag);
            if (value !== undefined) {
                if (!/^[1-9][0-9]*$/.test(value))
                    throw new SlackCompilationError("invalid_input", `Supply --${flag} as a positive decimal integer within the documented bounds.`);
                bounds[key] = Number(value);
            }
        }
        let result;
        if (input) {
            if (Object.keys(bounds).length)
                throw new SlackCompilationError("invalid_input", "Set bounds in the JSON input envelope; CLI bounds apply only to --item.");
            result = compileSlackPayload(readInput(input));
        }
        else {
            if (!ctx.sdk)
                throw new SlackCompilationError("invalid_input", "Run this command through a pm host that injects its SDK client (2026.10.25 or newer).");
            result = await compileSlackItem(ctx.sdk.client, item, link, bounds);
        }
        const include = ctx.options.payload;
        if (include !== undefined && include !== true && include !== false)
            throw new SlackCompilationError("invalid_input", "Use --payload as a boolean flag.");
        const summary = slackCompilationSummary(result, limit, after);
        return include ? { ...summary, payload: result.payload } : summary;
    }
    catch (error) {
        const refusal = error instanceof SlackCompilationError ? error : new SlackCompilationError("invalid_input", "Restore a readable UTF-8 JSON input or a readable SDK item, then retry; no message was sent.");
        return { ok: false, exit_code: refusal.exitCode, code: refusal.code, remediation: refusal.remedy };
    }
}
//# sourceMappingURL=payload-command.js.map