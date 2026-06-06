import assert from "node:assert/strict";
import test from "node:test";

import extension, { __test__ } from "../dist/index.js";

const {
  parseFormat,
  parseEvents,
  normalizeEvent,
  parseRoutes,
  ruleMatches,
  selectRoute,
  buildItemPayload,
  buildItemBlockKit,
  truncate,
  SLACK_SECTION_TEXT_MAX,
  SLACK_HEADER_TEXT_MAX,
  parseStoredItem,
  resolveWindow,
  aggregateDigest,
  buildDigestText,
  buildDigestBlockKit,
  buildDigestPayload,
  detectEvent,
  statusToEvent,
  parseAssigneeMap,
  resolveAssigneeMention,
  formatMention,
  buildMentionMap,
  loadConfig,
  warnWebhookUnsetOnce,
  __resetWarnState,
  resolveItemUrl,
  isHttpUrl,
  EVENT_META,
  resolveEffectiveWebhook,
  assertWebhookConfigured,
  CommandError,
  EXIT_CODE,
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

// ---------------------------------------------------------------------------
// Feature 1: expanded event taxonomy (detection + parsing + meta + reason)
// ---------------------------------------------------------------------------

test("EVENT_META covers every event with verb + emoji", () => {
  for (const e of ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"]) {
    const meta = (EVENT_META as Record<string, { verb: string; emoji: string }>)[e];
    assert.ok(meta, `missing meta for ${e}`);
    assert.equal(typeof meta.verb, "string");
    assert.equal(typeof meta.emoji, "string");
  }
});

test("parseEvents + normalizeEvent: status-name aliases normalize to EventKind", () => {
  assert.equal(normalizeEvent("canceled"), "cancel");
  assert.equal(normalizeEvent("cancelled"), "cancel");
  assert.equal(normalizeEvent("in_progress"), "start");
  assert.equal(normalizeEvent("in-progress"), "start");
  assert.equal(normalizeEvent("reopened"), "reopen");
  assert.equal(normalizeEvent("blocked"), "block");
  assert.equal(normalizeEvent("nonsense"), null);
  const set = parseEvents("create,canceled,in_progress");
  assert.ok(set.has("create"));
  assert.ok(set.has("cancel"));
  assert.ok(set.has("start"));
});

test("statusToEvent: maps resulting status to the right transition", () => {
  assert.equal(statusToEvent("canceled"), "cancel");
  assert.equal(statusToEvent("blocked"), "block");
  assert.equal(statusToEvent("closed"), "close");
  assert.equal(statusToEvent("in_progress"), "start");
  assert.equal(statusToEvent("open"), "open");
  assert.equal(statusToEvent("draft"), null);
  assert.equal(statusToEvent(undefined), null);
});

test("detectEvent: cancel, draft->open, start, unblock, reopen", () => {
  // canceled via --status option
  assert.equal(
    detectEvent({ command: "update", options: { status: "canceled" }, result: { item: { id: "x", status: "canceled" } } } as any),
    "cancel"
  );
  // draft -> open (no prior status known) => open
  assert.equal(
    detectEvent({ command: "update", options: { status: "open" }, result: { item: { id: "x", status: "open" } } } as any),
    "open"
  );
  // lifecycle alias claim => start
  assert.equal(detectEvent({ command: "claim", result: { item: { id: "x", status: "in_progress" } } } as any), "start");
  // unblock: blocked -> open with previousStatus
  assert.equal(
    detectEvent({ command: "update", options: { status: "open" }, result: { item: { id: "x", status: "open" }, previousStatus: "blocked" } } as any),
    "unblock"
  );
  // reopen: closed -> open with previousStatus
  assert.equal(
    detectEvent({ command: "update", options: { status: "open" }, result: { item: { id: "x", status: "open" }, previousStatus: "closed" } } as any),
    "reopen"
  );
  // create/close still work
  assert.equal(detectEvent({ command: "create", result: { item: { id: "x" } } } as any), "create");
  assert.equal(detectEvent({ command: "close", result: { item: { id: "x" } } } as any), "close");
  // unrelated command => null
  assert.equal(detectEvent({ command: "list" } as any), null);
});

test("cancel event reason falls back to close_reason in store; output well-formed", () => {
  const item = { id: "pm-c", title: "Canceled item", type: "Task", priority: 3 as const, status: "canceled", close_reason: "Duplicate" };
  const text = buildItemPayload(item, "cancel", "text").text;
  assert.ok(text.includes("canceled"));
  assert.ok(text.includes("Duplicate"), "cancel reason should come from close_reason");
  const { blocks } = buildItemBlockKit(item, "cancel");
  assert.ok(JSON.stringify(blocks).includes("Duplicate"));
});

// ---------------------------------------------------------------------------
// Feature 2: assignee → Slack @mention mapping
// ---------------------------------------------------------------------------

test("parseAssigneeMap: parses name=id pairs, case-insensitive keys", () => {
  const m = parseAssigneeMap("alice=U123, Bob=U456 ,bad,=skip,name=");
  assert.equal(m.get("alice"), "U123");
  assert.equal(m.get("bob"), "U456"); // key lowercased
  assert.equal(m.has("bad"), false);
  assert.equal(m.size, 2);
  assert.equal(parseAssigneeMap(undefined).size, 0);
  assert.equal(parseAssigneeMap("").size, 0);
});

test("resolveAssigneeMention: wraps raw id, passes through prewrapped, undefined when unmapped", () => {
  const map = parseAssigneeMap("alice=U123,team=<!subteam^S99>");
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "alice" }, map), "<@U123>");
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "Alice" }, map), "<@U123>"); // case-insensitive
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "team" }, map), "<!subteam^S99>");
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "nobody" }, map), undefined);
  assert.equal(resolveAssigneeMention({ id: "1", title: "t" }, map), undefined);
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "alice" }, new Map()), undefined);
});

