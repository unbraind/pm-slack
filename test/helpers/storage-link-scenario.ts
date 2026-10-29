/** Shared source/packed Node/Bun fixture: writers refuse persisted links, while legacy observations remain compatible. */
import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackOutbox } from "../../outbox.ts";
import { removeScratchTree } from "../../scripts/snapshot-filesystem.ts";

/** Reuse exactly the same linked-file and sidecar corpus with the actual captured constructor. */
export function assertStorageLinks(Constructor: typeof SlackOutbox): number {
  const directory = mkdtempSync(join(tmpdir(), "slack-packed-paths-"));
  let cases = 0;
  try {
    const external = join(directory, "external"); mkdirSync(external); chmodSync(external, 0o750);
    const file = join(external, "sentinel"); writeFileSync(file, "synthetic outside data"); chmodSync(file, 0o640);
    const mode = lstatSync(file).mode, directoryMode = lstatSync(external).mode, bytes = readFileSync(file);
    for (const component of ["runtime", "slack-outbox", "delivery.sqlite", "delivery.sqlite-journal", "delivery.sqlite-wal", "delivery.sqlite-shm"]) for (const hard of component.includes("sqlite") ? [true, false] : [false]) {
      const root = join(directory, `case-${cases++}`); mkdirSync(root);
      const base = component === "runtime" ? root : component === "slack-outbox" ? join(root, "runtime") : join(root, "runtime/slack-outbox"); mkdirSync(base, { recursive: true });
      const target = join(base, component);
      if (hard) linkSync(file, target); else symlinkSync(component.includes("sqlite") ? file : external, target);
      assert.throws(() => new Constructor(root), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "storage_unavailable");
      try { new Constructor(root, { readOnly: true }).close(); }
      catch (error) { assert.ok(typeof error === "object" && error !== null && "code" in error && error.code === "storage_unavailable"); }
      assert.equal(lstatSync(file).mode, mode); assert.equal(lstatSync(external).mode, directoryMode); assert.deepEqual(readFileSync(file), bytes);
    }
    return cases;
  } finally { removeScratchTree(directory); }
}
