# Rook: consuming the 0.32 fork

Status: written against the uncommitted `alex/october-31-refresh` tree. Rook
facts come from Rook `origin/main` at `b9467a95991e` (2026-10-31). Nothing in
Rook has changed yet.

This is the Rook work plan for moving from Agents 0.27.0 / Think 0.20.1 to
Agents 0.32.0 / Think 0.23.0. The SDK side is in
[`audit/agents-sync-2026-10-31.md`](audit/agents-sync-2026-10-31.md).

- **Paths.** Rook paths are relative to Rook's `packages/` unless they start at
  the repository root. SDK paths are under `vendor/agents/packages/`.
- **Unverified claims.** Anything not yet checked against a Rook build is marked
  UNVERIFIED.

Sections:

1. Prerequisites in do-runtime
2. Breakage list
3. Decisions for Rook
4. Features worth taking
5. Rook PR plan and tests

## 1. Prerequisites in do-runtime

These have landed in the refresh tree:

- **Merged tree.** The 0.32 tree is merged, with the hand-ports Rook depends on:
  - the recovery Stop hoist;
  - the `listRecoverableChatRequests` exhausted filter;
  - `prepareModel`, which is kept;
  - the alarm-write input-lock fix;
  - skills without a runner;
  - the media `read` re-port.
- **Examples.** `examples/extension/src/worker/think-probe.ts` drops
  `workspaceBash`, and `examples/vibe-platform/src/main.ts:568` reports
  `0.32.0`.

Still to do before Rook can start:

- **Tarballs.** `pnpm sdk:pack` and a new `rook-sdk-<sha>` tag (TBD). Keep the
  old `rook-*` tags, because they back Rook releases.
- **Computer source.** `@cloudflare/computer` comes from npm. 0.8.0 is npm
  `latest`, even though its `publishConfig.tag` says `unreleased`. The fork
  does not vendor it.

## 2. Breakage list

The list has 24 rows. Twenty-one break Rook. The other three:

- row 14 compiles unchanged now that the media `read` behaviour is re-ported;
- row 15 was do-runtime-side and has landed;
- row 16 breaks only under decision 3.1 (c).

Row 24 is UNVERIFIED.

The only upstream removals Rook hits are four names from `agents/skills` and
four from `@cloudflare/think/tools/workspace`. Every other name absent upstream
is fork-only, and the fork keeps it.

### Skills (`54ae3e86`, 0.32)

| #   | Rook site                                                                                                                                             | Change                                                                                                                                                                      | Rook edit                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `extension/src/offscreen/worker/agents/worker-agent.ts:24-26`: three `agents:skills/<dir>` imports, used by `browserThinkSkillSources` at 149-155     | `agents/vite` now throws on any `agents:skills` import                                                                                                                      | Add `bundled-skills.ts` built on `manifest()`. See the recipe below                                                                                                                                      |
| 2   | `extension/src/offscreen/worker/host/vitest.browser.config.ts:35-79, 99`: the `agents-skills-import` shim                                             | No plugin to wrap                                                                                                                                                           | Delete the shim                                                                                                                                                                                          |
| 3   | `delegated-run-agent.ts:3, 87-93`: `new SkillRegistry(...)`, `loadSkill(name)`, `skill.rawContent`                                                    | `loadSkillCatalog(sources)`                                                                                                                                                 | `const catalog = await loadSkillCatalog(this.getSkills())`; then `catalog.find(name)` and throw on a miss; then `formatSkill(entry.skill)`, or `catalog.activate(name)` for the `activate_skill` wrapper |
| 4   | `browser-runtime/skill-source.ts:3-9` and `fixtures/composer-parity.contract.test.ts:3`: `SkillContent`, `SkillDescriptor`, `SkillResourceDescriptor` | `Skill`, `ListedSkill`, `SkillResourceInfo`, `SkillResource`                                                                                                                | Rename the types                                                                                                                                                                                         |
| 5   | `skill-source.ts`: `listBrowserSkillSummaries` (31-49), `filterSkills` (57-82), `selectSkills` (85-91), `createWorkspaceSkillSource` (204-252)        | A `SkillSource` has `id`, `list()` and `readResource(skill, path)`. There is no `load`, `fingerprint` or `refresh`, and the id comes from `source.id` rather than per skill | See decision 3.2                                                                                                                                                                                         |
| 6   | `composer-parity.contract.test.ts:139-145, 249`                                                                                                       | Same as row 5                                                                                                                                                               | Drop the fingerprint assertion and rebuild the helpers                                                                                                                                                   |
| 7   | `extension/.fallowrc.json:28`: `"agents:skills"`                                                                                                      | The specifier is gone                                                                                                                                                       | Remove the line                                                                                                                                                                                          |
| 8   | `extension/src/offscreen/worker/agent-skills/workspace/SKILL.md:24` calls `readdir` "the `list` tool"                                                 | Think's file tool is now `ls`                                                                                                                                               | Change `list` to `ls`                                                                                                                                                                                    |

