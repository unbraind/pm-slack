/** Expected input refusal shared by SDK and CLI without reflecting private inputs. */
export class SlackRoutingError extends Error {
    /** Host-compatible nonzero usage status. */
    exitCode = 2;
    /** Machine-readable cause suitable for agent branching. */
    code;
    /** Concrete recovery action, free of user input and local paths. */
    remedy;
    /** Construct a safe expected refusal. */
    constructor(code, remedy) {
        super(code);
        this.name = "PmCliError";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Validate the entire identity once, rejecting unknown fields and unsafe or unbounded values. */
export function validateSlackRoutingIdentity(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        throw invalidIdentity();
    const value = input;
    const keys = Object.keys(value);
    if ((keys.length !== 3 && keys.length !== 4) || !keys.every((key) => ["item", "event", "revision", "version"].includes(key)) || (Object.hasOwn(value, "version") && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) || typeof value.item !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value.item) || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || typeof value.event !== "string" || !["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"].includes(value.event))
        throw invalidIdentity();
}
/** Give every schema failure the same bounded remedy. */
function invalidIdentity() {
    return new SlackRoutingError("invalid_routing_input", "Supply item, canonical event, a lowercase 64-character SDK history revision and optionally a positive safe integer mutation version; use the SDK mutation feed to discover identities.");
}
/** Render only the fixed diagnostic schema; JSON quoting preserves TOON scalar boundaries. */
export function slackRoutingToon(report) {
    return ["ok: true", `outcome: ${report.outcome}`, "identity:", ...Object.entries(report.identity).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
        "eligibility:", ...Object.entries(report.eligibility).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
        ...(report.state === undefined ? [] : [`state: ${report.state}`, `attempts: ${report.attempts}`]),
        ...(report.attempt_evidence === undefined ? [] : ["attempt_evidence:", ...Object.entries(report.attempt_evidence).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)]),
        `path[${report.path.length}]{stage,policy,decision,source,rule}:`, ...report.path.map((step) => `  ${[step.stage, step.policy, step.decision, step.source, step.rule ?? null].map((value) => JSON.stringify(value)).join(",")}`),
        `uncertainty[${report.uncertainty.length}]: ${report.uncertainty.map((value) => JSON.stringify(value)).join(",")}`].join("\n");
}
//# sourceMappingURL=routing-explanation.js.map