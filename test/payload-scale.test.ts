/** Valid maximum-domain payloads must complete within a bounded child lifetime, through SDK and CLI outputs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

test("all valid dense payload shapes compile in bounded work through SDK, JSON and TOON", async (t) => {
  const root = resolve(import.meta.dirname, "..");
  const code = `import {assertPayloadScale} from ${JSON.stringify(pathToFileURL(join(root, "test/helpers/payload-scale-scenario.ts")).href)};
import {compileSlackPayload,validateSlackWirePayload} from ${JSON.stringify(pathToFileURL(join(root, "payload-compilation.ts")).href)};
console.log(JSON.stringify(assertPayloadScale(compileSlackPayload,validateSlackWirePayload)));`;
  const started = performance.now();
  const rows = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", code], { timeout: 20000, encoding: "utf8", maxBuffer: 1024 * 1024 })) as { leaves: number }[];
  assert.equal(rows.length, 5); assert.equal(rows[1]!.leaves, 50000);
  t.diagnostic(`Five adversarial SDK shapes including 50,000 fields completed in ${Math.round(performance.now() - started)} ms.`);
  const directory = mkdtempSync(join(tmpdir(), "slack-dense-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, "source.json");
  writeFileSync(input, JSON.stringify({ item: "scale", link: "https://example.com/scale", preserve: [], payload: { text: "fallback", blocks: Array.from({ length: 200 }, () => ({ type: "section", fields: Array.from({ length: 100 }, () => ({ type: "mrkdwn", text: "x" })) })) } }));
  const harness = await createExtensionTestHarness(extension, { name: "pm-slack", capabilities: ["commands", "hooks", "schema", "preflight", "renderers"] }); t.after(() => harness.deactivate());
  const response = await harness.runCommand({ command: "slack compile", pmRoot: join(directory, ".agents/pm"), options: { input }, global: { json: true } });
  const result = response.result as { ok: boolean; total_losses: number; losses: unknown[] };
  assert.equal(result.ok, true); assert.equal(result.total_losses, 19500); assert.equal(result.losses.length, 20);
  assert.deepEqual(decode((await harness.runRendererOverride({ command: "slack compile", format: "toon", result })).rendered!), result);
});