**Bundled-skills recipe.** Copy `bundledSkills()` and `isBundledSkillFile()`
from `think/src/browser-tests/skills.test.ts`. That test runs them in a real
browser, together with `manifest()` and the catalog.

- **Glob.** Glob each directory with
  `import.meta.glob("<dir>/**/*", { query: "?raw", import: "default", eager: true })`.
- **Filter.** Before building entries, apply the 0.27 plugin's filter. Narrowing
  the glob alone misses ignored names nested under a resource root.
  - Keep `<folder>/SKILL.md`, plus files under `references/`, `scripts/`,
    `assets/`, `graphics/`, `fonts/`, `templates/`, `rendered-files/` and
    `illustrations/`.
  - Skip `.git`, `node_modules`, `.DS_Store` and the other ignored names at any
    depth.
  - Without the filter, the `index.ts` beside `SKILL.md` in
    `workspace-conventions/src/<skill>/` becomes a `kind: "file"` resource and
    shows up in the catalog.
- **Parse.** `parseSkill(markdown, { directory: folder })` gives the manifest
  fields. Kept files become `resources: [{ path, content }]`.
- **Ids.** Keep the old `bundle:<basename(dir)>` ids, so diagnostics stay
  stable.
- **Binaries.** `?raw` corrupts binary assets. Use `?inline`, or keep binaries
  out. UNVERIFIED whether Rook's three skill directories hold any.
- **Duplicates and metadata.**
  - `manifest()` silently keeps the first entry with a given name.
  - Nested `metadata` loads with a `SkillWarning`, and the nested key is dropped.
- **Context.** Rook never had compiled 0.27 skills JSON, so this recipe is the
  real migration.

Two other effects of the skills change:

- **Re-listing.** Think 0.23 re-lists every skill source on every turn
  (`_refreshSkillsIfChanged`). Rook's fingerprint plumbing no longer does
  anything.
- **Catalog delivery.** The catalog now arrives as a reminder block. Rook
  appends to `system` in `beforeTurn` (`worker-agent.ts:664`) and has no
  `getSystemPrompt` override, so ordering is unaffected. The wording the model
  sees changes.

### Workspace (Think 0.21-0.22: `8c720d3b`, `998ae40e`, `361046e4`)

| #   | Rook site                                                                                                                                                                                       | Change                                                                                                                                          | Rook edit                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | `WorkspaceLike` type imports in `browser-runtime/skill-source.ts:1`, `browser-runtime/tools.ts:1`, `site-index.ts:1`, `execution/ledger.ts:1` and `fixtures/composer-parity.contract.test.ts:4` | `@cloudflare/think/tools/workspace` is removed                                                                                                  | `import type { WorkspaceFsLike as WorkspaceLike } from "@cloudflare/shell"`; Shell's type is a superset                              |
| 10  | `createWorkspaceTools` in `fixtures/test-think-agents.ts:3,166` and `host/fixtures/browser/mcp-context.integration.test.ts:6,47`                                                                | `createAITools({ workspace })` from `@cloudflare/computer/tools/ai-sdk`, which takes a workspace with `.fs`                                     | Drop the spread in test-think-agents, because Think already adds the tools. In mcp-context, call `createAITools({ workspace }).read` |
| 11  | `createReadTool` in `fixtures/read-tool-model-output.contract.test.ts:15` and `host/fixtures/provider-media.integration.test.ts:1,15`                                                           | The fork's gated read is now `createWorkspaceReadTool({ workspace, acceptsImages, acceptsPdfs, pdfText })`, exported from `@cloudflare/think`   | Retarget the tests. The expectation changes are listed below                                                                         |
| 12  | `worker-agent.ts:399` `ModelWorkspace`; `browser-runtime/tools.ts:66-123`; `root-agent.ts:402`; `think-app/workspace/browser-workspace.ts:31` (no `.fs`)                                        | Think declares `workspace: ThinkWorkspace`, which needs `.fs` with `readFile`, `writeFile`, `mkdir`, `rm`, `stat`, `readdir`, `find` and `grep` | Add `get fs()` on `BrowserWorkspace`, about 60 lines. The adapter requirements are below                                             |
| 13  | `worker-agent.ts:404` `override workspaceBash = false`                                                                                                                                          | The member is removed                                                                                                                           | Delete the line. Rook's own `bash` tool stays                                                                                        |
| 14  | `worker-agent.ts:408-410` `workspaceAcceptsImages`, `workspaceAcceptsPdfs`, `workspacePdfText = extractPdfText`                                                                                 | The fork keeps all three. They gate Computer's `read` through `withWorkspaceReadMedia`                                                          | None. They compile unchanged                                                                                                         |
| 15  | do-runtime examples (`think-probe.ts`, `vibe-platform/main.ts:568`)                                                                                                                             | —                                                                                                                                               | Done in do-runtime                                                                                                                   |
| 16  | `worker-agent.ts:1218` `new WorkspaceFileSystem(this.workspace)`                                                                                                                                | —                                                                                                                                               | Breaks only under decision 3.1 (c)                                                                                                   |

