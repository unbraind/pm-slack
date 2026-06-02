import assert from "node:assert/strict";
import test from "node:test";

import extension, { __test__ } from "../dist/index.js";

const {
  parseFormat,
  parseRoutes,
  ruleMatches,
  selectRoute,
  buildItemPayload,
  buildItemBlockKit,
  parseStoredItem,
  resolveWindow,
  aggregateDigest,
  buildDigestText,
  buildDigestBlockKit,
  buildDigestPayload,
} = __test__;

// ---------------------------------------------------------------------------
// parseFormat
// ---------------------------------------------------------------------------

test("parseFormat: defaults and aliases", () => {
  assert.equal(parseFormat(undefined), "blockkit");
  assert.equal(parseFormat(""), "blockkit");
  assert.equal(parseFormat("text"), "text");
  assert.equal(parseFormat("plain"), "text");
  assert.equal(parseFormat("txt"), "text");
  assert.equal(parseFormat("blockkit"), "blockkit");
  assert.equal(parseFormat("block"), "blockkit");
  assert.equal(parseFormat("blocks"), "blockkit");
  assert.equal(parseFormat("BLOCKKIT"), "blockkit");
  // unknown falls back to supplied default
  assert.equal(parseFormat("bogus", "text"), "text");
  assert.equal(parseFormat("bogus"), "blockkit");
});

// ---------------------------------------------------------------------------
// buildItemPayload: format toggle
// ---------------------------------------------------------------------------

test("buildItemPayload: text format has no blocks, blockkit has blocks array", () => {
  const item = { id: "pm-1", title: "Auth", type: "Feature", priority: 2 as const, status: "open", author: "alice" };
  const textPayload = buildItemPayload(item, "create", "text", { channel: "#x" });
  assert.equal(textPayload.blocks, undefined);
  assert.equal(textPayload.mrkdwn, true);
  assert.ok(textPayload.text.includes("Auth"));
  assert.equal(textPayload.channel, "#x");

  const blockPayload = buildItemPayload(item, "create", "blockkit", { channel: "#x" });
  assert.ok(Array.isArray(blockPayload.blocks), "blockkit payload must carry a blocks array");
  assert.ok(blockPayload.blocks!.length > 0);
  assert.equal(blockPayload.blocks![0].type, "header");
});

test("buildItemBlockKit: well-formed Block Kit (header/section/context)", () => {
  const item = { id: "pm-9", title: "DB", type: "Issue", priority: 1 as const, status: "closed", close_reason: "fixed" };
  const { blocks, fallback } = buildItemBlockKit(item, "close", { channel: "#ops" });
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("header"));
  assert.ok(types.includes("section"));
  assert.ok(types.includes("context"));
  // every block must have a string type
  for (const b of blocks) assert.equal(typeof b.type, "string");
  assert.ok(fallback.includes("closed"));
  // reason must surface (regression guard for the snake_case fix)
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("fixed"), "close_reason should appear in blocks");
});

// ---------------------------------------------------------------------------
// parseRoutes + ruleMatches + selectRoute
// ---------------------------------------------------------------------------

test("parseRoutes: ignores invalid JSON and meaningless rules", () => {
  assert.deepEqual(parseRoutes(undefined), []);
  assert.deepEqual(parseRoutes("not json"), []);
  assert.deepEqual(parseRoutes('{"match":"x"}'), []); // not an array
  // rule with neither webhook nor channel is dropped
  assert.deepEqual(parseRoutes('[{"match":"block"}]'), []);
  const rules = parseRoutes('[{"match":"block","channel":"#urgent"},{"match":"type:Bug","webhook":"https://h/x"}]');
  assert.equal(rules.length, 2);
  assert.equal(rules[0].match, "block");
  assert.equal(rules[0].channel, "#urgent");
  assert.equal(rules[1].webhook, "https://h/x");
});

