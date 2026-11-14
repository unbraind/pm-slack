/** Exercise the actual release writer, commit and subsequent tag-aware check in a real temporary repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { releaseChangelog } from "../scripts/pm-changelog.ts";

test("committed release changelog equals the same check after the release tag exists", () => {
  const root = mkdtempSync(join(tmpdir(), "slack-release-changelog-"));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-11-10T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-10T12:00:00Z" };
  for (const key of Object.keys(childEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|NPM_MEDIA_SERVER|^PM_PATH$/i.test(key)) delete childEnv[key];
  /** Execute the real tool and surface only bounded failure diagnostics. */
  const run = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, { cwd: root, env: childEnv, encoding: "utf8", timeout: 120000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout;
  };
  try {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "synthetic-release", version: "2026.11.11", type: "module" }));
    writeFileSync(join(root, ".gitignore"), "node_modules\n.agents/pm/runtime\n.agents/pm/search\n.agents/pm/locks\n");
    run("git", ["init", "-q"]);
    run("git", ["config", "user.name", "SteveBot"]); run("git", ["config", "user.email", "1153461+unbraind@users.noreply.github.com"]);
    run(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", join(root, ".agents/pm"), "workspace", "init", "--prefix", "fixture", "--defaults", "--agent-guidance", "skip", "--no-merge-fence"]);
    run("git", ["add", "package.json", ".gitignore", ".agents/pm"]); run("git", ["commit", "-qm", "Synthetic baseline"]);
    run("git", ["tag", "v2026.11.10"]);
    childEnv.GIT_AUTHOR_DATE = "2026-11-11T12:00:00Z"; childEnv.GIT_COMMITTER_DATE = "2026-11-11T12:00:00Z";
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
    const args = scripts["changelog:full"].split(/\s+/).slice(2);
    const check = scripts["changelog:check"].split(/\s+/).slice(2);
    assert.ok(args.includes("--include-empty"));
    assert.equal(releaseChangelog(check, root), 1, "check refuses a missing output without creating it");
    assert.throws(() => readFileSync(join(root, "CHANGELOG.md")), { code: "ENOENT" });
    assert.equal(releaseChangelog(args, root), 0);
    assert.equal(releaseChangelog(check, root), 0);
    const generated = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.doesNotMatch(generated, /^## Unreleased\s*$/m, "the generator omits an empty Unreleased section");
    run("git", ["add", "CHANGELOG.md"]); run("git", ["commit", "-qm", "Synthetic release metadata"]);
    run("git", ["tag", "v2026.11.11"]);
    const upstream = run(process.execPath, [resolve("node_modules/pm-changelog/dist/cli.js"), ...args.filter((arg, index) => index !== args.indexOf("--output") && index !== args.indexOf("--output") + 1), "--stdout"]);
    assert.equal(generated, upstream);
    assert.equal(releaseChangelog(check, root), 0);
    // Independently compare the committed bytes with the unwrapped upstream check.
    run(process.execPath, [resolve("node_modules/pm-changelog/dist/cli.js"), ...check]);
    assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), generated);
    assert.equal(run("git", ["show", "HEAD:CHANGELOG.md"]), generated);
    writeFileSync(join(root, "CHANGELOG.md"), "stale\n");
    assert.equal(releaseChangelog(check, root), 1, "check must still reject stale contents");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("release helper refuses incomplete or divergent generation controls before writes", () => {
  const root = mkdtempSync(join(tmpdir(), "slack-release-controls-"));
  try {
    const target = join(root, "CHANGELOG.md"); writeFileSync(target, "keep\n");
    const incomplete = [
      [], ["--output"],
      ["--output", "CHANGELOG.md", "--mode", "replace", "--all-release-tags"],
      ["--output", "CHANGELOG.md", "--mode", "replace", "--include-empty"],
      ["--output", "CHANGELOG.md", "--mode", "prepend", "--all-release-tags", "--include-empty"],
    ];
    for (const args of incomplete) assert.throws(() => releaseChangelog(args, root), /Release changelog requires/);
    assert.throws(() => releaseChangelog([]), /Release changelog requires/);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release helper preserves output across real generator refusals, spawn errors and signals", () => {
  const root = mkdtempSync(join(tmpdir(), "slack-release-errors-"));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  for (const key of Object.keys(childEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|NPM_MEDIA_SERVER|^PM_PATH$/i.test(key)) delete childEnv[key];
  const args = ["--pm-root", ".agents/pm", "--mode", "replace", "--output", "CHANGELOG.md", "--all-release-tags", "--include-empty", "--release-version-from-package", "--date-from-version"];
  try {
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "synthetic-release", version: "2026.11.11", type: "module" }));
    const initialized = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", join(root, ".agents/pm"), "workspace", "init", "--prefix", "fixture", "--defaults", "--agent-guidance", "skip", "--no-merge-fence"], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120000 });
    assert.ifError(initialized.error); assert.equal(initialized.status, 0, initialized.stderr);
    const target = join(root, "CHANGELOG.md"); writeFileSync(target, "keep\n");
    assert.throws(() => releaseChangelog(args, join(root, "absent")), { code: "ENOENT" });
    assert.equal(releaseChangelog(args, root), 1, "tag generation refuses a real non-git tracker");
    const cli = spawnSync(process.execPath, [resolve("scripts/pm-changelog.ts"), ...args], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120000 });
    assert.ifError(cli.error); assert.equal(cli.status, 1); assert.match(cli.stderr, /Git|git/);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    const preload = join(root, "signal.cjs"); writeFileSync(preload, "process.kill(process.pid, 'SIGTERM');\n");
    const originalOptions = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
      assert.equal(releaseChangelog(args, root), 1, "a signaled real generator process cannot report success");
    } finally {
      if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
    }
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(new URL("../scripts/pm-changelog.ts", import.meta.url).href)};`], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120000 });
    assert.ifError(imported.error); assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, "");
    assert.equal(readFileSync(target, "utf8"), "keep\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