**`.fs` adapter requirements.** Computer's tools read a 512-byte prefix and
then bounded ranges, so the adapter must:

- honour `readFile(path, { byteOffset, byteLength })` exactly;
- return `stat` with `isFile`, `size`, `mtime` and `mode`;
- throw errors with `code: "ENOENT"` for missing paths;
- call `this.writeFile`, `this.mkdir` and `this.rm` virtually, so
  `ModelWorkspace`'s write guards still apply.

`find` and `grep` map onto `glob` (`browser-workspace.ts:228`) and a read loop.

**Read contract test changes (rows 11 and 14).**

- An image arrives as a `file` part with `mediaType: "image/*"`, not as
  `image-data`.
- Sizes read "N bytes", not "9 B".
- The limit message is Computer's: "exceeds the 3670016-byte inline model
  output limit".
- SVG is read as paged text. HEIC renders as an unsupported binary result. Both
  used to get a "convert" note.
- A declared image or PDF type is checked against the file's first bytes. A
  mismatched image is relabelled, and anything else renders a note.
- The e2e read expectations still hold. They are `application.spec.ts:4850-4860`,
  `browser.spec.ts:722-735` and `webmcp.browser.spec.ts:78, 131-143`: `{content}`
  and `{error: "File not found: <path>"}` are unchanged.

**Behaviour changes that do not break the build.**

- **Old 0.20 media reads.** These results stored no bytes. They are now
  re-read from the file. A file that is no longer readable renders
  `Could not read file bytes: …` as a tool error, and history is untouched. A
  0.20 result recorded over the size limit stays an error.
- **New media reads.** These store base64 `data` in the tool output. Media
  eviction evicts only `data:` URLs, so these bytes stay in history. Watch
  transcript size.
- **Relative paths.** Computer's tools pass a relative path verbatim to Rook's
  `.fs`. Think's host bridge resolves it under `/workspace`. Rook's roots are
  absolute (`/skills`, `/mcp`, `/projects`). See decision 3.4.
- **Unchanged hooks.** `mediaEviction` (`worker-agent.ts:509`) and the
  `prepareModel` override (`worker-agent.ts:579`) are unchanged.

### Recovery (`05843e42`, 0.29)

| #   | Rook site                                                                                                   | Change                                                                                                       | Rook edit            |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| 17  | `conversation-agent.ts:1181-1188`: `onStart` marks every `listRecoverableChatRequests()` entry "recovering" | Upstream seals a turn after `maxInterruptedAttempts` (default 5) with reason `interrupted_attempts_exceeded` | None for correctness |

The fork guarantees two things:

- `listRecoverableChatRequests` skips sealed turns;
- a stopped or cancelled turn is never sealed or reported to `onExhausted`.

The open items are product decisions; see decision 3.3.

### Dependencies and packaging

