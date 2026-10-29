import { createHash } from "node:crypto";
/** Conservative package budgets, in addition to Slack's individual Block Kit limits. */
export const SLACK_PAYLOAD_BOUNDS = Object.freeze({ blocks: 50, text: 4000, bytes: 65536, inputBytes: 2097152 });
/** Typed refusal suitable for SDK callers and the CLI's nonzero result contract. */
export class SlackCompilationError extends Error {
    /** Stable refusal code; errors never echo source content. */
    code;
    /** A usage refusal, before any remote action. */
    exitCode = 2;
    /** Operator action needed before retry. */
    remedy;
    /** Create a content-free refusal with an actionable remedy. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`);
        this.name = "SlackCompilationError";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Reject malformed data without reflecting possibly private field values. */
function invalid() {
    throw new SlackCompilationError("invalid_input", "Supply the documented static Slack schema, dense bounded arrays, valid strings and explicit recovery/protected paths.");
}
/** Strict objects reject unknown keys and inherited/prototype payloads. */
function object(value, keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid();
    const record = value;
    if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !keys.includes(key)))
        invalid();
    return record;
}
/** Dense bounded arrays are checked before map/forEach can skip holes. */
function array(value, max, min = 1) {
    if (!Array.isArray(value) || value.length < min || value.length > max)
        invalid();
    for (let i = 0; i < value.length; i++)
        if (!Object.hasOwn(value, i))
            invalid();
    if (Reflect.ownKeys(value).length !== value.length + 1)
        invalid();
    return value;
}
/** Preserve whitespace exactly, while refusing lone surrogates and excessive input. */
function string(value, max = SLACK_PAYLOAD_BOUNDS.inputBytes) {
    if (typeof value !== "string" || !value.length || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
        invalid();
    return value;
}
/** Validate URLs without normalizing the recovery coordinate supplied by the caller. */
function url(value) {
    const text = string(value, 3000);
    try {
        const parsed = new URL(text);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\s<>|]/u.test(text))
            invalid();
    }
    catch {
        invalid();
    }
    return text;
}
/** Only finite safe integers in the documented domain can affect compilation decisions. */
function integer(value, fallback, min, max) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
        invalid();
    return value;
}
/** One strict schema serves both the input compiler and outbound wire validator. */
function parsePayload(input, wire) {
    const root = object(input, ["text", "blocks", "mrkdwn", "channel", "thread_ts"]);
    let sourceBytes = 0;
    /** Stop repeated-reference expansion before serialization can allocate an unbounded aggregate string. */
    const boundedString = (value, max = SLACK_PAYLOAD_BOUNDS.inputBytes) => {
        const result = string(value, max);
        sourceBytes += Buffer.byteLength(JSON.stringify(result));
        if (sourceBytes > SLACK_PAYLOAD_BOUNDS.inputBytes)
            invalid();
        return result;
    };
    const payload = { text: boundedString(root.text) };
    const leaves = [{ path: "/text", text: payload.text, cap: SLACK_PAYLOAD_BOUNDS.text, set: (v) => { payload.text = v; }, block: null, element: null }];
    if (root.mrkdwn !== undefined) {
        if (typeof root.mrkdwn !== "boolean")
            invalid();
        payload.mrkdwn = root.mrkdwn;
    }
    if (root.channel !== undefined)
        payload.channel = boundedString(root.channel, 255);
    if (root.thread_ts !== undefined) {
        payload.thread_ts = boundedString(root.thread_ts, 32);
        if (!/^[0-9]{1,20}\.[0-9]{1,10}$/.test(payload.thread_ts))
            invalid();
    }
    const ids = new Set();
    /** Parse a text composition object and record its original location and cap. */
    const text = (value, path, cap, block, element, plain = false) => {
        const row = object(value, ["type", "text", "emoji", "verbatim"]);
        if (row.type !== "plain_text" && (plain || row.type !== "mrkdwn"))
            invalid();
        const result = { type: row.type, text: boundedString(row.text) };
        for (const key of ["emoji", "verbatim"])
            if (row[key] !== undefined) {
                if (typeof row[key] !== "boolean" || (key === "emoji" ? row.type !== "plain_text" : row.type !== "mrkdwn"))
                    invalid();
                result[key] = row[key];
            }
        leaves.push({ path: `${path}/text`, text: result.text, cap, set: (v) => { result.text = v; }, block, element });
        return result;
    };
    if (root.blocks !== undefined)
        payload.blocks = array(root.blocks, wire ? 50 : 500).map((value, i) => {
            const row = object(value, ["type", "block_id", "text", "fields", "elements"]);
            const type = boundedString(row.type, 20);
            const allowed = new Map([["header", ["text"]], ["section", ["text", "fields"]], ["context", ["elements"]], ["actions", ["elements"]], ["divider", []]]);
            const specific = allowed.get(type);
            if (!specific || Object.keys(row).some((key) => !["type", "block_id", ...specific].includes(key)))
                invalid();
            const result = { type };
            if (row.block_id !== undefined) {
                const id = boundedString(row.block_id, 255);
                if (ids.has(id))
                    invalid();
                ids.add(id);
                result.block_id = id;
            }
            if (type === "header")
                result.text = text(row.text, `/blocks/${i}/text`, 150, i, null, true);
            if (type === "section") {
                if (row.text === undefined && row.fields === undefined)
                    invalid();
                if (row.text !== undefined)
                    result.text = text(row.text, `/blocks/${i}/text`, 3000, i, null);
                if (row.fields !== undefined)
                    result.fields = array(row.fields, wire ? 10 : 100).map((v, j) => text(v, `/blocks/${i}/fields/${j}`, 2000, i, j));
            }
            if (type === "context")
                result.elements = array(row.elements, wire ? 10 : 100).map((v, j) => text(v, `/blocks/${i}/elements/${j}`, 3000, i, j));
            if (type === "actions") {
                const actions = new Set();
                result.elements = array(row.elements, wire ? 25 : 100).map((v, j) => {
                    const button = object(v, ["type", "text", "url", "action_id"]);
                    if (button.type !== "button")
                        invalid();
                    const id = boundedString(button.action_id, 255);
                    if (actions.has(id))
                        invalid();
                    actions.add(id);
                    return { type: "button", text: text(button.text, `/blocks/${i}/elements/${j}/text`, 75, i, j, true), url: url(boundedString(button.url, 3000)), action_id: id };
                });
            }
            return result;
        });
    if (wire && leaves.some((leaf) => leaf.text.length > leaf.cap))
        invalid();
    if (Buffer.byteLength(JSON.stringify(payload)) > (wire ? SLACK_PAYLOAD_BOUNDS.bytes : SLACK_PAYLOAD_BOUNDS.inputBytes))
        invalid();
    return { payload, leaves };
}
/** Refuse malformed or oversized wire data before transport opens a socket; no clipping occurs here. */
export function validateSlackWirePayload(input) {
    return parsePayload(input, true).payload;
}
/** Keep Unicode code points intact while measuring conservatively in UTF-16 units. */
function clipped(value, cap) {
    let end = cap - 1;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]))
        end--;
    return { text: value.slice(0, end) + "…", end };
}
/** Compile the validated static schema while retaining original coordinates for the loss ledger. */
export function compileSlackPayload(input) {
    const row = object(input, ["payload", "item", "link", "preserve", "bounds"]);
    const item = string(row.item, 255), link = url(row.link);
    const preserve = new Set(array(row.preserve, 1000, 0).map((v) => string(v, 255)));
    const limits = row.bounds === undefined ? {} : object(row.bounds, ["blocks", "text", "bytes"]);
    const bounds = { blocks: integer(limits.blocks, 50, 1, 50), text: integer(limits.text, 4000, 1, 4000), bytes: integer(limits.bytes, 65536, 512, 65536) };
    const { payload, leaves } = parsePayload(row.payload, false);
    if (Buffer.byteLength(JSON.stringify({ payload, item, link, preserve: [...preserve], bounds })) > SLACK_PAYLOAD_BOUNDS.inputBytes)
        invalid();
    const source_sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const paths = new Set(leaves.map((leaf) => leaf.path));
    if ([...preserve].some((path) => !paths.has(path)))
        invalid();
    const blocks = payload.blocks;
    const required = new Set();
    const blockLeafCounts = new Uint32Array(blocks?.length ?? 0);
    const losses = [];
    const omitted = new Map();
    const excludedElements = new Set();
    /** Protected source content must be split upstream instead of disappearing. */
    const overflow = () => { throw new SlackCompilationError("protected_overflow", "Split the message or raise the configured budget; identity, status and recovery fields must fit intact."); };
    // Each leaf is inspected once, independently of the number of blocks and excess elements.
    for (const leaf of leaves)
        if (leaf.block !== null) {
            blockLeafCounts[leaf.block]++;
            const actions = blocks[leaf.block].type === "actions";
            if (actions)
                preserve.add(leaf.path); // Recovery links and labels are always critical.
            if (preserve.has(leaf.path))
                required.add(leaf.block);
            if (leaf.element !== null && leaf.element >= (actions ? 25 : 10)) {
                if (preserve.has(leaf.path))
                    overflow();
                excludedElements.add(leaf.path);
            }
        }
    if (required.size > bounds.blocks)
        overflow();
    let remaining = bounds.blocks - required.size;
    blocks?.forEach((block, i) => {
        if (!required.has(i)) {
            if (remaining-- <= 0)
                omitted.set(i, "block_limit");
        }
        for (const key of ["fields", "elements"])
            if (Array.isArray(block[key])) {
                const elements = block[key];
                const cap = block.type === "actions" ? 25 : 10;
                block[key] = elements.slice(0, cap);
            }
    });
    const clippedEnds = new Map();
    const clippedReasons = new Map();
    for (const leaf of leaves) {
        const cap = leaf.block === null ? bounds.text : leaf.cap;
        if (preserve.has(leaf.path) && leaf.text.length > cap)
            overflow();
        if (leaf.text.length > cap) {
            const result = clipped(leaf.text, cap);
            leaf.set(result.text);
            clippedEnds.set(leaf.path, result.end);
            clippedReasons.set(leaf.path, "text_limit");
        }
    }
    // Serialize each block once; dropping a block changes only its cost and one comma.
    const { blocks: _blocks, ...fallback } = payload;
    const baseBytes = Buffer.byteLength(JSON.stringify(fallback));
    const blockBytes = blocks?.map((block) => Buffer.byteLength(JSON.stringify(block))) ?? [];
    let selectedCount = 0, selectedBytes = 0;
    blockBytes.forEach((size, i) => { if (!omitted.has(i)) {
        selectedCount++;
        selectedBytes += size;
    } });
    /** Exact JSON object/array punctuation overhead, without serializing the remaining collection again. */
    const size = () => baseBytes + (selectedCount ? Buffer.byteLength(',"blocks":[]') + selectedBytes + selectedCount - 1 : 0);
    let bytes = size();
    for (let i = (blocks?.length ?? 0) - 1; bytes > bounds.bytes && i >= 0; i--) {
        if (required.has(i) || omitted.has(i))
            continue;
        omitted.set(i, "byte_limit");
        selectedCount--;
        selectedBytes -= blockBytes[i];
        bytes = size();
    }
    if (blocks) {
        payload.blocks = blocks.filter((_block, i) => !omitted.has(i));
        if (!payload.blocks.length)
            delete payload.blocks;
    }
    if (bytes > bounds.bytes && !preserve.has("/text")) {
        const source = leaves[0].text;
        const fixedBytes = bytes - Buffer.byteLength(JSON.stringify(payload.text));
        let lo = 1, hi = Math.min(bounds.text, source.length), selected = clipped(source, 1);
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2), candidate = clipped(source, mid);
            if (fixedBytes + Buffer.byteLength(JSON.stringify(candidate.text)) <= bounds.bytes) {
                selected = candidate;
                lo = mid + 1;
            }
            else
                hi = mid - 1;
        }
        payload.text = selected.text;
        clippedEnds.set("/text", selected.end);
        clippedReasons.set("/text", "byte_limit");
    }
    bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > bounds.bytes)
        overflow();
    for (const leaf of leaves) {
        const omission = leaf.block === null ? undefined : omitted.get(leaf.block);
        const reason = omission ?? (excludedElements.has(leaf.path) ? "element_limit" : clippedReasons.get(leaf.path));
        if (reason)
            losses.push({ path: leaf.path, start: omission || excludedElements.has(leaf.path) ? 0 : clippedEnds.get(leaf.path), end: leaf.text.length, reason, item, link });
    }
    // Non-text blocks still receive a structural omission receipt.
    for (const [i, reason] of omitted)
        if (blockLeafCounts[i] === 0)
            losses.push({ path: `/blocks/${i}`, start: 0, end: 0, reason, item, link });
    validateSlackWirePayload(payload);
    return { ok: true, source_sha256, payload, bytes, bounds, losses };
}
/** Read one item through the host-injected SDK; all identity, lifecycle and relationship fields remain protected. */
export async function compileSlackItem(client, id, link, bounds) {
    string(id, 255);
    url(link);
    const source = await client.get(id, { depth: "full", noTruncate: true, outputBudget: "unbounded", outputLimit: "unbounded" });
    return compileSlackItemRead(source, link, bounds);
}
/** Internal full-read adapter; public consumers use compileSlackItem so this package controls the read projection. @internal */
export function compileSlackItemRead(source, link, bounds) {
    if (!("item" in source))
        throw new SlackCompilationError("invalid_input", "Read the full unbounded SDK item before compiling; a budget refusal is not source content.");
    const { item } = source;
    if (typeof item.body !== "string" || source.output_budget_truncation !== undefined)
        throw new SlackCompilationError("invalid_input", "Read the full SDK item with its body and unbounded output before compiling; projected content cannot prove source loss.");
    const fields = [item.id, item.type, item.status, item.priority, item.assignee, item.parent, item.dependencies].map((value) => JSON.stringify(value ?? null));
    const names = ["Item", "Type", "Status", "Priority", "Assignee", "Parent", "Dependencies"];
    const payload = { text: `${item.id} · ${item.status} · ${link}`, blocks: [
            { type: "header", text: { type: "plain_text", text: item.title } },
            { type: "section", fields: fields.map((value, i) => ({ type: "plain_text", text: `${names[i]}: ${value}` })) },
            ...(item.body ? [{ type: "section", text: { type: "plain_text", text: item.body } }] : []),
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open full item" }, url: link, action_id: "pm_slack_recover" }] },
        ] };
    return compileSlackPayload({ payload, item: item.id, link, preserve: ["/text", ...fields.map((_v, i) => `/blocks/1/fields/${i}/text`)], ...(bounds ? { bounds } : {}) });
}
/** Compact ledger projection avoids echoing message bodies into agent output. Payload access is explicit in the CLI. */
export function slackCompilationSummary(result, limit = 20, after = 0) {
    integer(limit, 20, 1, 100);
    integer(after, 0, 0, 100000);
    const losses = result.losses.slice(after, after + limit);
    return { ok: result.ok, source_sha256: result.source_sha256, bytes: result.bytes, blocks: result.payload.blocks?.length ?? 0, bounds: result.bounds, losses,
        total_losses: result.losses.length, omitted: result.losses.length - losses.length, next_cursor: after + losses.length < result.losses.length ? after + losses.length : null };
}
/** Render the compact ledger using the same keys and values as JSON. */
export function slackCompilationToon(result) {
    return ["ok: true", `source_sha256: ${JSON.stringify(result.source_sha256)}`, `bytes: ${result.bytes}`, `blocks: ${result.blocks}`, "bounds:", ...Object.entries(result.bounds).map(([key, value]) => `  ${key}: ${value}`),
        `total_losses: ${result.total_losses}`, `omitted: ${result.omitted}`, `next_cursor: ${result.next_cursor}`,
        `losses[${result.losses.length}]{path,start,end,reason,item,link}:`, ...result.losses.map((row) => `  ${[row.path, row.start, row.end, row.reason, row.item, row.link].map((v) => JSON.stringify(v)).join(",")}`)].join("\n");
}
//# sourceMappingURL=payload-compilation.js.map