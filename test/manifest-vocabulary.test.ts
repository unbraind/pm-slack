import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";

const repoRoot = resolve(import.meta.dirname, "..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { devDependencies?: Record<string, string> };
const extensionManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "manifest.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The pm CLI treats the extension manifest vocabulary as a closed set of keys
 * (name, version, entry, priority, description, author, capabilities,
 * manifest_version, pm_min_version, pm_max_version, engines, trusted,
 * provenance, sandbox_profile, permissions, activation, contributions,
 * legacy_capability_aliases). Since pm-cli 2026.8.19, any other top-level
 * manifest.json key produces a `manifest_unknown_key` finding instead of being
 * silently ignored. This repo's manifest carried an inert `"pm":
 * {"compatibility": "v2"}` key that nothing ever read; downstream strict
 * assertions on exact finding-code lists (e.g. unbraind/pm-linear PRs #75 and
 * #76, which expect exactly `["pm_min_version_unmet"]`) broke because the
 * extra key prepended `manifest_unknown_key` to those lists. The key has been
 * removed; this test pins the manifest to the closed vocabulary so any future
 * unknown key fails here first. It also asserts the pinned dev dependency is
 * an exact three-part version, because the check runs with that pin as the
 * effective pm version.
 */
test("the extension manifest uses only keys the pm CLI recognizes", () => {
  const pin = packageJson.devDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(pin, /^\d+\.\d+\.\d+$/, "the pinned CLI version must be an exact three-part version");
  const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: pin });
  const unknownKeyFindings = result.findings.filter((finding) => finding.code === "manifest_unknown_key");
  assert.deepStrictEqual(
    unknownKeyFindings,
    [],
    `manifest.json carries keys outside the closed manifest vocabulary: ${unknownKeyFindings.map((f) => f.path).join(", ")}`,
  );
});