| #   | Rook site                                                                           | Change                                                                                                                      | Rook edit                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | `pnpm-workspace.yaml:13-16`: MCP client 2.0.0, core 2.0.0, SDK 1.30.0, server 2.0.0 | Agents 0.32 requires client 2.4.0 exactly. SDK 1.32.2 and server 2.4.0 are optional peers                                   | Bump to client 2.4.0, core 2.4.0, SDK 1.32.2, server 2.4.0. The fork's `minimumReleaseAgeExclude` lists all four, so core 2.4.0 is published. Add Rook entries if any is inside the age window |
| 19  | `pnpm-workspace.yaml:11, 26-30, 58-62`: `rook-sdk-abba5d67d9d6` tarballs            | New `rook-sdk-<sha>` tag (TBD) with agents 0.32.0, Think 0.23.0, Shell 0.5.0, AI Chat 0.12.2, Codemode 0.5.6 and do-runtime | Swap URLs and file names. Add the new `@mcp-b/do-runtime` version to `minimumReleaseAgeExclude`                                                                                                |
| 20  | `cli/package.json:45, 50` hardcodes the agents and Codemode tarball URLs            | —                                                                                                                           | Bump both, or switch them to `catalog:`                                                                                                                                                        |
| 21  | `extension/package.json` has no `@cloudflare/computer`                              | Think 0.23 requires `@cloudflare/computer ^0.8.0`                                                                           | Add `"@cloudflare/computer": "catalog:"` with catalog `0.8.0`                                                                                                                                  |
| 22  | `companion/package.json:22`, `think-app/package.json:41`                            | Same peer                                                                                                                   | Add `@cloudflare/computer`                                                                                                                                                                     |
| 23  | `host/vitest.browser.config.ts:270-291` `optimizeDeps.include`                      | Think imports `@cloudflare/computer`; `agents/skills` imports `yaml`                                                        | Add `@cloudflare/computer`, `@cloudflare/computer/tools/ai-sdk` and `yaml`. Without them, the browser lane re-optimises mid-run and reloads                                                    |
| 24  | `host/vite-aliases.ts` `actorAwaitTransformInclude`                                 | Computer's code may await actor storage across a gate                                                                       | UNVERIFIED. Add `@cloudflare/computer/dist` if the browser lane shows a lost lock                                                                                                              |

**Bundler aliases for Computer.** Think's main entry imports `Workspace`
from Computer's main entry (`think/src/think.ts:635`). That pulls in:

- `node:crypto`, `node:events`, `node:fs` and `node:zlib`;
- `cloudflare:workers` (`RpcTarget`, `WorkerEntrypoint`);
- capnweb `^0.10`.

do-runtime's Vite plugin aliases only `cloudflare:workers`, `cloudflare:email`
and `async_hooks`. Rook's bundles therefore need their own aliases.

- **Recipe.** Use `examples/extension/vite.config.ts:127-146`, where the
  journey passes. It maps `crypto`, `buffer`, `stream` and `events` (with and
  without `node:`) to node-stdlib-browser. For the Think probe it maps
  `node:zlib` and `node:stream/promises` to unenv. `browserHost` supplies
  `cloudflare:workers`.
- **`node:fs`.** The example has no explicit `node:fs` alias; it resolves
  through the node-stdlib-browser spread (`vite.config.ts:139-140`), whose
  `fs` entry is `cjs/mock/empty.js`. Computer's main entry imports `node:fs`
  twice, `node:crypto` three times, `node:events` twice and `node:zlib` once
  (grep of `@cloudflare/computer@0.8.0/dist`); the browser code path never
  calls into `fs`, so the empty mock is enough. Rook already maps `node:fs`
  to `shims/node-fs.ts`, `node:crypto` to crypto-browserify and `events` to
  node-stdlib-browser.
- **To check.** Confirm Rook covers `node:zlib`.
- **capnweb.** Computer brings capnweb 0.10 beside Rook's 0.12
  (`pnpm-lock.yaml:3871`). Decide whether to dedupe; see decision 3.5.

**Bundle size (UNVERIFIED until a build).**

- Computer's `index.js` is 265 KB, and `tools/ai-sdk.js` is 4.5 KB.
- Agents now declares `sideEffects: ["./dist/cli.js"]`, which may offset some of
  the growth.
- Re-run the CI core-js guard (`.github/workflows/ci.yml:141-144`) on the zip.

**Unchanged.**

- `@opentelemetry/api`: Rook already pins 1.9.1.
- The `agents()` plugin calls in `wxt.config.ts:274, 293`.

**MCP redirects (`131af4b0`, 0.28.1).** MCP client transports now follow
redirects only within the same origin. A connector added through `addMcpServer`
(`root-agent.ts:696-706`) whose endpoint redirects across origins now fails.
UNVERIFIED whether any current connector does.

## 3. Decisions for Rook

### 3.1 Workspace

