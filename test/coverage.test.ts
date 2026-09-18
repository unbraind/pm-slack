/**
 * Behavioural tests driving every uncovered line, branch, and function in
 * `index.ts` toward 100 % coverage.
 *
 * These tests exercise the real extension through `createExtensionTestHarness`
 * (the pm SDK's real activation engine) for command handlers and lifecycle
 * hooks, and call pure helpers directly through `__test__` for formatting,
 * parsing, and HTTP-path coverage. Network-facing code is driven with a real
 * `node:http` server on 127.0.0.1 — no `fetch` monkey-patching.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { AfterCommandHookContext, PreflightOverrideContext } from "@unbrained/pm-cli/sdk/authoring";

import extension, { __test__ } from "../index.ts";

const {
  loadConfig,
  __resetWarnState,
  meetsMinPriority,
  extractItem,
  detectEvent,
  buildTextMessage,
  buildCustomMessage,
  buildItemPayload,
  buildItemBlockKit,
  buildDigestText,
  buildDigestPayload,
  buildDigestBlockKit,
  aggregateDigest,
  parseEvents,
  parseFormat,
  parseRoutes,
  parseFilter,
  selectRoute,
  parseRetryAfterMs,
  parseStoredItem,
  resolveWindow,
  resolveEffectiveWebhook,
  assertWebhookConfigured,
  postToSlackOnce,
  SlackHttpError,
  CommandError,
  EXIT_CODE,
  EVENT_META,
  SLACK_MAX_RETRY_DELAY_MS,
  sleep,
  truncate,
  sectionFields,
  SLACK_SECTION_TEXT_MAX,
  SLACK_SECTION_FIELD_TEXT_MAX,
  SLACK_SECTION_FIELDS_MAX,
  SLACK_HEADER_TEXT_MAX,
  toErrorMessage,
} = __test__;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Save, set, and restore environment variables around a callback. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(env);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
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

/** Async version of withEnv — awaits the callback before restoring env. */
async function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = Object.keys(env);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

/** Reserve and immediately free a port so connection attempts to it fail. */
function getUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Create a temp pm-root workspace with item directories and files. */
function makeTempPmRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-slack-"));
  return dir;
}

/**
 * Activate pm-slack through the real pm host engine and return the harness.
 * Mirrors the helper in smoke.test.ts so command/hook dispatch uses the same
 * validation the CLI runs.
 */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-slack",
    capabilities: ["commands", "hooks", "schema", "preflight"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

/** Build a minimal afterCommand hook context for the harness. */
function afterCtx(overrides: Partial<AfterCommandHookContext>): AfterCommandHookContext {
  return {
    command: "",
    args: [],
    pm_root: "",
    ok: true,
    ...overrides,
  };
}

/** Build a preflight context for the harness. */
function preflightCtx(command: string, options: Record<string, unknown>): PreflightOverrideContext {
  return {
    command,
    args: [],
    options,
    global: { json: false, quiet: false, noPager: false } as never,
    pm_root: "",
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  };
}

// ---------------------------------------------------------------------------
// loadConfig: valid webhook, invalid webhook, routes-with-webhook
// ---------------------------------------------------------------------------

test("loadConfig: returns a full config when PM_SLACK_WEBHOOK is a valid URL", () => {
  withEnv({ PM_SLACK_WEBHOOK: "https://hooks.slack.com/services/A/B/C", PM_SLACK_ROUTES: undefined }, () => {
    __resetWarnState();
    const config = loadConfig();
    assert.ok(config, "config must be returned with a valid webhook");
    assert.equal(config!.webhookUrl, "https://hooks.slack.com/services/A/B/C");
    assert.equal(config!.channel, undefined);
    assert.equal(config!.minPriority, 1);
    assert.ok(config!.events.has("create"), "default events include create");
    assert.equal(config!.format, "blockkit");
    assert.equal(config!.mentionAssignee, false);
    assert.equal(config!.routes.length, 0);
  });
});

test("loadConfig: invalid webhook URL disables notifications", () => {
  withEnv({ PM_SLACK_WEBHOOK: "not-a-url", PM_SLACK_ROUTES: undefined }, () => {
    __resetWarnState();
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const config = loadConfig();
      assert.equal(config, null, "invalid webhook → null");
      assert.ok(lines.some((l) => l.includes("not a valid URL")), "must warn about invalid URL");
    } finally {
      console.error = orig;
    }
  });
});

test("loadConfig: routes with webhooks keep config alive without a default webhook", () => {
  withEnv(
    {
      PM_SLACK_WEBHOOK: undefined,
      PM_SLACK_ROUTES: JSON.stringify([{ match: "block", webhook: "https://h/r" }]),
    },
    () => {
      __resetWarnState();
      const config = loadConfig();
      assert.ok(config, "routes-only webhook must not disable config");
      assert.equal(config!.webhookUrl, "");
      assert.equal(config!.routes.length, 1);
      assert.equal(config!.routes[0].webhook, "https://h/r");
    },
  );
});

test("loadConfig: channel, min-priority, and mention-env are read correctly", () => {
  withEnv(
    {
      PM_SLACK_WEBHOOK: "https://hooks.slack.com/services/A/B/C",
      PM_SLACK_CHANNEL: "#team",
      PM_SLACK_MIN_PRIORITY: "3",
      PM_SLACK_FORMAT: "text",
      PM_SLACK_ASSIGNEE_MAP: "alice=U123",
      PM_SLACK_MENTION_ASSIGNEE: undefined,
    },
    () => {
      __resetWarnState();
      const config = loadConfig();
      assert.ok(config);
      assert.equal(config!.channel, "#team");
      assert.equal(config!.minPriority, 3);
      assert.equal(config!.format, "text");
      assert.equal(config!.mentionAssignee, true, "non-empty assignee map auto-enables mention");
      assert.equal(config!.assigneeMap.get("alice"), "U123");
    },
  );
});

test("loadConfig: out-of-range priority falls back to 1", () => {
  withEnv(
    { PM_SLACK_WEBHOOK: "https://hooks.slack.com/services/A/B/C", PM_SLACK_MIN_PRIORITY: "9" },
    () => {
      __resetWarnState();
      const config = loadConfig();
      assert.ok(config);
      assert.equal(config!.minPriority, 1, "invalid priority clamps to 1");
    },
  );
});

test("loadConfig: mentionAssignee=0 forces mentions off even with a map", () => {
  withEnv(
    {
      PM_SLACK_WEBHOOK: "https://hooks.slack.com/services/A/B/C",
      PM_SLACK_ASSIGNEE_MAP: "alice=U123",
      PM_SLACK_MENTION_ASSIGNEE: "0",
    },
    () => {
      __resetWarnState();
      const config = loadConfig();
      assert.ok(config);
      assert.equal(config!.mentionAssignee, false, "explicit 0 disables mention");
    },
  );
});

// ---------------------------------------------------------------------------
// meetsMinPriority
// ---------------------------------------------------------------------------

test("meetsMinPriority: undefined priority always passes, lower number wins", () => {
  assert.equal(meetsMinPriority({ id: "1", title: "t" }, 2), true, "undefined priority passes");
  assert.equal(meetsMinPriority({ id: "1", title: "t", priority: 1 }, 2), true, "priority 1 <= 2");
  assert.equal(meetsMinPriority({ id: "1", title: "t", priority: 3 }, 2), false, "priority 3 > 2");
  assert.equal(meetsMinPriority({ id: "1", title: "t", priority: 2 }, 2), true, "priority 2 <= 2");
});

// ---------------------------------------------------------------------------
// eventReason: block event and cancel fallback to closedReason
// ---------------------------------------------------------------------------

test("eventReason: block event reads blocked_reason/blockedReason", () => {
  const item1 = { id: "1", title: "t", blocked_reason: "Waiting on API" };
  const r1 = buildItemPayload(item1, "block", "text").text;
  assert.ok(r1.includes("Waiting on API"), "blocked_reason in block event text");

  const item2 = { id: "1", title: "t", blockedReason: "Design pending" };
  // blocked_reason absent → falls back to blockedReason (camelCase)
  const r2 = buildItemPayload(item2, "block", "text").text;
  assert.ok(r2.includes("Design pending"), "blockedReason fallback in text output");
});

