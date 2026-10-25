/** Minimal stale-event reproduction; copy into a temp project with the SDK version under test installed. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create, init, listMutationEvents, readHistoryEntries, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";

/** Compare event-page integrity with the bytes actually retained by the tracker. */
async function observe(pmRoot: string, id: string) {
  const page = await listMutationEvents({ pmRoot, full: true, limit: 1000 });
  const cached = page.events.filter((event) => event.item_id === id).map((event) => event.entry!);
  const authoritative = await readHistoryEntries(join(pmRoot, "history", `${id}.jsonl`), id);
  return { source: page.source, page_fields: Object.keys(page).sort(), cached_chain_verifies: verifyHistoryEntries(cached).ok,
    authoritative_chain_verifies: verifyHistoryEntries(authoritative).ok };
}

if (process.argv[2] === "probe") {
  process.stdout.write(JSON.stringify(await observe(process.argv[3]!, process.argv[4]!)));
} else {
  const directory = mkdtempSync(join(tmpdir(), "sdk-event-cache-repro-"));
  try {
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    process.env.PATH = directory;
    const pmRoot = join(directory, ".agents", "pm");
    const client = { cwd: directory, pmRoot, noExtensions: true };
    await init("cache-repro", { defaults: true, agentGuidance: "skip" }, client);
    const created = await create({ title: "Synthetic cache integrity probe", priority: 1 }, client);
    const primed = await listMutationEvents({ pmRoot, full: true, limit: 1000 });
    const file = join(pmRoot, "history", `${created.item.id}.jsonl`);
    const original = readFileSync(file, "utf8");
    const at = original.indexOf('"record_hash":"') + '"record_hash":"'.length;
    assert.ok(at >= '"record_hash":"'.length);
    const damaged = original.slice(0, at) + (original[at] === "a" ? "b" : "a") + original.slice(at + 1);
    assert.equal(Buffer.byteLength(damaged), Buffer.byteLength(original));
    writeFileSync(file, damaged);
    const sameProcess = await observe(pmRoot, created.item.id);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "probe", pmRoot, created.item.id], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const restarted = JSON.parse(child.stdout) as Awaited<ReturnType<typeof observe>>;
    console.log(JSON.stringify({ primed_source: primed.source, same_byte_size: true, same_process: sameProcess, restarted_process: restarted }, null, 2));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
