import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

/**
 * Activate pm-slack through pm's real host engine with the manifest's declared
 * capabilities.
 *
 * This deliberately replaces the hand-rolled `api` doubles these tests used to
 * build. A double accepts every registration unconditionally, so it cannot
 * observe host-side rejection — which is how `--json` flags that shadow a
 * host-owned global stayed green in CI while `slack notify`, `slack test`, and
 * `slack digest` failed to register against a real pm host. The harness runs the
 * same validation the CLI runs, so an invalid registration fails the suite here.
 */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-slack",
    capabilities: ["commands", "hooks", "schema", "preflight"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

test("extension activates cleanly against the real pm host", async () => {
  const ext = await harness();
  assert.strictEqual(ext.name, "pm-slack");
  await ext.deactivate();
});

test("extension registers slack notify, test, and digest commands", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "slack notify" });
  ext.assertCommandContract({ name: "slack test" });
  ext.assertCommandContract({ name: "slack digest" });

  await ext.deactivate();
});

test("extension registers an afterCommand hook", async () => {
  const ext = await harness();

  ext.assertHook({ kind: "after_command" });

  await ext.deactivate();
});

test("extension registers a preflight override", async () => {
  const ext = await harness();

  ext.assertPreflightOverride();

  await ext.deactivate();
});

test("preflight override is scoped to pm-slack's owned command paths", async () => {
  // The override MUST register as a scoped object (commands + run), not a bare
  // function: a global (unscoped) override collides pairwise with every other
  // installed package's preflight override (pm health reports
  // extension_preflight_override_collision). The runtime matches a command
  // against `commands` by exact normalized path, so the array lists the full
  // posting command paths the gate covers (NOT `slack test`, an offline
  // preview).
  const ext = await harness();
  const override = ext.assertPreflightOverride();
  assert.deepEqual(
    override.commands,
    ["slack notify", "slack digest"],
    "preflight override must be scoped to exactly pm-slack's owned posting command paths",
  );
  assert.equal(
    typeof override.run,
    "function",
    "scoped preflight override must expose a run function",
  );
  await ext.deactivate();
});

test("slack notify declares --filter, --channel-override, --template, --format, --dry-run, --thread", async () => {
  const ext = await harness();

  const { flags } = ext.assertCommandContract({
    name: "slack notify",
    flags: ["--filter", "--channel-override", "--template", "--format", "--dry-run", "--thread"],
  });
  const longs = flags.map((flag) => flag.long);
  assert.ok(longs.includes("--filter"), "slack notify has --filter");
  assert.ok(longs.includes("--channel-override"), "slack notify has --channel-override");
  assert.ok(longs.includes("--template"), "slack notify has --template");
  assert.ok(longs.includes("--format"), "slack notify has --format");
  assert.ok(longs.includes("--dry-run"), "slack notify has --dry-run");
  assert.ok(longs.includes("--thread"), "slack notify has --thread");

  await ext.deactivate();
});

test("slack test declares --filter, --channel-override, --template", async () => {
  const ext = await harness();

  const { flags } = ext.assertCommandContract({
    name: "slack test",
    flags: ["--filter", "--channel-override", "--template"],
  });
  const longs = flags.map((flag) => flag.long);
  assert.ok(longs.includes("--filter"), "slack test has --filter");
  assert.ok(longs.includes("--channel-override"), "slack test has --channel-override");
  assert.ok(longs.includes("--template"), "slack test has --template");

  await ext.deactivate();
});

test("slack digest declares --thread and --dry-run", async () => {
  const ext = await harness();

  const { flags } = ext.assertCommandContract({
    name: "slack digest",
    flags: ["--thread", "--dry-run"],
  });
  const longs = flags.map((flag) => flag.long);
  assert.ok(longs.includes("--thread"), "slack digest has --thread");
  assert.ok(longs.includes("--dry-run"), "slack digest has --dry-run");

  await ext.deactivate();
});

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the one command that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});