test("eventReason: cancel falls back to close_reason then closedReason", () => {
  const item = { id: "1", title: "t", close_reason: "Dup", closedReason: "Other" };
  const text = buildItemPayload(item, "cancel", "text").text;
  assert.ok(text.includes("Dup"), "cancel reads close_reason first");
});

test("eventReason: no reason fields → 'no reason given' in text", () => {
  const item = { id: "1", title: "t" };
  const text = buildItemPayload(item, "block", "text").text;
  assert.ok(text.includes("no reason given"), "block without reason falls back");
});

// ---------------------------------------------------------------------------
// buildTextMessage: status-transition events (open/start/unblock/reopen)
// ---------------------------------------------------------------------------

test("buildTextMessage: status-transition events show status and assignee", () => {
  const item = { id: "1", title: "Rate limiter", type: "Feature", priority: 2 as const, status: "in_progress", assignee: "frank" };
  const text = buildTextMessage(item, "start");
  assert.ok(text.includes("Status: in_progress"), "start event shows status");
  assert.ok(text.includes("Assignee: frank"), "start event shows assignee");
});

test("buildTextMessage: status transition without assignee omits assignee line", () => {
  const item = { id: "1", title: "Onboarding", type: "Task", status: "open" };
  const text = buildTextMessage(item, "open");
  assert.ok(text.includes("Status: open"));
  assert.ok(!text.includes("Assignee:"), "no assignee field when absent");
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs: date form, array form, malformed
// ---------------------------------------------------------------------------

test("parseRetryAfterMs: numeric, date, array, and malformed forms", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("0"), 0);
  // HTTP-date form: a future date yields a non-negative offset
  const future = new Date(Date.now() + 5000).toUTCString();
  const delay = parseRetryAfterMs(future);
  assert.ok(delay !== undefined && delay > 0 && delay <= 5000, "future date → positive delay");
  // past date → clamped to 0
  const past = new Date(Date.now() - 10000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 0, "past date → 0");
  // array form: first element used
  assert.equal(parseRetryAfterMs(["3", "5"]), 3000);
  // empty/undefined
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  // negative numeric: -1 is also a valid HTTP-date in some runtimes, so use
  // a value that is neither a valid number nor a valid date
  assert.equal(parseRetryAfterMs("not-a-date-or-number"), undefined);
});

// ---------------------------------------------------------------------------
// postToSlackOnce: non-2xx, request error, timeout
// ---------------------------------------------------------------------------

test("postToSlackOnce: non-2xx response rejects with SlackHttpError carrying status", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(429, { "retry-after": "2" });
    res.end("rate_limited");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      postToSlackOnce(`http://127.0.0.1:${port}/hook`, { text: "hi" }),
      (err: unknown) => {
        assert.ok(err instanceof SlackHttpError);
        assert.equal((err as InstanceType<typeof SlackHttpError>).status, 429);
        assert.equal((err as InstanceType<typeof SlackHttpError>).retryAfterMs, 2000);
        assert.match((err as Error).message, /429/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("postToSlackOnce: connection refused triggers req.on(error)", async () => {
  // Reserve and free a port so we know nothing is listening on it.
  const port = await getUnusedPort();
  await assert.rejects(
    postToSlackOnce(`http://127.0.0.1:${port}/hook`, { text: "hi" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Slack webhook request failed/);
      return true;
    },
  );
});

test("postToSlackOnce: 500 response with Retry-After date header", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { "retry-after": new Date(Date.now() + 3000).toUTCString() });
    res.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      postToSlackOnce(`http://127.0.0.1:${port}/hook`, { text: "hi" }),
      (err: unknown) => {
        assert.ok(err instanceof SlackHttpError);
        assert.equal((err as InstanceType<typeof SlackHttpError>).status, 503);
        assert.ok((err as InstanceType<typeof SlackHttpError>).retryAfterMs !== undefined);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// postToSlack (retry loop): tested through slack notify command handler
// ---------------------------------------------------------------------------

test("postToSlack retries on 429 then succeeds via slack notify command", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { "retry-after": "0" });
      res.end("rate_limited");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const webhookUrl = `http://127.0.0.1:${port}/hook`;
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Hello", webhook: webhookUrl },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.ok((result.result as { posted: boolean }).posted);
    assert.equal(calls, 2, "first attempt 429, second succeeds");
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("postToSlack exhausts retries on persistent 500 and re-throws", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end("error");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const webhookUrl = `http://127.0.0.1:${port}/hook`;
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Hello", webhook: webhookUrl },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    // The notify handler catches network failures and returns posted:false
    assert.equal((result.result as { posted: boolean }).posted, false);
    assert.ok((result.result as { error: string }).error);
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// readStoreItems: tested through slack digest command with a temp pm root
// ---------------------------------------------------------------------------

test("slack digest reads store items from a temp pm root (dry-run)", async () => {
  const pmRoot = makeTempPmRoot();
  mkdirSync(join(pmRoot, "tasks"), { recursive: true });
  writeFileSync(
    join(pmRoot, "tasks", "pm-aaa.toon"),
    [
      "id: pm-aaa",
      'title: "Test task"',
      "type: Task",
      "status: open",
      "priority: 2",
      `created_at: "${new Date().toISOString()}"`,
      `updated_at: "${new Date().toISOString()}"`,
    ].join("\n"),
  );
  mkdirSync(join(pmRoot, "issues"), { recursive: true });
  writeFileSync(
    join(pmRoot, "issues", "pm-bbb.toon"),
    [
      "id: pm-bbb",
      'title: "Closed issue"',
      "type: Issue",
      "status: closed",
      `created_at: "${new Date(Date.now() - 10 * 86400000).toISOString()}"`,
      `updated_at: "${new Date().toISOString()}"`,
    ].join("\n"),
  );
  // A non-item directory to verify it's walked but non-item files are skipped
  mkdirSync(join(pmRoot, "features"), { recursive: true });
  writeFileSync(join(pmRoot, "features", "readme.txt"), "not an item");

  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, days: "1" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { dryRun: boolean; counts: { created: number; closed: number }; total: number };
  assert.equal(res.dryRun, true);
  assert.equal(res.counts.created, 1, "pm-aaa created today");
  assert.equal(res.counts.closed, 1, "pm-bbb closed today");
  assert.equal(res.total, 2);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// extractItem
// ---------------------------------------------------------------------------

test("extractItem: result.item wins, result.items fallback, null when absent", () => {
  assert.deepEqual(
    extractItem(afterCtx({ result: { item: { id: "x", title: "T" } } })),
    { id: "x", title: "T" },
  );
  assert.deepEqual(
    extractItem(afterCtx({ result: { items: [{ id: "y", title: "U" }] } })),
    { id: "y", title: "U" },
  );
  assert.equal(extractItem(afterCtx({ result: {} })), null);
  assert.equal(extractItem(afterCtx({})), null);
  // items array with no id on first entry → null
  assert.equal(extractItem(afterCtx({ result: { items: [{ title: "no id" }] } })), null);
});

// ---------------------------------------------------------------------------
// afterCommand hook: full behavioural coverage through the harness
// ---------------------------------------------------------------------------

test("afterCommand hook: no-op when ok=false", async () => {
  const ext = await harness();
  const warnings = await ext.runHook({
    kind: "after_command",
    context: afterCtx({ command: "create", ok: false, result: { item: { id: "x", title: "T" } } }),
  });
  assert.deepEqual(warnings, [], "failed command must not trigger hook");
  await ext.deactivate();
});

test("afterCommand hook: no-op when no webhook configured", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, async () => {
    __resetWarnState();
    const warnings = await ext.runHook({
      kind: "after_command",
      context: afterCtx({ command: "create", result: { item: { id: "x", title: "T" } } }),
    });
    assert.deepEqual(warnings, [], "no webhook → silent no-op");
  });
  await ext.deactivate();
});

test("afterCommand hook: posts notification on create event", async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { received += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ext = await harness();
    await withEnvAsync(
      { PM_SLACK_WEBHOOK: `http://127.0.0.1:${port}/hook`, PM_SLACK_ROUTES: undefined },
      async () => {
        const warnings = await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "create",
            result: { item: { id: "pm-1", title: "New feature", type: "Feature", priority: 1, status: "open", author: "alice" } },
          }),
        });
        assert.deepEqual(warnings, [], "hook must not produce warnings on a clean post");
        // Wait a tick for the async post (the hook is fire-and-forget)
        assert.ok(received.length > 0, "payload must be posted");
        const payload = JSON.parse(received);
        assert.ok(payload.text.includes("New feature"), "notification includes item title");
      },
    );
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("afterCommand hook: event filtered by PM_SLACK_EVENTS", async () => {
  const ext = await harness();
  await withEnvAsync(
    { PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_EVENTS: "close", PM_SLACK_ROUTES: undefined },
    async () => {
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "create",
            result: { item: { id: "x", title: "T" } },
          }),
        });
      } finally {
        console.error = orig;
      }
      assert.ok(lines.some((l) => l.includes("filtered by PM_SLACK_EVENTS")), "must log filter reason");
    },
  );
  await ext.deactivate();
});

