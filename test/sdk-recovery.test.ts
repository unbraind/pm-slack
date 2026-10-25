/** Canonical mutation-feed recovery on real trackers, with no git executable. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { create, createHistoryEntry, init, listMutationEvents, readHistoryEntries, serializeItemDocument, update, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { captureSlackOutbox, SlackOutbox } from "../index.ts";
import type { OutboxRecoveryReport } from "../index.ts";

/** Keep count assertions strict while requiring complete typed reasons for damaged candidates. */
function assertRecoveryTotals(actual: OutboxRecoveryReport, expected: { inspected: number; queued: number; failed: number }) {
  const { failures, ...totals } = actual;
  assert.deepEqual(totals, expected);
  assert.equal(failures?.length ?? 0, expected.failed);
  for (const failure of failures ?? []) {
    assert.equal(failure.code, "history_unavailable");
    assert.ok(failure.item && failure.reason);
  }
}

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
      assertRecoveryTotals(result, { inspected: 0, queued: 0, failed: 1 });
      assert.equal(box.status().rows.length, 0, "no intent may be published from a corrupt stream");
      assert.equal(box.since(), optIn, "verification must not advance opt-in");
      assert.deepEqual(box.recoveryPolicies(), policies, "verification must not advance eligibility");
      assertRecoveryTotals(await captureSlackOutbox(pmRoot, box, [created.item.id]), { inspected: 0, queued: 0, failed: 1 });
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
  assertRecoveryTotals((response.result as { recovered: OutboxRecoveryReport }).recovered, { inspected: 0, queued: 0, failed: 1 });
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
      assertRecoveryTotals(recovered, { inspected: 2, queued: 0, failed: 1 });
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

/** Every batch includes both review reproductions and independent history failures. */
const mixedDamage = ["document_empty", "document_missing", "document_missing_prefix", "document_invalid", "document_unreadable", "document_identity", "history_partial", "history_reorder", "history_forged", "history_missing", "history_empty", "history_null"] as const;

