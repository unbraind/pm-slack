/** Measure explanations on an exported read-only public tracker outside git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";
import http from "node:http";
import { listAllComplete, readHistoryEntries, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { explainSlackRouting, classifySlackTransition } from "../index.ts";
import { slackRoutingToon } from "../routing-explanation.ts";

/** Capture every exported byte before and after diagnosis without changing the tracker. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? fingerprint(join(root, entry.name)) : readFileSync(join(root, entry.name)));
  }
  return hash.digest("hex");
}

const pmRoot = process.argv[2];
assert.ok(pmRoot, "Pass an exported public tracker root.");
const before = fingerprint(pmRoot);
const statusRegistry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
const corpus = await listAllComplete({}, { pmRoot, cwd: pmRoot, noExtensions: true });
let networkCalls = 0;
/** Any attempted transport fails the measurement immediately. */
function forbidNetwork(): never { networkCalls += 1; throw new Error("Offline diagnosis attempted transport"); }
https.request = forbidNetwork;
http.request = forbidNetwork;
globalThis.fetch = forbidNetwork;
process.env.PM_SLACK_WEBHOOK = "https://example.invalid/synthetic";
process.env.PM_SLACK_EVENTS = "create,close,block,cancel,open,start,unblock,reopen";
process.env.PM_SLACK_MIN_PRIORITY = "4";
process.env.PM_SLACK_ROUTES = JSON.stringify([{ match: "block", channel: "synthetic" }, { match: "*", channel: "synthetic" }]);
let historyEntries = 0;
let diagnosed = 0;
let urgentPolicies = 0;
let uncertain = 0;
let maxJsonBytes = 0;
let maxToonBytes = 0;
for (const item of corpus.items) {
  const history = await readHistoryEntries(join(pmRoot, "history", `${item.id}.jsonl`), item.id);
  let previous: string | undefined;
  for (const [index, entry] of history.entries()) {
    historyEntries += 1;
    const change = entry.patch.find((patch) => patch.path === "/metadata/status" || patch.path === "/front_matter/status");
    const status = change && "value" in change ? String(change.value) : undefined;
    const prior = previous;
    if (status) previous = status;
    if (entry.op !== "create" && (!status || status === prior)) continue;
    const event = classifySlackTransition({ command: entry.op === "create" ? "create" : "update", status, previousStatus: prior }, statusRegistry);
    if (!event) continue;
    const report = await explainSlackRouting(pmRoot, { item: item.id, event, revision: entry.after_hash, version: index + 1 });
    assert.deepEqual([...new Set(report.path.map((step) => step.stage))], ["history", "events", "priority", "route", "coalescing", "delivery"]);
    diagnosed += 1;
    if (report.path.some((step) => step.policy.includes("bypasses"))) urgentPolicies += 1;
    if (report.outcome === "uncertain") uncertain += 1;
    maxJsonBytes = Math.max(maxJsonBytes, Buffer.byteLength(JSON.stringify(report)));
    maxToonBytes = Math.max(maxToonBytes, Buffer.byteLength(slackRoutingToon(report)));
  }
}
assert.equal(fingerprint(pmRoot), before);
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ items: corpus.items.length, history_entries: historyEntries, complete_paths: diagnosed, urgent_policies: urgentPolicies,
  uncertain_without_runtime_receipts: uncertain, network_calls: networkCalls, max_json_bytes: maxJsonBytes, max_toon_bytes: maxToonBytes,
  tracker_bytes_unchanged: true, fingerprint: before }, null, 2));