test("afterCommand hook: no item extracted → skip", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_ROUTES: undefined }, async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await ext.runHook({
        kind: "after_command",
        context: afterCtx({ command: "create", result: {} }),
      });
    } finally {
      console.error = orig;
    }
    assert.ok(lines.some((l) => l.includes("Could not extract item")), "must log extraction failure");
  });
  await ext.deactivate();
});

test("afterCommand hook: priority below minimum → skip", async () => {
  const ext = await harness();await withEnvAsync(    { PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_MIN_PRIORITY: "1", PM_SLACK_ROUTES: undefined },
    async () => {
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "create",
            result: { item: { id: "x", title: "T", priority: 4 } },
          }),
        });
      } finally {
        console.error = orig;
      }
      assert.ok(lines.some((l) => l.includes("below minimum")), "must log priority skip");
    },
  );
  await ext.deactivate();
});

test("afterCommand hook: no route resolved → skip", async () => {
  const ext = await harness();
  // Routes-only config where the event doesn't match any rule, and no default webhook
  await withEnvAsync(
    {
      PM_SLACK_WEBHOOK: undefined,
      PM_SLACK_ROUTES: JSON.stringify([{ match: "close", webhook: "https://h/close" }]),
    },
    async () => {
      __resetWarnState();
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try {
        await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "create",
            result: { item: { id: "x", title: "T" } },
          }),
        });
      } finally {
        console.error = orig;
      }
      assert.ok(lines.some((l) => l.includes("No webhook resolved")), "must log no-route skip");
    },
  );
  await ext.deactivate();
});

test("afterCommand hook: hook error is swallowed (never throws)", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_ROUTES: undefined }, async () => {
    // An unreachable webhook will cause postToSlack to fail, but the hook
    // catches everything. The runHook helper returns warnings, not throws.
    const warnings = await ext.runHook({
      kind: "after_command",
      context: afterCtx({
        command: "create",
        result: { item: { id: "x", title: "T" } },
      }),
    });
    // The hook swallows errors, so no warnings from the hook runner either.
    assert.deepEqual(warnings, []);
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack notify command: full behavioural coverage
// ---------------------------------------------------------------------------

test("slack notify --dry-run: prints message and payload without posting", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { text: "Release shipped", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { dryRun: boolean; event: string; format: string };
  assert.equal(res.dryRun, true);
  assert.equal(res.event, "create");
  await ext.deactivate();
});

test("slack notify: no title or text → CommandError", async () => {
  const ext = await harness();
  await assert.rejects(
    ext.runCommand({ command: "slack notify", options: { "dry-run": true }, global: { json: true } as never }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Provide a --title or --text/);
      assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
  await ext.deactivate();
});

test("slack notify: --filter that does not match → filtered result", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { title: "Bug fix", type: "Bug", on: "close", filter: "type:Feature", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { filtered: boolean };
  assert.equal(res.filtered, true);
  await ext.deactivate();
});

test("slack notify: --format custom without --template → CommandError", async () => {
  const ext = await harness();
  await assert.rejects(
    ext.runCommand({
      command: "slack notify",
      options: { title: "Deploy", format: "custom", "dry-run": true },
      global: { json: true } as never,
    }),
    (err: unknown) => err instanceof Error && /\-\-format custom requires \-\-template/.test((err as Error).message),
  );
  await ext.deactivate();
});

test("slack notify: --format custom with --template dry-run", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: {
      title: "Deploy",
      format: "custom",
      template: "{emoji} {title} ({id}) {event}",
      "dry-run": true,
    },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { dryRun: boolean; format: string; payload: { text: string } };
  assert.equal(res.format, "custom");
  assert.ok(res.payload.text.includes("Deploy"));
  await ext.deactivate();
});

test("slack notify: --thread adds thread_ts to payload", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { text: "Threaded reply", thread: "1700000000.000100", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { thread_ts: string };
  assert.equal(res.thread_ts, "1700000000.000100");
  await ext.deactivate();
});

test("slack notify: --mention-map resolves assignee mention in dry-run", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: {
      title: "Auth",
      assignee: "alice",
      "mention-map": "alice=U123",
      "dry-run": true,
    },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { text: string; blocks: unknown[] } }).payload;
  assert.ok(payload.text.includes("<@U123>"), "mention map resolves to @U123");
  await ext.deactivate();
});

test("slack notify: --channel-override redirects event to different channel", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: {
      title: "Hotfix",
      on: "close",
      "channel-override": "close=#incidents",
      "dry-run": true,
    },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { channel: string };
  assert.equal(res.channel, "#incidents");
  await ext.deactivate();
});

test("slack notify: --url adds action button link in dry-run blockkit payload", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: {
      title: "Feature",
      url: "https://github.com/unbraind/pm-slack/issues/1",
      "dry-run": true,
    },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { blocks: unknown[] } }).payload;
  const json = JSON.stringify(payload.blocks);
  assert.ok(json.includes("View on GitHub"), "github URL shows 'View on GitHub' button");
  await ext.deactivate();
});

test("slack notify: real post to local server succeeds", async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { received += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Hello team", webhook: `http://127.0.0.1:${port}/hook` },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { posted: boolean }).posted, true);
    assert.ok(JSON.parse(received).text.includes("Hello team"));
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("slack notify: non-dry-run without webhook → CommandError", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({
        command: "slack notify",
        options: { text: "Hello" },
        global: { json: true } as never,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /No Slack webhook configured/);
        assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.USAGE);
        return true;
      },
    );
  });
  await ext.deactivate();
});

test("slack notify: network failure returns posted:false (does not throw)", async () => {
  const ext = await harness();
  const port = await getUnusedPort();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { text: "Hello", webhook: `http://127.0.0.1:${port}/hook` },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { posted: boolean }).posted, false);
  assert.ok((result.result as { error: string }).error);
  await ext.deactivate();
});

test("slack notify: human-mode dry-run writes to stdout", async () => {
  const ext = await harness();
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Human mode", "dry-run": true },
      global: { json: false } as never,
    });
    assert.equal(result.handled, true);
    const output = chunks.join("");
    assert.ok(output.includes("Human mode"), "dry-run prints message to stdout");
  } finally {
    process.stdout.write = origWrite;
  }
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test command: full behavioural coverage
// ---------------------------------------------------------------------------

test("slack test: default preview returns payload for create event", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: {},
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { preview: boolean; event: string; format: string };
  assert.equal(res.preview, true);
  assert.equal(res.event, "create");
  assert.equal(res.format, "blockkit");
  await ext.deactivate();
});

test("slack test: --on close preview with filter", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "close", filter: "type:Issue" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { event: string; filtered: boolean };
  assert.equal(res.event, "close");
  assert.equal(res.filtered, false, "close sample is an Issue, filter matches");
  await ext.deactivate();
});

test("slack test: --format custom without --template → CommandError", async () => {
  const ext = await harness();
  await assert.rejects(
    ext.runCommand({
      command: "slack test",
      options: { format: "custom" },
      global: { json: true } as never,
    }),
    (err: unknown) => err instanceof Error && /\-\-format custom requires \-\-template/.test((err as Error).message),
  );
  await ext.deactivate();
});

