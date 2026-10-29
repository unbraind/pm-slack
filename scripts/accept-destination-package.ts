/** Exercise one captured package artifact through five real host installation shapes, isolated from ambient config and credentials. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SlackOutbox, slackDestination } from "../outbox.ts";
import type { DestinationMigrationReport } from "../destination-migration.ts";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "slack-packed-migration-"));
const host = "@unbrained/pm-cli@2026.10.28";
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (/token|secret|password|credential|api[_-]?key|auth|NPM_MEDIA_SERVER/i.test(key) || /^PM_/.test(key) || key.toLowerCase() === "npm_config_allow_scripts") delete childEnv[key];
childEnv.NPM_CONFIG_USERCONFIG = "/dev/null";
childEnv.npm_config_userconfig = "/dev/null";
childEnv.NPM_CONFIG_CACHE = join(directory, "npm-cache");
childEnv.HOME = join(directory, "home");
childEnv.GIT_CONFIG_GLOBAL = "/dev/null";
childEnv.GIT_CONFIG_NOSYSTEM = "1";
childEnv.GIT_CEILING_DIRECTORIES = tmpdir();
childEnv.BUN_INSTALL_CACHE_DIR = join(directory, "bun-cache");
mkdirSync(childEnv.HOME, { recursive: true });

/** Run a public package-manager/CLI operation without shell interpolation or credential output. */
function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, env: childEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root)) as { filename: string; files: { path: string }[] }[];
  const artifact = join(directory, packed[0]!.filename);
  for (const path of ["dist/index.js", "dist/outbox.js", "dist/destination-migration.js", "docs/destination-migration-example.md"]) assert.ok(packed[0]!.files.some((file) => file.path === path));
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const extracted = join(directory, "artifact"); mkdirSync(extracted);
  run("tar", ["xzf", artifact, "-C", extracted], directory);
  for (const shape of ["project-local", "npm-global", "bun-global", "npx", "bunx"] as const) {
    const workspace = join(directory, shape); mkdirSync(workspace);
    const prefix = join(workspace, "host");
    let command: string; let lead: string[] = [];
    if (shape === "project-local") {
      run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--prefix", prefix, host], workspace);
      command = join(prefix, "node_modules", ".bin", "pm");
    } else if (shape === "npm-global") {
      run("npm", ["install", "--global", "--ignore-scripts", "--prefix", prefix, host], workspace);
      command = join(prefix, "bin", "pm");
    } else if (shape === "bun-global") {
      childEnv.BUN_INSTALL_GLOBAL_DIR = join(prefix, "global"); childEnv.BUN_INSTALL_BIN = join(prefix, "bin");
      run("bun", ["add", "--global", "--ignore-scripts", host], workspace);
      command = join(prefix, "bin", "pm");
    } else if (shape === "npx") {
      command = "npm"; lead = ["exec", "--yes", `--package=${host}`, "--", "pm"];
    } else {
      command = "bun"; lead = ["x", "--bun", host];
    }
    /** Use the host's real package installer, including its supported SDK binding. */
    const pm = (args: string[]) => run(command, [...lead, ...args, "--json"], workspace);
    pm(["init", "packed-migration", "--defaults", "--agent-guidance", "skip"]);
    pm(["package", "install", join(extracted, "package"), "--project"]);
    childEnv.PM_SLACK_WEBHOOK = "http://127.0.0.1:1/old";
    childEnv.PM_SLACK_ROUTES = JSON.stringify([{ match: "close", webhook: "http://127.0.0.1:1/new" }]);
    pm(["slack", "outbox", "--action", "enable"]);
    pm(["slack", "migrate", "--action", "bind", "--alias", "old", "--route", "default", "--binding-revision", "0"]);
    pm(["slack", "migrate", "--action", "bind", "--alias", "new", "--route", "close", "--binding-revision", "1"]);
    const box = new SlackOutbox(join(workspace, ".agents", "pm"));
    try {
      const originalKey = box.enqueue({ item: "packed-event", event: "close", revision: "packed-r1", destination: slackDestination(childEnv.PM_SLACK_WEBHOOK), payload: { text: "Packed migration event" }, priority: 1 });
      const preview = JSON.parse(pm(["slack", "migrate", "--from", "old", "--to", "new"])) as DestinationMigrationReport;
      assert.equal(preview.counts.movable, 1);
      const args = ["slack", "migrate", "--action", "apply", "--from", "old", "--to", "new", "--binding-revision", String(preview.binding_revision), "--plan-revision", preview.plan_revision!];
      const applied = JSON.parse(pm(args)) as DestinationMigrationReport;
      assert.equal(applied.counts.moved, 1);
      assert.equal((JSON.parse(pm(args)) as DestinationMigrationReport).status, "already_applied");
      assert.equal(box.status().rows.length, 1);
      assert.equal(box.planCoalescing().notifications[0]!.destination, slackDestination("http://127.0.0.1:1/new"));
      box.resolve(originalKey, "skip");
    } finally { box.close(); }
    // Execute the captured artifact's native outbox, rather than the checkout's implementation.
    const code = `import {SlackOutbox,migrateSlackDestinations,slackDestination} from ${JSON.stringify(pathToFileURL(join(extracted, "package", "dist", "outbox.js")).href)};
import {assertMigrationDestinationHold} from ${JSON.stringify(pathToFileURL(join(root, "test", "helpers", "destination-hold-scenario.ts")).href)};
const pmRoot=${JSON.stringify(join(workspace, ".agents", "pm"))};const box=new SlackOutbox(pmRoot);
try{for(const kind of ["plain","coalesced-urgent","coalesced-routine"]){await assertMigrationDestinationHold(box,(input)=>migrateSlackDestinations(pmRoot,input),{namespace:"packed-"+kind,source:slackDestination("http://127.0.0.1:1/"+kind+"-source"),target:slackDestination("http://127.0.0.1:1/"+kind+"-target"),coalesced:kind!=="plain",routine:kind==="coalesced-routine"});}}finally{box.close();}`;
    const nativeBun = shape === "bun-global" || shape === "bunx";
    run(nativeBun ? "bun" : process.execPath, nativeBun ? ["--eval", code] : ["--input-type=module", "--eval", code], workspace);
    delete childEnv.PM_SLACK_WEBHOOK; delete childEnv.PM_SLACK_ROUTES;
    console.log(`Packed acceptance: ${shape} passed (migration/replay plus plain, urgent and routine ambiguity holds; zero duplicate receipts or remote posts).`);
  }
  assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), sha256);
  console.log(JSON.stringify({ shapes: 5, passed: 5, captured_artifact_hold_scenarios: 15, package_sha256: sha256, host, remote_posts: 0 }));
} finally { rmSync(directory, { recursive: true, force: true }); }
