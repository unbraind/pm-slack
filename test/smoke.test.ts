import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one hook via hooks API", () => {
  const registered: string[] = [];
  const hooksRegistered: string[] = [];
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerHook: () => { registered.push("hook"); },
    registerImporter: () => { registered.push("importer"); },
    registerSchema: () => { registered.push("schema"); },
    registerRenderer: () => { registered.push("renderer"); },
    registerSearchProvider: () => { registered.push("search"); },
    registerPreflight: () => { registered.push("preflight"); },
    registerService: () => { registered.push("service"); },
    hooks: {
      afterCommand: (fn: unknown) => { hooksRegistered.push("afterCommand"); },
      beforeCommand: (fn: unknown) => { hooksRegistered.push("beforeCommand"); },
    },
  };
  extension.activate(api as any);
  const all = [...registered, ...hooksRegistered];
  assert.ok(all.length > 0, `extension should register at least one capability, got: ${JSON.stringify(all)}`);
});