test("ruleMatches: event, type:, status:, wildcard", () => {
  const item = { id: "1", title: "t", type: "Bug", status: "blocked" };
  assert.ok(ruleMatches({ match: "block" }, "block", item));
  assert.ok(!ruleMatches({ match: "create" }, "block", item));
  assert.ok(ruleMatches({ match: "type:bug" }, "block", item)); // case-insensitive
  assert.ok(ruleMatches({ match: "type:Bug" }, "create", item));
  assert.ok(!ruleMatches({ match: "type:Feature" }, "block", item));
  assert.ok(ruleMatches({ match: "status:blocked" }, "create", item));
  assert.ok(ruleMatches({ match: "*" }, "create", item));
  assert.ok(ruleMatches({ match: "all" }, "close", item));
});

test("selectRoute: first match wins, falls back to defaults, null when nothing", () => {
  const item = { id: "1", title: "t", type: "Bug", status: "blocked" };
  const routes = [
    { match: "type:Bug", channel: "#bugs" },
    { match: "block", webhook: "https://h/block" },
  ];
  // first matching rule wins → type:Bug, channel override, default webhook
  const t1 = selectRoute("block", item, routes, "https://h/default", "#default");
  assert.deepEqual(t1, { webhookUrl: "https://h/default", channel: "#bugs" });

  // no rule matches → defaults
  const t2 = selectRoute("create", { id: "2", title: "x", type: "Feature" }, routes, "https://h/default", "#default");
  assert.deepEqual(t2, { webhookUrl: "https://h/default", channel: "#default" });

  // no default webhook and no matching rule webhook → null
  const t3 = selectRoute("create", { id: "3", title: "y", type: "Feature" }, routes, "", undefined);
  assert.equal(t3, null);

  // matching rule with its own webhook works even with no default webhook
  const t4 = selectRoute("block", { id: "4", title: "z", type: "Feature" }, [{ match: "block", webhook: "https://h/b" }], "", undefined);
  assert.deepEqual(t4, { webhookUrl: "https://h/b", channel: undefined });
});

// ---------------------------------------------------------------------------
// parseStoredItem
// ---------------------------------------------------------------------------

test("parseStoredItem: toon scalar parsing, ignores nested blocks", () => {
  const toon = [
    "id: pm-abc",
    'title: "Hello: world"',
    "type: Task",
    "status: closed",
    "priority: 2",
    'created_at: "2026-06-01T00:00:00.000Z"',
    'close_reason: "done"',
    'notes[1]{created_at,author,text}:',
    '  "2026-06-01T00:00:00.000Z",me,"ignored"',
    'body: ""',
  ].join("\n");
  const item = parseStoredItem(toon, ".toon");
  assert.ok(item);
  assert.equal(item!.id, "pm-abc");
  assert.equal(item!.title, "Hello: world");
  assert.equal(item!.status, "closed");
  assert.equal(item!.priority, 2);
  assert.equal(item!.created_at, "2026-06-01T00:00:00.000Z");
  // nested note text must not leak into scalar fields
  assert.notEqual((item as any).text, "ignored");
});

test("parseStoredItem: json form and {item:...} wrapper, null when no id", () => {
  const j1 = parseStoredItem('{"id":"pm-x","title":"T","status":"open"}', ".json");
  assert.equal(j1!.id, "pm-x");
  const j2 = parseStoredItem('{"item":{"id":"pm-y","title":"U"}}', ".json");
  assert.equal(j2!.id, "pm-y");
  assert.equal(parseStoredItem("{}", ".json"), null);
  assert.equal(parseStoredItem("garbage", ".json"), null);
  assert.equal(parseStoredItem("title: no id here", ".toon"), null);
});

// ---------------------------------------------------------------------------
// resolveWindow
// ---------------------------------------------------------------------------