test("formatMention: raw id wrapped, @handle and prewrapped kept verbatim", () => {
  assert.equal(formatMention("U123"), "<@U123>");
  assert.equal(formatMention("  U123  "), "<@U123>"); // trims
  assert.equal(formatMention("@alice"), "@alice"); // human handle kept as-is (no <@@…>)
  assert.equal(formatMention("<@U123>"), "<@U123>"); // already wrapped
  assert.equal(formatMention("<!subteam^S99>"), "<!subteam^S99>");
});

test("resolveAssigneeMention: @handle value renders without double-wrapping", () => {
  const map = parseAssigneeMap("alice=@alice,bob=U456");
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "alice" }, map), "@alice");
  assert.equal(resolveAssigneeMention({ id: "1", title: "t", assignee: "bob" }, map), "<@U456>");
});

test("buildMentionMap: layers env maps + --mention-map flag (flag wins)", () => {
  withEnv({ PM_SLACK_ASSIGNEE_MAP: "alice=U1,bob=U2", PM_SLACK_MENTION_MAP: undefined }, () => {
    // env-only
    const m1 = buildMentionMap(undefined);
    assert.equal(m1.get("alice"), "U1");
    assert.equal(m1.get("bob"), "U2");
    // flag overrides one name, adds a new one
    const m2 = buildMentionMap("alice=@alice-handle,carol=U3");
    assert.equal(m2.get("alice"), "@alice-handle"); // flag wins
    assert.equal(m2.get("bob"), "U2"); // env preserved
    assert.equal(m2.get("carol"), "U3"); // flag-added
  });
  // PM_SLACK_MENTION_MAP overlays PM_SLACK_ASSIGNEE_MAP
  withEnv({ PM_SLACK_ASSIGNEE_MAP: "alice=U1", PM_SLACK_MENTION_MAP: "alice=@a,dan=U9" }, () => {
    const m = buildMentionMap(undefined);
    assert.equal(m.get("alice"), "@a"); // MENTION_MAP wins over ASSIGNEE_MAP
    assert.equal(m.get("dan"), "U9");
  });
  // no source at all → empty (unchanged default behavior)
  withEnv({ PM_SLACK_ASSIGNEE_MAP: undefined, PM_SLACK_MENTION_MAP: undefined }, () => {
    assert.equal(buildMentionMap(undefined).size, 0);
  });
  // pure: explicit env params are honored without touching process.env
  // (precedence assigneeMap < mentionMap < flag preserved).
  withEnv({ PM_SLACK_ASSIGNEE_MAP: "alice=UENV", PM_SLACK_MENTION_MAP: undefined }, () => {
    const m = buildMentionMap("carol=@c", { assigneeMap: "alice=U1,bob=U2", mentionMap: "alice=@a" });
    assert.equal(m.get("alice"), "@a"); // explicit mentionMap param wins over explicit assigneeMap param
    assert.equal(m.get("bob"), "U2"); // explicit assigneeMap param used (NOT process.env's UENV)
    assert.equal(m.get("carol"), "@c"); // flag-added
    assert.notEqual(m.get("alice"), "UENV"); // process.env was ignored when params supplied
  });
});