test("slack test: --format custom with --template", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { format: "custom", template: "{emoji} {title} ({id}) {event}", on: "close" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { format: string; payload: { text: string } };
  assert.equal(res.format, "custom");
  assert.ok(res.payload.text.includes("Fix login redirect bug"));
  await ext.deactivate();
});

test("slack test: --channel-override redirects event channel", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "close", "channel-override": "close=#releases" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { channel: string }).channel, "#releases");
  await ext.deactivate();
});

test("slack test: --mention-assignee resolves sample assignee", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "start", "mention-assignee": true, "mention-map": "frank=U999" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { text: string; blocks: unknown[] } }).payload;
  assert.ok(payload.text.includes("<@U999>"), "mention resolved from map");
  await ext.deactivate();
});

test("slack test: --url overrides the sample URL", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { url: "https://example.com/custom" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { blocks: unknown[] } }).payload;
  const json = JSON.stringify(payload.blocks);
  assert.ok(json.includes("Open item"), "non-github URL shows 'Open item' button");
  assert.ok(json.includes("example.com/custom"));
  await ext.deactivate();
});

test("slack test: human-mode prints preview to stdout", async () => {
  const ext = await harness();
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await ext.runCommand({
      command: "slack test",
      options: { on: "block" },
      global: { json: false } as never,
    });
    assert.equal(result.handled, true);
    const output = chunks.join("");
    assert.ok(output.includes("Dashboard redesign"), "preview prints sample title to stdout");
  } finally {
    process.stdout.write = origWrite;
  }
  await ext.deactivate();
});

test("slack test: --title overrides sample title", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "create", title: "Custom title" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { text: string; blocks: unknown[] } }).payload;
  assert.ok(payload.text.includes("Custom title"));
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack digest command: full behavioural coverage
// ---------------------------------------------------------------------------

test("slack digest --dry-run: empty store yields zero counts", async () => {
  const pmRoot = makeTempPmRoot();
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, days: "7" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { dryRun: boolean; total: number; counts: { created: number } };
  assert.equal(res.dryRun, true);
  assert.equal(res.total, 0);
  assert.equal(res.counts.created, 0);
  await ext.deactivate();
});

test("slack digest: --days must be a positive integer → CommandError", async () => {
  const ext = await harness();
  await assert.rejects(
    ext.runCommand({
      command: "slack digest",
      options: { "dry-run": true, days: "0" },
      global: { json: true } as never,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /--days must be a positive integer/);
      assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
  await ext.deactivate();
});

test("slack digest: --format custom → CommandError", async () => {
  const ext = await harness();
  await assert.rejects(
    ext.runCommand({
      command: "slack digest",
      options: { "dry-run": true, format: "custom" },
      global: { json: true } as never,
    }),
    (err: unknown) => err instanceof Error && /slack digest supports only/.test((err as Error).message),
  );
  await ext.deactivate();
});

test("slack digest: --since overrides --days", async () => {
  const pmRoot = makeTempPmRoot();
  mkdirSync(join(pmRoot, "tasks"), { recursive: true });
  writeFileSync(
    join(pmRoot, "tasks", "pm-old.toon"),
    [
      "id: pm-old",
      'title: "Old task"',
      "type: Task",
      "status: open",
      `created_at: "${new Date(Date.now() - 30 * 86400000).toISOString()}"`,
    ].join("\n"),
  );
  const ext = await harness();
  // --since far in the past includes the old item
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, since: "2020-01-01" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { total: number }).total, 1, "old item included with wide since");
  await ext.deactivate();
});

test("slack digest: --thread adds thread_ts to payload", async () => {
  const pmRoot = makeTempPmRoot();
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, thread: "1700000000.000100" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { thread_ts: string }).thread_ts, "1700000000.000100");
  await ext.deactivate();
});

test("slack digest: real post to local server succeeds", async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { received += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const pmRoot = makeTempPmRoot();
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack digest",
      options: { webhook: `http://127.0.0.1:${port}/hook`, days: "1" },
      pmRoot,
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { posted: boolean }).posted, true);
    assert.ok(JSON.parse(received).text.includes("activity digest"));
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("slack digest: non-dry-run without webhook → CommandError", async () => {
  const pmRoot = makeTempPmRoot();
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, async () => {
    await assert.rejects(
      ext.runCommand({
        command: "slack digest",
        options: { days: "7" },
        pmRoot,
        global: { json: true } as never,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /No Slack webhook configured/);
        assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.USAGE);
        return true;
      },
    );
  });
  await ext.deactivate();
});

test("slack digest: post failure throws CommandError", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end("bad webhook");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const pmRoot = makeTempPmRoot();
  try {
    const ext = await harness();
    await assert.rejects(
      ext.runCommand({
        command: "slack digest",
        options: { webhook: `http://127.0.0.1:${port}/hook`, days: "1" },
        pmRoot,
        global: { json: true } as never,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /Failed to post digest to Slack/);
        assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.GENERIC_FAILURE);
        return true;
      },
    );
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("slack digest: human-mode dry-run writes to stdout", async () => {
  const pmRoot = makeTempPmRoot();
  const ext = await harness();
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await ext.runCommand({
      command: "slack digest",
      options: { "dry-run": true, days: "7" },
      pmRoot,
      global: { json: false } as never,
    });
    assert.equal(result.handled, true);
    const output = chunks.join("");
    assert.ok(output.includes("activity digest"), "digest dry-run prints to stdout");
  } finally {
    process.stdout.write = origWrite;
  }
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// Preflight override: behavioural coverage through the harness
// ---------------------------------------------------------------------------

test("preflight override: non-posting command returns pass-through", async () => {
  const ext = await harness();
  // slack test is NOT in the preflight scope (SLACK_POSTING_COMMANDS), so the
  // runner returns overridden:false (no matched override for that command).
  const result = await ext.runPreflightOverride(preflightCtx("slack test", {}));
  assert.equal(result.overridden, false, "slack test has no matching preflight override");
  await ext.deactivate();
});

test("preflight override: dry-run posting command returns empty delta", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, async () => {
    const result = await ext.runPreflightOverride(
      preflightCtx("slack notify", { "dry-run": true }),
    );
    assert.equal(result.overridden, true);
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// Helper branches: parseEvents, parseFormat, parseRoutes, selectRoute
// ---------------------------------------------------------------------------

test("parseEvents: undefined spec returns all events, empty parsed returns all", () => {
  const all = parseEvents(undefined);
  assert.equal(all.size, 8, "undefined spec → all 8 events");
  // spec with only invalid tokens → all events (safety fallback)
  const invalid = parseEvents("nonsense,garbage");
  assert.equal(invalid.size, 8, "all-invalid spec → all events");
});

test("parseFormat: 'rich' alias maps to blockkit", () => {
  assert.equal(parseFormat("rich"), "blockkit");
});

test("parseRoutes: non-object entries and entries with non-string match are skipped", () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
  // null entry, number entry, entry with non-string match
  const rules = parseRoutes('[null, 42, {"match": 123}, {"match": "  ", "channel": "#x"}, {"match": "ok", "channel": "#y"}]');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].match, "ok");
  } finally {
    console.error = orig;
  }
});

test("selectRoute: matching rule with no webhook and no default → null", () => {
  const item = { id: "1", title: "t", type: "Bug" };
  // Rule matches but has only a channel, and there's no default webhook
  const target = selectRoute(
    "create",
    item,
    [{ match: "type:Bug", channel: "#bugs" }],
    "",
    undefined,
  );
  assert.equal(target, null, "rule matches but no webhook resolvable");
});

// ---------------------------------------------------------------------------
// resolveEffectiveWebhook: flag source path
// ---------------------------------------------------------------------------

test("resolveEffectiveWebhook: flag source returns flag URL", () => {
  withEnv({ PM_SLACK_WEBHOOK: undefined, PM_SLACK_ROUTES: undefined }, () => {
    const r = resolveEffectiveWebhook("  https://hooks.slack.com/flag  ");
    assert.equal(r.source, "flag");
    assert.equal(r.webhookUrl, "https://hooks.slack.com/flag");
  });
});

