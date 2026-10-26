/** Exhaustive SQL-boundary races against real SQLite handles on one non-git SDK tracker. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { init } from "@unbrained/pm-cli/sdk";
import { SlackOutbox, OutboxError } from "../outbox.ts";
import type { OutboxDecision, OutboxOutcome } from "../outbox.ts";

/** Two independent handles share real durable storage, with git discovery disabled. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "slack-interleaving-"));
  const pmRoot = join(directory, ".agents", "pm");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await init("interleaving", { defaults: true, agentGuidance: "skip" }, { cwd: directory, pmRoot, noExtensions: true });
  assert.equal(existsSync(join(directory, ".git")), false);
  const box = new SlackOutbox(pmRoot);
  const peer = new SlackOutbox(pmRoot);
  t.after(() => { peer.close(); box.close(); });
  box.enable();
  const keys = ["first", "second"].map((revision) => box.enqueue({ item: "task", event: "create", revision, destination: "synthetic-route", payload: { text: "Synthetic event" }, at: 1000, priority: 2 }));
  const db = (box as unknown as { db: DatabaseSync }).db;
  (peer as unknown as { db: DatabaseSync }).db.exec("PRAGMA busy_timeout=1");
  return { box, peer, db, keys, pmRoot, directory };
}

/** Observe completed SQL calls without replacing SQLite behavior or any SDK operation. */
function boundaries(db: DatabaseSync, checkpoint: (sql: string) => void): () => void {
  const exec = db.exec;
  const prepare = db.prepare;
  db.exec = function (sql) { exec.call(this, sql); checkpoint(sql); };
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ["run", "get", "all"] as const) {
      const operation = statement[method];
      Object.defineProperty(statement, method, { value: (...args: SQLInputValue[]) => {
        const result: unknown = Reflect.apply(operation, statement, args);
        checkpoint(sql);
        return result;
      } });
    }
    return statement;
  };
  return () => { db.exec = exec; db.prepare = prepare; };
}

/** Execute a real sender that can terminate between actual durable operations. */
async function child(pmRoot: string, directory: string, source: string): Promise<number | null> {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", source, pmRoot], {
      cwd: directory, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    processChild.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    processChild.on("error", reject);
    processChild.on("exit", (code) => code === 73 ? done(code) : reject(new Error(stderr)));
  });
}

const moduleUrl = new URL("../outbox.ts", import.meta.url).href;
const senderSource = `import {SlackOutbox} from ${JSON.stringify(moduleUrl)}; const box=new SlackOutbox(process.argv[1]);`;

/** Leave an actual dead sender's complete claim, rather than fabricating crash state. */
async function crash(pmRoot: string, directory: string): Promise<void> {
  assert.equal(await child(pmRoot, directory, `${senderSource} await box.drainCoalesced(async()=>process.exit(73));`), 73);
}

type Scenario = { outcome: OutboxOutcome | "typed-retry" | "typed-refusal" } | { from: "crash" | "ambiguous" | "rejected" | "refused"; decision: OutboxDecision };

