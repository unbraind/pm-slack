/** Archive probes inspect a complete tree before chmod; cleanup never chmods or traverses linked files. */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, relative } from "node:path";
import { chmodOwnedEntry, ownedEntry } from "../storage-paths.ts";

/** A captured inode is the authority for a later descriptor-based permission change. */
interface SnapshotEntry { path: string; stat: Stats }

/** Inspect every archive entry without following links, before changing even the first permission. */
function inventory(root: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  /** Retain exact no-follow identities for all regular files and directories. */
  const visit = (path: string): void => {
    const stat = ownedEntry(path);
    entries.push({ path, stat });
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
  return entries;
}

/** Reject linked archives before mutation; optionally retain the existing policy's writable parent directories. */
export function makeSnapshotReadOnly(root: string, readonlyDirectories?: ReadonlySet<string>): void {
  const entries = inventory(root);
  for (const { path, stat } of entries) {
    if (!stat.isDirectory()) chmodOwnedEntry(path, 0o444, stat);
    else if (readonlyDirectories === undefined || readonlyDirectories.has(relative(root, path))) chmodOwnedEntry(path, 0o555, stat);
  }
}

/** Restore only owned directory access, unlinking symlinks and hardlinks without ever chmodding their targets. */
export function removeScratchTree(root: string): void {
  /** A link is a leaf during cleanup, even when its target is a directory. */
  const writableDirectories = (path: string): void => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return;
    chmodOwnedEntry(path, 0o700, stat);
    for (const name of readdirSync(path)) writableDirectories(join(path, name));
  };
  writableDirectories(root);
  rmSync(root, { recursive: true, force: true });
}