test("mixed damaged inputs never abort healthy recovery or disable a check, with primed caches and restart", async (t) => {
  for (const seed of [7, 19, 104729]) for (const restart of [false, true]) await t.test(`seed=${seed} restart=${restart}`, async (t) => {
    const { directory, pmRoot, client, box } = await fixture(t);
    const choose = randomPositions(seed);
    const roles: string[] = [...mixedDamage, ...Array.from({ length: 5 }, () => "healthy")];
    for (let index = roles.length - 1; index > 0; index--) {
      const other = choose(index + 1);
      [roles[index], roles[other]] = [roles[other]!, roles[index]!];
    }
    const candidates: { id: string; damage: string }[] = [];
    for (const [index, damage] of roles.entries()) {
      const created = await create({ title: `Mixed source ${index}`, priority: 1 }, client);
      await update(created.item.id, { title: `Committed mixed revision ${seed}-${index}` }, client);
      await update(created.item.id, { status: "blocked" }, client);
      candidates.push({ id: created.item.id, damage });
    }
    assert.equal((await listMutationEvents({ pmRoot, cwd: directory, full: true, limit: 1000 })).source, "derived_index");
    for (const { id, damage } of candidates) {
      const item = join(pmRoot, "tasks", `${id}.toon`);
      const history = join(pmRoot, "history", `${id}.jsonl`);
      const original = readFileSync(history, "utf8");
      if (damage === "document_empty") writeFileSync(item, "");
      else if (damage === "document_missing" || damage === "document_missing_prefix") {
        rmSync(item);
        if (damage === "document_missing_prefix") writeFileSync(history, original.split("\n")[0]! + "\n");
      } else if (damage === "document_invalid") writeFileSync(item, "null\n");
      else if (damage === "document_unreadable") { rmSync(item); mkdirSync(item); }
      else if (damage === "document_identity") writeFileSync(item, readFileSync(item, "utf8").replace(id, `${id}-wrong`));
      else if (damage === "history_partial") writeFileSync(history, corruptHistory(original, "partial-tail", choose)!);
      else if (damage === "history_reorder") writeFileSync(history, corruptHistory(original, "reorder", choose)!);
      else if (damage === "history_forged") writeFileSync(history, corruptHistory(original, "hash", choose)!);
      else if (damage === "history_missing") rmSync(history);
      else if (damage === "history_empty") writeFileSync(history, " \n");
      else if (damage === "history_null") writeFileSync(history, "null\n");
    }
    let result: { first: OutboxRecoveryReport; second: OutboxRecoveryReport; rows: { item: string; event: string }[] };
    if (restart) {
      const child = spawnSync(process.execPath, [join(import.meta.dirname, "helpers", "sdk-mixed-recovery-probe.ts"), pmRoot],
        { cwd: directory, env: { ...process.env }, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      result = JSON.parse(child.stdout) as typeof result;
    } else {
      result = { first: await captureSlackOutbox(pmRoot, box), second: await captureSlackOutbox(pmRoot, box), rows: box.status(100).rows };
    }
    const healthy = candidates.filter((candidate) => candidate.damage === "healthy").map((candidate) => candidate.id).sort();
    const damaged = candidates.filter((candidate) => candidate.damage !== "healthy").map((candidate) => candidate.id).sort();
    assertRecoveryTotals(result.first, { inspected: healthy.length * 3, queued: healthy.length * 2, failed: damaged.length });
    assertRecoveryTotals(result.second, { inspected: healthy.length * 3, queued: 0, failed: damaged.length });
    assert.deepEqual(result.first.failures!.map((failure) => failure.item).sort(), damaged);
    assert.deepEqual(result.second.failures, result.first.failures);
    assert.deepEqual([...new Set(result.rows.map((row) => row.item))].sort(), healthy);
    assert.equal(result.rows.length, healthy.length * 2);
    for (const id of healthy) assert.deepEqual(result.rows.filter((row) => row.item === id).map((row) => row.event).sort(), ["block", "create"]);
    const missing = candidates.find((candidate) => candidate.damage === "document_missing_prefix")!.id;
    assert.equal(result.first.failures!.find((failure) => failure.item === missing)!.reason, "document_missing");
    const empty = candidates.find((candidate) => candidate.damage === "document_empty")!.id;
    assert.equal(result.first.failures!.find((failure) => failure.item === empty)!.reason, "document_unreadable_or_invalid");
  });
});

test("wrong-shaped history fields are explicit failures and cannot suppress another item's notification", async (t) => {
  const cases = ["null", "scalar", "timestamp_type", "timestamp_value", "operation_type", "operation_empty", "patch_type"] as const;
  for (const shape of cases) await t.test(shape, async (t) => {
    const { pmRoot, client, box } = await fixture(t);
    const bad = await create({ title: "Bad wire shape", priority: 1 }, client);
    const good = await create({ title: "Healthy wire shape neighbor", priority: 1 }, client);
    await listMutationEvents({ pmRoot, full: true });
    const file = join(pmRoot, "history", `${bad.item.id}.jsonl`);
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (shape === "timestamp_type") entry.ts = 42;
    else if (shape === "timestamp_value") entry.ts = "not-a-timestamp";
    else if (shape === "operation_type") entry.op = {};
    else if (shape === "operation_empty") entry.op = "";
    else if (shape === "patch_type") entry.patch = {};
    writeFileSync(file, JSON.stringify(shape === "null" ? null : shape === "scalar" ? 42 : entry) + "\n");
    const recovered = await captureSlackOutbox(pmRoot, box);
    assertRecoveryTotals(recovered, { inspected: 1, queued: 1, failed: 1 });
    assert.equal(recovered.failures![0]!.item, bad.item.id);
    assert.equal(recovered.failures![0]!.reason, "history_unreadable_or_invalid");
    assert.deepEqual(box.status().rows.map((row) => row.item), [good.item.id]);
  });
});

test("unreadable and absent inventory directories do not abort known healthy candidates", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const good = await create({ title: "Recover beside damaged discovery input", priority: 1 }, client);
  rmSync(join(pmRoot, "issues"), { recursive: true });
  writeFileSync(join(pmRoot, "issues"), "not a directory");
  rmSync(join(pmRoot, "epics"), { recursive: true });
  writeFileSync(join(pmRoot, "tasks", "ignored.txt"), "Not an item document");
  const recovered = await captureSlackOutbox(pmRoot, box);
  assertRecoveryTotals(recovered, { inspected: 1, queued: 1, failed: 1 });
  assert.deepEqual(recovered.failures, [{ item: "_inventory", code: "history_unavailable", reason: "inventory_unavailable" }]);
  assert.deepEqual(box.status().rows.map((row) => row.item), [good.item.id]);
});

test("a missing history directory reports each current item instead of bypassing or aborting verification", async (t) => {
  const { pmRoot, client, box } = await fixture(t);
  const items = [await create({ title: "First missing stream", priority: 1 }, client), await create({ title: "Second missing stream", priority: 1 }, client)];
  rmSync(join(pmRoot, "history"), { recursive: true });
  const recovered = await captureSlackOutbox(pmRoot, box);
  assertRecoveryTotals(recovered, { inspected: 0, queued: 0, failed: 2 });
  assert.deepEqual(recovered.failures!.map((failure) => failure.item).sort(), items.map((item) => item.item.id).sort());
  assert.ok(recovered.failures!.every((failure) => failure.reason === "history_missing"));
});

test("invalid historical values cannot partially publish an item or stop its healthy neighbor", async (t) => {
  for (const field of ["priority", "type", "timestamp"] as const) await t.test(field, async (t) => {
    const { pmRoot, client, box } = await fixture(t);
    const bad = await create({ title: "Invalid historical projection", priority: 1 }, client);
    const good = await create({ title: "Valid neighboring projection", priority: 1 }, client);
    const before = { metadata: bad.item, body: "" };
    const metadata: Record<string, unknown> = { ...bad.item, status: "blocked" };
    if (field !== "timestamp") metadata[field] = {};
    const historical = { metadata, body: "" } as unknown as ItemDocument;
    const timestamp = field === "timestamp" ? "64" : new Date(Date.now() + 1000).toISOString();
    const transitions = [
      createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before, after: historical }),
      createHistoryEntry({ nowIso: timestamp, author: "fixture-agent", op: "update", before: historical, after: before }),
    ];
    const file = join(pmRoot, "history", `${bad.item.id}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + transitions.map((entry) => JSON.stringify(entry) + "\n").join(""));
    assert.equal(verifyHistoryEntries(await readHistoryEntries(file, bad.item.id), before).ok, true);
    if (field === "type") process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "type:Task", webhook: process.env.PM_SLACK_WEBHOOK }]);
    const recovered = await captureSlackOutbox(pmRoot, box);
    assert.equal(recovered.queued, 1);
    assert.equal(recovered.failed, 1);
    assert.deepEqual(recovered.failures, [{ item: bad.item.id, code: "history_unavailable", reason: "historical_snapshot_invalid" }]);
    assert.deepEqual(box.status().rows.map((row) => row.item), [good.item.id]);
  });
});
