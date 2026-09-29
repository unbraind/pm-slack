/** Real SDK tracker regressions for complete, observational Slack digests. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import test from "node:test";
import { close, create, init, schemaAddType } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

test("digest includes configured custom types and decodes escaped titles through the SDK", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-slack-corpus-"));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, noExtensions: true };
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  try {
    await init("slack", { defaults: true, agentGuidance: "skip" }, client);
    await schemaAddType("Maintenance", { folder: "maintenance" }, client);
    await create({ type: "Maintenance", title: "Escaped\nline and \\\"quote" }, client);
    const response = await harness.runCommand({ command: "slack digest", pmRoot,
      options: { "dry-run": true, days: "1" }, global: { json: true } });
    const result = response.result as { total: number; counts: { created: number }; payload: { text: string } };
    assert.equal(result.total, 1);
    assert.equal(result.counts.created, 1);
    assert.ok(result.payload.text.includes("Escaped\nline and \\\"quote"));
  } finally {
    await harness.deactivate();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("digest includes every terminal and active item in a multi-item corpus", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-slack-complete-"));
  const pmRoot = join(directory, ".agents", "pm");
  const client = { pmRoot, cwd: directory, noExtensions: true };
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  try {
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
  } finally {
    await harness.deactivate();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed records refuse a real post before contacting the localhost webhook", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-slack-no-post-"));
  const pmRoot = join(directory, ".agents", "pm");
  let requests = 0;
  const server = http.createServer((_request, response) => { requests += 1; response.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  try {
    await init("slack", { defaults: true, agentGuidance: "skip" }, { pmRoot, cwd: directory, noExtensions: true });
    writeFileSync(join(pmRoot, "tasks", "broken.toon"), "not a valid item document");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(harness.runCommand({ command: "slack digest", pmRoot,
      options: { webhook: `http://127.0.0.1:${address.port}/fixture` }, global: { json: true } }), /complete|read|unreadable/i);
    assert.equal(requests, 0);
  } finally {
    await harness.deactivate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("digest refuses malformed tracker records instead of previewing an incomplete corpus", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pm-slack-corrupt-"));
  const pmRoot = join(directory, ".agents", "pm");
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight"] });
  try {
    await init("slack", { defaults: true, agentGuidance: "skip" }, { pmRoot, cwd: directory, noExtensions: true });
    // Deliberate corruption of an isolated fixture tests the unsafe read boundary.
    writeFileSync(join(pmRoot, "tasks", "broken.toon"), "not a valid item document");
    await assert.rejects(harness.runCommand({ command: "slack digest", pmRoot,
      options: { "dry-run": true }, global: { json: true } }), /complete|read|unreadable/i);
  } finally {
    await harness.deactivate();
    rmSync(directory, { recursive: true, force: true });
  }
});