/** Arrange one transition and inject a peer's complete asynchronous group claim at a selected boundary. */
async function race(t: TestContext, scenario: Scenario, boundary = -1): Promise<string[]> {
  const { box, peer, db, keys, pmRoot, directory } = await fixture(t);
  const trace: string[] = [];
  let armed = false;
  let peerDrain: Promise<unknown> | undefined;
  let releasePeer: ((outcome: OutboxOutcome) => void) | undefined;
  let peerAccepted = 0;
  let blocked = 0;
  /** Hold the peer after acceptance so older cleanup runs before its uncertain completion. */
  const sendPeer = async (): Promise<OutboxOutcome> => {
    peerAccepted += 1;
    assert.equal(peer.status().counts.sending, 2, "a claimed group must contain both originals");
    return new Promise((done) => { releasePeer = done; });
  };
  /** Start synchronously through the peer claim, recording expected SQLite writer contention. */
  const startPeer = (): Promise<unknown> => peer.drainCoalesced(sendPeer).catch((error: unknown) => {
    assert.match(String(error), /locked|busy|storage_unavailable/);
    blocked += 1;
  });
  if ("from" in scenario) {
    if (scenario.from === "crash") await crash(pmRoot, directory);
    else {
      const from = scenario.from;
      await box.drainCoalesced(async (_destination, _payload, context) => {
        if (from === "refused") throw new OutboxError("destination_changed", "Restore synthetic route.");
        context.requestDispatched();
        return from;
      });
    }
  }
  const restore = boundaries(db, (sql) => {
    if (!armed) return;
    trace.push(sql);
    if (trace.length - 1 === boundary) peerDrain = startPeer();
  });
  try {
    if ("outcome" in scenario) {
      const transport = async () => {
        armed = true;
        if (scenario.outcome === "typed-retry") throw new OutboxError("invalid_input", "Repair synthetic configuration.");
        if (scenario.outcome === "typed-refusal") throw new OutboxError("destination_changed", "Restore synthetic route.");
        if (scenario.outcome === "ambiguous") throw new Error("Synthetic connection lost after transmission");
        return scenario.outcome;
      };
      const preflight = scenario.outcome === "typed-retry" || scenario.outcome === "typed-refusal";
      const draining = box.drainCoalesced(preflight ? async (_destination, _payload, _context) => transport() : transport);
      if (scenario.outcome === "typed-retry") await assert.rejects(draining, OutboxError);
      else await draining;
    } else {
      armed = true;
      box.resolve(keys[0]!, scenario.decision);
    }
  } finally { armed = false; restore(); }
  if (boundary >= 0) assert.ok(trace.length > boundary, "the selected SQL boundary must execute");
  const report = box.status();
  assert.equal(new Set(report.rows.map((row) => row.state)).size, 1, "peers must never observe split group state");
  if (report.counts.pending === 2) {
    await peerDrain;
    peerDrain = startPeer();
  }
  if (releasePeer) {
    assert.equal(peer.status().counts.sending, 2);
    releasePeer("ambiguous");
    await peerDrain;
    assert.equal(peer.status().counts.ambiguous, 2);
    peer.resolve(keys[1]!, "acknowledged");
    assert.equal(peer.status().counts.acknowledged, 2, "reconciling either sibling must recover the whole peer group");
  } else {
    await peerDrain;
    assert.equal(peerAccepted, 0, "unresolved or terminal groups must never be claimed");
    if (!report.counts.acknowledged && !report.counts.skipped) {
      assert.equal(report.counts.ambiguous + report.counts.rejected + report.counts.refused, 2);
      box.resolve(keys[1]!, "acknowledged");
      assert.equal(box.status().counts.acknowledged, 2);
    }
  }
  assert.ok(peerAccepted <= 1, "each original may be accepted at most once");
  assert.equal(box.status().counts.ambiguous, 0, "no orphan ambiguity may remain after sibling reconciliation");
  await peer.drainCoalesced(async () => { assert.fail("a recovered group cannot be delivered twice"); });
  assert.ok(blocked <= 1, "at most the injected peer encounters a held writer fence");
  return trace;
}

test("retry and failure cleanup fence peer claims at every SQL boundary on one non-git tracker", async (t) => {
  for (const outcome of ["retry", "typed-retry", "ambiguous", "rejected", "typed-refusal", "acknowledged"] as const) {
    const scenario = { outcome };
    const trace = await race(t, scenario);
    for (let boundary = 0; boundary < trace.length; boundary += 1) {
      await t.test(`${outcome} boundary ${boundary + 1}: ${trace[boundary]!.split(" ").slice(0, 3).join(" ")}`, async (subtest) => { await race(subtest, scenario, boundary); });
    }
  }
});

test("failure and dead-sender reconciliation fence peer claims at every SQL boundary and recover whole groups", async (t) => {
  for (const from of ["crash", "ambiguous", "rejected", "refused"] as const) {
    for (const decision of ["retry", "acknowledged", "skip"] as const) {
      const scenario = { from, decision };
      const trace = await race(t, scenario);
      for (let boundary = 0; boundary < trace.length; boundary += 1) {
        await t.test(`${from} ${decision} boundary ${boundary + 1}`, async (subtest) => { await race(subtest, scenario, boundary); });
      }
    }
  }
});

test("stale grouped and plain sender completions cannot overwrite or delete a newer attempt", async (t) => {
  for (const mode of ["grouped", "plain"] as const) for (const outcome of ["retry", "acknowledged", "typed-retry", "ambiguous"] as const) {
    await t.test(`${mode} ${outcome}`, async (subtest) => {
      const { box, peer, keys } = await fixture(subtest);
      let releaseOld!: () => void;
      const sendOld = async (_destination: string, _payload: unknown, context: { requestDispatched(): void }): Promise<OutboxOutcome> => {
        await new Promise<void>((done) => { releaseOld = done; });
        if (outcome === "typed-retry") throw new OutboxError("invalid_input", "Repair synthetic configuration.");
        context.requestDispatched();
        return outcome;
      };
      const old = mode === "grouped" ? box.drainCoalesced(sendOld) : box.drain(sendOld, 1);
      // The operator must verify absence before forcing; here the transport is deliberately held before acceptance.
      peer.resolve(keys[0]!, "retry", { force: true });
      let releaseNew!: () => void;
      let accepted = 0;
      const newer = peer.drainCoalesced(async () => {
        accepted += 1;
        await new Promise<void>((done) => { releaseNew = done; });
        return "ambiguous";
      });
      releaseOld();
      if (outcome === "typed-retry") await assert.rejects(old, OutboxError); else await old;
      assert.equal(peer.status().counts.sending, 2, "old completion cannot change the newer group's state");
      releaseNew(); await newer;
      peer.resolve(keys[1]!, "acknowledged");
      assert.equal(peer.status().counts.acknowledged, 2);
      assert.equal(accepted, 1);
    });
  }
});