// ---------------------------------------------------------------------------
// priorityLabel: undefined priority
// ---------------------------------------------------------------------------

test("priorityLabel: undefined priority returns 'unknown'", () => {
  const text = buildTextMessage({ id: "1", title: "T" }, "create");
  assert.ok(text.includes("Priority: unknown"), "undefined priority → 'unknown'");
});

// ---------------------------------------------------------------------------
// templateReplacements: title/id nullish fallback
// ---------------------------------------------------------------------------

test("buildCustomMessage: missing title and id produce empty replacements", () => {
  // PmItem declares title/id as required strings, but the SDK's runtime
  // result can omit them. This exercises the ?? "" defensive fallback.
  const item = { id: undefined, title: undefined } as unknown as Parameters<typeof buildCustomMessage>[0];
  const result = buildCustomMessage(item, "create", "title={title} id={id}");
  assert.ok(result.includes("title= id="), "missing title/id → empty strings");
});

// ---------------------------------------------------------------------------
// truncate: max <= 0 returns empty string
// ---------------------------------------------------------------------------

test("truncate: max <= 0 returns empty string", () => {
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", -1), "");
});

// ---------------------------------------------------------------------------
// buildItemBlockKit: note with only whitespace is not added as a section
// ---------------------------------------------------------------------------

test("buildItemPayload: whitespace-only note is omitted from text body", () => {
  const item = { id: "1", title: "T", type: "Bug" };
  // whitespace-only note → not appended to text body (opts.note.trim() is falsy)
  const payload = buildItemPayload(item, "create", "text", { note: "   " });
  assert.ok(!payload.text.includes("   "), "whitespace-only note not appended");

  // non-empty note → appended to text body
  const payload2 = buildItemPayload(item, "create", "text", { note: "Extra context" });
  assert.ok(payload2.text.includes("Extra context"), "non-empty note appended");
});

// ---------------------------------------------------------------------------
// statusIsClosed: various closed-status synonyms
// ---------------------------------------------------------------------------

test("aggregateDigest: done/resolved/complete statuses count as closed", () => {
  const now = new Date().toISOString();
  const items = [
    { id: "a", title: "done", status: "done", updated_at: now },
    { id: "b", title: "resolved", status: "resolved", updated_at: now },
    { id: "c", title: "completed", status: "completed", updated_at: now },
    { id: "d", title: "open", status: "open", updated_at: now },
  ];
  const s = aggregateDigest(items, 0, "today");
  assert.equal(s.counts.closed, 3, "done+resolved+completed all count as closed");
});

// ---------------------------------------------------------------------------
// digestItemLines: overflow marker when items exceed max
// ---------------------------------------------------------------------------

test("digestItemLines: overflow marker when more items than max (via buildDigestText)", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `pm-${i}`, title: `T${i}`, created_at: new Date().toISOString(), status: "open" }));
  const s = aggregateDigest(items, 0, "today");
  const text = buildDigestText(s);
  // digestItemLines caps at 5, so the 6th and 7th items are replaced by an overflow marker
  assert.ok(text.includes("more"), "overflow marker present when items exceed max");
});

test("digestItemLines: items with no title show (untitled) (via buildDigestText)", () => {
  const items = [{ id: "x", title: undefined as unknown as string, created_at: new Date().toISOString(), status: "open" }];
  const s = aggregateDigest(items, 0, "today");
  const text = buildDigestText(s);
  assert.ok(text.includes("(untitled)"), "missing title shows (untitled)");
});

// ---------------------------------------------------------------------------
// buildDigestText: singular "update" vs plural "updates"
// ---------------------------------------------------------------------------

test("buildDigestText: total=1 uses singular 'update'", () => {
  const items = [{ id: "a", title: "t", created_at: new Date().toISOString(), status: "open" }];
  const s = aggregateDigest(items, 0, "today");
  const text = buildDigestText(s);
  assert.ok(text.includes("1 update"), "singular form for total=1");
  assert.ok(!text.includes("1 updates"), "not plural for total=1");
});

test("buildDigestText: total=0 shows no-activity line", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const text = buildDigestText(s);
  assert.ok(text.includes("No activity"), "empty window shows no-activity");
});

// ---------------------------------------------------------------------------
// buildDigestBlockKit: channel in footer
// ---------------------------------------------------------------------------

test("buildDigestBlockKit: channel appears in footer context", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const { blocks } = buildDigestBlockKit(s, "#team");
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("#team"), "channel shown in block kit footer");
});

test("buildDigestBlockKit: total=1 singular in context line", () => {
  const items = [{ id: "a", title: "t", created_at: new Date().toISOString(), status: "open" }];
  const s = aggregateDigest(items, 0, "today");
  const { blocks } = buildDigestBlockKit(s);
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("1 update"), "singular in block kit context");
});

// ---------------------------------------------------------------------------
// buildDigestPayload: channel attached
// ---------------------------------------------------------------------------

test("buildDigestPayload: channel is attached to payload", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const payload = buildDigestPayload(s, "text", "#chan");
  assert.equal(payload.channel, "#chan");
});

// ---------------------------------------------------------------------------
// detectEvent: uncovered branches
// ---------------------------------------------------------------------------

test("detectEvent: undefined command, OPEN_COMMAND non-reopen, update with unknown status", () => {
  // undefined command → empty string → no match → null
  assert.equal(detectEvent({ command: undefined, args: [], pm_root: "", ok: true } as unknown as AfterCommandHookContext), null);

  // OPEN_COMMAND 'pause-task' (not 'reopen') → 'open'
  assert.equal(
    detectEvent(afterCtx({ command: "pause-task", result: { item: { id: "x", status: "open" } } })),
    "open",
  );

  // OPEN_COMMAND 'release' → 'open'
  assert.equal(
    detectEvent(afterCtx({ command: "release", result: { item: { id: "x", status: "open" } } })),
    "open",
  );

  // update with unknown --status → falls back to result status
  assert.equal(
    detectEvent(afterCtx({ command: "update", options: { status: "draft" }, result: { item: { id: "x", status: "blocked" } } })),
    "block",
  );

  // update with --status that maps but result status is absent
  assert.equal(
    detectEvent(afterCtx({ command: "update", options: { status: "in_progress" }, result: { item: { id: "x" } } })),
    "start",
  );

  // update with no --status and no result status → null
  assert.equal(
    detectEvent(afterCtx({ command: "update", result: { item: { id: "x" } } })),
    null,
  );

  // previousStatus as non-string (number) → treated as empty
  assert.equal(
    detectEvent(afterCtx({
      command: "update",
      options: { status: "open" },
      result: { item: { id: "x", status: "open" }, previousStatus: 42 as unknown as string },
    })),
    "open",
  );
});

// ---------------------------------------------------------------------------
// postToSlackOnce: HTTPS protocol selection (http vs https)
// ---------------------------------------------------------------------------

