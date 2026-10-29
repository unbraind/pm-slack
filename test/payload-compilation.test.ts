/** Exact loss accounting and real non-git SDK state, without network or SDK mocks. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import test from "node:test";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk";
import { init, create, update, focus, PmClient, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";
import extension, { __test__, compileSlackItem, compileSlackPayload, SlackCompilationError, validateSlackWirePayload } from "../index.ts";
import type { SlackCompilationInput, SlackCompilation } from "../index.ts";
import { slackCompilationSummary, slackCompilationToon, compileSlackItemRead } from "../payload-compilation.ts";
import { runSlackCompilationCommand } from "../payload-command.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

/** A complete caller declaration; identity paths are never inferred from localized labels. */
function input(payload: SlackCompilationInput["payload"] = { text: "fallback" }): SlackCompilationInput {
  return { payload, item: "task-1", link: "https://example.com/item/task-1", preserve: [] };
}

/** Typed refusal must include a usable next action without reflecting source content. */
function refuses(code = "invalid_input") {
  return (e: unknown) => e instanceof SlackCompilationError && e.code === code && e.exitCode === 2 && e.remedy.length > 20;
}

/** Resolve original source coordinates independently of the compiler's traversal. */
function at(value: unknown, pointer: string): unknown {
  for (const key of pointer.slice(1).split("/")) value = (value as Record<string, unknown>)[key];
  return value;
}

/** Every exclusion covers exactly the removed suffix, and both output producers round-trip. */
function verify(source: SlackCompilationInput, result: SlackCompilation) {
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.payload)));
  assert.ok(result.bytes <= result.bounds.bytes);
  assert.ok((result.payload.blocks?.length ?? 0) <= result.bounds.blocks);
  assert.deepEqual(validateSlackWirePayload(result.payload), result.payload);
  const seen = new Set<string>();
  for (const receipt of result.losses) {
    assert.equal(receipt.item, source.item); assert.equal(receipt.link, source.link);
    assert.ok(!seen.has(receipt.path)); seen.add(receipt.path);
    const original = at(source.payload, receipt.path);
    if (typeof original === "string") {
      assert.equal(receipt.end, original.length);
      assert.ok(receipt.start >= 0 && receipt.start < receipt.end);
      assert.ok(!/[\uD800-\uDBFF]/u.test(original[receipt.start - 1] ?? ""));
      if (receipt.reason === "text_limit") assert.equal(at(result.payload, receipt.path), original.slice(0, receipt.start) + "…");
    } else assert.equal(receipt.start + receipt.end, 0);
  }
  const summary = slackCompilationSummary(result);
  assert.deepEqual(decode(slackCompilationToon(summary)), JSON.parse(JSON.stringify(summary)));
  /** Every emitted numeric leaf is bounded and finite, including pagination and receipt spans. */
  const numeric = (value: unknown): void => {
    if (typeof value === "number") assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 2097152);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(numeric);
  };
  numeric(summary);
}

test("bounded Block Kit compilation accounts for every clipped and omitted field and keeps critical blocks", () => {
  const fields = Array.from({ length: 12 }, (_v, i) => ({ type: "plain_text", text: `${i}:` + "é".repeat(2200) }));
  const source = input({ text: "fallback".repeat(1000), channel: "#channel", thread_ts: "123.00001", mrkdwn: false, blocks: [
    { type: "header", text: { type: "plain_text", text: "x".repeat(149) + "😀end", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "x".repeat(4000), verbatim: false }, fields },
    { type: "context", elements: Array.from({ length: 12 }, () => ({ type: "mrkdwn", text: "c".repeat(3001) })) },
    { type: "divider" },
    { type: "section", fields: [{ type: "plain_text", text: "urgent task-1 blocked" }] },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Recover" }, url: sourceLink(), action_id: "recover" }] },
  ] });
  source.preserve = ["/blocks/4/fields/0/text"];
  const result = compileSlackPayload(source);
  verify(source, result);
  assert.equal(result.losses.length, 28);
  const tight = compileSlackPayload({ ...source, bounds: { blocks: 2 } });
  assert.equal(tight.payload.blocks?.length, 2);
  assert.deepEqual(tight.payload.blocks, source.payload.blocks?.slice(4));
  assert.equal(tight.losses.filter((r) => r.reason === "block_limit").length, 27);
  assert.equal(tight.losses.find((r) => r.path === "/blocks/0/text/text")?.start, 0, "omission replaces earlier clipping, without duplicate ranges");
  assert.throws(() => compileSlackPayload({ ...source, bounds: { blocks: 1 } }), refuses("protected_overflow"));
});

