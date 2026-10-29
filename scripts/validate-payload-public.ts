/** Compile a read-only public Git-object snapshot in a non-git directory; report aggregate numbers only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { makeSnapshotReadOnly, removeScratchTree } from "./snapshot-filesystem.ts";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PmClient, listAllComplete, locateItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import { compileSlackItem, SlackCompilationError, validateSlackWirePayload } from "../payload-compilation.ts";

const source = process.argv[2] ?? ".";
const ref = process.argv[3] ?? "origin/main";
const directory = mkdtempSync(join(tmpdir(), "slack-public-payload-"));
const pmRoot = join(directory, ".agents", "pm");
const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;

/** Enumerate only the disposable snapshot, recording exact file bytes and permission bits. */
function snapshot(path: string): string[] {
  return readdirSync(path).sort().flatMap((name) => {
    const full = join(path, name), stat = lstatSync(full);
    assert.ok(!stat.isSymbolicLink());
    return stat.isDirectory() ? snapshot(full) : [`${relative(directory, full)}:${stat.mode}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`];
  });
}

try {
  const revision = execFileSync("git", ["rev-parse", ref], { cwd: source, encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["archive", ref, ".agents/pm"], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["xf", "-", "-C", directory], { input: archive });
  mkdirSync(join(directory, "no-executables"));
  makeSnapshotReadOnly(directory);
  const before = snapshot(directory);
  process.env.PATH = join(directory, "no-executables"); process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const options = { cwd: directory, pmRoot, noExtensions: true };
  const client = new PmClient(options);
  const corpus = await listAllComplete({}, options);
  const settings = await readSettings(pmRoot), types = resolveItemTypeRegistry(settings);
  let compiled = 0, refused = 0, losses = 0, clipped = 0, omitted = 0, maxBytes = 0, totalBytes = 0, maxBlocks = 0;
  for (const item of corpus.items) {
    const located = await locateItem(pmRoot, item.id, settings.id_prefix, settings.item_format, types.type_to_folder);
    assert.ok(located);
    const link = `https://github.com/unbraind/pm-slack/blob/${revision}/.agents/pm/${relative(pmRoot, located.itemPath).split("/").map(encodeURIComponent).join("/")}`;
    try {
      const result = await compileSlackItem(client, item.id, link);
      validateSlackWirePayload(result.payload);
      const replay = await compileSlackItem(client, item.id, link);
      assert.deepEqual(replay, result);
      compiled++; totalBytes += result.bytes; maxBytes = Math.max(maxBytes, result.bytes); maxBlocks = Math.max(maxBlocks, result.payload.blocks?.length ?? 0);
      losses += result.losses.length; clipped += result.losses.filter((r) => r.start > 0).length; omitted += result.losses.filter((r) => r.start === 0).length;
    } catch (error) {
      if (!(error instanceof SlackCompilationError)) throw error;
      assert.equal(error.code, "protected_overflow"); refused++;
    }
  }
  assert.deepEqual(snapshot(directory), before, "all copied tracker bytes and permissions must remain unchanged");
  console.log(JSON.stringify({ revision, items: corpus.items.length, compiled, refused, losses, clipped, omitted, totalBytes, maxBytes, maxBlocks, trackerFiles: before.length, replays: compiled, posts: 0, mutations: 0, gitAvailable: false }, null, 2));
} finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  removeScratchTree(directory);
}
