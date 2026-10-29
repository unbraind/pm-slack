/** No-follow, inode-bound permissions protect every archive and SQLite path in real non-git fixtures. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { tokenize } from "pm-ops/docstrings";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodOwnedEntry, ownedEntry, ownedOutboxFile } from "../storage-paths.ts";
import { makeSnapshotReadOnly, removeScratchTree } from "../scripts/snapshot-filesystem.ts";
import { SlackOutbox, migrateSlackDestinations, readSlackRoutingEvidence, OutboxError, slackDestination } from "../outbox.ts";
import { assertStorageLinks } from "./helpers/storage-link-scenario.ts";

/** Retain both data and access/inode identity when an untrusted path tries to escape its root. */
function identity(path: string) {
  const stat = lstatSync(path);
  return { bytes: stat.isFile() ? readFileSync(path).toString("hex") : null, mode: stat.mode, ino: stat.ino, dev: stat.dev };
}

test("permission mutation rejects links, shared files, special entries and replaced inodes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "slack-owned-path-")); t.after(() => removeScratchTree(root));
  const file = join(root, "file"); writeFileSync(file, "owned"); chmodSync(file, 0o600);
  const expected = ownedEntry(file);
  chmodOwnedEntry(file, 0o400, expected); assert.equal(lstatSync(file).mode & 0o777, 0o400);
  const modeRevision = ownedEntry(file); chmodSync(file, 0o500);
  assert.throws(() => chmodOwnedEntry(file, 0o600, modeRevision), /permissions changed/);
  assert.equal(lstatSync(file).mode & 0o777, 0o500);
  chmodSync(file, 0o600); chmodOwnedEntry(file, 0o600, modeRevision);
  assert.equal(lstatSync(file).mode & 0o777, 0o600, "report the peer's completed permission policy truthfully");
  const replacement = join(root, "replacement"); writeFileSync(replacement, "foreign"); chmodSync(replacement, 0o640);
  renameSync(file, join(root, "old")); renameSync(replacement, file);
  const before = identity(file);
  assert.throws(() => chmodOwnedEntry(file, 0o777, { ...lstatSync(file), dev: lstatSync(file).dev + 1 }), /changed/);
  assert.throws(() => chmodOwnedEntry(file, 0o777, expected), /changed/); assert.deepEqual(identity(file), before);
  const alias = join(root, "alias"); symlinkSync(file, alias);
  assert.throws(() => ownedEntry(alias), /linked/);
  assert.throws(() => chmodOwnedEntry(alias, 0o777, expected)); assert.deepEqual(identity(file), before);
  const hardlink = join(root, "hardlink"); linkSync(file, hardlink);
  assert.throws(() => ownedEntry(file), /linked/);
  assert.throws(() => chmodOwnedEntry(file, 0o777, lstatSync(file)), /changed/);
  assert.deepEqual(identity(file), before);
  rmSync(hardlink); chmodOwnedEntry(file, 0o600);
  const fifo = join(root, "fifo"); execFileSync("mkfifo", [fifo]);
  assert.throws(() => ownedEntry(fifo), /special/);
  assert.throws(() => chmodOwnedEntry(fifo, 0o777, lstatSync(fifo)), /changed/);
});