test("cleanup and recovery SQL faults roll back membership, attempts and release together", async (t) => {
  for (const transition of ["cleanup", "resolve"] as const) for (const fault of ["delete", "release"] as const) for (const rollback of ["ABORT", "ROLLBACK"] as const) {
    await t.test(`${transition} ${fault} ${rollback}`, async (subtest) => {
      const { box, peer, db, keys } = await fixture(subtest);
      if (transition === "resolve") await box.drainCoalesced(async () => "ambiguous");
      const before = transition === "resolve" ? box.status().rows : undefined;
      const trigger = fault === "delete" ? "BEFORE DELETE ON delivery_group" : `BEFORE UPDATE ON delivery WHEN NEW.state='pending' AND NEW.key='${keys[1]}'`;
      db.exec(`CREATE TRIGGER refuse_transition ${trigger} BEGIN SELECT RAISE(${rollback}, 'synthetic transition fault'); END`);
      if (transition === "cleanup") await assert.rejects(box.drainCoalesced(async () => "retry"), /synthetic transition fault/);
      else assert.throws(() => box.resolve(keys[0]!, "retry"), /synthetic transition fault/);
      if (before) assert.deepEqual(box.status().rows, before);
      else { assert.equal(box.status().counts.sending, 2); assert.ok(box.status().rows.every((row) => row.attempts === 1)); }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_group").get()!.n, 2);
      await peer.drainCoalesced(async () => { assert.fail("a failed transition cannot release members"); });
      db.exec("DROP TRIGGER refuse_transition");
      box.resolve(keys[1]!, "acknowledged", { force: true });
      assert.equal(box.status().counts.acknowledged, 2);
    });
  }
});

test("process death at every retry cleanup and crash recovery SQL boundary leaves complete recoverable groups", async (t) => {
  for (const transition of ["cleanup", "recovery"] as const) {
    const scenario: Scenario = transition === "cleanup" ? { outcome: "retry" } : { from: "crash", decision: "retry" };
    const trace = await race(t, scenario);
    for (let boundary = 0; boundary < trace.length; boundary += 1) {
      await t.test(`${transition} process death boundary ${boundary + 1}`, async (subtest) => {
        const { box, peer, db, keys, pmRoot, directory } = await fixture(subtest);
        if (transition === "recovery") await crash(pmRoot, directory);
        // The wrappers observe native calls and terminate only after the selected SQL step completes.
        const observe = `let armed=false,step=0; const checkpoint=()=>{if(armed && step++===${boundary}) process.exit(73);};
          const db=box.db, exec=db.exec, prepare=db.prepare;
          db.exec=function(sql){exec.call(this,sql);checkpoint();};
          db.prepare=function(sql){const statement=prepare.call(this,sql);for(const method of ['run','get','all']){const operation=statement[method];statement[method]=function(...args){const result=operation.apply(this,args);checkpoint();return result;};}return statement;};`;
        const action = transition === "cleanup" ? "await box.drainCoalesced(async()=>{armed=true;return 'retry';});" : `armed=true;box.resolve(${JSON.stringify(keys[0])},'retry');`;
        assert.equal(await child(pmRoot, directory, senderSource + observe + action), 73);
        const report = box.status();
        assert.equal(new Set(report.rows.map((row) => row.state)).size, 1);
        assert.equal(report.counts.pending + report.counts.sending, 2);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_group").get()!.n, report.counts.sending);
        if (report.counts.sending) {
          await peer.drainCoalesced(async () => { assert.fail("a dead sender cannot authorize automatic duplicate delivery"); });
          peer.resolve(keys[0]!, "retry");
        }
        let accepted = 0;
        await peer.drainCoalesced(async () => { accepted += 1; return "ambiguous"; });
        assert.equal(peer.status().counts.ambiguous, 2);
        peer.resolve(keys[1]!, "acknowledged");
        assert.equal(peer.status().counts.acknowledged, 2);
        await box.drainCoalesced(async () => { assert.fail("recovered originals cannot resend"); });
        assert.equal(accepted, 1);
      });
    }
  }
});
