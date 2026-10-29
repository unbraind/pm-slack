/** Pure Slack wire compilation. Receipts refer to the unchanged input using UTF-16 half-open ranges. */
import type { PmClient, GetResult, PmReadOutputBudgetExceeded } from "@unbrained/pm-cli/sdk";
import { createHash } from "node:crypto";

/** A static block whose type has passed the shared wire schema. */
export interface CompiledSlackBlock extends Record<string, unknown> {
  /** Slack block discriminator. */
  type: string;
}

/** Conservative package budgets, in addition to Slack's individual Block Kit limits. */
export const SLACK_PAYLOAD_BOUNDS = Object.freeze({ blocks: 50, text: 4000, bytes: 65536, inputBytes: 2097152 });

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
  bounds?: { blocks?: number; text?: number; bytes?: number };
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
  bounds: { blocks: number; text: number; bytes: number };
  /** Exact original source exclusions, ordered by traversal. */
  losses: SlackLossReceipt[];
}

/** Typed refusal suitable for SDK callers and the CLI's nonzero result contract. */
export class SlackCompilationError extends Error {
  /** Stable refusal code; errors never echo source content. */
  readonly code: "invalid_input" | "protected_overflow";
  /** A usage refusal, before any remote action. */
  readonly exitCode = 2;
  /** Operator action needed before retry. */
  readonly remedy: string;
  /** Create a content-free refusal with an actionable remedy. */
  constructor(code: SlackCompilationError["code"], remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "SlackCompilationError";
    this.code = code;
    this.remedy = remedy;
  }
}

type Leaf = { path: string; text: string; cap: number; set: (value: string) => void; block: number | null; element: number | null };
type Parsed = { payload: CompiledSlackPayload; leaves: Leaf[] };

/** Reject malformed data without reflecting possibly private field values. */
function invalid(): never {
  throw new SlackCompilationError("invalid_input", "Supply the documented static Slack schema, dense bounded arrays, valid strings and explicit recovery/protected paths.");
}

/** Strict objects reject unknown keys and inherited/prototype payloads. */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  return record;
}

/** Dense bounded arrays are checked before map/forEach can skip holes. */
function array(value: unknown, max: number, min = 1): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return value;
}

/** Preserve whitespace exactly, while refusing lone surrogates and excessive input. */
function string(value: unknown, max: number = SLACK_PAYLOAD_BOUNDS.inputBytes): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}

/** Validate URLs without normalizing the recovery coordinate supplied by the caller. */
function url(value: unknown): string {
  const text = string(value, 3000);
  try {
    const parsed = new URL(text);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\s<>|]/u.test(text)) invalid();
  } catch { invalid(); }
  return text;
}

/** Only finite safe integers in the documented domain can affect compilation decisions. */
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

