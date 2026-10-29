/** Behavioral regression proof in a disposable source copy; the package worktree is never mutated. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "slack-payload-revert-"));

/** Run only pure compilation and local-transport regressions, never the seeded SDK sequence. */
function run() {
  return spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=bounded Block Kit|byte budgets|malformed wire", "test/payload-compilation.test.ts"], { cwd: directory, encoding: "utf8" });
}

try {
  for (const name of readdirSync(root).filter((name) => name.endsWith(".ts") || name === "package.json")) copyFileSync(join(root, name), join(directory, name));
  mkdirSync(join(directory, "test")); copyFileSync(join(root, "test", "payload-compilation.test.ts"), join(directory, "test", "payload-compilation.test.ts"));
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const compiler = join(directory, "payload-compilation.ts"), source = readFileSync(compiler, "utf8");
  const marker = '  const source_sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");';
  assert.ok(source.includes(marker));
  // Restore the previous pass-through behavior of unbounded wire source in this function only.
  writeFileSync(compiler, source.replace(marker, `${marker}\n  return {ok:true,source_sha256,payload,bytes:Buffer.byteLength(JSON.stringify(payload)),bounds,losses:[]};`));
  const unbounded = run(); assert.notEqual(unbounded.status, 0); assert.match(unbounded.stdout + unbounded.stderr, /failing tests|fail [1-9]/);
  writeFileSync(compiler, source);
  const entry = join(directory, "index.ts"), entrySource = readFileSync(entry, "utf8");
  assert.ok(entrySource.includes("    validateSlackWirePayload(payload);"));
  writeFileSync(entry, entrySource.replace("    validateSlackWirePayload(payload);", ""));
  const noGuard = run(); assert.notEqual(noGuard.status, 0); assert.match(noGuard.stdout + noGuard.stderr, /malformed wire/);
  writeFileSync(entry, entrySource);
  const fixed = run(); assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  console.log("Behavioral revert proof: pass-through compiler FAIL; removed pre-send validator FAIL; restored implementation PASS (3 focused regressions).");
} finally { rmSync(directory, { recursive: true, force: true }); }