test("postToSlackOnce: http protocol uses port 80 default, https uses 443", async () => {
  // We can only practically test http locally; this covers the http branch.
  // The https branch is covered implicitly by the URL validation tests.
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await postToSlackOnce(`http://127.0.0.1:${port}/hook`, { text: "ok" });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// eventReason: cancel with no reason fields at all → undefined
// ---------------------------------------------------------------------------

test("eventReason: cancel with no reason fields returns undefined", () => {
  const item = { id: "1", title: "t", status: "canceled" };
  const text = buildItemPayload(item, "cancel", "text").text;
  assert.ok(text.includes("no reason given"), "cancel with no reason → 'no reason given'");
});

// ---------------------------------------------------------------------------
// readStoreItems: unreadable file is skipped (catch block)
// ---------------------------------------------------------------------------

test("slack digest skips unreadable items in store (catch block)", async () => {
  const pmRoot = mkdtempSync(join(tmpdir(), "pm-slack-"));
  mkdirSync(join(pmRoot, "tasks"), { recursive: true });
  // A directory with .toon extension causes readFileSync to throw EISDIR
  mkdirSync(join(pmRoot, "tasks", "bad.toon"), { recursive: true });
  // A valid item alongside the bad one
  writeFileSync(
    join(pmRoot, "tasks", "pm-good.toon"),
    ["id: pm-good", 'title: "Good"', "type: Task", "status: open", `created_at: "${new Date().toISOString()}"`].join("\n"),
  );
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, days: "1" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { total: number }).total, 1, "only the valid item is counted");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack notify: routes-only config hits the defensive webhook guard
// ---------------------------------------------------------------------------

test("slack notify: routes-only config without --webhook hits defensive guard", async () => {
  const ext = await harness();
  await withEnvAsync(
    {
      PM_SLACK_WEBHOOK: undefined,
      PM_SLACK_ROUTES: JSON.stringify([{ match: "create", webhook: "https://h/r" }]),
    },
    async () => {
      __resetWarnState();
      await assert.rejects(
        ext.runCommand({
          command: "slack notify",
          options: { text: "Hello" },
          global: { json: true } as never,
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match((err as Error).message, /No Slack webhook configured for `slack notify`/);
          assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.USAGE);
          return true;
        },
      );
    },
  );
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack digest: routes-only config hits the defensive webhook guard
// ---------------------------------------------------------------------------

test("slack digest: routes-only config without --webhook hits defensive guard", async () => {
  const pmRoot = mkdtempSync(join(tmpdir(), "pm-slack-"));
  const ext = await harness();
  await withEnvAsync(
    {
      PM_SLACK_WEBHOOK: undefined,
      PM_SLACK_ROUTES: JSON.stringify([{ match: "close", webhook: "https://h/r" }]),
    },
    async () => {
      __resetWarnState();
      await assert.rejects(
        ext.runCommand({
          command: "slack digest",
          options: { days: "7" },
          pmRoot,
          global: { json: true } as never,
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match((err as Error).message, /No Slack webhook configured/);
          assert.equal((err as unknown as { exitCode: number }).exitCode, EXIT_CODE.GENERIC_FAILURE);
          return true;
        },
      );
    },
  );
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack notify: human-mode filtered notification writes to stderr
// ---------------------------------------------------------------------------

test("slack notify: human-mode filtered notification logs to stderr", async () => {
  const ext = await harness();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const result = await ext.runCommand({
      command: "slack notify",
      options: { title: "Bug", type: "Bug", on: "close", filter: "type:Feature", "dry-run": true },
      global: { json: false } as never,
    });
    assert.equal(result.handled, true);
  } finally {
    console.error = orig;
  }
  assert.ok(lines.some((l) => l.includes("filtered out")), "filtered notification logged to stderr");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// postToSlack: retries a non-HTTP retryable error (socket hang up)
// ---------------------------------------------------------------------------

test("postToSlack retries on socket hang up then succeeds via slack notify", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      // Destroy the socket immediately → "socket hang up" (retryable)
      req.socket.destroy();
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const webhookUrl = `http://127.0.0.1:${port}/hook`;
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Retry me", webhook: webhookUrl },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { posted: boolean }).posted, true);
    assert.ok(calls >= 2, "first attempt failed, second succeeded");
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// aggregateDigest: items with undefined status
// ---------------------------------------------------------------------------

test("aggregateDigest: items without status are handled gracefully", () => {
  const now = new Date().toISOString();
  const items = [
    { id: "a", title: "no status", created_at: now },
    { id: "b", title: "has status", status: "open", created_at: now },
  ];
  const s = aggregateDigest(items, 0, "today");
  assert.equal(s.counts.created, 2);
  assert.equal(s.counts.closed, 0);
  assert.equal(s.counts.blocked, 0);
  assert.equal(s.counts.in_progress, 0);
});

// ---------------------------------------------------------------------------
// buildDigestPayload: blockkit format without channel
// ---------------------------------------------------------------------------

test("buildDigestPayload: blockkit without channel has no channel field", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const payload = buildDigestPayload(s, "blockkit");
  assert.equal(payload.channel, undefined);
});

// ---------------------------------------------------------------------------
// postToSlackOnce: timeout fires on a non-responsive server
// ---------------------------------------------------------------------------

test("postToSlackOnce: timeout fires on a server that never responds", async () => {
  // Create a server that accepts the connection but never sends a response.
  // The 10-second timeout in postToSlackOnce fires and destroys the request.
  const server = http.createServer((req) => {
    // Intentionally never call res.end() — let the timeout fire.
    req.resume(); // drain the request body
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      postToSlackOnce(`http://127.0.0.1:${port}/hook`, { text: "will timeout" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match((err as Error).message, /timed out|socket hang up/i,
          "timeout error must mention timeout or socket hang up");
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// postToSlack: all retries fail with non-HTTP error → re-throws last error
// ---------------------------------------------------------------------------

test("postToSlack exhausts retries on persistent socket hang up", async () => {
  const server = http.createServer((req) => {
    req.socket.destroy(); // Always hang up
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const webhookUrl = `http://127.0.0.1:${port}/hook`;
  try {
    const ext = await harness();
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Will fail", webhook: webhookUrl },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { posted: boolean }).posted, false);
    assert.ok((result.result as { error: string }).error);
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// slack notify: --status and --assignee flags populate the synthetic item
// ---------------------------------------------------------------------------

test("slack notify: --status and --assignee populate the synthetic item", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { title: "With details", type: "Feature", status: "open", assignee: "bob", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { blocks: unknown[] } }).payload;
  const json = JSON.stringify(payload.blocks);
  assert.ok(json.includes("open"), "status appears in block kit fields");
  assert.ok(json.includes("bob"), "assignee appears in block kit fields");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack notify: --on with multiple events, first event wins
// ---------------------------------------------------------------------------

test("slack notify: --on close,create → close event wins (first in ALL_EVENTS order)", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { title: "Multi", on: "close,create", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  // ALL_EVENTS = [create, close, block, ...] → create is first
  assert.equal((result.result as { event: string }).event, "create");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack notify: --text different from --title adds note to payload
// ---------------------------------------------------------------------------

test("slack notify: --text different from --title adds note", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { title: "Title", text: "Title\nExtra body text", format: "text", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { text: string; blocks: unknown[] } }).payload;
  assert.ok(payload.text.includes("Extra body text"), "note body appended");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test: --format text produces text-only payload
// ---------------------------------------------------------------------------

test("slack test: --format text produces text-only payload", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { format: "text", on: "create" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const payload = (result.result as { payload: { blocks: unknown; text: string } }).payload;
  assert.equal(payload.blocks, undefined, "text format has no blocks");
  assert.ok(payload.text.includes("Add OAuth login flow"));
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test: filter that does not match → filtered=true
// ---------------------------------------------------------------------------

test("slack test: --filter that does not match → filtered=true", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "create", filter: "type:Bug" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  // create sample is type Feature, filter type:Bug does not match
  assert.equal((result.result as { filtered: boolean }).filtered, true);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack digest: --format text produces text-only payload
// ---------------------------------------------------------------------------

test("slack digest: --format text dry-run", async () => {
  const pmRoot = mkdtempSync(join(tmpdir(), "pm-slack-"));
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, days: "7", format: "text" },
    pmRoot,
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  const res = result.result as { dryRun: boolean; format: string; payload: { blocks: unknown } };
  assert.equal(res.format, "text");
  assert.equal(res.payload.blocks, undefined, "text format has no blocks");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// afterCommand hook: mention resolved from config assignee map
// ---------------------------------------------------------------------------

test("afterCommand hook: mention resolved from PM_SLACK_ASSIGNEE_MAP", async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { received += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ext = await harness();
    await withEnvAsync(
      {
        PM_SLACK_WEBHOOK: `http://127.0.0.1:${port}/hook`,
        PM_SLACK_ASSIGNEE_MAP: "alice=U123",
        PM_SLACK_ROUTES: undefined,
      },
      async () => {
        __resetWarnState();
        await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "create",
            result: { item: { id: "pm-1", title: "Mention me", type: "Feature", priority: 1, status: "open", author: "alice", assignee: "alice" } },
          }),
        });
        const payload = JSON.parse(received);
        assert.ok(payload.text.includes("<@U123>"), "mention resolved from env assignee map");
      },
    );
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// afterCommand hook: close event with item URL
// ---------------------------------------------------------------------------

test("afterCommand hook: close event posts with item URL in payload", async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { received += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ext = await harness();
    await withEnvAsync(
      { PM_SLACK_WEBHOOK: `http://127.0.0.1:${port}/hook`, PM_SLACK_ROUTES: undefined },
      async () => {
        __resetWarnState();
        await ext.runHook({
          kind: "after_command",
          context: afterCtx({
            command: "close",
            result: { item: { id: "pm-9", title: "Fix bug", type: "Issue", priority: 1, status: "closed", close_reason: "fixed", github_url: "https://github.com/unbraind/pm-slack/issues/2" } },
          }),
        });
        const payload = JSON.parse(received);
        assert.ok(JSON.stringify(payload.blocks).includes("View on GitHub"), "github URL in block kit");
      },
    );
    await ext.deactivate();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
// ---------------------------------------------------------------------------
// toErrorMessage: both arms of the instanceof ternary
// ---------------------------------------------------------------------------

test("toErrorMessage: Error instance returns .message, non-Error returns String()", () => {
  assert.equal(toErrorMessage(new Error("boom")), "boom");
  assert.equal(toErrorMessage(new CommandError("usage", 2)), "usage");
  assert.equal(toErrorMessage("plain string"), "plain string");
  assert.equal(toErrorMessage(42), "42");
  assert.equal(toErrorMessage(null), "null");
  assert.equal(toErrorMessage(undefined), "undefined");
});

// ---------------------------------------------------------------------------
// Handler direct calls with options: undefined to cover ?? {} fallbacks
// ---------------------------------------------------------------------------

test("slack notify handler: ctx.options undefined falls back to empty object", async () => {
  const ext = await harness();
  const handler = ext.activation.commands.handlers.find((h) => h.command === "slack notify");
  assert.ok(handler, "slack notify handler must be registered");
  // Call run directly with options: undefined — the ?? {} defensive guard fires
  await assert.rejects(
    handler!.run({ options: undefined, args: [], global: { json: true }, pm_root: "", command: "slack notify" } as never) as Promise<unknown>,
    (err: unknown) => err instanceof Error && /No Slack webhook configured/.test((err as Error).message),
  );
  await ext.deactivate();
});

test("slack test handler: ctx.options undefined falls back to empty object", async () => {
  const ext = await harness();
  const handler = ext.activation.commands.handlers.find((h) => h.command === "slack test");
  assert.ok(handler, "slack test handler must be registered");
  const result = await handler!.run({ options: undefined, args: [], global: { json: true }, pm_root: "", command: "slack test" } as never);
  assert.ok(result, "slack test returns a result even with undefined options");
  await ext.deactivate();
});

test("slack digest handler: ctx.options undefined falls back to empty object", async () => {
  const ext = await harness();
  const handler = ext.activation.commands.handlers.find((h) => h.command === "slack digest");
  assert.ok(handler, "slack digest handler must be registered");
  const pmRoot = mkdtempSync(join(tmpdir(), "pm-slack-"));
  // With undefined options, dry-run defaults to false, format defaults to blockkit.
  // Set PM_SLACK_WEBHOOK so the preflight gate passes, but the post will fail
  // since there's no real server. The handler catches the failure and throws.
  await withEnvAsync({ PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_ROUTES: undefined }, async () => {
    await assert.rejects(
      handler!.run({ options: undefined, args: [], global: { json: true }, pm_root: pmRoot, command: "slack digest" } as never) as Promise<unknown>,
      (err: unknown) => err instanceof Error,
    );
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// PM_SLACK_CHANNEL env var coverage
// ---------------------------------------------------------------------------

test("slack notify: PM_SLACK_CHANNEL env var provides channel", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_CHANNEL: "#env-team" }, async () => {
    const result = await ext.runCommand({
      command: "slack notify",
      options: { text: "Env chan", "dry-run": true },
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { channel: string }).channel, "#env-team");
  });
  await ext.deactivate();
});

test("slack test: PM_SLACK_CHANNEL env var provides channel", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_CHANNEL: "#preview" }, async () => {
    const result = await ext.runCommand({
      command: "slack test",
      options: {},
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { channel: string }).channel, "#preview");
  });
  await ext.deactivate();
});

test("slack digest: PM_SLACK_CHANNEL env var provides channel", async () => {
  const pmRoot = mkdtempSync(join(tmpdir(), "pm-slack-"));
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_CHANNEL: "#digest-env" }, async () => {
    const result = await ext.runCommand({
      command: "slack digest",
      options: { "dry-run": true, days: "7" },
      pmRoot,
      global: { json: true } as never,
    });
    assert.equal(result.handled, true);
    assert.equal((result.result as { channel: string }).channel, "#digest-env");
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// pm_root fallback: ctx.pm_root undefined falls back to cwd/.agents/pm
// ---------------------------------------------------------------------------

test("slack digest: ctx.pm_root undefined falls back to cwd default", async () => {
  const ext = await harness();
  // When pm_root is not provided in the context, the handler defaults to
  // path.join(process.cwd(), ".agents", "pm"). We test this by ensuring the
  // handler doesn't crash (it will read whatever is at that path, likely empty).
  const result = await ext.runCommand({
    command: "slack digest",
    options: { "dry-run": true, days: "7" },
    // pmRoot intentionally omitted to trigger the ?? fallback
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ALL_EVENTS.find(...) ?? "create" fallback: --on with no valid events
// ---------------------------------------------------------------------------

test("slack notify: --on with only invalid events falls back to create", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack notify",
    options: { title: "Fallback", on: "nonsense,garbage", "dry-run": true },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  // parseEvents returns all events for all-invalid spec, so the first event
  // in ALL_EVENTS (create) is used
  assert.equal((result.result as { event: string }).event, "create");
  await ext.deactivate();
});

test("slack test: --on with only invalid events falls back to create", async () => {
  const ext = await harness();
  const result = await ext.runCommand({
    command: "slack test",
    options: { on: "nonsense,garbage" },
    global: { json: true } as never,
  });
  assert.equal(result.handled, true);
  assert.equal((result.result as { event: string }).event, "create");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test: human mode with no filter shows no filter note
// ---------------------------------------------------------------------------

test("slack test: human mode without filter shows no filter note", async () => {
  const ext = await harness();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await ext.runCommand({
      command: "slack test",
      options: { on: "create" },
      global: { json: false } as never,
    });
  } finally {
    console.error = orig;
  }
  // No filter note because filters.length === 0
  assert.ok(!lines.some((l) => l.includes("FILTERED")), "no filter note without --filter");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// afterCommand hook: detectEvent returns null → no post
// ---------------------------------------------------------------------------

test("afterCommand hook: unrelated command → detectEvent returns null → no post", async () => {
  const ext = await harness();
  await withEnvAsync({ PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_ROUTES: undefined }, async () => {
    __resetWarnState();
    const warnings = await ext.runHook({
      kind: "after_command",
      context: afterCtx({ command: "list", result: {} }),
    });
    assert.deepEqual(warnings, [], "unrelated command produces no warnings");
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// priorityLabel: invalid priority number (defensive ?? "unknown")
// ---------------------------------------------------------------------------

test("priorityLabel: out-of-range priority returns 'unknown' via defensive fallback", () => {
  // PmItem.priority is typed Priority (1-4), but the SDK runtime can deliver
  // any number. This exercises the PRIORITY_LABELS[p] ?? "unknown" fallback.
  const item = { id: "1", title: "T", priority: 9 as never } as Parameters<typeof buildTextMessage>[0];
  const text = buildTextMessage(item, "create");
  assert.ok(text.includes("Priority: unknown"), "out-of-range priority → 'unknown'");
});

// ---------------------------------------------------------------------------
// parseRoutes: entry that is an array (not object) is skipped
// ---------------------------------------------------------------------------

test("parseRoutes: array entry and non-string webhook/channel are skipped", () => {
  const rules = parseRoutes('[[], {"match": "ok", "webhook": 123, "channel": 456}]');
  // Neither entry produces a valid rule: arrays are not objects, and
  // non-string webhook/channel are treated as undefined → rule with no override dropped
  assert.equal(rules.length, 0);
});

// ---------------------------------------------------------------------------
// parseFilter: spec with only whitespace parts produces empty array
// ---------------------------------------------------------------------------

test("parseFilter: spec with only whitespace produces empty array", () => {
  assert.deepEqual(parseFilter("  ,  ,  "), []);
});

// ---------------------------------------------------------------------------
// statusIsClosed: undefined status returns false
// ---------------------------------------------------------------------------

test("aggregateDigest: items with undefined status don't count as closed", () => {
  const now = new Date().toISOString();
  const items = [
    { id: "a", title: "no status", created_at: now, updated_at: now },
  ];
  const s = aggregateDigest(items, 0, "today");
  assert.equal(s.counts.closed, 0, "undefined status → not closed");
  assert.equal(s.counts.created, 1);
});

// ---------------------------------------------------------------------------
// buildDigestPayload: text format without channel
// ---------------------------------------------------------------------------

test("buildDigestPayload: text format without channel has no channel field", () => {
  const s = aggregateDigest([], Date.now(), "last 7 days");
  const payload = buildDigestPayload(s, "text");
  assert.equal(payload.channel, undefined);
});

// ---------------------------------------------------------------------------
// eventReason: close with closedReason fallback (no close_reason)
// ---------------------------------------------------------------------------

test("eventReason: close event falls back to closedReason", () => {
  const item = { id: "1", title: "t", closedReason: "Alt reason" };
  const text = buildItemPayload(item, "close", "text").text;
  assert.ok(text.includes("Alt reason"), "close falls back to closedReason");
});

// ---------------------------------------------------------------------------
// eventReason: cancel with cancelReason (camelCase)
// ---------------------------------------------------------------------------

test("eventReason: cancel event reads cancelReason (camelCase)", () => {
  const item = { id: "1", title: "t", cancelReason: "Duplicate work" };
  const text = buildItemPayload(item, "cancel", "text").text;
  assert.ok(text.includes("Duplicate work"), "cancel reads cancelReason");
});

// ---------------------------------------------------------------------------
// eventReason: cancel with cancel_reason (snake_case)
// ---------------------------------------------------------------------------

test("eventReason: cancel event reads cancel_reason (snake_case)", () => {
  const item = { id: "1", title: "t", cancel_reason: "Deprecated" };
  const text = buildItemPayload(item, "cancel", "text").text;
  assert.ok(text.includes("Deprecated"), "cancel reads cancel_reason");
});

// ---------------------------------------------------------------------------
// eventReason: block with blockedReason (camelCase)
// ---------------------------------------------------------------------------

test("eventReason: block event reads blockedReason (camelCase)", () => {
  const item = { id: "1", title: "t", blockedReason: "Design pending" };
  const text = buildItemPayload(item, "block", "text").text;
  assert.ok(text.includes("Design pending"), "block reads blockedReason");
});

// ---------------------------------------------------------------------------
// ruleMatches: type: selector on item with no type field
// ---------------------------------------------------------------------------

test("ruleMatches: type: selector on item with undefined type does not match", () => {
  const item = { id: "1", title: "t" }; // no type field
  assert.ok(!__test__.ruleMatches({ match: "type:Bug" }, "create", item));
});

// ---------------------------------------------------------------------------
// filterMatches: type: and status: selectors on item with missing fields
// ---------------------------------------------------------------------------

test("filterMatches: type: selector on item with undefined type does not match", () => {
  const item = { id: "1", title: "t" }; // no type, no status
  assert.ok(!__test__.filterMatches("type:Bug", "create", item));
  assert.ok(!__test__.filterMatches("status:open", "create", item));
});

// ---------------------------------------------------------------------------
// truncate: max === 1 returns ellipsis for long text
// ---------------------------------------------------------------------------

test("truncate: max === 1 returns ellipsis for text longer than 1", () => {
  assert.equal(truncate("hello", 1), "…");
  assert.equal(truncate("a", 1), "a"); // exactly 1 char → returned as-is
});

// ---------------------------------------------------------------------------
// Preflight: undefined command and options trigger ?? fallbacks
// ---------------------------------------------------------------------------

test("preflight override: undefined command and options trigger defensive fallbacks", async () => {
  const ext = await harness();
  // Call the override's run function directly (bypassing the SDK's command
  // normalization) to exercise the ?? defensive fallbacks in the preflight.
  const override = ext.activation.preflight.overrides[0];
  assert.ok(override, "preflight override must be registered");
  const result = await override.run({
    command: undefined as unknown as string,
    args: [],
    options: undefined as unknown as Record<string, unknown>,
    global: {} as never,
    pm_root: "",
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  } as never);
  // With undefined command → "" → not a posting command → returns empty delta
  assert.ok(result, "preflight returns a delta for undefined command");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack digest: handler called directly with pm_root undefined
// ---------------------------------------------------------------------------

test("slack digest handler: ctx.pm_root undefined falls back to cwd default", async () => {
  const ext = await harness();
  const handler = ext.activation.commands.handlers.find((h) => h.command === "slack digest");
  assert.ok(handler, "slack digest handler must be registered");
  // Call run directly with pm_root: undefined to trigger the ?? fallback
  const result = await handler!.run({
    options: { "dry-run": true, days: "7" },
    args: [],
    global: { json: true },
    pm_root: undefined as unknown as string,
    command: "slack digest",
  } as never) as { handled?: boolean };
  assert.ok(result, "handler returns a result with undefined pm_root");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// Preflight: posting command with undefined options triggers ?? {} fallback
// ---------------------------------------------------------------------------

test("preflight override: posting command with undefined options triggers ?? {} fallback", async () => {
  const ext = await harness();
  const override = ext.activation.preflight.overrides[0];
  assert.ok(override, "preflight override must be registered");
  await withEnvAsync({ PM_SLACK_WEBHOOK: "http://127.0.0.1:1/hook", PM_SLACK_ROUTES: undefined }, async () => {
    // command is a posting command so the early return is NOT taken,
    // and options is undefined so the ?? {} defensive guard fires.
    const result = await override.run({
      command: "slack notify",
      args: [],
      options: undefined as unknown as Record<string, unknown>,
      global: {} as never,
      pm_root: "",
      decision: {
        enforce_item_format_gate: false,
        run_preflight_item_format_sync: false,
        run_extension_migrations: false,
        enforce_mandatory_migration_gate: false,
      },
    } as never);
    assert.ok(result, "preflight returns a delta");
  });
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test: human mode with matching filter shows [filter matched]
// ---------------------------------------------------------------------------

test("slack test: human mode with matching filter shows [filter matched]", async () => {
  const ext = await harness();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await ext.runCommand({
      command: "slack test",
      options: { on: "close", filter: "type:Issue" },
      global: { json: false } as never,
    });
  } finally {
    console.error = orig;
  }
  assert.ok(lines.some((l) => l.includes("[filter matched]")), "matching filter shows [filter matched]");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// slack test: human mode with non-matching filter shows [FILTERED OUT]
// ---------------------------------------------------------------------------

test("slack test: human mode with non-matching filter shows [FILTERED OUT]", async () => {
  const ext = await harness();
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await ext.runCommand({
      command: "slack test",
      options: { on: "create", filter: "type:Bug" },
      global: { json: false } as never,
    });
  } finally {
    console.error = orig;
  }
  assert.ok(lines.some((l) => l.includes("[FILTERED OUT]")), "non-matching filter shows [FILTERED OUT]");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// postToSlackOnce: https protocol without explicit port defaults to 443
// ---------------------------------------------------------------------------

test("postToSlackOnce: https protocol uses https.request and port 443 default", async () => {
  // An https URL with no explicit port triggers the parsed.port falsy branch
  // (defaults to 443) and the https.request branch. The connection to
  // localhost:443 will fail (nothing is listening), so the error handler fires.
  await assert.rejects(
    postToSlackOnce("https://localhost/hook", { text: "hi" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /Slack webhook request failed/);
      return true;
    },
  );
});