/** One strict schema serves both the input compiler and outbound wire validator. */
function parsePayload(input: unknown, wire: boolean): Parsed {
  const root = object(input, ["text", "blocks", "mrkdwn", "channel", "thread_ts"]);
  let sourceBytes = 0;
  /** Stop repeated-reference expansion before serialization can allocate an unbounded aggregate string. */
  const boundedString = (value: unknown, max: number = SLACK_PAYLOAD_BOUNDS.inputBytes): string => {
    const result = string(value, max);
    sourceBytes += Buffer.byteLength(JSON.stringify(result));
    if (sourceBytes > SLACK_PAYLOAD_BOUNDS.inputBytes) invalid();
    return result;
  };
  const payload: CompiledSlackPayload = { text: boundedString(root.text) };
  const leaves: Leaf[] = [{ path: "/text", text: payload.text, cap: SLACK_PAYLOAD_BOUNDS.text, set: (v) => { payload.text = v; }, block: null, element: null }];
  if (root.mrkdwn !== undefined) {
    if (typeof root.mrkdwn !== "boolean") invalid();
    payload.mrkdwn = root.mrkdwn;
  }
  if (root.channel !== undefined) payload.channel = boundedString(root.channel, 255);
  if (root.thread_ts !== undefined) {
    payload.thread_ts = boundedString(root.thread_ts, 32);
    if (!/^[0-9]{1,20}\.[0-9]{1,10}$/.test(payload.thread_ts)) invalid();
  }
  const ids = new Set<string>();
  /** Parse a text composition object and record its original location and cap. */
  const text = (value: unknown, path: string, cap: number, block: number, element: number | null, plain = false): Record<string, unknown> => {
    const row = object(value, ["type", "text", "emoji", "verbatim"]);
    if (row.type !== "plain_text" && (plain || row.type !== "mrkdwn")) invalid();
    const result: Record<string, unknown> = { type: row.type, text: boundedString(row.text) };
    for (const key of ["emoji", "verbatim"]) if (row[key] !== undefined) {
      if (typeof row[key] !== "boolean" || (key === "emoji" ? row.type !== "plain_text" : row.type !== "mrkdwn")) invalid();
      result[key] = row[key];
    }
    leaves.push({ path: `${path}/text`, text: result.text as string, cap, set: (v) => { result.text = v; }, block, element });
    return result;
  };
  if (root.blocks !== undefined) payload.blocks = array(root.blocks, wire ? 50 : 500).map((value, i) => {
    const row = object(value, ["type", "block_id", "text", "fields", "elements"]);
    const type = boundedString(row.type, 20);
    const allowed = new Map<string, string[]>([["header", ["text"]], ["section", ["text", "fields"]], ["context", ["elements"]], ["actions", ["elements"]], ["divider", []]]);
    const specific = allowed.get(type);
    if (!specific || Object.keys(row).some((key) => !["type", "block_id", ...specific].includes(key))) invalid();
    const result: CompiledSlackBlock = { type };
    if (row.block_id !== undefined) {
      const id = boundedString(row.block_id, 255);
      if (ids.has(id)) invalid();
      ids.add(id); result.block_id = id;
    }
    if (type === "header") result.text = text(row.text, `/blocks/${i}/text`, 150, i, null, true);
    if (type === "section") {
      if (row.text === undefined && row.fields === undefined) invalid();
      if (row.text !== undefined) result.text = text(row.text, `/blocks/${i}/text`, 3000, i, null);
      if (row.fields !== undefined) result.fields = array(row.fields, wire ? 10 : 100).map((v, j) => text(v, `/blocks/${i}/fields/${j}`, 2000, i, j));
    }
    if (type === "context") result.elements = array(row.elements, wire ? 10 : 100).map((v, j) => text(v, `/blocks/${i}/elements/${j}`, 3000, i, j));
    if (type === "actions") {
      const actions = new Set<string>();
      result.elements = array(row.elements, wire ? 25 : 100).map((v, j) => {
        const button = object(v, ["type", "text", "url", "action_id"]);
        if (button.type !== "button") invalid();
        const id = boundedString(button.action_id, 255);
        if (actions.has(id)) invalid();
        actions.add(id);
        return { type: "button", text: text(button.text, `/blocks/${i}/elements/${j}/text`, 75, i, j, true), url: url(boundedString(button.url, 3000)), action_id: id };
      });
    }
    return result;
  });
  if (wire && leaves.some((leaf) => leaf.text.length > leaf.cap)) invalid();
  if (Buffer.byteLength(JSON.stringify(payload)) > (wire ? SLACK_PAYLOAD_BOUNDS.bytes : SLACK_PAYLOAD_BOUNDS.inputBytes)) invalid();
  return { payload, leaves };
}

/** Refuse malformed or oversized wire data before transport opens a socket; no clipping occurs here. */
export function validateSlackWirePayload(input: unknown): CompiledSlackPayload {
  return parsePayload(input, true).payload;
}

/** Keep Unicode code points intact while measuring conservatively in UTF-16 units. */
function clipped(value: string, cap: number): { text: string; end: number } {
  let end = cap - 1;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return { text: value.slice(0, end) + "…", end };
}