/** Stable URL reused by recovery-button fixtures. */
function sourceLink() { return "https://example.com/item/task-1"; }

test("byte budgets remove optional blocks then clip fallback exactly, with finite boundary decisions", () => {
  const source = input({ text: "😀".repeat(2500), blocks: Array.from({ length: 50 }, () => ({ type: "section", text: { type: "plain_text", text: "漢".repeat(3000) } })) });
  const result = compileSlackPayload({ ...source, bounds: { bytes: 512 } });
  verify({ ...source, bounds: { bytes: 512 } }, result);
  assert.equal(result.losses.filter((r) => r.reason === "byte_limit").length, 51);
  assert.ok(result.bytes >= 508 && result.bytes <= 512);
  assert.throws(() => compileSlackPayload({ ...source, preserve: ["/text"], bounds: { bytes: 512 } }), refuses("protected_overflow"));
  const protectedBlock = input({ text: "x".repeat(1000), blocks: [{ type: "section", fields: [{ type: "plain_text", text: "y".repeat(1000) }] }] });
  assert.throws(() => compileSlackPayload({ ...protectedBlock, preserve: ["/blocks/0/fields/0/text"], bounds: { bytes: 512 } }), refuses("protected_overflow"));
  const one = compileSlackPayload({ ...input({ text: "abc" }), bounds: { text: 1 } });
  assert.equal(one.payload.text, "…"); assert.equal(one.losses[0]?.start, 0);
  for (const n of [149, 150, 151, 1999, 2000, 2001, 2999, 3000, 3001, 3999, 4000, 4001]) {
    const s = input({ text: "x".repeat(n) }); verify(s, compileSlackPayload(s));
  }
});

