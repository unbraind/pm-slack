/** Differential proof on read-only public tracker snapshots in non-git directories.
 * Usage: node scripts/verify-sdk-adoption.ts BASELINE_REF PUBLIC_REPOSITORY [...]
 * Repositories are read through git objects only; probes cannot contact Slack.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { makeSnapshotReadOnly, removeScratchTree } from "./snapshot-filesystem.ts";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const [baselineRef, ...repositories] = process.argv.slice(2);
assert.ok(baselineRef && repositories.length, "Provide a baseline ref and public repository directories.");
const scratch = mkdtempSync(join(tmpdir(), "slack-sdk-differential-"));

/** Read a public repository object without modifying its checkout or tracker. */
function git(repository: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", repository, ...args], { maxBuffer: 128 * 1024 * 1024 });
}

/** Hash authoritative snapshot bytes so derived-index writes cannot hide mutations. */
function fingerprint(directory: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(join(directory, file)));
  return hash.digest("hex");
}

/** Run the same exported recovery function from one build in a git-free child. */
function probe(module: string, directory: string): unknown {
  const runner = join(scratch, "probe.ts");
  writeFileSync(runner, `/** Offline differential probe; authoritative files are read only. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureSlackOutbox, SlackOutbox } from ${JSON.stringify(pathToFileURL(module).href)};
const pmRoot = join(process.argv[2], '.agents', 'pm');
const box = new SlackOutbox(pmRoot);
box.enable({events:['create','close','block','cancel','open','start','unblock','reopen'],minPriority:4});
const db = new DatabaseSync(join(pmRoot, 'runtime', 'slack-outbox', 'delivery.sqlite'));
// The disposable outbox opts in before retained events, without rewriting history.
db.exec("UPDATE settings SET since='2000-01-01T00:00:00.000Z'; UPDATE recovery_policy SET since='2000-01-01T00:00:00.000Z'");
const first = await captureSlackOutbox(pmRoot, box);
const rows = db.prepare('SELECT key,item,event,revision,destination,payload,state,attempts FROM delivery ORDER BY rowid').all();
const contexts = db.prepare('SELECT key,at,priority FROM delivery_context ORDER BY key').all();
const repeat = await captureSlackOutbox(pmRoot, box);
const selected = rows.length ? [String(rows[0].item)] : ['missing'];
const filtered = await captureSlackOutbox(pmRoot, box, selected);
let sends = 0;
await box.drain(async () => { sends++; return 'ambiguous'; });
await box.drain(async () => { assert.fail('uncertain destination must stay held'); });
const status = box.status(100);
assert.equal(repeat.queued, 0);
assert.ok(rows.length > 0, 'public corpus must exercise real notification intents');
process.stdout.write(JSON.stringify({first,repeat,filtered,rows,contexts,status,sends}));
db.close(); box.close();
`);
  const env = { ...process.env, PATH: join(scratch, "no-executables"), GIT_CEILING_DIRECTORIES: scratch };
  for (const key of Object.keys(env)) if (key.startsWith("PM_SLACK_")) delete env[key as keyof typeof env];
  const output = execFileSync(process.execPath, [runner, directory], { cwd: directory,
    env: { ...env, PM_SLACK_WEBHOOK: "http://127.0.0.1:1/offline", PM_SLACK_MIN_PRIORITY: "4" },
    maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(output.toString()) as unknown;
}

try {
  const baseline = join(scratch, "baseline");
  mkdirSync(baseline);
  const baselineHead = git(root, "rev-parse", baselineRef).toString().trim();
  const sources = git(root, "ls-tree", "--name-only", baselineHead).toString().trim().split("\n")
    .filter((file) => file.endsWith(".ts") || file === "tsconfig.json" || file === "package.json");
  for (const file of sources) writeFileSync(join(baseline, file), git(root, "show", `${baselineHead}:${file}`));
  symlinkSync(join(root, "node_modules"), join(baseline, "node_modules"), "junction");
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", baseline], { cwd: baseline });
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")], { cwd: root });
  console.log(`baseline ${baselineHead}: freshly compiled with pinned dependencies`);
  for (const [index, repository] of repositories.entries()) {
    const repositoryRoot = resolve(repository);
    const head = git(repositoryRoot, "rev-parse", "origin/main").toString().trim();
    const files = git(repositoryRoot, "ls-tree", "-r", "--name-only", head, "--", ".agents/pm").toString().trim().split("\n");
    assert.ok(files.some((file) => file.endsWith(".jsonl")), "Public snapshot must contain retained history.");
    const snapshot = join(scratch, `snapshot-${index}`);
    mkdirSync(snapshot);
    execFileSync("tar", ["-x", "-C", snapshot], { input: git(repositoryRoot, "archive", head, "--", ".agents/pm") });
    const directories = new Set(files.filter((file) => file.endsWith(".toon") || file.endsWith(".jsonl")).map(dirname));
    makeSnapshotReadOnly(snapshot, directories);
    const expectedHash = fingerprint(snapshot, files);
    const before = join(scratch, `before-${index}`);
    const after = join(scratch, `after-${index}`);
    cpSync(snapshot, before, { recursive: true });
    cpSync(snapshot, after, { recursive: true });
    const oldOutput = probe(join(baseline, "dist", "index.js"), before);
    const newOutput = probe(join(root, "dist", "index.js"), after);
    assert.deepEqual(newOutput, oldOutput);
    assert.equal(fingerprint(before, files), expectedHash);
    assert.equal(fingerprint(after, files), expectedHash);
    const result = newOutput as { first: { inspected: number; queued: number; failed: number }; rows: unknown[] };
    console.log(`${basename(repositoryRoot)} ${head}: ${JSON.stringify(result.first)}; ${result.rows.length} exact payload/receipt matches; authoritative bytes unchanged; zero intentional output differences`);
  }
} finally {
  // Restore scratch directory permissions before disposing of read-only copies.
  removeScratchTree(scratch);
}