/** Compile raw static Slack content once; every removed source span has exactly one linked receipt. */
export function compileSlackPayload(input: SlackCompilationInput): SlackCompilation;
/** Validate untrusted JSON through the same boundary as typed SDK input. */
export function compileSlackPayload(input: unknown): SlackCompilation;
/** Compile the validated static schema while retaining original coordinates for the loss ledger. */
export function compileSlackPayload(input: unknown): SlackCompilation {
  const row = object(input, ["payload", "item", "link", "preserve", "bounds"]);
  const item = string(row.item, 255), link = url(row.link);
  const preserve = new Set(array(row.preserve, 1000, 0).map((v) => string(v, 255)));
  const limits = row.bounds === undefined ? {} : object(row.bounds, ["blocks", "text", "bytes"]);
  const bounds = { blocks: integer(limits.blocks, 50, 1, 50), text: integer(limits.text, 4000, 1, 4000), bytes: integer(limits.bytes, 65536, 512, 65536) };
  const { payload, leaves } = parsePayload(row.payload, false);
  if (Buffer.byteLength(JSON.stringify({ payload, item, link, preserve: [...preserve], bounds })) > SLACK_PAYLOAD_BOUNDS.inputBytes) invalid();
  const source_sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const paths = new Set(leaves.map((leaf) => leaf.path));
  if ([...preserve].some((path) => !paths.has(path))) invalid();
  const required = new Set(leaves.filter((leaf) => preserve.has(leaf.path)).map((leaf) => leaf.block));
  // URL buttons are always recovery-critical, even when a caller forgets to protect their labels.
  payload.blocks?.forEach((block, i) => { if (block.type === "actions") { required.add(i); leaves.filter((leaf) => leaf.block === i).forEach((leaf) => preserve.add(leaf.path)); } });
  const losses: SlackLossReceipt[] = [];
  const omitted = new Map<number, SlackLossReceipt["reason"]>();
  const excludedElements = new Set<string>();
  /** Protected source content must be split upstream instead of disappearing. */
  const overflow = (): never => { throw new SlackCompilationError("protected_overflow", "Split the message or raise the configured budget; identity, status and recovery fields must fit intact."); };
  if ([...required].filter((i) => i !== null).length > bounds.blocks) overflow();
  let remaining = bounds.blocks - [...required].filter((i) => i !== null).length;
  payload.blocks?.forEach((block, i) => {
    if (!required.has(i)) { if (remaining-- <= 0) omitted.set(i, "block_limit"); }
    for (const key of ["fields", "elements"]) if (Array.isArray(block[key])) {
      const elements = block[key] as unknown[];
      const cap = block.type === "actions" ? 25 : 10;
      for (let j = cap; j < elements.length; j++) {
        const affected = leaves.filter((leaf) => leaf.block === i && leaf.element === j);
        if (affected.some((leaf) => preserve.has(leaf.path))) overflow();
        affected.forEach((leaf) => excludedElements.add(leaf.path));
      }
      block[key] = elements.slice(0, cap);
    }
  });
  const clippedEnds = new Map<string, number>();
  const clippedReasons = new Map<string, SlackLossReceipt["reason"]>();
  for (const leaf of leaves) {
    const cap = leaf.block === null ? bounds.text : leaf.cap;
    if (preserve.has(leaf.path) && leaf.text.length > cap) overflow();
    if (leaf.text.length > cap) {
      const result = clipped(leaf.text, cap); leaf.set(result.text); clippedEnds.set(leaf.path, result.end); clippedReasons.set(leaf.path, "text_limit");
    }
  }
  const blocks = payload.blocks;
  /** Materialize the selected blocks without changing the source coordinates used by receipts. */
  const materialize = (): void => {
    if (blocks) {
      payload.blocks = blocks.filter((_block, i) => !omitted.has(i));
      if (!payload.blocks.length) delete payload.blocks;
    }
  };
  materialize();
  let bytes = Buffer.byteLength(JSON.stringify(payload));
  for (let i = (blocks?.length ?? 0) - 1; bytes > bounds.bytes && i >= 0; i--) {
    if (required.has(i) || omitted.has(i)) continue;
    omitted.set(i, "byte_limit"); materialize(); bytes = Buffer.byteLength(JSON.stringify(payload));
  }
  if (bytes > bounds.bytes && !preserve.has("/text")) {
    const source = leaves[0]!.text;
    let lo = 1, hi = Math.min(bounds.text, source.length), selected = clipped(source, 1);
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2), candidate = clipped(source, mid);
      payload.text = candidate.text;
      if (Buffer.byteLength(JSON.stringify(payload)) <= bounds.bytes) { selected = candidate; lo = mid + 1; }
      else hi = mid - 1;
    }
    payload.text = selected.text; clippedEnds.set("/text", selected.end); clippedReasons.set("/text", "byte_limit");
    bytes = Buffer.byteLength(JSON.stringify(payload));
  }
  if (bytes > bounds.bytes) overflow();
  for (const leaf of leaves) {
    const omission = leaf.block === null ? undefined : omitted.get(leaf.block);
    const reason = omission ?? (excludedElements.has(leaf.path) ? "element_limit" : clippedReasons.get(leaf.path));
    if (reason) losses.push({ path: leaf.path, start: omission || excludedElements.has(leaf.path) ? 0 : clippedEnds.get(leaf.path)!, end: leaf.text.length, reason, item, link });
  }
  // Non-text blocks still receive a structural omission receipt.
  for (const [i, reason] of omitted) if (!leaves.some((leaf) => leaf.block === i)) losses.push({ path: `/blocks/${i}`, start: 0, end: 0, reason, item, link });
  validateSlackWirePayload(payload);
  return { ok: true, source_sha256, payload, bytes, bounds, losses };
}

