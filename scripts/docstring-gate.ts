#!/usr/bin/env node
/**
 * Enforce meaningful docstrings across pm-slack source declarations.
 *
 * The analyzer comes from pm-ops so the fleet shares one lexer-backed policy:
 * every exported declaration, every public member of an exported class, and
 * every substantial private function needs JSDoc that contributes information
 * beyond its identifier. The analyzer has no ignore list and treats unknown
 * declaration forms as violations, so a new syntax form fails closed.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeDocstringCoverage } from "pm-ops/docstrings";

const repoRoot = join(import.meta.dirname, "..");

/**
 * Outcome of one gate run, held as plain strings so a test can inspect it.
 *
 * Declared here rather than shared from a helper module so this script stays a
 * single self-contained file, matching how the other gate scripts in this
 * package are wired.
 */
interface GateResult {
  /** Process exit code the run would produce (0 on success; non-zero on failure). */
  readonly exitCode: number;
  /** Content the run would write to stdout, without a trailing newline. */
  readonly stdout: string;
  /** Content the run would write to stderr, without a trailing newline. */
  readonly stderr: string;
}

/**
 * Whether this module is the process entry point rather than a test import.
 *
 * `import.meta.url` is already symlink-resolved, so `argv[1]` is resolved through
 * `realpathSync` and converted to a URL before comparison. A launcher reaching
 * this file through a symlink (an npm bin shim, a linked workspace) would
 * otherwise compare unequal and skip the gate silently.
 *
 * An unresolvable `argv[1]` **propagates** rather than returning false. The two
 * outcomes are not equally safe: returning false means `npm run docstring`
 * exits 0 having scanned nothing, which is a required release check reporting
 * success without doing its job — the one failure this gate exists to prevent.
 * Letting `realpathSync` throw turns that into a loud non-zero exit. The case
 * requires `argv[1]` to stop resolving after Node has already loaded this file,
 * so in practice it means the environment is broken, and a broken environment
 * must not silently satisfy a gate.
 *
 * A genuinely different entry path still returns false, which is how a test
 * importing this module declines to run the gate.
 *
 * @param argv - The process argv to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` resolves to this module's own URL, false when it
 *          resolves to something else.
 * @throws Whatever `realpathSync` throws when `argv[1]` cannot be resolved.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return pathToFileURL(realpathSync(entry)).href === moduleUrl;
}

/**
 * Run the docstring gate against a repository root and return what it would write.
 *
 * Pure by design: it touches neither the process streams nor `process.exit`, so
 * a test imports this and asserts on the returned strings, while the thin
 * {@link main} entry point writes them and sets the exit code.
 *
 * @param root - Absolute repository root to scan.
 * @returns The exit code and the newline-free stdout/stderr content; {@link main}
 *          appends the trailing newline when it writes them.
 */
export function runGate(root: string): GateResult {
  const report = analyzeDocstringCoverage({ root });
  if (report.violations.length > 0) {
    let message = `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n`;
    for (const violation of report.violations) {
      message += `${violation.file}:${violation.line} ${violation.symbol}: ${violation.reason}\n`;
    }
    return { exitCode: 1, stdout: "", stderr: message.trimEnd() };
  }
  return {
    exitCode: 0,
    stdout: `docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`,
    stderr: "",
  };
}

/**
 * CLI entry point: run the gate and emit its result.
 *
 * Writes the exact stdout/stderr bytes {@link runGate} produced and appends a
 * trailing newline to each non-empty stream so the next `release:check` step
 * starts on its own line rather than butting against this gate's output.
 * {@link runGate}'s returned strings stay newline-free so a test can assert on
 * them exactly. Sets `process.exitCode` rather than calling `process.exit`, so
 * a test can invoke this in-process, observe the streams, and restore the exit
 * code.
 *
 * @param root - Absolute repository root to scan.
 */
export function main(root: string): void {
  const result = runGate(root);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  main(repoRoot);
}