test("strict schema refuses malformed/extreme inputs and preserves previously valid static payloads", () => {
  const broken: unknown[] = [null, [], {}, { ...input(), extra: true }, { ...input(), item: "" }, { ...input(), link: "javascript:void(0)" }, { ...input(), link: "https://u:p@example.com" }, { ...input(), link: "https://example.com/a b" }, { ...input(), link: "://" },
    { ...input(), preserve: ["/missing"] }, { ...input(), preserve: [3] }, { ...input(), preserve: new Array(1) }, { ...input(), preserve: Array(1001).fill("/text") },
    { ...input(), payload: { text: "\ud800" } }, { ...input(), payload: { text: "\udc00" } }, { ...input(), payload: { text: "" } },
    { ...input(), payload: { text: "x", blocks: new Array(1) } }, { ...input(), payload: { text: "x", blocks: [] } }, { ...input(), payload: { text: "x", blocks: Array(501).fill({ type: "divider" }) } },
    { ...input(), payload: { text: "x", mrkdwn: "yes" } }, { ...input(), payload: { text: "x", thread_ts: "yesterday" } },
    { ...input(), payload: { text: "x", channel: "x".repeat(256) } }, { ...input(), payload: { text: "x", attachments: [] } },
  ];
  for (const n of [NaN, Infinity, -Infinity, -1, 0, 1.5, Number.MAX_VALUE, "50", null]) for (const key of ["text", "blocks", "bytes"]) broken.push({ ...input(), bounds: { [key]: n } });
  for (const bounds of [{ blocks: 51 }, { bytes: 511 }, { bytes: 65537 }, { text: 4001 }, { unknown: 1 }]) broken.push({ ...input(), bounds });
  const badBlocks = [
    { type: "unsupported" }, { type: "divider", text: {} }, { type: "section" }, { type: "header", text: { type: "mrkdwn", text: "x" } },
    { type: "section", text: { type: "html", text: "x" } }, { type: "section", text: { type: "mrkdwn", text: "x", emoji: true } },
    { type: "section", text: { type: "plain_text", text: "x", verbatim: true } }, { type: "section", text: { type: "plain_text", text: "x", emoji: 1 } },
    { type: "actions", elements: [{ type: "image" }] }, { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "x" }, url: sourceLink(), action_id: "" }] },
    { type: "context", elements: Array(101).fill({ type: "mrkdwn", text: "x" }) }, { type: "divider", block_id: "x".repeat(256) },
  ];
  badBlocks.forEach((block) => broken.push(input({ text: "x", blocks: [block] })));
  const button = { type: "button", text: { type: "plain_text", text: "x" }, url: sourceLink(), action_id: "same" };
  broken.push(input({ text: "x", blocks: [{ type: "actions", elements: [button, button] }] }));
  broken.push(input({ text: "x", blocks: [{ type: "divider", block_id: "same" }, { type: "divider", block_id: "same" }] }));
  const extraArray = Object.assign(["/text"], { unexpected: true }); broken.push({ ...input(), preserve: extraArray });
  broken.push({ ...input(), preserve: Object.assign(["/text"], { [Symbol("foreign")]: true }) });
  broken.push(Object.create({ payload: { text: "x" } }));
  broken.push({ ...input(), payload: { text: "x", [Symbol("foreign")]: "x" } });
  broken.push(input({ text: "x".repeat(2097153) }));
  broken.push(input({ text: "x".repeat(2097100) }));
  broken.push(input({ text: "x".repeat(2097112), blocks: [{ type: "divider" }] }));
  broken.push(input({ text: "x".repeat(1100000), blocks: [{ type: "section", text: { type: "plain_text", text: "y".repeat(1100000) } }] }));
  // A tiny reference graph can describe gigabytes of expanded JSON: refuse while parsing, before serialization.
  const repeated = { type: "section", fields: Array(100).fill({ type: "plain_text", text: "x".repeat(50000) }) };
  broken.push(input({ text: "fallback", blocks: Array(500).fill(repeated) }));
  broken.forEach((v) => assert.throws(() => compileSlackPayload(v), refuses()));
  const valid = [
    { text: "  prior\r\nversion  ", channel: "#legacy", mrkdwn: true, thread_ts: "123.001" },
    { text: "x", blocks: [{ type: "divider", block_id: "constructor" }] },
    { text: "x", blocks: [{ type: "context", elements: [{ type: "plain_text", text: "context", emoji: false }] }] },
    { text: "x", blocks: [{ type: "section", fields: [{ type: "mrkdwn", text: "field", verbatim: true }] }] },
    { text: "x", blocks: [{ type: "header", text: { type: "plain_text", text: "heading" } }] },
  ];
  for (const payload of valid) { assert.deepEqual(validateSlackWirePayload(payload), payload); assert.deepEqual(compileSlackPayload(input(payload)).payload, payload); }
  for (const payload of [
    { text: "x".repeat(4001) }, { text: "x", blocks: Array(51).fill({ type: "divider" }) },
    { text: "x", blocks: [{ type: "section", fields: Array(11).fill({ type: "plain_text", text: "x" }) }] },
    { text: "x", blocks: Array.from({ length: 50 }, () => ({ type: "section", text: { type: "plain_text", text: "漢".repeat(3000) } })) },
  ]) assert.throws(() => validateSlackWirePayload(payload), refuses());
  assert.throws(() => compileSlackPayload({ ...input({ text: "x", blocks: [{ type: "section", fields: Array(11).fill({ type: "plain_text", text: "x" }) }] }), preserve: ["/blocks/0/fields/10/text"] }), refuses("protected_overflow"));
  assert.throws(() => compileSlackPayload(input({ text: "x", blocks: [{ type: "actions", elements: Array.from({ length: 26 }, (_v, i) => ({ ...button, action_id: String(i) })) }] })), refuses("protected_overflow"));
});

