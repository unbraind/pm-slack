/** Shared real-process crash fixture and byte/permission oracle for observational consumers. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Leave real producer-written dispatched and pending receipts behind a dead process, without sending HTTP. */
export async function seedObservationalOutbox(pmRoot: string, moduleUrl: string, destination: string): Promise<void> {
  const source = `import {SlackOutbox} from ${JSON.stringify(moduleUrl)};
const box=new SlackOutbox(${JSON.stringify(pmRoot)});
for(const revision of ["dead-owner","pending"]){box.enqueue({item:"observational-fixture",event:"close",revision,destination:${JSON.stringify(destination)},payload:{text:"Synthetic crash fixture"},priority:1});}
const keepAlive=setInterval(()=>{},1000);
await box.drain(async(_destination,_payload,context)=>{context.requestDispatched();process.stdout.write("ready\\n");await new Promise(()=>{});return "ambiguous";},1);
clearInterval(keepAlive);`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/token|secret|password|credential|api[_-]?key|auth|NPM_MEDIA_SERVER/i.test(key) || /^PM_/.test(key)) delete env[key];
  const child = spawn(process.execPath, process.versions.bun ? ["--eval", source] : ["--input-type=module", "--eval", source], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Crash producer did not reach dispatch.")), 60000);
      let stdout = "";
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); if (stdout.includes("ready\n")) resolve(); });
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Crash producer exited before dispatch: ${stderr}`)));
    });
  } finally {
    clearTimeout(timer); child.kill("SIGKILL"); await closed;
  }
}

/** Capture every owned runtime file and directory, including permissions; reads never normalize stored bytes. */
function snapshot(directory: string): unknown[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = join(directory, entry.name);
    return [entry.name, statSync(file).mode, entry.isDirectory() ? snapshot(file) : readFileSync(file)];
  });
}

/** Assert each operation against one immutable baseline and restore exact permissions even when a regression fails. */
export async function withObservationalOutbox(pmRoot: string, run: (unchanged: () => void) => Promise<void>): Promise<void> {
  const directory = join(pmRoot, "runtime", "slack-outbox"); const file = join(directory, "delivery.sqlite");
  const directoryMode = statSync(directory).mode & 0o777; const fileMode = statSync(file).mode & 0o777;
  try {
    chmodSync(file, 0o400); chmodSync(directory, 0o500);
    const before = snapshot(directory); const mode = statSync(directory).mode;
    await run(() => {
      assert.equal(statSync(directory).mode, mode, "observation must preserve the runtime directory permissions");
      assert.deepEqual(snapshot(directory), before, "observation must preserve every outbox byte, file and permission, including unfinished recovery evidence");
    });
  } finally { chmodSync(directory, directoryMode); chmodSync(file, fileMode); }
}
