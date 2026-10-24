/** Native Bun acceptance against a real non-git SDK tracker and the shipped package entry. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, create } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { SlackOutbox, slackDestination } from "../dist/index.js";
import type { OutboxReport, CoalescingReport } from "../dist/index.js";
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
  const queued = new SlackOutbox(pmRoot);
  try {
    for (const revision of ["routine-a", "routine-b"]) queued.enqueue({ item: "bun-routine", event: "close", revision,
      destination: slackDestination(process.env.PM_SLACK_WEBHOOK!), payload: { text: "Native Bun routine event" }, at: 1000, priority: 2 });
  } finally { queued.close(); }
  const grouped = (await harness.runCommand({ command: "slack coalesce", pmRoot, options: { action: "drain", budget: "1" }, global: { json: true } })).result as CoalescingReport;
  assert.equal(grouped.summary.coalesced, 2);
  assert.equal(grouped.summary.notifications, 1);
  assert.equal(grouped.rows.length, 2);
  assert.equal(grouped.rows.every((row) => row.state === "acknowledged"), true);
  assert.equal(sends, 2);
  const owner = new SlackOutbox(pmRoot);
  const peer = new SlackOutbox(pmRoot);
  try {
    const keys = ["race-a", "race-b"].map((revision) => owner.enqueue({ item: "bun-race", event: "close", revision,
      destination: "synthetic-route", payload: { text: "Native Bun concurrent event" }, at: 1000, priority: 2 }));
    await owner.drainCoalesced(async () => "retry");
    assert.equal(peer.status().counts.pending, 2);
    let releaseOld!: () => void;
    const old = owner.drainCoalesced(async () => { await new Promise<void>((done) => { releaseOld = done; }); return "retry"; });
    peer.resolve(keys[0]!, "retry", { force: true });
    let releaseNew!: () => void;
    let accepted = 0;
    const newer = peer.drainCoalesced(async () => { accepted += 1; await new Promise<void>((done) => { releaseNew = done; }); return "ambiguous"; });
    releaseOld(); await old;
    assert.equal(peer.status().counts.sending, 2);
    releaseNew(); await newer;
    peer.resolve(keys[1]!, "acknowledged");
    assert.equal(peer.status().counts.ambiguous, 0);
    assert.equal(peer.status().counts.acknowledged, 5);
    assert.equal(accepted, 1);
  } finally { peer.close(); owner.close(); }
  console.log("Native Bun acceptance: 1 recovered lifecycle + 2 coalesced events, 2 acknowledged HTTP sends; retry cleanup and stale completion preserve 1 peer group, 0 duplicates, no git.");
} finally {
  await harness?.deactivate();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(directory, { recursive: true, force: true });
}
