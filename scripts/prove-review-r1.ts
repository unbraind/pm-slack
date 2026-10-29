/** Restore reviewed behaviors only in disposable copies and require their adversarial regressions to fail. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./snapshot-filesystem.ts";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "slack-review-r1-revert-"));

/** Run bounded adversarial cases without the package's unrelated long property suites. */
function run(files: string[], pattern?: string) {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files], { cwd: directory, encoding: "utf8", timeout: 60000 });
}

try {
  for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") || name === "package.json")) copyFileSync(join(root, file), join(directory, file));
  cpSync(join(root, "test"), join(directory, "test"), { recursive: true });
  cpSync(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const compiler = join(directory, "payload-compilation.ts"), fixed = readFileSync(compiler, "utf8");
  const baseline = execFileSync("git", ["show", "c5b19ed:payload-compilation.ts"], { cwd: root, encoding: "utf8" });
  const start = "export function compileSlackPayload(input: unknown): SlackCompilation {", end = "/** Read one item through the host-injected SDK";
  const originalBody = baseline.slice(baseline.indexOf(start), baseline.indexOf(end));
  assert.ok(originalBody.includes("leaves.filter"));
  writeFileSync(compiler, fixed.slice(0, fixed.indexOf(start)) + originalBody + fixed.slice(fixed.indexOf(end)));
  const slow = run(["test/payload-scale.test.ts"]);
  assert.notEqual(slow.status, 0); assert.match(slow.stdout + slow.stderr, /non-linear|ETIMEDOUT|timed out/);
  writeFileSync(compiler, fixed);
  const oldBytesStart = baseline.indexOf("  const blocks = payload.blocks;", baseline.indexOf(start));
  const oldBytesEnd = baseline.indexOf("  if (bytes > bounds.bytes) overflow();", oldBytesStart);
  const newBytesStart = fixed.indexOf("  // Serialize each block once;");
  const newBytesEnd = fixed.indexOf("  if (bytes > bounds.bytes) overflow();", newBytesStart);
  assert.ok(oldBytesStart > 0 && oldBytesEnd > oldBytesStart && newBytesStart > 0 && newBytesEnd > newBytesStart);
  const oldBytes = baseline.slice(oldBytesStart, oldBytesEnd).replace("  const blocks = payload.blocks;\n", "");
  writeFileSync(compiler, fixed.slice(0, newBytesStart) + oldBytes + fixed.slice(newBytesEnd));
  const rescanBytes = spawnSync(process.execPath, ["--input-type=module", "--eval", 'import {assertPayloadScale} from "./test/helpers/payload-scale-scenario.ts"; import {compileSlackPayload,validateSlackWirePayload} from "./payload-compilation.ts"; assertPayloadScale(compileSlackPayload,validateSlackWirePayload,true);'], { cwd: directory, encoding: "utf8", timeout: 30000 });
  assert.notEqual(rescanBytes.status, 0); assert.match(rescanBytes.stdout + rescanBytes.stderr, /non-linear serialization/);
  writeFileSync(compiler, fixed);
  const probe = join(directory, "scripts/validate-payload-public.ts"), fixedProbe = readFileSync(probe, "utf8");
  writeFileSync(probe, execFileSync("git", ["show", "c5b19ed:scripts/validate-payload-public.ts"], { cwd: root }));
  const unsafeArchive = run(["test/storage-paths.test.ts"], "actual public archive probe");
  assert.notEqual(unsafeArchive.status, 0); assert.match(unsafeArchive.stdout + unsafeArchive.stderr, /external permissions/);
  writeFileSync(probe, fixedProbe);
  const storage = join(directory, "storage-paths.ts"), fixedStorage = readFileSync(storage, "utf8");
  const from = fixedStorage.indexOf("export function chmodOwnedEntry("), to = fixedStorage.indexOf("/** Validate package-controlled SQLite paths");
  assert.ok(from > 0 && to > from);
  writeFileSync(storage, 'import {chmodSync} from "node:fs";\n' + fixedStorage.slice(0, from) + 'export function chmodOwnedEntry(path: string, mode: number): void { chmodSync(path, mode); }\n\n' + fixedStorage.slice(to));
  const unsafeInode = run(["test/storage-paths.test.ts"], "permission mutation rejects");
  assert.notEqual(unsafeInode.status, 0); assert.match(unsafeInode.stdout + unsafeInode.stderr, /Missing expected exception/);
  writeFileSync(storage, fixedStorage);
  const restored = run(["test/payload-scale.test.ts", "test/storage-paths.test.ts"]);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  console.log("Review R1 revert proof: global leaf rescans FAIL; repeated serialization FAIL; archived-link permission traversal FAIL; pathname chmod FAIL; restored implementation PASS.");
} finally { removeScratchTree(directory); }
