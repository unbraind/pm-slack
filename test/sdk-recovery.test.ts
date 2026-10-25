/** Canonical mutation-feed recovery on real trackers, with no git executable. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { create, createHistoryEntry, init, listMutationEvents, readHistoryEntries, serializeItemDocument, update, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureSlackOutbox, SlackOutbox } from "../index.ts";

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
  return { directory, pmRoot, client, box };
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
  const after = { ...before, metadata: { ...created.item, status: "blocked" as const, title: "Beyond the cursor boundary" } };
  const blocked = createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before, after });
  writeFileSync(historyPath, original + [...annotations, blocked].map((entry) => JSON.stringify(entry) + "\n").join(""));
  writeFileSync(join(pmRoot, "tasks", `${created.item.id}.toon`), serializeItemDocument(after));
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
  const excluded = await create({ title: "Outside the requested legacy stream", priority: 1 }, client);
  assert.deepEqual(await captureSlackOutbox(pmRoot, box, [created.item.id]), { inspected: 1, queued: 0, failed: 0 });
  assert.equal(box.status().rows.some((row) => row.item === excluded.item.id), false,
    "the explicit retained-history fallback must preserve the requested item filter");
});

test("canonical timestamp normalization preserves sealed retained records through history fallback", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const created = await create({ title: "Sealed timestamp offset", priority: 1 }, client);
  const historyPath = join(pmRoot, "history", `${created.item.id}.jsonl`);
  const original = readFileSync(historyPath, "utf8");
  const before = { metadata: created.item, body: "" };
  const after = { ...before, metadata: { ...created.item, status: "blocked" as const } };
  const blocked = createHistoryEntry({
    nowIso: new Date(Date.now() + 1000).toISOString().replace("Z", "+00:00"),
    author: "fixture-agent", op: "update", before,
    after,
  });
  const history = original + JSON.stringify(blocked) + "\n";
  writeFileSync(historyPath, history);
  writeFileSync(join(pmRoot, "tasks", `${created.item.id}.toon`), serializeItemDocument(after));
  assert.deepEqual(await captureSlackOutbox(pmRoot, box), { inspected: 2, queued: 2, failed: 0 });
  assert.deepEqual(box.status().rows.map((row) => row.event), ["create", "block"]);
  assert.equal(readFileSync(historyPath, "utf8"), history);
});

/** Reproducible random positions make every failing corruption case replayable. */
function randomPositions(seed: number) {
  let state = seed;
  return (bound: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % bound;
  };
}

/** Corruption operators vary the damaged record, field byte and prefix length. */
const corruptions = ["hash", "byte", "partial-tail", "valid-prefix", "reorder", "deleted", "duplicate", "empty"] as const;

/** Damage authoritative bytes while retaining the independently primed SDK index. */
function corruptHistory(raw: string, kind: typeof corruptions[number], choose: (bound: number) => number): string | null {
  const lines = raw.trimEnd().split("\n");
  const index = choose(lines.length);
  if (kind === "deleted") return null;
  if (kind === "empty") return "";
  if (kind === "valid-prefix") return lines.slice(0, 1 + choose(lines.length - 1)).join("\n") + "\n";
  if (kind === "partial-tail") {
    const tail = lines.pop()!;
    return lines.join("\n") + "\n" + tail.slice(0, 1 + choose(tail.length - 2));
  }
  if (kind === "reorder") {
    const other = (index + 1 + choose(lines.length - 1)) % lines.length;
    [lines[index], lines[other]] = [lines[other]!, lines[index]!];
  } else if (kind === "duplicate") lines.splice(index, 0, lines[index]!);
  else {
    const field = kind === "hash" ? "record_hash" : "author";
    const match = new RegExp(`"${field}":"([^"]+)"`).exec(lines[index]!)!;
    const at = match.index + field.length + 4 + choose(match[1]!.length);
    const line = lines[index]!;
    lines[index] = line.slice(0, at) + (line[at] === "a" ? "b" : "a") + line.slice(at + 1);
  }
  return lines.join("\n") + "\n";
}

