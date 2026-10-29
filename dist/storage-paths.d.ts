import type { Stats } from "node:fs";
/** Refuse links, shared file inodes and special files before they become permission-change targets. */
export declare function ownedEntry(path: string): Stats;
/** Change the inspected inode through a no-follow descriptor, never through a replaceable final path component. */
export declare function chmodOwnedEntry(path: string, mode: number, expected?: Stats): void;
/** Validate package-controlled SQLite paths before writers open them, including sidecars; legacy read-only inspection does not chmod. */
export declare function ownedOutboxFile(pmRoot: string, create: boolean): string;
//# sourceMappingURL=storage-paths.d.ts.map