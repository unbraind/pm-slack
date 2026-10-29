/** No-follow permission changes for owned entries; storage roots themselves remain operator-selected paths. */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
/** Refuse links, shared file inodes and special files before they become permission-change targets. */
export function ownedEntry(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1))
        throw new Error("Refuse linked or special storage entries; restore an owned regular file or directory.");
    return stat;
}
/** Change the inspected inode through a no-follow descriptor, never through a replaceable final path component. */
export function chmodOwnedEntry(path, mode, expected = ownedEntry(path)) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const actual = fstatSync(fd);
        if (actual.dev !== expected.dev || actual.ino !== expected.ino || (!actual.isDirectory() && (!actual.isFile() || actual.nlink !== 1)))
            throw new Error("Storage entry changed after inspection; retry using the current owned entry.");
        const permissions = actual.mode & 0o7777;
        if (permissions !== (expected.mode & 0o7777) && permissions !== mode)
            throw new Error("Storage permissions changed after inspection; preserve the peer's change and retry.");
        if (permissions === mode)
            return; // A peer may already have completed this exact permission policy.
        fchmodSync(fd, mode);
    }
    finally {
        closeSync(fd);
    }
}
/** Validate package-controlled SQLite paths before writers open them, including sidecars; legacy read-only inspection does not chmod. */
export function ownedOutboxFile(pmRoot, create) {
    const original = join(pmRoot, "runtime", "slack-outbox", "delivery.sqlite");
    if (create)
        mkdirSync(pmRoot, { recursive: true });
    else if (!lstatSync(pmRoot, { throwIfNoEntry: false }))
        return original;
    // The supplied root is an operator coordinate. Links inside it are untrusted persisted state.
    let directory = realpathSync(pmRoot);
    for (const name of ["runtime", "slack-outbox"]) {
        directory = join(directory, name);
        let stat = lstatSync(directory, { throwIfNoEntry: false });
        if (!stat && create) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                    throw error;
            }
            stat = ownedEntry(directory);
        }
        if (!stat)
            return original;
        const inspected = ownedEntry(directory);
        if (!inspected.isDirectory())
            throw new Error("Outbox storage parents must be owned directories.");
        if (create)
            chmodOwnedEntry(directory, 0o700, inspected);
    }
    const file = join(directory, "delivery.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const path = file + suffix;
        if (lstatSync(path, { throwIfNoEntry: false })) {
            if (!ownedEntry(path).isFile())
                throw new Error("Outbox storage and sidecars must be owned regular files.");
        }
    }
    return file;
}
//# sourceMappingURL=storage-paths.js.map