/** Read one item through the host-injected SDK; all identity, lifecycle and relationship fields remain protected. */
export async function compileSlackItem(client: Pick<PmClient, "get">, id: string, link: string, bounds?: SlackCompilationInput["bounds"]): Promise<SlackCompilation> {
  string(id, 255); url(link);
  const source = await client.get(id, { depth: "full", noTruncate: true, outputBudget: "unbounded", outputLimit: "unbounded" });
  return compileSlackItemRead(source, link, bounds);
}

/** Internal full-read adapter; public consumers use compileSlackItem so this package controls the read projection. @internal */
export function compileSlackItemRead(source: GetResult | PmReadOutputBudgetExceeded, link: string, bounds?: SlackCompilationInput["bounds"]): SlackCompilation {
  if (!("item" in source)) throw new SlackCompilationError("invalid_input", "Read the full unbounded SDK item before compiling; a budget refusal is not source content.");
  const { item } = source;
  if (typeof item.body !== "string" || source.output_budget_truncation !== undefined) throw new SlackCompilationError("invalid_input", "Read the full SDK item with its body and unbounded output before compiling; projected content cannot prove source loss.");
  const fields = [item.id, item.type, item.status, item.priority, item.assignee, item.parent, item.dependencies].map((value) => JSON.stringify(value ?? null));
  const names = ["Item", "Type", "Status", "Priority", "Assignee", "Parent", "Dependencies"];
  const payload: CompiledSlackPayload = { text: `${item.id} · ${item.status} · ${link}`, blocks: [
    { type: "header", text: { type: "plain_text", text: item.title } },
    { type: "section", fields: fields.map((value, i) => ({ type: "plain_text", text: `${names[i]}: ${value}` })) },
    ...(item.body ? [{ type: "section", text: { type: "plain_text", text: item.body } }] : []),
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open full item" }, url: link, action_id: "pm_slack_recover" }] },
  ] };
  return compileSlackPayload({ payload, item: item.id, link, preserve: ["/text", ...fields.map((_v, i) => `/blocks/1/fields/${i}/text`)], ...(bounds ? { bounds } : {}) });
}

/** Compact ledger projection avoids echoing message bodies into agent output. Payload access is explicit in the CLI. */
export function slackCompilationSummary(result: SlackCompilation, limit = 20, after = 0) {
  integer(limit, 20, 1, 100); integer(after, 0, 0, 100000);
  const losses = result.losses.slice(after, after + limit);
  return { ok: result.ok, source_sha256: result.source_sha256, bytes: result.bytes, blocks: result.payload.blocks?.length ?? 0, bounds: result.bounds, losses,
    total_losses: result.losses.length, omitted: result.losses.length - losses.length, next_cursor: after + losses.length < result.losses.length ? after + losses.length : null };
}

/** Render the compact ledger using the same keys and values as JSON. */
export function slackCompilationToon(result: ReturnType<typeof slackCompilationSummary>): string {
  return ["ok: true", `source_sha256: ${JSON.stringify(result.source_sha256)}`, `bytes: ${result.bytes}`, `blocks: ${result.blocks}`, "bounds:", ...Object.entries(result.bounds).map(([key, value]) => `  ${key}: ${value}`),
    `total_losses: ${result.total_losses}`, `omitted: ${result.omitted}`, `next_cursor: ${result.next_cursor}`,
    `losses[${result.losses.length}]{path,start,end,reason,item,link}:`, ...result.losses.map((row) => `  ${[row.path, row.start, row.end, row.reason, row.item, row.link].map((v) => JSON.stringify(v)).join(",")}`)].join("\n");
}