test("buildMentionMap mention renders in fallback text + blockkit context", () => {
  withEnv({ PM_SLACK_ASSIGNEE_MAP: undefined, PM_SLACK_MENTION_MAP: undefined }, () => {
    const map = buildMentionMap("alice=@alice");
    const item = { id: "pm-z", title: "Ship it", type: "Feature", priority: 2 as const, status: "open", assignee: "alice" };
    const mention = resolveAssigneeMention(item, map);
    assert.equal(mention, "@alice");
    const textPayload = buildItemPayload(item, "create", "text", { mention });
    assert.ok(textPayload.text.includes("@alice"), "fallback text must carry the @mention");
    const blockPayload = buildItemPayload(item, "create", "blockkit", { mention });
    assert.ok(JSON.stringify(blockPayload.blocks).includes("@alice"), "blockkit must carry the @mention");
  });
});

test("mention appears in both text and blockkit output", () => {
  const item = { id: "pm-a", title: "Auth", type: "Feature", priority: 2 as const, status: "open", assignee: "alice" };
  const textPayload = buildItemPayload(item, "create", "text", { mention: "<@U123>" });
  assert.ok(textPayload.text.includes("<@U123>"));
  const blockPayload = buildItemPayload(item, "create", "blockkit", { mention: "<@U123>" });
  assert.ok(JSON.stringify(blockPayload.blocks).includes("<@U123>"));
  // without mention but with assignee, raw name still shown in blockkit fields
  const noMention = buildItemBlockKit(item, "create", {});
  assert.ok(JSON.stringify(noMention.blocks).includes("alice"));
});

// ---------------------------------------------------------------------------
// Feature 3: action buttons / URL extraction
// ---------------------------------------------------------------------------

test("isHttpUrl: only http/https strings pass", () => {
  assert.ok(isHttpUrl("https://github.com/x/y"));
  assert.ok(isHttpUrl("http://example.com"));
  assert.ok(!isHttpUrl("ftp://x"));
  assert.ok(!isHttpUrl("not a url"));
  assert.ok(!isHttpUrl(""));
  assert.ok(!isHttpUrl(123));
});

test("resolveItemUrl: override wins, github detection, defensive field names", () => {
  assert.deepEqual(
    resolveItemUrl({ id: "1", title: "t" }, "https://github.com/unbraind/pm-slack/issues/1"),
    { url: "https://github.com/unbraind/pm-slack/issues/1", isGithub: true }
  );
  assert.deepEqual(
    resolveItemUrl({ id: "1", title: "t", html_url: "https://example.com/x" }),
    { url: "https://example.com/x", isGithub: false }
  );
  // github_url preferred over generic url
  assert.equal(
    resolveItemUrl({ id: "1", title: "t", url: "https://a.com", github_url: "https://github.com/o/r" })!.url,
    "https://github.com/o/r"
  );
  assert.equal(resolveItemUrl({ id: "1", title: "t" }), undefined);
  assert.equal(resolveItemUrl({ id: "1", title: "t", url: "garbage" }), undefined);
});