The fork follows upstream's Computer `Workspace`. It re-ports the media gates
onto Computer's `read`, so Rook needs no `read` override.

- **(a) A `.fs` adapter on `BrowserWorkspace` (recommended).** This means rows
  9-13 only. Every Shell-based subsystem stays: OPFS, local folders, MCP mounts
  and `WorkspaceFileSystem`. The `prepareModel` and `workspaceAccepts*` policy
  stays where it is.
- **(b) The adapter plus a Rook-side `read` override.** Rook takes over the
  media policy. This is only needed if the fork's `workspace-read.ts` ever goes
  away.
- **(c) Adopt a Computer `Workspace` over do-runtime storage.** This is high
  risk. It drops the OPFS, local-folder and MCP mounts unless they are rebuilt
  as Computer backends.

### 3.2 Skills source

- **Bundled skills:** `manifest()` with the recipe in row 1.
- **`/skills` (recommended).** Keep Rook's validated source, reduced to two
  methods:
  - `list()` returns `ok({ skills: ListedSkill[], invalid })`;
  - `readResource(skill, path)` returns `ok(SkillResource)` or
    `err(new SkillResourceNotFoundError(skill, path))`.
  - `filterSkills` and `selectSkills` become a wrapper that filters
    `list().value.skills`.
- **`/skills` (alternative).** Upstream's `workspace(target, { root: "/skills", id })`.
  - `target.fs` needs `find(dir, pattern?, { exclude? })` and
    `readFile(path) → ReadableStream<Uint8Array>`.
  - This drops Rook's agent-skills-ts-sdk validation.
- **Cache the `/skills` listing.** Either source is listed on every turn, which
  means an OPFS scan per turn. Key the cache on directory mtime or the set of
  `SKILL.md` files.
- **No script runner.** `run_skill_script` does not exist, and scripts stay
  readable through `read_skill_resource`. UNVERIFIED that no Rook skill tells the
  model to run a script; grep the three bundled directories and `/skills` for
  `scripts/`.

### 3.3 Recovery budget and the exhausted UX

Upstream seals a turn after 5 interrupted attempts.

- **What counts.** The original death counts as one attempt, and progress never
  resets the count.
- **Rook's case.** Offscreen teardown, a service-worker restart, an extension
  reload and a laptop sleeping mid-turn each count. Long agentic turns can reach 5.
- **Remaining choices.**
  - The budget:
    - accept 5;
    - set `chatRecovery = { maxInterruptedAttempts: 10, onExhausted }` in
      `worker-agent.ts:483-487`;
    - use `Infinity`, which restores the pre-0.29 behaviour.
  - What a sealed turn shows. Today `onExhausted` calls
    `publishRunning("aborted", requestId)`, and `root-agent.ts:2780` maps that to
    "interrupted". `info.reason` is ignored.
- **Recommendation.** 10, plus a distinct "stopped after repeated
  interruptions" status with Retry. That touches `worker-agent.ts:483-487`,
  `root-agent.ts:2771-2795`, the attention handling at 1317 and the UI that
  renders it (UNVERIFIED file).

### 3.4 Relative paths

Accept upstream's `/workspace` default. Make the soul and skills prompts use
absolute paths. Do not remap `/workspace/x` to `/x` in the adapter, because
that would hide upstream's real semantics. UNVERIFIED whether any e2e path
writes a relative file.

### 3.5 Duplicate capnweb

Accept the second copy for now and measure the bundle. A pnpm override to 0.12
risks Computer's RPC wire format (UNVERIFIED compatibility).

### 3.6 Remote MCP redirects

Accept same-origin-only redirects. List any connector in e2e or staging that
redirects across origins, and point it at its final URL.

## 4. Features worth taking

