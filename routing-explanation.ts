/** Public contracts and the single strict request boundary for offline routing diagnosis. */
import type { SlackDeliveryEvidence, SlackDeliveryOutcome } from "./delivery-evidence.ts";
import type { OutboxEvent, OutboxState } from "./outbox.ts";

/** Exact committed event identity; revisions prevent conflating repeated transitions. */
export interface SlackRoutingIdentity {
  /** Canonical tracker item identifier, at most 160 safe characters. */
  item: string;
  /** Canonical lifecycle transition. */
  event: OutboxEvent;
  /** SDK history after_hash identifying the committed transition. */
  revision: string;
  /** Optional one-based SDK mutation version; required when a state hash repeats. */
  version?: number;
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
  outcome: SlackDeliveryOutcome;
  /** Exact safe filter operands, so a historical priority exclusion needs no second inspection. */
  eligibility: {
    /** Event filter result; null means no configuration evidence. */
    event_enabled: boolean | null;
    /** Priority at the requested revision; null means unspecified and passes the filter. */
    priority: number | null;
    /** Inclusive priority ceiling, from 1 through 4, or null without evidence. */
    min_priority: number | null;
    /** Retained epoch, current configuration, or no evidence. */
    source: "retained" | "current_config" | "unknown";
  };
  /** One complete ordered path through filters, routes, coalescing and transport. */
  path: SlackRoutingStep[];
  /** Durable state when an exact receipt was retained. */
  state?: OutboxState;
  /** Count of persisted transport attempts, if known. */
  attempts?: number;
  /** Bounded proof over all attempts and operator resolutions when retained. */
  attempt_evidence?: SlackDeliveryEvidence;
  /** Explicit limits on retrospective knowledge, expressed as stable codes. */
  uncertainty: string[];
}

/** Expected input refusal shared by SDK and CLI without reflecting private inputs. */
export class SlackRoutingError extends Error {
  /** Host-compatible nonzero usage status. */
  readonly exitCode = 2;
  /** Machine-readable cause suitable for agent branching. */
  readonly code: "invalid_routing_input" | "event_not_found" | "event_ambiguous" | "routing_config_invalid";
  /** Concrete recovery action, free of user input and local paths. */
  readonly remedy: string;
  /** Construct a safe expected refusal. */
  constructor(code: SlackRoutingError["code"], remedy: string) {
    super(code);
    this.name = "PmCliError";
    this.code = code;
    this.remedy = remedy;
  }
}

/** Validate the entire identity once, rejecting unknown fields and unsafe or unbounded values. */
export function validateSlackRoutingIdentity(input: unknown): asserts input is SlackRoutingIdentity {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidIdentity();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if ((keys.length !== 3 && keys.length !== 4) || !keys.every((key) => ["item", "event", "revision", "version"].includes(key)) || (Object.hasOwn(value, "version") && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) || typeof value.item !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value.item) || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || typeof value.event !== "string" || !["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"].includes(value.event)) throw invalidIdentity();
}

/** Give every schema failure the same bounded remedy. */
function invalidIdentity(): SlackRoutingError {
  return new SlackRoutingError("invalid_routing_input", "Supply item, canonical event, a lowercase 64-character SDK history revision and optionally a positive safe integer mutation version; use the SDK mutation feed to discover identities.");
}

/** Render only the fixed diagnostic schema; JSON quoting preserves TOON scalar boundaries. */
export function slackRoutingToon(report: SlackRoutingExplanation): string {
  return ["ok: true", `outcome: ${report.outcome}`, "identity:", ...Object.entries(report.identity).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
    "eligibility:", ...Object.entries(report.eligibility).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
    ...(report.state === undefined ? [] : [`state: ${report.state}`, `attempts: ${report.attempts}`]),
    ...(report.attempt_evidence === undefined ? [] : ["attempt_evidence:", ...Object.entries(report.attempt_evidence).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)]),
    `path[${report.path.length}]{stage,policy,decision,source,rule}:`, ...report.path.map((step) => `  ${[step.stage, step.policy, step.decision, step.source, step.rule ?? null].map((value) => JSON.stringify(value)).join(",")}`),
    `uncertainty[${report.uncertainty.length}]: ${report.uncertainty.map((value) => JSON.stringify(value)).join(",")}`].join("\n");
}