test("snapshot setup preflights the whole tree; cleanup treats all links as leaves", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "slack-snapshot-safe-")); t.after(() => removeScratchTree(outer));
  const external = join(outer, "external"); mkdirSync(external, { mode: 0o700 });
  const target = join(external, "sentinel"); writeFileSync(target, "external sentinel"); chmodSync(target, 0o600);
  const expected = [identity(external), identity(target)];
  for (const kind of ["absolute-file", "relative-file", "directory", "dangling", "chain", "hardlink", "root-link"] as const) {
    const root = join(outer, kind); mkdirSync(root);
    const ordinary = join(root, "a-ordinary"); writeFileSync(ordinary, "local"); chmodSync(ordinary, 0o640);
    const before = identity(ordinary);
    const alias = join(root, "z-link");
    if (kind === "hardlink") linkSync(target, alias);
    else if (kind === "chain") { symlinkSync(target, alias); symlinkSync(alias, join(root, "z-chain")); }
    else symlinkSync(kind === "directory" ? external : kind === "dangling" ? join(external, "missing") : kind === "relative-file" ? "../external/sentinel" : target, alias);
    assert.throws(() => makeSnapshotReadOnly(root), /linked/);
    assert.deepEqual(identity(ordinary), before, "preflight refuses before the first chmod");
    if (kind === "root-link") {
      const rootAlias = join(outer, "root-alias"); symlinkSync(root, rootAlias);
      assert.throws(() => makeSnapshotReadOnly(rootAlias)); removeScratchTree(rootAlias); assert.ok(existsSync(root));
    }
    removeScratchTree(root);
    assert.deepEqual([identity(external), identity(target)], expected, `${kind} must not alter an external inode`);
  }
  const clean = join(outer, "clean"); mkdirSync(join(clean, "keep"), { recursive: true }); writeFileSync(join(clean, "keep", "file"), "owned");
  makeSnapshotReadOnly(clean, new Set(["keep"])); assert.equal(lstatSync(join(clean, "keep")).mode & 0o777, 0o555);
  makeSnapshotReadOnly(clean); assert.equal(lstatSync(clean).mode & 0o777, 0o555);
  removeScratchTree(clean); removeScratchTree(clean);
});

test("the actual public archive probe refuses linked trackers without touching external files", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "slack-archive-regression-")); t.after(() => removeScratchTree(outer));
  const repository = join(outer, "repository"); mkdirSync(join(repository, ".agents/pm"), { recursive: true });
  const target = join(outer, "sentinel"); writeFileSync(target, "outside the archive"); chmodSync(target, 0o600);
  const before = identity(target);
  symlinkSync(target, join(repository, ".agents/pm", "link"));
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "add", ".agents/pm/link"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic linked archive"]);
  try {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/validate-payload-public.ts"), repository, "HEAD"], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.deepEqual(identity(target), before, "setup and finally must both preserve external permissions");
    assert.match(result.stderr, /linked/);
  } finally { chmodSync(target, 0o600); }
});

test("outbox writers refuse linked runtime components and sidecars while observers preserve legacy reads", (t) => {
  assert.equal(assertStorageLinks(SlackOutbox), 10);
  const outer = mkdtempSync(join(tmpdir(), "slack-outbox-links-")); t.after(() => removeScratchTree(outer));
  const external = join(outer, "external"); mkdirSync(external);
  const externalFile = join(external, "sentinel"); writeFileSync(externalFile, "sentinel"); chmodSync(externalFile, 0o600);
  const before = [identity(external), identity(externalFile)];
  for (const component of ["runtime", "slack-outbox", "delivery.sqlite", "delivery.sqlite-journal", "delivery.sqlite-wal", "delivery.sqlite-shm"]) {
    const pmRoot = join(outer, component); mkdirSync(pmRoot);
    const base = component === "runtime" ? pmRoot : component === "slack-outbox" ? join(pmRoot, "runtime") : join(pmRoot, "runtime/slack-outbox");
    mkdirSync(base, { recursive: true }); symlinkSync(component.includes("sqlite") ? externalFile : external, join(base, component));
    assert.throws(() => new SlackOutbox(pmRoot), (e: unknown) => e instanceof OutboxError && e.code === "storage_unavailable");
    try { new SlackOutbox(pmRoot, { readOnly: true }).close(); }
    catch (error) { assert.ok(error instanceof OutboxError && error.code === "storage_unavailable"); }
    // Existing database paths exercise migration and routing inspectors too.
    if (component.includes("sqlite") && component !== "delivery.sqlite") writeFileSync(join(base, "delivery.sqlite"), "not opened");
    if (component.includes("sqlite")) {
      assert.throws(() => migrateSlackDestinations(pmRoot, { action: "bindings" }));
      assert.throws(() => readSlackRoutingEvidence(pmRoot, "item", "create", "revision", "timestamp"));
    }
    assert.deepEqual([identity(external), identity(externalFile)], before);
  }
  assert.ok(ownedOutboxFile(join(outer, "absent"), false).endsWith("delivery.sqlite"));
  const missingChild = join(outer, "missing-child"); mkdirSync(missingChild); ownedOutboxFile(missingChild, false);
  const nondirectory = join(outer, "nondirectory"); mkdirSync(nondirectory); writeFileSync(join(nondirectory, "runtime"), "file"); assert.throws(() => ownedOutboxFile(nondirectory, true));
  const badDb = join(outer, "bad-db"); mkdirSync(join(badDb, "runtime/slack-outbox/delivery.sqlite"), { recursive: true }); assert.throws(() => ownedOutboxFile(badDb, false));
  const good = join(outer, "good"); const box = new SlackOutbox(good); box.close(); const observer = new SlackOutbox(good, { readOnly: true }); observer.close();
  const original = join(outer, "original"); const source = new SlackOutbox(original); source.enable(); source.close();
  const originalFile = join(original, "runtime/slack-outbox/delivery.sqlite"); chmodSync(originalFile, 0o640);
  const legacy = join(outer, "legacy"); mkdirSync(join(legacy, "runtime/slack-outbox"), { recursive: true }); symlinkSync(originalFile, join(legacy, "runtime/slack-outbox/delivery.sqlite"));
  const prior = identity(originalFile);
  const reader = new SlackOutbox(legacy, { readOnly: true }); assert.equal(reader.status().rows.length, 0); reader.close();
  assert.equal(migrateSlackDestinations(legacy, { action: "bindings" }).ok, true);
  assert.ok(readSlackRoutingEvidence(legacy, "item", "create", "revision", "timestamp").since);
  assert.throws(() => migrateSlackDestinations(legacy, { action: "bind", alias: "safe", destination: slackDestination("https://example.com/hook"), channel: null, bindingRevision: 0 }));
  assert.deepEqual(identity(originalFile), prior, "legacy observations remain readable without new validation or chmod");
});

