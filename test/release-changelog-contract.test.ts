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
    assert.equal(releaseChangelog(args, root), 0);
    assert.equal(releaseChangelog(check, root), 0);
    const generated = readFileSync(join(root, "CHANGELOG.md"), "utf8");
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
