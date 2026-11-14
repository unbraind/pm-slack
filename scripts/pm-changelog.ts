/** Generate and check the upstream changelog identically before and after tagging. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Generate or check the same full changelog on either side of release tagging. */
export function releaseChangelog(args: readonly string[], cwd = process.cwd()): number {
  const outputIndex = args.indexOf("--output");
  const output = args[outputIndex + 1];
  if (outputIndex < 0 || !output || !args.includes("--include-empty") || !args.includes("--all-release-tags") || args[args.indexOf("--mode") + 1] !== "replace") {
    throw new Error("Release changelog requires replace mode, an output, all release tags and include-empty.");
  }
  const generateArgs = args.filter((arg, index) => index !== outputIndex && index !== outputIndex + 1 && arg !== "--check");
  const result = spawnSync(process.execPath, [resolve(cwd, "node_modules/pm-changelog/dist/cli.js"), ...generateArgs, "--stdout"], {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.stderr.write(result.stderr); return result.status ?? 1; }
  const generated = result.stdout;
  const target = resolve(cwd, output);
  if (args.includes("--check")) {
    if (!existsSync(target) || readFileSync(target, "utf8") !== generated) {
      process.stderr.write("Changelog is out of date.\n"); return 1;
    }
  } else writeFileSync(target, generated);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = releaseChangelog(process.argv.slice(2));
}
