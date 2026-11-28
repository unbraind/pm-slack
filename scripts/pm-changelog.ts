/** Generate and check the upstream changelog identically before and after tagging. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Generate or check the same full changelog on either side of release tagging. */
export function releaseChangelog(args: readonly string[], cwd = process.cwd()): number {
  const outputIndex = args.indexOf("--output");
  const output = args[outputIndex + 1];
  if (outputIndex < 0 || !output || !args.includes("--include-empty") || !args.includes("--all-release-tags") || args[args.indexOf("--mode") + 1] !== "replace") {
    throw new Error("Release changelog requires replace mode, an output, all release tags and include-empty.");
  }
  const result = spawnSync(process.execPath, [resolve(cwd, "node_modules/pm-changelog/dist/cli.js"), ...args], {
    cwd, stdio: ["ignore", "inherit", "inherit"], timeout: 120000,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = releaseChangelog(process.argv.slice(2));
}
