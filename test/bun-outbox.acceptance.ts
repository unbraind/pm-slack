/** Native Bun acceptance against a real non-git SDK tracker and the shipped package entry. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, create } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { SlackOutbox } from "../dist/index.js";
import type { OutboxReport } from "../dist/index.js";
import http from "node:http";

const directory = mkdtempSync(join(tmpdir(), "slack-bun-acceptance-"));
const pmRoot = join(directory, ".agents", "pm");
process.env.PATH = directory;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const server = http.createServer((request, response) => {
  request.resume(); request.on("end", () => { sends += 1; response.end("ok"); });
});
let sends = 0;
let harness: Awaited<ReturnType<typeof createExtensionTestHarness>> | undefined;
try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.PM_SLACK_WEBHOOK = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture`;
  process.env.PM_SLACK_MIN_PRIORITY = "4";
  delete process.env.PM_SLACK_ROUTES;
  const client = { cwd: directory, pmRoot, noExtensions: true };
  await init("bun", { defaults: true, agentGuidance: "skip" }, client);
  harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] });
  await harness.runCommand({ command: "slack outbox", pmRoot, options: { action: "enable" } });
  await create({ title: "Native Bun lifecycle", priority: 1 }, client);
  const result = (await harness.runCommand({ command: "slack outbox", pmRoot, options: { action: "drain" }, global: { json: true } })).result as OutboxReport;
  assert.equal(result.counts.acknowledged, 1);
  const restarted = new SlackOutbox(pmRoot);
  try {
    await restarted.drain(async () => { throw new Error("An acknowledged intent must not send again"); });
    assert.equal(restarted.status().counts.acknowledged, 1);
    assert.equal(sends, 1);
  } finally { restarted.close(); }
  console.log("Native Bun acceptance: 1 lifecycle recovered, 1 acknowledged send, 0 duplicates, no git.");
} finally {
  await harness?.deactivate();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(directory, { recursive: true, force: true });
}