test("blockkit: action button block present with correct url + label", () => {
  const item = { id: "pm-1", title: "Auth", type: "Feature", priority: 2 as const, status: "open" };
  const { blocks } = buildItemBlockKit(item, "create", { link: { url: "https://github.com/o/r/issues/1", isGithub: true } });
  const actions = blocks.find((b) => b.type === "actions") as any;
  assert.ok(actions, "actions block must be present");
  assert.equal(actions.elements[0].type, "button");
  assert.equal(actions.elements[0].url, "https://github.com/o/r/issues/1");
  assert.equal(actions.elements[0].text.text, "View on GitHub");
  assert.equal(actions.elements[0].action_id, "pm_slack_open_github");

  // non-github => "Open item"
  const { blocks: b2 } = buildItemBlockKit(item, "create", { link: { url: "https://x.com/i", isGithub: false } });
  const a2 = b2.find((b) => b.type === "actions") as any;
  assert.equal(a2.elements[0].text.text, "Open item");

  // no link => no actions block (additive: unchanged when absent)
  const { blocks: b3 } = buildItemBlockKit(item, "create", {});
  assert.equal(b3.find((b) => b.type === "actions"), undefined);

  // plain-text path never gets blocks/buttons
  const textPayload = buildItemPayload(item, "create", "text", { link: { url: "https://github.com/o/r", isGithub: true } });
  assert.equal(textPayload.blocks, undefined);
});

// ---------------------------------------------------------------------------
// Webhook preflight validation gate
// ---------------------------------------------------------------------------

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(env);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("resolveEffectiveWebhook: flag > env > route > none", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    assert.equal(resolveEffectiveWebhook("https://hooks.slack.com/x").source, "flag");
    assert.equal(resolveEffectiveWebhook(undefined).source, "none");
  });
  withEnv({ PM_SLACK_WEBHOOK: "https://hooks.slack.com/env", PM_SLACK_ROUTES: undefined }, () => {
    const r = resolveEffectiveWebhook(undefined);
    assert.equal(r.source, "env");
    assert.equal(r.webhookUrl, "https://hooks.slack.com/env");
  });
  withEnv(
    {
      PM_SLACK_WEBHOOK: undefined,
      PM_SLACK_ROUTES: JSON.stringify([{ match: "block", webhook: "https://hooks.slack.com/route" }]),
    },
    () => {
      assert.equal(resolveEffectiveWebhook(undefined).source, "route");
    }
  );
});

test("assertWebhookConfigured: throws USAGE CommandError when no webhook", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    assert.throws(
      () => assertWebhookConfigured(undefined, "slack digest"),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.equal((err as InstanceType<typeof CommandError>).exitCode, EXIT_CODE.USAGE);
        assert.match((err as Error).message, /slack digest/);
        return true;
      }
    );
  });
});

test("assertWebhookConfigured: throws on invalid URL", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    assert.throws(
      () => assertWebhookConfigured("not a url", "slack notify"),
      (err: unknown) => err instanceof CommandError && (err as InstanceType<typeof CommandError>).exitCode === EXIT_CODE.USAGE
    );
  });
});

test("assertWebhookConfigured: passes silently on valid env webhook", () => {
  withEnv({ PM_SLACK_WEBHOOK: "https://hooks.slack.com/services/A/B/C", PM_SLACK_ROUTES: undefined }, () => {
    assert.doesNotThrow(() => assertWebhookConfigured(undefined, "slack digest"));
  });
});

test("assertWebhookConfigured: passes on a valid --webhook flag override", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    assert.doesNotThrow(() => assertWebhookConfigured("https://hooks.slack.com/services/A/B/C", "slack notify"));
  });
});

// ---------------------------------------------------------------------------
// Stderr de-spam: "webhook not set" notice emitted at most once per process
// ---------------------------------------------------------------------------

test("loadConfig: 'webhook not set' notice is emitted at most once per process", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    __resetWarnState();
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      // Simulate the hook firing on many commands without a webhook configured.
      for (let i = 0; i < 5; i++) {
        assert.equal(loadConfig(), null, "no webhook → null config");
      }
    } finally {
      console.error = orig;
    }
    const notices = lines.filter((l) => l.includes("PM_SLACK_WEBHOOK not set"));
    assert.equal(notices.length, 1, `expected exactly one notice across 5 calls, got ${notices.length}`);
  });
});

test("warnWebhookUnsetOnce: only the first call writes to stderr", () => {
  __resetWarnState();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    warnWebhookUnsetOnce();
    warnWebhookUnsetOnce();
    warnWebhookUnsetOnce();
  } finally {
    console.error = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /notifications disabled/);
});