test("malformed wire payloads refuse before socket creation and before dispatch callbacks", async (t) => {
  let requests = 0, dispatches = 0;
  const server = http.createServer((_req, res) => { requests++; res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const link = `http://127.0.0.1:${address.port}/webhook`;
  await assert.rejects(__test__.postToSlackOnce(link, { text: "x", blocks: [{ type: "section" }] }, () => { dispatches++; }), refuses());
  await assert.rejects(__test__.postToSlackOnce(link, { text: "x".repeat(4001) }), refuses());
  assert.equal(__test__.classifyOutboxSendError(new SlackCompilationError("invalid_input", "Fix the payload")), "rejected");
  assert.equal(requests, 0); assert.equal(dispatches, 0);
  await __test__.postToSlackOnce(link, compileSlackPayload(input({ text: "valid" })).payload);
  assert.equal(requests, 1);
  const directory = mkdtempSync(join(tmpdir(), "slack-refusal-command-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  await init("refusal", { defaults: true, agentGuidance: "skip" }, { cwd: directory, pmRoot, noExtensions: true });
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] }); t.after(() => harness.deactivate());
  for (const [command, options] of [["slack notify", { title: "x".repeat(5000), format: "text", webhook: link }], ["slack digest", { thread: "invalid", webhook: link }]] as const) {
    const response = await harness.runCommand({ command, pmRoot, options, global: { json: true } });
    assert.equal((response.result as { code: string }).code, "invalid_input");
    assert.equal((response.result as { exit_code: number }).exit_code, 2);
  }
  assert.equal(requests, 1, "typed command refusals also open no socket");
});

test("500 seeded operation sequences export/replay SDK snapshots without changing native state or ambient relationships", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slack-compile-model-"));
  const previous = { path: process.env.PATH, ceiling: process.env.GIT_CEILING_DIRECTORIES };
  t.after(() => { if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path; if (previous.ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previous.ceiling; rmSync(directory, { recursive: true, force: true }); });
  process.env.PATH = directory; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const options = { cwd: directory, pmRoot: join(directory, ".agents", "pm"), noExtensions: true, author: "compiler-test" };
  await init("compile", { defaults: true, agentGuidance: "skip" }, options);
  const client = new PmClient(options);
  await create({ id: "anchor", title: "Ambient parent", type: "Task", status: "open", parent: "none", sprint: "none", release: "none", assignee: "none", dep: [] }, options);
  await create({ id: "subject", title: "Initial", type: "Task", status: "open", priority: 1, parent: "none", sprint: "none", release: "none", assignee: "none", body: "source", dep: ["id=anchor,kind=related_to"] }, options);
  let seed = 0x51ac2026;
  /** Fixed PRNG makes every failed sequence replayable. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const archived: SlackCompilationInput[] = [];
  const rolesSeen = new Set<string>();
  let model = (await client.get("subject", { depth: "full", noTruncate: true })).item;
  for (let sequence = 0; sequence < 500; sequence++) {
    if (sequence % 25 === 0) {
      const custom = `active_${sequence}`;
      const roles = [["active"], ["blocked"], ["terminal", "terminal_done"], ["terminal", "terminal_canceled"]][(random() >>> 8) % 4]!;
      rolesSeen.add(roles.join(","));
      await schemaAddStatus(custom, { role: roles }, options);
      await focus(random() % 2 ? "anchor" : "subject", {}, options);
      await update("subject", { title: `  Title ${random()} 😀  `, body: `  body ${random()}\r\n${"é".repeat(random() % 4500)}\n  `, status: custom, priority: (random() % 5) as 0 | 1 | 2 | 3 | 4, assignee: random() % 2 ? "agent" : "none", parent: random() % 2 ? "anchor" : "none", sprint: "none", release: "none", dep: random() % 2 ? ["id=anchor,kind=related_to"] : [], replaceDeps: true, closeReason: "model outcome", blockedReason: "model blocker", force: true }, options);
      model = (await client.get("subject", { depth: "full", noTruncate: true })).item;
    }
    const result = await compileSlackItem(client, "subject", sourceLink());
    assert.ok(JSON.stringify(result.payload).includes(model.status!));
    const expected = [model.id, model.type, model.status, model.priority, model.assignee, model.parent, model.dependencies].map((v) => JSON.stringify(v ?? null));
    const fields = result.payload.blocks?.find((b) => b.type === "section" && b.fields)?.fields as { text: string }[];
    expected.forEach((v, i) => assert.ok(fields[i]!.text.endsWith(v)));
    const original = input({ text: `  ${random()}\r\n${"😀".repeat(random() % 2300)}\n  `, blocks: [{ type: "section", fields: [{ type: "plain_text", text: JSON.stringify(model.dependencies ?? []) }] }] });
    archived.push(original);
    // Replay older uncompiled inputs and already compiled payloads, with CRLF/whitespace intact.
    const replay = archived[random() % archived.length]!;
    const compiled = compileSlackPayload(replay); verify(replay, compiled);
    const round = compileSlackPayload({ ...replay, payload: JSON.parse(JSON.stringify(compiled.payload)) as SlackCompilationInput["payload"] });
    assert.deepEqual(round.payload, compiled.payload); assert.deepEqual(round.losses, []);
    assert.deepEqual((await client.get("subject", { depth: "full", noTruncate: true })).item, model, `SDK state differs at sequence ${sequence}`);
  }
  assert.equal(rolesSeen.size, 4, "seed exercises active, blocked, done and canceled custom roles");
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => harness.deactivate());
  harness.assertCommandContract({ command: "slack compile", flags: ["--input", "--item", "--link", "--payload"] });
  const command = await harness.runCommand({ command: "slack compile", pmRoot: options.pmRoot, options: { item: "subject", link: sourceLink() }, global: { json: true } });
  assert.equal((command.result as { ok: boolean }).ok, true);
  const report = slackCompilationSummary(await compileSlackItem(client, "subject", sourceLink()));
  assert.deepEqual(decode((await harness.runRendererOverride({ command: "slack compile", format: "toon", result: report })).rendered!), report);
  for (const value of [null, { ok: false }, { ...report, payload: {} }]) assert.equal((await harness.runRendererOverride({ command: "slack compile", format: "toon", result: value })).overridden, false);
});

test("CLI returns compact receipts or explicit payloads and actionable refusals", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slack-compile-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "input.json"); writeFileSync(path, JSON.stringify(input()));
  /** File mode requires no SDK acquisition at all. */
  const run = (options: Record<string, unknown>) => runSlackCompilationCommand({ options } as CommandHandlerContext);
  const summary = await run({ input: path, limit: "1", after: "0" }); assert.equal(summary.ok, true); assert.ok(!("payload" in summary));
  const full = await run({ input: path, payload: true }); assert.equal(full.ok, true); assert.ok("payload" in full);
  assert.equal((await run({ input: path, payload: false })).ok, true);
  for (const options of [{}, { item: "x" }, { input: path, item: "x" }, { input: path, link: sourceLink() }, { item: "x", link: sourceLink() }, { input: path, payload: "true" }, { input: path, maxBytes: "512" }, { input: path, maxBlocks: "1.2" }, { input: path, item: " " }, { input: 3 }, { item: "x", link: sourceLink(), maxText: "1" }, { item: "x", link: sourceLink(), "max-bytes": "512" }, { input: path, limit: "nan" }, { input: path, limit: "0" }, { input: path, limit: "101" }, { input: path, after: "100001" }]) {
    const result = await run(options); assert.equal(result.ok, false); assert.ok("remediation" in result && result.remediation.length > 0);
  }
  assert.equal((await run({ input: join(directory, "missing") })).ok, false);
  assert.equal((await run({ input: directory })).ok, false);
  writeFileSync(path, "bad JSON"); assert.equal((await run({ input: path })).ok, false);
  writeFileSync(path, Buffer.from([255])); assert.equal((await run({ input: path })).ok, false);
  writeFileSync(path, "x".repeat(2097153)); assert.equal((await run({ input: path })).ok, false);
});

test("SDK read producers handle empty bodies and real budget refusals and every legacy renderer emits valid wire data", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slack-compile-sdk-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { cwd: directory, pmRoot: join(directory, ".agents", "pm"), noExtensions: true };
  await init("producer", { defaults: true, agentGuidance: "skip" }, options);
  await create({ id: "empty", title: "Empty body", type: "Task", status: "open", parent: "none", assignee: "none", sprint: "none", release: "none", dep: [], body: "" }, options);
  const client = new PmClient(options);
  const empty = await compileSlackItem(client, "empty", sourceLink()); assert.deepEqual(empty.losses, []);
  const refused = await client.get("empty", { depth: "full", outputBudget: 1 });
  assert.ok(!("item" in refused)); assert.throws(() => compileSlackItemRead(refused, sourceLink()), refuses());
  const brief = await client.get("empty", { depth: "brief" });
  assert.throws(() => compileSlackItemRead(brief, sourceLink()), refuses());
  // Fuzz a captured producer output: a disclosed partial read must never become a complete source.
  const partial = await client.get("empty", { depth: "full", noTruncate: true });
  Object.assign(partial, { output_budget_truncation: {} });
  assert.throws(() => compileSlackItemRead(partial, sourceLink()), refuses());
  const many = compileSlackPayload(input({ text: "x", blocks: Array.from({ length: 55 }, () => ({ type: "section", text: { type: "plain_text", text: "x".repeat(3001) } })) }));
  const pages = [slackCompilationSummary(many, 20, 0), slackCompilationSummary(many, 20, 20), slackCompilationSummary(many, 20, 40)];
  assert.equal(pages[0]!.next_cursor, 20); assert.equal(pages[1]!.next_cursor, 40); assert.equal(pages[2]!.next_cursor, null);
  assert.deepEqual(pages.flatMap((page) => page.losses), many.losses);
  pages.forEach((page) => assert.deepEqual(decode(slackCompilationToon(page)), page));
  for (const event of ["create", "close", "block", "cancel", "start", "reopen", "open", "unblock"] as const) for (const format of ["blockkit", "text", "custom"] as const) {
    const payload = __test__.buildItemPayload({ id: "legacy", title: "Previously released fixture", status: "custom_working", type: "Task", priority: 1, author: "agent", assignee: "worker" }, event, format, { template: "{id}: {title}" });
    assert.deepEqual(validateSlackWirePayload(payload), payload);
  }
});
