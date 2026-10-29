/** Verify one captured tarball under five real host installation shapes, without credentials or git trackers. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode } from "@toon-format/toon";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "slack-packed-payload-"));
const host = "@unbrained/pm-cli@2026.10.28";
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (/token|secret|password|credential|api[_-]?key|auth|NPM_MEDIA_SERVER/i.test(key) || /^PM_/.test(key) || key.toLowerCase() === "npm_config_allow_scripts") delete childEnv[key];
childEnv.NPM_CONFIG_USERCONFIG = "/dev/null"; childEnv.npm_config_userconfig = "/dev/null";
childEnv.NPM_CONFIG_CACHE = join(directory, "npm-cache"); childEnv.HOME = join(directory, "home");
childEnv.GIT_CONFIG_GLOBAL = "/dev/null"; childEnv.GIT_CONFIG_NOSYSTEM = "1"; childEnv.GIT_CEILING_DIRECTORIES = tmpdir();
childEnv.BUN_INSTALL_CACHE_DIR = join(directory, "bun-cache"); mkdirSync(childEnv.HOME, { recursive: true });

/** Execute only explicit trusted package/host operations; never print child environment or raw error output. */
function run(command: string, args: string[], cwd: string): string {
  try { return execFileSync(command, args, { cwd, env: childEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error(`Packed acceptance operation failed: ${command.split("/").at(-1)} ${args[0]}`); }
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root)) as { filename: string; files: { path: string }[] }[];
  const artifact = join(directory, packed[0]!.filename);
  const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  for (const path of ["dist/index.js", "dist/payload-compilation.js", "dist/payload-command.js", "dist/payload-compilation.d.ts", "docs/payload-compilation-example.md"]) assert.ok(packed[0]!.files.some((file) => file.path === path));
  const extracted = join(directory, "artifact"); mkdirSync(extracted); run("tar", ["xzf", artifact, "-C", extracted], directory);
  for (const shape of ["project-local", "npm-global", "bun-global", "npx", "bunx"] as const) {
    const workspace = join(directory, shape), prefix = join(workspace, "host"); mkdirSync(workspace);
    let command: string; let lead: string[] = [];
    if (shape === "project-local") {
      run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--prefix", prefix, host], workspace);
      command = join(prefix, "node_modules", ".bin", "pm");
    } else if (shape === "npm-global") {
      run("npm", ["install", "--global", "--ignore-scripts", "--prefix", prefix, host], workspace); command = join(prefix, "bin", "pm");
    } else if (shape === "bun-global") {
      childEnv.BUN_INSTALL_GLOBAL_DIR = join(prefix, "global"); childEnv.BUN_INSTALL_BIN = join(prefix, "bin");
      run("bun", ["add", "--global", "--ignore-scripts", host], workspace); command = join(prefix, "bin", "pm");
    } else if (shape === "npx") { command = "npm"; lead = ["exec", "--yes", `--package=${host}`, "--", "pm"]; }
    else { command = "bun"; lead = ["x", "--bun", host]; }
    /** All host acquisition goes through supported real package-manager entry points. */
    const pm = (args: string[]) => run(command, [...lead, ...args, "--json"], workspace);
    pm(["init", "packed-payload", "--defaults", "--agent-guidance", "skip"]);
    pm(["package", "install", join(extracted, "package"), "--project"]);
    const created = JSON.parse(pm(["create", "Task", "A".repeat(180), "--body", "  exact\r\n" + "x".repeat(3500), "--parent", "none", "--assignee", "none"])) as { id: string };
    const args = ["slack", "compile", "--item", created.id, "--link", "https://example.com/item/packed"];
    const json = JSON.parse(pm(args)) as { ok: boolean; total_losses: number; bytes: number };
    assert.equal(json.ok, true); assert.equal(json.total_losses, 2); assert.ok(json.bytes <= 65536);
    assert.deepEqual(decode(run(command, [...lead, ...args], workspace)), json);
    const full = JSON.parse(pm([...args, "--payload"])) as { payload: { text: string; blocks: unknown[] } };
    assert.ok(full.payload.text.includes(created.id)); assert.ok(full.payload.blocks.length > 0);
    const file = join(workspace, "raw.json");
    writeFileSync(file, JSON.stringify({ item: created.id, link: "https://example.com/item/packed", preserve: ["/text"], payload: { text: "urgent identity", blocks: Array.from({ length: 55 }, () => ({ type: "section", text: { type: "plain_text", text: "x".repeat(3500) } })) } }));
    const raw = JSON.parse(pm(["slack", "compile", "--input", file])) as { ok: boolean; total_losses: number; losses: unknown[] };
    assert.equal(raw.ok, true); assert.equal(raw.total_losses, 55); assert.equal(raw.losses.length, 20);
    const last = JSON.parse(pm(["slack", "compile", "--input", file, "--after", "40"])) as { losses: unknown[]; next_cursor: number | null };
    assert.equal(last.losses.length, 15); assert.equal(last.next_cursor, null);
    assert.equal(createHash("sha256").update(readFileSync(artifact)).digest("hex"), digest);
    console.log(`Packed payload acceptance: ${shape} passed (SDK item, JSON/TOON, wire payload, oversized source and paginated recovery; zero posts).`);
  }
  console.log(`Captured artifact SHA-256: ${digest}`);
} finally { rmSync(directory, { recursive: true, force: true }); }
