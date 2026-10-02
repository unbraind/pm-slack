/** Real SDK tracker regressions for complete, observational Slack digests. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import test, { type TestContext } from "node:test";
import { close, create, init, schemaAddType } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

/** Extension harness returned by `createExtensionTestHarness`, deactivated at teardown. */
type ExtensionHarness = Awaited<ReturnType<typeof createExtensionTestHarness>>;

/** Disposable resources for one corpus test, torn down by the fixture hook. */
interface CorpusFixture {
  /** Temporary directory holding the disposable tracker. */
  readonly directory: string;
  /** Record the initialized harness so teardown deactivates it. */
  trackHarness: (harness: ExtensionHarness) => void;
  /** Record the listening webhook server so teardown closes it. */
  trackServer: (server: Server) => void;
}

/**
 * Create the disposable tracker directory for one corpus test and register its
 * full teardown on the owning test's lifecycle before any other setup runs.
 *
 * The registered hook runs even when a later setup step or an assertion fails,
 * and it performs the same sequence the per-test `finally` blocks used —
 * harness deactivation, webhook server close, directory removal — for whichever
 * resources exist at that point. Registering the hook immediately after the
 * directory is created, instead of entering `try`/`finally` only after the
 * harness and server are already up, is what keeps a rejected harness creation
 * or server listen from leaking the resources already made.
 *
 * @param context - Owning test lifecycle, so cleanup runs on every exit path.
 * @param prefix - `mkdtempSync` prefix identifying this corpus test in tmpdir().
 * @returns Fixture directory and recorders for the teardown-owned resources.
 */
function createCorpusFixture(context: TestContext, prefix: string): CorpusFixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const resources: { harness?: ExtensionHarness; server?: Server } = {};
  context.after(async () => {
    await resources.harness?.deactivate();
    if (resources.server) {
      await new Promise<void>((resolve, reject) => {
        resources.server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    trackHarness: (harness) => { resources.harness = harness; },
    trackServer: (server) => { resources.server = server; },
  };
}

/** Directory created by the setup-failure regression test; checked once its hooks ran. */
let setupFailureDirectory: string | undefined;

test("digest includes configured custom types and decodes escaped titles through the SDK", async (t) => {
  const fixture = createCorpusFixture(t, "pm-slack-corpus-");
  const pmRoot = join(fixture.directory, ".agents", "pm");
  const client = { pmRoot, cwd: fixture.directory, noExtensions: true };
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  fixture.trackHarness(harness);
  await init("slack", { defaults: true, agentGuidance: "skip" }, client);
  await schemaAddType("Maintenance", { folder: "maintenance" }, client);
  await create({ type: "Maintenance", title: "Escaped\nline and \\\"quote" }, client);
  const response = await harness.runCommand({ command: "slack digest", pmRoot,
    options: { "dry-run": true, days: "1" }, global: { json: true } });
  const result = response.result as { total: number; counts: { created: number }; payload: { text: string } };
  assert.equal(result.total, 1);
  assert.equal(result.counts.created, 1);
  assert.ok(result.payload.text.includes("Escaped\nline and \\\"quote"));
});

test("digest includes every terminal and active item in a multi-item corpus", async (t) => {
  const fixture = createCorpusFixture(t, "pm-slack-complete-");
  const pmRoot = join(fixture.directory, ".agents", "pm");
  const client = { pmRoot, cwd: fixture.directory, noExtensions: true };
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  fixture.trackHarness(harness);
  await init("slack", { defaults: true, agentGuidance: "skip" }, client);
  for (let index = 0; index < 12; index += 1) {
    const created = await create({ title: `Synthetic digest task ${index}` }, client);
    if (index === 0) await close(created.item.id, "Synthetic completion", {}, client);
  }
  const response = await harness.runCommand({ command: "slack digest", pmRoot,
    options: { "dry-run": true, days: "1" }, global: { json: true } });
  const result = response.result as { total: number; counts: { created: number; closed: number } };
  assert.deepEqual(result.counts, { created: 12, closed: 1, blocked: 0, in_progress: 0 });
  assert.equal(result.total, 13, "status updates and creations retain existing bucket semantics");
});

test("malformed records refuse a real post before contacting the localhost webhook", async (t) => {
  const fixture = createCorpusFixture(t, "pm-slack-no-post-");
  const pmRoot = join(fixture.directory, ".agents", "pm");
  let requests = 0;
  const server = http.createServer((_request, response) => { requests += 1; response.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.trackServer(server);
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  fixture.trackHarness(harness);
  await init("slack", { defaults: true, agentGuidance: "skip" }, { pmRoot, cwd: fixture.directory, noExtensions: true });
  writeFileSync(join(pmRoot, "tasks", "broken.toon"), "not a valid item document");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(harness.runCommand({ command: "slack digest", pmRoot,
    options: { webhook: `http://127.0.0.1:${address.port}/fixture` }, global: { json: true } }), /complete|read|unreadable/i);
  assert.equal(requests, 0);
});

test("digest refuses malformed tracker records instead of previewing an incomplete corpus", async (t) => {
  const fixture = createCorpusFixture(t, "pm-slack-corrupt-");
  const pmRoot = join(fixture.directory, ".agents", "pm");
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  fixture.trackHarness(harness);
  await init("slack", { defaults: true, agentGuidance: "skip" }, { pmRoot, cwd: fixture.directory, noExtensions: true });
  // Deliberate corruption of an isolated fixture tests the unsafe read boundary.
  writeFileSync(join(pmRoot, "tasks", "broken.toon"), "not a valid item document");
  await assert.rejects(harness.runCommand({ command: "slack digest", pmRoot,
    options: { "dry-run": true }, global: { json: true } }), /complete|read|unreadable/i);
});

test("corpus fixture removes the tracker directory when later setup never runs", async (t) => {
  // Regression for the Greptile "setup failure skips cleanup" review: the
  // corpus tests created the directory (and, in the webhook test, a listening
  // server) before entering try/finally, so a rejected harness creation or
  // server listen leaked them. The fixture registers its teardown hook before
  // any other setup, so the directory is removed even when nothing else is
  // created. The follow-up test asserts the removal after this test's
  // lifecycle hooks have run.
  const fixture = createCorpusFixture(t, "pm-slack-setup-fail-");
  setupFailureDirectory = fixture.directory;
  assert.ok(existsSync(fixture.directory), "the disposable tracker directory exists during the test");
});

test("no corpus directory leaks when setup failed before harness creation", () => {
  assert.ok(setupFailureDirectory, "the setup-failure regression test must run first");
  assert.ok(
    !existsSync(setupFailureDirectory),
    "the registered teardown must remove the tracker directory even when later setup never runs",
  );
});