test("activate registers a preflight override", () => {
  let registered = false;
  const api = {
    registerCommand: () => {},
    registerPreflight: () => { registered = true; },
    hooks: { afterCommand: () => {} },
  };
  extension.activate(api as any);
  assert.equal(registered, true);
});

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

// ---------------------------------------------------------------------------
// Block Kit truncation to Slack hard limits (section text 3000, header 150)
// ---------------------------------------------------------------------------

test("truncate: leaves short text unchanged, caps long text with an ellipsis", () => {
  // exact limits expose the off-by-one boundary
  assert.equal(SLACK_SECTION_TEXT_MAX, 3000);
  assert.equal(SLACK_HEADER_TEXT_MAX, 150);

  // shorter / equal length is returned verbatim (zero regression)
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello", 5), "hello");

  // longer is cut to exactly `max` and ends with the ellipsis indicator
  const cut = truncate("a".repeat(20), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith("…"));
  assert.equal(cut, "a".repeat(9) + "…");

  // surrogate pairs (emoji / non-BMP) are never sliced in half (gemini review).
  // The cap is on UTF-16 length (what Slack measures); each 🆕 is 2 units, so
  // with max=3 one emoji (2 units) + "…" (1 unit) fits and the rest is dropped
  // whole — never split into a lone surrogate.
  const emojiCut = truncate("🆕🆕🆕🆕🆕", 3);
  assert.ok(emojiCut.length <= 3, "result stays within the UTF-16 budget");
  assert.equal(emojiCut, "🆕…", "cuts on a code-point boundary, dropping the partial emoji");
  assert.ok(
    ![...emojiCut].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff),
    "result must contain no lone surrogate",
  );
  // an emoji string that already fits is returned verbatim
  assert.equal(truncate("🆕🆕", 5), "🆕🆕");
});

test("buildItemBlockKit: oversized note + reason + title stay within Slack limits", () => {
  const item = {
    id: "pm-1",
    title: "T".repeat(400), // > 150 header limit
    type: "Issue",
    priority: 1 as const,
    status: "closed",
    close_reason: "R".repeat(5000), // > 3000 section limit
  };
  const note = "N".repeat(5000); // > 3000 section limit
  const { blocks } = buildItemBlockKit(item, "close", { note });

  const header = blocks.find((b) => b.type === "header") as any;
  assert.ok(header.text.text.length <= SLACK_HEADER_TEXT_MAX, "header within 150");
  assert.ok(header.text.text.endsWith("…"), "header marked as truncated");

  // every section's text.text (the long reason + note) must be within 3000
  const sectionTexts = (blocks as any[])
    .filter((b) => b.type === "section" && b.text)
    .map((b) => b.text.text as string);
  assert.ok(sectionTexts.length >= 2, "expected reason + note sections");
  for (const t of sectionTexts) {
    assert.ok(t.length <= SLACK_SECTION_TEXT_MAX, `section text within 3000, got ${t.length}`);
  }
  // the two oversized sections must be visibly truncated
  const truncated = sectionTexts.filter((t) => t.endsWith("…"));
  assert.equal(truncated.length, 2, "reason + note both truncated with ellipsis");
});

test("buildDigestBlockKit: oversized bucket list stays within section limit", () => {
  // a single item with a giant title pushes the bucket section text past 3000
  const now = new Date().toISOString();
  const items = [
    {
      id: "pm-big",
      title: "X".repeat(5000), // > 3000 section limit on its own
      type: "Issue",
      priority: 2 as const,
      status: "closed",
      created_at: now,
      updated_at: now,
    },
  ];
  const summary = aggregateDigest(items, 0, "today");
  const { blocks } = buildDigestBlockKit(summary);

  const sectionTexts = (blocks as any[])
    .filter((b) => b.type === "section" && b.text)
    .map((b) => b.text.text as string);
  for (const t of sectionTexts) {
    assert.ok(t.length <= SLACK_SECTION_TEXT_MAX, `digest section within 3000, got ${t.length}`);
  }
  // at least one section was big enough to require truncation
  assert.ok(sectionTexts.some((t) => t.endsWith("…")), "a long bucket section was truncated");
});
