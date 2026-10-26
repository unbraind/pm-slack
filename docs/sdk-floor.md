# Published pm SDK capability floor

Audited main: `e23ecfe839fbb85c55e47a1cd325abf153593d4d`. Required API floor: **2026.9.8**.

Declared host floor: `2026.10.15`. npm peer: `>=2026.10.15`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: getActiveExtensionRegistrations` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: getItemPath` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: isTimestampLiteral` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: listMutationEvents` | 2026.7.25 | 2026.7.24 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: readHistorySnapshot` | 2026.9.8 | 2026.9.7 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: replayHistoryToTarget` | 2026.7.15 | 2026.7.14 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [index.ts:35](../index.ts#L35) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [index.ts:35](../index.ts#L35) |
| `AfterCommandHookContext.ok` | 2026.5.1 | 2026.3.12 | [index.ts:2127](../index.ts#L2127) |
| `AfterCommandHookContext.result` | 2026.5.1 | 2026.3.12 | [index.ts:1769](../index.ts#L1769) |
| `BeforeCommandHookContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:1762](../index.ts#L1762) |
| `BeforeCommandHookContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:1781](../index.ts#L1781) |
| `BeforeCommandHookContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2129](../index.ts#L2129), [index.ts:2130](../index.ts#L2130), [index.ts:2135](../index.ts#L2135) |
| `CommandHandlerContext.command` | 2026.5.1 | 2026.3.12 | [index.ts:2225](../index.ts#L2225) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:2233](../index.ts#L2233), [index.ts:2268](../index.ts#L2268), [index.ts:2269](../index.ts#L2269), [index.ts:2270](../index.ts#L2270), [index.ts:2271](../index.ts#L2271), [index.ts:2305](../index.ts#L2305) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2273](../index.ts#L2273), [index.ts:2278](../index.ts#L2278), [index.ts:2312](../index.ts#L2312), [index.ts:2328](../index.ts#L2328) |
| `ExtensionApi.hooks` | 2026.5.1 | 2026.3.12 | [index.ts:2117](../index.ts#L2117), [index.ts:2118](../index.ts#L2118) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:2253](../index.ts#L2253), [index.ts:2254](../index.ts#L2254), [index.ts:2290](../index.ts#L2290), [index.ts:2342](../index.ts#L2342), [index.ts:2504](../index.ts#L2504), [index.ts:2610](../index.ts#L2610) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:2221](../index.ts#L2221), [index.ts:2222](../index.ts#L2222) |
| `ExtensionApi.registerRenderer` | 2026.5.1 | 2026.3.12 | [index.ts:2099](../index.ts#L2099), [index.ts:2107](../index.ts#L2107) |
| `RendererOverrideContext.result` | 2026.5.1 | 2026.3.12 | [index.ts:2100](../index.ts#L2100), [index.ts:2108](../index.ts#L2108) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.9.7 | `9befaac9056ce94b2dff006e0fe2329c0b0c18479bf9c9f9027684789387c7ae` |
| 2026.9.8 | `529c08a4cb65507f86dc3f9b7efd673a031c6491156ae753c0a058d0d48e10bc` |