test("resolveWindow: since wins, days fallback, default 7", () => {
  const now = Date.parse("2026-06-10T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  const w1 = resolveWindow("2026-06-01", undefined, now);
  assert.equal(w1.cutoffMs, Date.parse("2026-06-01"));
  assert.ok(w1.label.includes("since"));

  const w2 = resolveWindow(undefined, 3, now);
  assert.equal(w2.cutoffMs, now - 3 * day);
  assert.ok(w2.label.includes("3 days"));

  const w3 = resolveWindow(undefined, undefined, now);
  assert.equal(w3.cutoffMs, now - 7 * day);

  // invalid since → fall through to days/default
  const w4 = resolveWindow("not-a-date", 1, now);
  assert.equal(w4.cutoffMs, now - 1 * day);
  assert.ok(w4.label.includes("1 day"));
});

// ---------------------------------------------------------------------------
// aggregateDigest
// ---------------------------------------------------------------------------

test("aggregateDigest: buckets by created/closed/blocked/in_progress within window", () => {
  const now = Date.parse("2026-06-10T00:00:00.000Z");
  const cutoff = now - 7 * 24 * 60 * 60 * 1000; // 2026-06-03
  const items = [
    { id: "a", title: "newly created", created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-05T00:00:00Z", status: "open" },
    { id: "b", title: "old, ignore", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z", status: "open" },
    { id: "c", title: "closed recently", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-06-06T00:00:00Z", status: "closed" },
    { id: "d", title: "blocked recently", created_at: "2026-06-04T00:00:00Z", updated_at: "2026-06-07T00:00:00Z", status: "blocked" },
    { id: "e", title: "in progress", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-06-08T00:00:00Z", status: "in_progress" },
  ];
  const s = aggregateDigest(items, cutoff, "last 7 days");
  assert.equal(s.counts.created, 2, "a + d created in window");
  assert.equal(s.counts.closed, 1, "c");
  assert.equal(s.counts.blocked, 1, "d");
  assert.equal(s.counts.in_progress, 1, "e");
  assert.equal(s.total, 5); // d counts in both created and blocked
  assert.ok(s.buckets.created.some((i) => i.id === "d"));
  assert.ok(!s.buckets.created.some((i) => i.id === "b"));
});

test("aggregateDigest: empty window yields zeros", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  assert.equal(s.total, 0);
  assert.deepEqual(s.counts, { created: 0, closed: 0, blocked: 0, in_progress: 0 });
});

// ---------------------------------------------------------------------------
// digest rendering
// ---------------------------------------------------------------------------

test("buildDigestText/BlockKit/Payload: well-formed output", () => {
  const items = [
    { id: "a", title: "created one", created_at: "2026-06-05T00:00:00Z", status: "open" },
    { id: "c", title: "closed one", updated_at: "2026-06-06T00:00:00Z", status: "closed" },
  ];
  const cutoff = Date.parse("2026-06-01T00:00:00Z");
  const s = aggregateDigest(items, cutoff, "since 2026-06-01");

  const text = buildDigestText(s, "#pm");
  assert.ok(text.includes("activity digest"));
  assert.ok(text.includes("a — created one"));
  assert.ok(text.includes("#pm"));

  const { blocks, fallback } = buildDigestBlockKit(s, "#pm");
  assert.equal(blocks[0].type, "header");
  for (const b of blocks) assert.equal(typeof b.type, "string");
  assert.ok(fallback.includes("activity digest"));

  const textPayload = buildDigestPayload(s, "text");
  assert.equal(textPayload.blocks, undefined);
  const blockPayload = buildDigestPayload(s, "blockkit");
  assert.ok(Array.isArray(blockPayload.blocks));
});

test("buildDigestBlockKit: empty digest is still valid Block Kit", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const { blocks } = buildDigestBlockKit(s);
  assert.ok(blocks.length >= 2);
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("No activity"));
});

// ---------------------------------------------------------------------------
// command registration: new commands appear
// ---------------------------------------------------------------------------

test("activate registers slack notify, test, and digest commands", () => {
  const commands: string[] = [];
  const api = {
    registerCommand: (def: { name: string }) => { commands.push(def.name); },
    hooks: { afterCommand: () => {} },
  };
  extension.activate(api as any);
  assert.ok(commands.includes("slack notify"));
  assert.ok(commands.includes("slack test"));
  assert.ok(commands.includes("slack digest"));
});
