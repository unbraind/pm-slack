import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { isSlackOfflineCommand, isSlackPostingCommand } from "../index.ts";

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
  // Derive the declared set from the REAL activation registrations, never from a
  // literal repeated here. The previous version of this test compared the scope
  // against a hand-written array and then checked only that each CURRENT scope
  // entry was declared — one direction. Registering another posting command and
  // forgetting the scope left it green, which is precisely the drift this test
  // exists to catch.
  const declaredPaths = [...new Set(ext.activation.registrations.commands.map((c) => c.command))].sort();
  assert.ok(declaredPaths.length > 0, "activation should declare command paths");
  // Partition the declared set with the SAME predicates production uses, so this
  // test cannot hold a second, drifting copy of the posting/offline knowledge.
  // Both classes are named in production; neither is the other's complement, so
  // a declared command in neither class is UNCLASSIFIED rather than silently
  // defaulted to ungated.
  const postingPaths = declaredPaths.filter(isSlackPostingCommand);
  const offlinePaths = declaredPaths.filter(isSlackOfflineCommand);
  const unclassified = declaredPaths.filter(
    (command) => !isSlackPostingCommand(command) && !isSlackOfflineCommand(command),
  );
  assert.deepEqual(
    unclassified,
    [],
    `every declared command must be classified as posting or offline; unclassified: ${unclassified.join(", ")}`,
  );
  // Total partition: every declared path lands in exactly one class and the two
  // classes reconstruct the declared set EXACTLY. A newly declared command that
  // nobody classified fails here rather than passing unnoticed.
  assert.deepEqual(
    [...postingPaths, ...offlinePaths].sort(),
    declaredPaths,
    "every declared command path must be classified as posting or offline",
  );
  // Both directions of the scope relation: the scope EQUALS the posting class.
  // Equality is what closes the finding — a subset check in either direction
  // alone lets one side grow silently.
  assert.deepEqual(
    [...(override.commands ?? [])].sort(),
    postingPaths,
    "preflight override scope must equal the posting class of the declared command set exactly",
  );
  assert.equal(
    typeof override.run,
    "function",
    "scoped preflight override must expose a run function",
  );
  // Bind the scope to the commands pm-slack declares. Narrowing the override
  // to a command list means an entry missing on either side is a command that
  // silently loses its webhook gate, so every scoped path must be a declared
  // command (renames and removals fail here)...
  for (const command of override.commands ?? []) {
    ext.assertCommandContract({ name: command });
  }
  // ...and the only declared-but-omitted path must be the offline preview
  // `slack test`, which must both stay out of the scope and never be gated.
  assert.ok(
    !(override.commands ?? []).includes("slack test"),
    "slack test is an offline preview and must not claim a preflight scope entry",
  );
  // Behavioral half of the binding: run() warns for a scoped posting command
  // with no resolvable webhook (the runtime swallows throws, so the stderr
  // warning is the visible early signal), stays silent for --dry-run previews
  // and for the offline `slack test`, and silent again once a webhook resolves.
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  const hadWebhook = process.env["PM_SLACK_WEBHOOK"];
  const hadRoutes = process.env["PM_SLACK_ROUTES"];
  const preflightCtx = (command: string, options: Record<string, unknown>) => ({
    command,
    args: [],
    options,
    global: {},
    pm_root: process.cwd(),
    decision: {
      enforce_item_format_gate: false,
      run_preflight_item_format_sync: false,
      run_extension_migrations: false,
      enforce_mandatory_migration_gate: false,
    },
  });
  try {
    delete process.env["PM_SLACK_WEBHOOK"];
    delete process.env["PM_SLACK_ROUTES"];
    await ext.runPreflightOverride(preflightCtx("slack notify", {}));
    assert.strictEqual(warnings.length, 1, "slack notify without a webhook must warn");
    await ext.runPreflightOverride(preflightCtx("slack digest", {}));
    assert.strictEqual(warnings.length, 2, "slack digest without a webhook must warn");
    // A --dry-run preview is never gated, including the string-spelled forms a
    // raw argv parse (no camelCase normalization) produces: every truthy
    // spelling silences the gate, every falsy/junk spelling still warns.
    await ext.runPreflightOverride(preflightCtx("slack notify", { "dry-run": true }));
    for (const truthy of ["true", "1", "yes", "on"]) {
      await ext.runPreflightOverride(preflightCtx("slack notify", { "dry-run": truthy }));
    }
    assert.strictEqual(
      warnings.length,
      2,
      "--dry-run previews in every truthy spelling must never warn",
    );
    for (const falsy of ["false", "0", "no", "off", "maybe"]) {
      await ext.runPreflightOverride(preflightCtx("slack digest", { "dry-run": falsy }));
    }
    assert.strictEqual(
      warnings.length,
      7,
      "falsy or unrecognized --dry-run spellings must still warn (not a preview)",
    );
    await ext.runPreflightOverride(preflightCtx("slack test", {}));
    assert.strictEqual(
      warnings.length,
      7,
      "the offline slack test must never warn",
    );
    // Every valid webhook source stays silent: --webhook flag, env var, and a
    // routes-only configuration (route rules may carry their own webhooks).
    await ext.runPreflightOverride(
      preflightCtx("slack notify", { webhook: "https://hooks.slack.com/services/T000/B000/XXXX" }),
    );
    assert.strictEqual(warnings.length, 7, "a --webhook flag must not warn");
    process.env["PM_SLACK_ROUTES"] =
      '[{"match":"close","webhook":"https://hooks.slack.com/services/T000/B000/R000"}]';
    await ext.runPreflightOverride(preflightCtx("slack digest", {}));
    assert.strictEqual(warnings.length, 7, "a routes-only webhook source must not warn");
    delete process.env["PM_SLACK_ROUTES"];
    process.env["PM_SLACK_WEBHOOK"] = "https://hooks.slack.com/services/T000/B000/XXXX";
    await ext.runPreflightOverride(preflightCtx("slack notify", {}));
    assert.strictEqual(warnings.length, 7, "a resolvable webhook must not warn");
    // Malformed webhooks warn: not a URL at all, and a URL with a non-http(s)
    // protocol. Both reach the user via the warning because the runtime
    // swallows the thrown CommandError.
    await ext.runPreflightOverride(
      preflightCtx("slack notify", { webhook: "hooks.slack.com/services/T000/B000/XXXX" }),
    );
    await ext.runPreflightOverride(
      preflightCtx("slack digest", { webhook: "ftp://hooks.example.com/services/T000/B000/XXXX" }),
    );
    assert.strictEqual(
      warnings.length,
      9,
      "a malformed --webhook URL and a non-http(s) protocol must both warn",
    );
    assert.match(warnings[7]!, /not a valid URL/);
    assert.match(warnings[8]!, /http\(s\) URL/);
  } finally {
    console.error = originalError;
    if (hadWebhook === undefined) delete process.env["PM_SLACK_WEBHOOK"];
    else process.env["PM_SLACK_WEBHOOK"] = hadWebhook;
    if (hadRoutes === undefined) delete process.env["PM_SLACK_ROUTES"];
    else process.env["PM_SLACK_ROUTES"] = hadRoutes;
  }
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