test("a peer directory creation is accepted while actual creation failures refuse", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "slack-storage-interleave-")); t.after(() => removeScratchTree(outer));
  const original = fs.mkdirSync;
  for (const peer of [true, false]) {
    const root = join(outer, peer ? "peer" : "failure");
    /** Inject at the exact lstat-to-mkdir boundary using real directories and the real EEXIST result. */
    fs.mkdirSync = ((path, options) => {
      if (String(path) === join(root, "runtime")) {
        if (!peer) throw new Error("creation failed");
        original(path, options);
      }
      return original(path, options);
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    try {
      if (peer) assert.ok(ownedOutboxFile(root, true).endsWith("delivery.sqlite"));
      else assert.throws(() => ownedOutboxFile(root, true), /creation failed/);
    } finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
  }
});

test("no command, archive probe or cleanup reintroduces pathname chmod or recursive shell chmod", () => {
  const root = resolve(import.meta.dirname, "..");
  const files = [...readdirSync(root).filter((p) => p.endsWith(".ts")), ...readdirSync(join(root, "scripts")).filter((p) => p.endsWith(".ts")).map((p) => `scripts/${p}`)];
  for (const file of files) {
    const tokens = tokenize(readFileSync(join(root, file), "utf8"), file);
    const forbidden = new Set(["chmod", "chmodSync"]);
    // The shared lexer skips comments and literal bodies, preserving import/destructuring aliases.
    tokens.forEach((token, i) => { if (forbidden.has(token.text) && ["as", ":"].includes(tokens[i + 1]?.text ?? "")) forbidden.add(tokens[i + 2]!.text); });
    tokens.forEach((token, i) => {
      const next = tokens[i + 1]?.text;
      assert.ok(!["chmod", "chmodSync"].includes(token.text), `${file}: pathname chmod reference can escape through an alias`);
      assert.ok(!/^['"](?:chmod|chmodSync)['"]$/.test(token.text), `${file}: computed pathname chmod or shell command alias`);
      assert.ok(!(forbidden.has(token.text) && next === "("), `${file}: pathname chmod`);
      assert.ok(!(/^['"]chmod(?:Sync)?['"]$/.test(token.text) && next === "]" && tokens[i + 2]?.text === "("), `${file}: computed pathname chmod`);
      if (/exec|spawn/.test(token.text) && next === "(") assert.ok(!/(^|\s|\/)chmod(?:\s|$)/.test(tokens[i + 2]!.text.slice(1, -1)), `${file}: shell chmod`);
    });
  }
});