test("primed SDK caches cannot authorize corrupted history, with seeded mutations and real process restarts", async (t) => {
  for (const kind of corruptions) for (const seed of [0x42, 0xbad, 0xc0de]) for (const restart of [false, true]) {
    await t.test(`${kind} seed=${seed} restart=${restart}`, async (t) => {
      const { directory, pmRoot, client, box } = await fixture(t);
      const created = await create({ title: "Property source", priority: 1 }, client);
      await update(created.item.id, { title: `Committed revision ${seed}` }, client);
      await update(created.item.id, { status: "blocked" }, client);
      const optIn = box.since();
      const policies = box.recoveryPolicies();
      const primed = await listMutationEvents({ pmRoot, cwd: directory, full: true, limit: 1000 });
      assert.equal(primed.source, "derived_index");
      const file = join(pmRoot, "history", `${created.item.id}.jsonl`);
      const original = readFileSync(file, "utf8");
      const damaged = corruptHistory(original, kind, randomPositions(seed));
      if (damaged === null) rmSync(file); else writeFileSync(file, damaged);
      if (kind === "hash" || kind === "byte") assert.equal(Buffer.byteLength(damaged!), Buffer.byteLength(original));
      let result: { inspected: number; queued: number; failed: number };
      if (restart) {
        const child = spawnSync(process.execPath, [join(import.meta.dirname, "helpers", "sdk-corruption-probe.ts"), pmRoot,
          ...((kind === "hash" || kind === "byte") ? [created.item.id] : [])],
          { cwd: directory, env: { ...process.env }, encoding: "utf8" });
        assert.equal(child.status, 0, child.stderr);
        if (child.stderr) t.diagnostic(child.stderr.trim());
        result = JSON.parse(child.stdout) as typeof result;
      } else {
        if (kind === "hash" || kind === "byte") {
          const page = await listMutationEvents({ pmRoot, cwd: directory, full: true, limit: 1000 });
          const entries = page.events.filter((event) => event.item_id === created.item.id).map((event) => event.entry!);
          t.diagnostic(`SDK cache observation: ${JSON.stringify({ source: page.source, cached_chain_verifies: verifyHistoryEntries(entries).ok })}`);
        }
        result = await captureSlackOutbox(pmRoot, box);
      }
      assert.deepEqual(result, { inspected: 0, queued: 0, failed: 1 });
      assert.equal(box.status().rows.length, 0, "no intent may be published from a corrupt stream");
      assert.equal(box.since(), optIn, "verification must not advance opt-in");
      assert.deepEqual(box.recoveryPolicies(), policies, "verification must not advance eligibility");
      assert.deepEqual(await captureSlackOutbox(pmRoot, box, [created.item.id]), { inspected: 0, queued: 0, failed: 1 });
    });
  }
});

test("authoritative item mismatch refuses cached history with a typed CLI failure", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const created = await create({ title: "Authoritative alpha", priority: 1 }, client);
  await listMutationEvents({ pmRoot, full: true });
  const itemPath = join(pmRoot, "tasks", `${created.item.id}.toon`);
  writeFileSync(itemPath, readFileSync(itemPath, "utf8").replace("Authoritative alpha", "Authoritative omega"));
  const ext = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  t.after(() => ext.deactivate());
  const response = await ext.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } });
  assert.equal(response.exitCode, 2);
  assert.equal(response.errorCode, "history_unavailable");
  assert.deepEqual((response.result as { recovered: unknown }).recovered, { inspected: 0, queued: 0, failed: 1 });
  assert.equal(box.status().rows.length, 0);
});

test("verified historical snapshots enforce identity and title while retaining the unknown-priority default", async (t) => {
  for (const field of ["id", "title", "priority"] as const) await t.test(field, async (t) => {
    const { pmRoot, client, box } = await fixture(t);
    const created = await create({ title: "Current valid snapshot", priority: 1 }, client);
    const before = { metadata: created.item, body: "" };
    const metadata: Record<string, unknown> = { ...created.item, status: "blocked" };
    if (field === "id") metadata.id = `${created.item.id}-historical`; else delete metadata[field];
    // SDK hashes can verify historical states that predate current item-field
    // guarantees. Restore the current valid snapshot to test that boundary.
    const historical = { metadata, body: "" } as unknown as ItemDocument;
    const timestamp = new Date(Date.now() + 1000).toISOString();
    const transitions = [
      createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before, after: historical }),
      createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before: historical, after: before }),
    ];
    const file = join(pmRoot, "history", `${created.item.id}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + transitions.map((entry) => JSON.stringify(entry) + "\n").join(""));
    assert.equal(verifyHistoryEntries(await readHistoryEntries(file, created.item.id), before).ok, true);
    const recovered = await captureSlackOutbox(pmRoot, box);
    if (field !== "priority") {
      assert.deepEqual(recovered, { inspected: 2, queued: 0, failed: 1 });
      assert.equal(box.status().rows.length, 0, "an invalid historical snapshot cannot publish an earlier buffered intent");
    } else {
      assert.deepEqual(recovered, { inspected: 3, queued: 2, failed: 0 });
      const blocked = box.status().rows.find((row) => row.event === "block")!;
      const db = new DatabaseSync(join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite"), { readOnly: true });
      t.after(() => db.close());
      assert.equal(db.prepare("SELECT priority FROM delivery_context WHERE key=?").get(blocked.key)!.priority, 4);
    }
  });
});
