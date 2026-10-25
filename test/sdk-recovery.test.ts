/** Canonical mutation-feed recovery on real trackers, with no git executable. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { create, createHistoryEntry, init } from "@unbrained/pm-cli/sdk";
import { captureSlackOutbox, SlackOutbox } from "../index.ts";

/** Initialize a real non-git tracker with isolated notification configuration. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-sdk-feed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = Object.keys(process.env).filter((key) => key.startsWith("PM_SLACK_"));
  keys.push("PATH", "GIT_CEILING_DIRECTORIES");
  const saved = { ...process.env };
  for (const key of keys) delete process.env[key];
  process.env.PATH = directory;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  process.env.PM_SLACK_WEBHOOK = "http://127.0.0.1:1/webhook";
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  t.after(() => {
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("PM_SLACK_"))) delete process.env[key];
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, noExtensions: true };
  await init("feed", { defaults: true, agentGuidance: "skip" }, client);
  const box = new SlackOutbox(pmRoot);
  t.after(() => box.close());
  box.enable({ events: ["create", "block"], minPriority: 4 });
  return { pmRoot, client, box };
}

test("recovery builds the canonical feed projection and catches up beyond 1,000 events without git", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const created = await create({ title: "Before the cursor boundary", priority: 1 }, client);
  const historyPath = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = readFileSync(historyPath, "utf8");
  const before = { metadata: created.item, body: "" };
  const timestamp = new Date(Date.now() + 1000).toISOString();
  const annotations = Array.from({ length: 1000 }, () => createHistoryEntry({
    nowIso: timestamp, author: "fixture-agent", op: "notes", before, after: before,
  }));
  const blocked = createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before,
    after: { ...before, metadata: { ...created.item, status: "blocked", title: "Beyond the cursor boundary" } } });
  writeFileSync(historyPath, original + [...annotations, blocked].map((entry) => JSON.stringify(entry) + "\n").join(""));
  const history = readFileSync(historyPath, "utf8");
  const projection = join(pmRoot, "runtime", "history-event-index.sqlite");
  rmSync(projection, { force: true });
  assert.deepEqual(await captureSlackOutbox(pmRoot, box), { inspected: 1002, queued: 2, failed: 0 });
  assert.equal(existsSync(projection), true, "recovery must use the canonical SDK feed, which rebuilds its missing projection");
  assert.deepEqual(box.status().rows.map((row) => row.event), ["create", "block"]);
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 0);
  assert.equal((await captureSlackOutbox(pmRoot, box, [])).inspected, 0);
  assert.equal(readFileSync(historyPath, "utf8"), history, "feed recovery must leave authoritative history untouched");
});

test("legacy timestamps outside the strict feed contract retain verified history fallback", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const created = await create({ title: "Retained pre-feed transition", priority: 1 }, client);
  const historyPath = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = JSON.parse(readFileSync(historyPath, "utf8")) as Record<string, unknown>;
  // Old records have item-state integrity only; removing the modern envelope
  // models an actual legacy record rather than breaking a sealed record's hash.
  delete original.record_hash;
  delete original.record_hash_version;
  original.ts = new Date(Date.now() + 1000).toISOString().replace("Z", "000Z");
  writeFileSync(historyPath, JSON.stringify(original) + "\n");
  assert.deepEqual(await captureSlackOutbox(pmRoot, box), { inspected: 1, queued: 1, failed: 0 });
  assert.equal((await captureSlackOutbox(pmRoot, box)).queued, 0);
});

test("canonical timestamp normalization preserves sealed retained records through history fallback", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const created = await create({ title: "Sealed timestamp offset", priority: 1 }, client);
  const historyPath = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = readFileSync(historyPath, "utf8");
  const before = { metadata: created.item, body: "" };
  const blocked = createHistoryEntry({
    nowIso: new Date(Date.now() + 1000).toISOString().replace("Z", "+00:00"),
    author: "fixture-agent", op: "update", before,
    after: { ...before, metadata: { ...created.item, status: "blocked" } },
  });
  const history = original + JSON.stringify(blocked) + "\n";
  writeFileSync(historyPath, history);
  assert.deepEqual(await captureSlackOutbox(pmRoot, box), { inspected: 2, queued: 2, failed: 0 });
  assert.deepEqual(box.status().rows.map((row) => row.event), ["create", "block"]);
  assert.equal(readFileSync(historyPath, "utf8"), history);
});