| Feature                                                                                | Upstream               | Runs in Rook today?                                                                                         | Why                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Chat recovery sealing and the `onExhausted` reason                                     | `05843e42`             | Yes, with the fork's hoist and filter                                                                       | A turn that keeps dying on offscreen teardown stops looping and burning tokens. This is the highest value item |
| Skills catalog: live re-listing, `read_skill_resource`, `manifest()`/`workspace()`     | `54ae3e86`             | Yes. `r2()` is not useful                                                                                   | Skills written into `/skills` appear next turn without fingerprint plumbing                                    |
| Computer workspace tools: paged `read` with `nextOffset`, plus `ls`, `find` and `grep` | `8c720d3b`, `998ae40e` | Yes over the `.fs` adapter. `exec` and `publish` need a Computer runtime backend (UNVERIFIED for just-bash) | Large files stop blowing the context; native find and grep replace model-written loops                         |
| Codemode pending tool-call release; output schemas in generated types                  | `d6606fd5`, `7945da9c` | Yes, with the tarball                                                                                       | Stopped runs stop leaving tool calls pending; typed outputs help first-try code                                |
| Lifecycle startup fallback alarm                                                       | `f4045474`, `fc4cd249` | Yes                                                                                                         | Scheduled and long-running work resumes more reliably after eviction                                           |
| OpenTelemetry bridge                                                                   | `34cbd305`, `df85805e` | UNVERIFIED. It needs `nativeTracing` and the ALS `snapshot()` shim, neither of which has run                | Per-turn traces for diagnostics. Prove it in do-runtime first                                                  |
| MCP Client ID Metadata Documents                                                       | `a2d371ec`             | UNVERIFIED. It needs a hosted HTTPS metadata document and an `addMcpServer` option                          | Fewer orphaned dynamic client registrations                                                                    |
| `sideEffects` tree-shaking                                                             | `08747d9a`             | Yes, automatically                                                                                          | May offset the Computer bundle growth                                                                          |
| `agents/webfetch`, `agents/websearch`                                                  | 0.28                   | No. They need `env.AI` and AI Gateway, and `redirect: "manual"` yields `opaqueredirect` in a browser        | Rook reads pages through the real browser                                                                      |
| browserTool, Browser Run, `internalHosts`                                              | 0.28-0.31              | No. do-runtime has no Worker Loader transport                                                               | Rook is the browser                                                                                            |

## 5. Rook PR plan and tests

About 25 files change:

- **Dependencies:**
  - `pnpm-workspace.yaml` (catalog, a Computer entry, overrides,
    `minimumReleaseAgeExclude`) and `pnpm-lock.yaml`;
  - `cli/package.json:45,50`;
  - the extension, companion and think-app `package.json` files.
- **Config:**
  - `extension/.fallowrc.json:28`;
  - `host/vitest.browser.config.ts` (35-79, 99, 270-291);
  - possibly `host/vite-aliases.ts`;
  - Rook's bundler aliases for Computer's `node:*` imports, if any are missing.
- **Workspace:**
  - `think-app/workspace/browser-workspace.ts`;
  - the four type-import files from row 9;
  - `worker-agent.ts:404`.
- **Skills:**
  - new `agents/bundled-skills.ts`;
  - `worker-agent.ts:24-26, 149-155`;
  - `browser-runtime/skill-source.ts`;
  - `delegated-run-agent.ts:3, 83-97`;
  - `agent-skills/workspace/SKILL.md:24`.
- **Recovery UX:** `worker-agent.ts:483-487` and `root-agent.ts:2771-2795`.
- **Tests:**
  - `composer-parity.contract.test.ts`;
  - `read-tool-model-output.contract.test.ts`;
  - `test-think-agents.ts`;
  - `provider-media.integration.test.ts`;
  - `mcp-context.integration.test.ts`.
- **Docs:**
  - `docs/shim-surface.md:78` and `docs/testing.md:186`, which mention
    `agents:skills`;
  - `docs/architecture.md`;
  - ADRs 0015 and 0026.

Order:

1. Bump dependencies and install with `vp install`. Expect type errors only in
   the skills and workspace files.
2. Fix the type imports, add the `.fs` adapter, and delete `workspaceBash`.
3. Skills: add `bundled-skills.ts`, migrate `skill-source.ts` and
   `delegated-run-agent.ts`, and delete the vitest shim and the fallow entry.
4. Recovery budget and the exhausted status.
5. Tests and docs.

Run these from the Rook root:

- `vp run typecheck`.
- `vp check`.
- `vp run @rook/extension#test:integration-contract`, which covers
  composer-parity, read-tool and the skills fixtures.
- `vp run @rook/extension#test:integration-offscreen`.
- `vp run @rook/extension#test:integration-host`.
- `vp run @rook/extension#test:integration-browser`, which builds with
  `THINK_E2E_HOOKS=1` and runs the provider-media, mcp-context and code-runtime
  lanes.
- `vp run @rook/extension#zip:production`, then the core-js guard
  (`ci.yml:143`), then compare zip and offscreen chunk sizes with main.
- `vp run test:e2e`.
  - Focus on the read specs listed under row 11.
  - Add a recovery scenario: kill offscreen mid-turn more times than the budget
    and expect the exhausted status.
