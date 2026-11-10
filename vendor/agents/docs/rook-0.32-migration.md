# Rook: consuming the 0.32 fork

Status: rows 1-24 were written against the `alex/october-31-refresh` branch
(PR #111) from Rook `origin/main` at `b9467a95991e` (2026-10-31) and applied
in Rook #251. Rows 25-33 (2026-11-08) are still to apply.

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

- **Tarballs.** Done: `rook-sdk-1d0ad5194176` for rows 1-24, then
  `rook-sdk-576d9f3fe35a` with npm `@mcp-b/do-runtime@0.13.1` for rows 25-33,
  then `rook-sdk-19cd4c3db334` with npm `@mcp-b/do-runtime@0.14.0` and
  `@mcp-b/browser-workspace@0.2.0`, which adds messenger channel names (#126).
  Rook needed no source change for that one beyond the pins.
  Keep the old `rook-*` tags, because they back Rook releases.
- **Computer source.** `@cloudflare/computer` comes from npm. 0.8.0 is npm
  `latest`, even though its `publishConfig.tag` says `unreleased`. The fork
  does not vendor it.

## 2. Breakage list

The list has 33 rows. Rows 1-24 are the 0.32 bump; twenty-one break Rook. The other three:

- row 14 compiles unchanged now that the media `read` behaviour is re-ported;
- row 15 was do-runtime-side and has landed;
- row 16 breaks only under decision 3.1 (c).

Row 24 is optional and unproven by a run.

The only upstream removals Rook hits are four names from `agents/skills` and
four from `@cloudflare/think/tools/workspace`. Every other name absent upstream
is fork-only, and the fork keeps it.

### Skills (`54ae3e86`, 0.32)

| #   | Rook site                                                                                                                                             | Change                                                                                                                                                                      | Rook edit                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `extension/src/offscreen/worker/agents/worker-agent.ts:24-26`: three `agents:skills/<dir>` imports, used by `browserThinkSkillSources` at 149-155     | `agents/vite` now throws on any `agents:skills` import                                                                                                                      | Add `bundled-skills.ts` built on `manifest()`. See the recipe below                                                                                                                                                                                    |
| 2   | `extension/src/offscreen/worker/host/vitest.browser.config.ts:35-79, 99`: the `agents-skills-import` shim                                             | No plugin to wrap                                                                                                                                                           | Delete the shim                                                                                                                                                                                                                                        |
| 3   | `delegated-run-agent.ts:3, 87-93`: `new SkillRegistry(...)`, `loadSkill(name)`, `skill.rawContent`                                                    | `loadSkillCatalog(sources)`                                                                                                                                                 | `const catalog = await loadSkillCatalog(this.getSkills())`; then `catalog.find(name)` and throw on a miss; then `formatSkill(entry.skill)`, or `catalog.activate(name)` for the `activate_skill` wrapper. The text changes; see "Delegated runs" below |
| 4   | `browser-runtime/skill-source.ts:3-9` and `fixtures/composer-parity.contract.test.ts:3`: `SkillContent`, `SkillDescriptor`, `SkillResourceDescriptor` | `Skill`, `ListedSkill`, `SkillResourceInfo`, `SkillResource`                                                                                                                | Rename the types                                                                                                                                                                                                                                       |
| 5   | `skill-source.ts`: `listBrowserSkillSummaries` (31-49), `filterSkills` (57-82), `selectSkills` (85-91), `createWorkspaceSkillSource` (204-252)        | A `SkillSource` has `id`, `list()` and `readResource(skill, path)`. There is no `load`, `fingerprint` or `refresh`, and the id comes from `source.id` rather than per skill | See decision 3.2                                                                                                                                                                                                                                       |
| 6   | `composer-parity.contract.test.ts:139-145, 249`                                                                                                       | Same as row 5                                                                                                                                                               | Drop the fingerprint assertion and rebuild the helpers                                                                                                                                                                                                 |
| 7   | `extension/.fallowrc.json:28`: `"agents:skills"`                                                                                                      | The specifier is gone                                                                                                                                                       | Remove the line                                                                                                                                                                                                                                        |
| 8   | `extension/src/offscreen/worker/agent-skills/workspace/SKILL.md:24` calls `readdir` "the `list` tool"                                                 | Think's file tool is now `ls`                                                                                                                                               | Change `list` to `ls`                                                                                                                                                                                                                                  |

**Bundled-skills recipe.** Copy `bundledSkills()` and `isBundledSkillFile()`
from `think/src/browser-tests/skills.test.ts`. That test runs them in a real
browser, together with `manifest()` and the catalog.

- **Glob.** Glob only what can be kept:
  `import.meta.glob(["<dir>/*/SKILL.md", "<dir>/*/{references,scripts,assets,graphics,fonts,templates,rendered-files,illustrations}/**"], { query: "?raw", import: "default", eager: true })`.
  Do not glob `<dir>/**/*`, which is what the fork's test does
  (`think/src/browser-tests/skills.test.ts:132`). An eager `?raw` glob inlines
  every match into the bundle as a string before any runtime filter runs. In
  `workspace-conventions/src` that is the four `<skill>/index.ts` files plus
  the top-level `concepts.ts`, `executions.ts`, `frontmatter.ts`, `paths.ts`,
  `sites.ts`, `skills.ts`, `source.ts`, `concepts.test.ts` and `paths.test.ts`
  (Rook `git ls-tree origin/main packages/workspace-conventions/src`).
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
- **Order.** Sort each manifest's entries by name with `localeCompare`, as the
  0.27 plugin did (`agents/src/vite.ts:341` at `abba5d67`). `manifest()` keeps
  definition order (`agents/src/skills/manifest.ts:132`). A different order
  re-renders the `think_skills` section, and every pre-upgrade conversation
  then gets the perpetual reminder described under "Catalog delivery" below.
- **Binaries.** `?raw` corrupts binary assets. None of Rook's three skill
  directories holds one: `workspace-conventions/src` and
  `extension/src/offscreen/worker/agent-skills` have only `.md` and `.ts`
  files, and `@rook/google-workspace/skills` has only
  `google-workspace/SKILL.md` and `references/sources.md` (as installed). Every
  frontmatter `name` equals its folder.
- **Duplicates and metadata.**
  - `manifest()` silently keeps the first entry with a given name.
  - Nested `metadata` loads with a `SkillWarning`, and the nested key is dropped.
- **Context.** Rook never had compiled 0.27 skills JSON, so this recipe is the
  real migration.

Other effects of the skills change:

- **Re-listing.** Think 0.23 re-lists every skill source on every turn
  (`_refreshSkillsIfChanged`, `think/src/think.ts:6954`, called at 7865).
  Rook's fingerprint plumbing no longer does anything.
- **Catalog delivery.** See below. This one breaks Rook's prefix cache.

**Catalog delivery.** The first catalog is still in the frozen system prompt.
Only a changed catalog travels as a reminder.

- **First catalog.** `_initializeSkills` adds the `think_skills` block with
  `whenChanged: "remind"` (`think.ts:6904-6916`). `freezeSystemPrompt` renders
  it into the stored prompt (`agents/src/context/blocks.ts:415-431`). Rook
  appends to `system` in `beforeTurn` (`worker-agent.ts:664`) and has no
  `getSystemPrompt` override, so ordering there is unaffected.
- **Changed catalog.** After a mid-conversation `/skills` edit, `reminder()`
  returns the new section on every call until `refreshSystemPrompt()` runs
  (`blocks.ts:446-475`). Compaction, clearing history and extension unload
  call it (`think.ts:4142, 5034, 7463`). Think appends the reminder,
  unpersisted, as an extra text part on the last user message
  (`withContextReminder`, `think.ts:1745-1765`, applied at 7916). That happens before
  `beforeTurn` runs (7954).
- **What 0.20.1 did.** It called `context.refreshSystemPrompt()` once, when
  the registry fingerprint changed (`think.ts:6946-6949` at `abba5d67`).
- **Rook impact.** `BrowserThinkConversation.beforeTurn` replays only its own
  `rook_turn_context` blocks (`conversation-agent.ts:351-399`). Turn N's last
  user message carried the reminder. On turn N+1 that message is replayed
  without it, so the rule that each request extends the previous one byte for
  byte fails from that message on. That rule is ADRs 0068 and 0070, now
  archived into 0057 (Rook `docs/adr/README.md`, lines 173 and 175). The
  cache misses on every turn until compaction.
  `turn-context-replay.integration.test.ts:61` never edits skills, so it will
  not catch this.
- **Fix, option 1: record the reminder.** In `beforeTurn`, read
  `await this.context.reminder()` (`context` is protected, `think.ts:3897`).
  When it is not null, store it as the first entry of the `blocks` row for
  that message id. Do not append it again for the current turn, because Think
  already has. Replay it as its own text part, the way `withContextReminder`
  does (`think.ts:1751-1756`). `appendText` joins string content with a blank
  line instead (`conversation-agent.ts:326-330`).
- **Fix, option 2: refresh once.** In `beforeTurn`, when
  `await this.context.reminder()` is not null, call
  `await this.context.refreshSystemPrompt()`. This turn still carries the
  reminder. The next turn has the new catalog in its system prompt and no
  reminder, which costs one full cache miss, as in 0.20.1. This also clears
  the whitespace case below. Option 1 does not.
- **Test.** Add a `/skills` edit between two turns of
  `turn-context-replay.integration.test.ts`.
- **Existing conversations.** A stored prompt matches a block only by its
  exact section text (`blocks.ts:87-90`). The label (`think_skills`), the
  preamble and the description line format are unchanged. The new renderer
  collapses each description's whitespace, though
  (`agents/src/skills/catalog.ts:335`). A user `/skills` description that
  contains a newline or a double space therefore no longer matches the stored
  prompt of a pre-upgrade conversation. Without option 2, that conversation
  then gets the reminder on every turn until compaction. The bundled
  descriptions are safe if the recipe keeps the old order (see "Order"
  above).

**Delegated runs (row 3).** `delegated-run-agent.ts:83-96` appends each
selected skill's `rawContent` to `system`. The changes:

- **No exact replacement.** No 0.32 API reproduces those bytes.
  `formatSkill` re-serializes the frontmatter as YAML
  (`agents/src/skills/markdown.ts:118-135`), and `catalog.activate` renders
  the activation form.
- **Keeping the bytes.** Keep the raw `SKILL.md` strings in
  `bundled-skills.ts`, and read `/skills/<name>/SKILL.md` directly. Each run
  is a single turn, so only snapshots and evals see the difference.
- **Activation form.** `<skill_content name="…">` plus a
  `<skill_resources>` list (`catalog.ts:340-365`). The 0.27 `activate_skill`
  output carried a `version` attribute and a trailing "Bundled resources:"
  section (`agents/src/skills/registry.ts:49-67, 447-452` at `abba5d67`;
  Rook's `docs/context-snapshot.md:1417` shows it). The new form adds a
  `location` attribute only when the source sets `ListedSkill.location`
  (`agents/src/skills/source.ts:58`). `workspace()` sets it to
  `<root>/<dir>` (`workspace.ts:103`); `manifest()` never does.
- **Duplicate listing.** A Rook-side `loadSkillCatalog` in `beforeTurn`
  repeats Think's own per-turn listing (`think.ts:7865`), which is two `/skills`
  OPFS scans per turn. Load the catalog once per task and cache it; the
  selection is fixed once `#task` is set.
- **No skills selected.** The system prompt now contains
  "No skills are available." (`think.ts:6915`). 0.20.1 rendered nothing,
  because `registry.systemPrompt()` returned null (`registry.ts:296-314` at
  `abba5d67`).

### Workspace (Think 0.21-0.22: `8c720d3b`, `998ae40e`, `361046e4`)

| #   | Rook site                                                                                                                                                                                       | Change                                                                                                                                          | Rook edit                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | `WorkspaceLike` type imports in `browser-runtime/skill-source.ts:1`, `browser-runtime/tools.ts:1`, `site-index.ts:1`, `execution/ledger.ts:1` and `fixtures/composer-parity.contract.test.ts:4` | `@cloudflare/think/tools/workspace` is removed                                                                                                  | `import type { WorkspaceFsLike as WorkspaceLike } from "@cloudflare/shell"`; Shell's type is a superset                                   |
| 10  | `createWorkspaceTools` in `fixtures/test-think-agents.ts:3,166` and `host/fixtures/browser/mcp-context.integration.test.ts:6,47`                                                                | `createAITools({ workspace })` from `@cloudflare/computer/tools/ai-sdk`, which takes a workspace with `.fs`                                     | Drop the spread in test-think-agents, because Think already adds the tools. In mcp-context, call `createAITools({ workspace }).read`      |
| 11  | `createReadTool` in `fixtures/read-tool-model-output.contract.test.ts:15` and `host/fixtures/provider-media.integration.test.ts:1,15`                                                           | The fork's gated read is now `createWorkspaceReadTool({ workspace, acceptsImages, acceptsPdfs, pdfText })`, exported from `@cloudflare/think`   | Retarget the tests. The expectation changes are listed below                                                                              |
| 12  | `worker-agent.ts:399` `ModelWorkspace`; `browser-runtime/tools.ts:66-123`; `root-agent.ts:402`; `think-app/workspace/browser-workspace.ts:31` (no `.fs`)                                        | Think declares `workspace: ThinkWorkspace`, which needs `.fs` with `readFile`, `writeFile`, `mkdir`, `rm`, `stat`, `readdir`, `find` and `grep` | Add `get fs()` on `BrowserWorkspace`. Budget roughly 150-250 lines plus a contract test (an estimate). The adapter requirements are below |
| 13  | `worker-agent.ts:404` `override workspaceBash = false`                                                                                                                                          | The member is removed                                                                                                                           | Delete the line. Rook's own `bash` tool stays                                                                                             |
| 14  | `worker-agent.ts:408-410` `workspaceAcceptsImages`, `workspaceAcceptsPdfs`, `workspacePdfText = extractPdfText`                                                                                 | The fork keeps all three. They gate Computer's `read` through `withWorkspaceReadMedia`                                                          | None. They compile unchanged                                                                                                              |
| 15  | do-runtime examples (`think-probe.ts`, `vibe-platform/main.ts:568`)                                                                                                                             | —                                                                                                                                               | Done in do-runtime                                                                                                                        |
| 16  | `worker-agent.ts:1218` `new WorkspaceFileSystem(this.workspace)`                                                                                                                                | —                                                                                                                                               | Breaks only under decision 3.1 (c)                                                                                                        |

**`.fs` adapter requirements.** Computer's tools read a 512-byte prefix and
then bounded ranges.

- **Contract.** The type is `ThinkWorkspaceFilesystem`, a `Pick` of eight
  methods of Computer's `WorkspaceFilesystem`
  (`think/src/workspace-files.ts:8-18`).
  Their signatures are in `@cloudflare/computer@0.8.0`
  `dist/shared-BbpnqJrh.d.ts:24-164`.
- **Callers.** The adapter is driven by Computer's file store
  (`dist/shared-YMPmP_Qz.js`), its `find`, `grep` and `ls` executors
  (`dist/shared-CbahGQgi.js:591-709`) and Think's own `WorkspaceFiles`
  (`think/src/workspace-files.ts:114-161`).
- **Rook's conventions.** Rook's `BrowserWorkspace` follows Shell's
  conventions: `stat` and `readFile` return `null` for a missing path,
  `FileInfo` has `type` and `updatedAt` but no `mode` or `inode`, and
  `writeFile` takes a string only (`shell/src/filesystem.ts:123-132, 517, 543`;
  `browser-workspace.ts:47-182`). Every method below needs translation.

| Method                                                                                 | What the callers rely on                                                                                                                                                                                                                                                                                                                                                                            | Mapping onto `BrowserWorkspace`                                                                                                                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readFile(path, options?)`                                                             | Must return a `ReadableStream<Uint8Array>`, with or without a range: the store calls `.getReader()` on both the whole-file read and the ranged read (`shared-YMPmP_Qz.js:25, 41-44, 64-65`). A range may omit `byteLength`, meaning to the end of the file (`shared-CbahGQgi.js:1071`). The type has five overloads, including `"utf8"` forms that return a string (`shared-BbpnqJrh.d.ts:142-150`) | `readFileRange(path, offset, length)` when `byteLength` is set, otherwise `readFileBytes`; wrap the bytes in a one-chunk stream; throw ENOENT on `null`         |
| `stat(path)`                                                                           | The type requires `{ name, inode, mode, mtime, size, isFile, isDirectory, isSymbolicLink }` (`shared-BbpnqJrh.d.ts:115-124`). The store reads `isFile`, `size`, `mtime` and `mode`, and treats a non-file as missing (`shared-YMPmP_Qz.js:9-22`). Think's legacy media re-read uses `size` (`think/src/workspace-read.ts:329-330`)                                                                  | `stat`, then `mtime = updatedAt`, `inode = 0`, and a synthesized `mode` (for example `0o644`). Throw ENOENT on `null`                                           |
| `readdir(path, { limit, offset })`                                                     | Returns `{ name, parentPath, size, mtime, isFile, isDirectory, isSymbolicLink }[]` (`shared-BbpnqJrh.d.ts:77-85`). `ls` asks for `limit + 1` entries to detect another page (`shared-CbahGQgi.js:682-689`), so `limit` and `offset` must be honoured                                                                                                                                                | `readDir(path, { limit, offset })`, mapping `type` and `updatedAt`                                                                                              |
| `find(dir, pattern?, { limit, offset, exclude })`                                      | Returns `{ path, type: "file" \| "dir" }[]` and pages the same way (`shared-CbahGQgi.js:596-600`). `exclude` globs prune whole subtrees (`shared-BbpnqJrh.d.ts:28-40`)                                                                                                                                                                                                                              | `glob` (`browser-workspace.ts:228`), then filter, slice and map the types                                                                                       |
| `grep(pattern, path, { ignoreCase, regex, context, include, exclude, limit, offset })` | Returns `{ path, line, text, context? }[]`, where `context` holds the surrounding lines with `isMatch` (`shared-BbpnqJrh.d.ts:41-72`). The query is literal unless `regex` is set (`shared-CbahGQgi.js:636-652`)                                                                                                                                                                                    | A glob plus read loop that implements all seven options. This is most of the code                                                                               |
| `writeFile(path, content, { mode?, exclusive? })`                                      | `content` may be a string, a `Uint8Array` or a `ReadableStream` (`shared-BbpnqJrh.d.ts:125-130`). Computer's write and edit tools send `Uint8Array` with `{ mode }` (`shared-CbahGQgi.js:520, 1317`)                                                                                                                                                                                                | Route to `this.writeFileBytes`, `this.writeFile` or `this.writeStreamAtomic`, all guarded in `ModelWorkspace` (`browser-runtime/tools.ts:72-95`); ignore `mode` |
| `mkdir(path, { recursive })`                                                           | Every store write first runs `mkdir(parent, { recursive: true })` (`shared-YMPmP_Qz.js:31-33, 89-94`), so it must succeed when the parent already exists                                                                                                                                                                                                                                            | `this.mkdir`. See the guard note below                                                                                                                          |
| `rm(path, { recursive, force })`                                                       | The delete tool always passes `force: true`, so a missing path must not throw (`shared-CbahGQgi.js:71-79`)                                                                                                                                                                                                                                                                                          | `this.rm`                                                                                                                                                       |

- **Missing paths.** Throw an error with `code: "ENOENT"`. Computer also
  accepts `/ENOENT|no such/` in the message (`shared-YMPmP_Qz.js:95-100`).
- **Guards run on the parent first.** Call `this.writeFile`, `this.mkdir` and
  `this.rm` virtually, so `ModelWorkspace`'s guards still apply. Because of
  the parent `mkdir`, the mkdir guard (`assertModelWrite(parent)`,
  `tools.ts:97-100`) runs before the file guard.
  - `/mcp` is read-only. `McpWorkspace.mkdir` throws `EROFS`
    (`think-app/workspace/mcp-workspace.ts:94-96, 103`), so a write into `/mcp`
    fails with that message rather than the file guard's message. That is the
    right outcome, but check the e2e expectations.
  - Confirm that `assertModelWrite` gives the same answer for a run-record
    directory as for a file inside it.
- **Error results.** The read executor's
  `{ error: "File not found: …" }` shape is unchanged (see below).
- **Size.** Most of the adapter's 150-250 lines go to `grep` (all seven
  options) and to `find` and `readdir` paging. Back it with a contract test
  run over OPFS, a local folder and `/mcp`.

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

| #   | Rook site                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rook edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | `pnpm-workspace.yaml:13-16`: MCP client 2.0.0, core 2.0.0, SDK 1.30.0, server 2.0.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Agents 0.32 requires client 2.4.0 exactly. SDK 1.32.2 and server 2.4.0 are optional peers                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Bump to client 2.4.0, core 2.4.0, SDK 1.32.2, server 2.4.0. The fork's `minimumReleaseAgeExclude` lists all four, so core 2.4.0 is published. None needs a Rook entry: client, core and server 2.4.0 and SDK 1.32.2 were published on 2026-10-23 (npm `time`), past pnpm 11's default one-day minimum. Rook pins `pnpm@11.9.0` (`package.json:28`) and sets only `minimumReleaseAgeExclude` (`pnpm-workspace.yaml:100`)                                                          |
| 19  | `pnpm-workspace.yaml:11, 26-30, 58-62`: `rook-sdk-abba5d67d9d6` tarballs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `rook-sdk-1d0ad5194176` with agents 0.32.0, Think 0.23.0, Shell 0.5.0, AI Chat 0.12.2, Codemode 0.5.6; `@mcp-b/do-runtime` 0.13.0 on npm                                                                                                                                                                                                                                                                                                                                                                                                                             | Swap URLs and file names. Add the new `@mcp-b/do-runtime` version to `minimumReleaseAgeExclude`                                                                                                                                                                                                                                                                                                                                                                                  |
| 20  | `cli/package.json:45, 50` hardcodes the agents and Codemode tarball URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Bump both, or switch them to `catalog:`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 21  | `extension/package.json` has no `@cloudflare/computer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Think 0.23 requires `@cloudflare/computer ^0.8.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Add `"@cloudflare/computer": "catalog:"` with catalog `0.8.0`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 22  | `companion/package.json:22`, `think-app/package.json:41`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same peer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Add `@cloudflare/computer`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 23  | `host/vitest.browser.config.ts:270-291` `optimizeDeps.include`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Think imports `@cloudflare/computer`; `agents/skills` imports `yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Add `@cloudflare/computer`, `@cloudflare/computer/tools/ai-sdk` and `yaml`. Without them, the browser lane re-optimises mid-run and reloads                                                                                                                                                                                                                                                                                                                                      |
| 24  | `host/vite-aliases.ts` `actorAwaitTransformInclude`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Computer's code may await actor storage across a gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Optional, for parity. The fs executors moved from `think/dist`, which the list covers (`vite-aliases.ts:30`), to `@cloudflare/computer/dist`, which it does not. They await only the `.fs` adapter, which is OPFS I/O, and their own in-memory file locks (`shared-CbahGQgi.js:5-30`). Add `**/node_modules/@cloudflare/computer/dist/**` anyway, and treat a lost lock in the browser lane as the signal                                                                        |
| 25  | `@cloudflare/shell/browser` imports: `packages/think-app/workspace/browser-workspace.ts:18` and `packages/think-app/workspace/opfs-workspace.ts:1` (`OpfsWorkspace`), `packages/think-app/workspace/local-folder-workspace.ts:1` (`DirectoryHandleWorkspace`), `packages/extension/src/offscreen/worker/execution/bash-filesystem.ts:1` (`WorkspaceFileSystem`), `packages/extension/src/offscreen/worker/host/fixtures/browser/workspace-performance.performance.test.ts:2` (type `OpfsWorkspace`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Shell no longer has `./browser`; the code moved unchanged to `@mcp-b/browser-workspace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Import from `@mcp-b/browser-workspace`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 26  | `@cloudflare/shell/paths` imports: `packages/extension/src/offscreen/worker/browser-runtime/starter-workspace.ts:2`, `packages/extension/src/offscreen/worker/execution/bash-filesystem.ts:12`, `packages/extension/src/offscreen/worker/execution/bash-tool.ts:7`, `packages/extension/src/offscreen/worker/fixtures/composer-parity.contract.test.ts:15`, `packages/extension/src/offscreen/worker/fixtures/execution-ledger.contract.test.ts:7`, `packages/extension/src/offscreen/worker/fixtures/memory-workspace.ts:2`, `packages/think-app/app/composer-parity.tsx:10`, `packages/think-app/app/local-folder-mounts.ts:4`, `packages/think-app/app/workspace-concepts/projects.tsx:17`, `packages/think-app/contracts/contracts.ts:52`, `packages/think-app/contracts/workspace/execution-table.ts:3`, `packages/think-app/host/local-folder-mounts.ts:1`, `packages/think-app/workspace/browser-workspace.ts:1, 4, 21`, `packages/think-app/workspace/local-folder-workspace.ts:17`, `packages/think-app/workspace/mcp-workspace.ts:3`, `packages/think-app/workspace/opfs-workspace.ts:2`, `packages/think-app/workspace/working-context.ts:3`, `packages/think-app/workspace/workspace-filesystem.ts:7` | Shell no longer has `./paths`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Import from `@mcp-b/browser-workspace/paths`; every imported name, including `validateReadRange`, is exported there                                                                                                                                                                                                                                                                                                                                                              |
| 27  | `@cloudflare/shell/browser/native-file-system` imports: `packages/extension/src/offscreen/worker/host/fixtures/browser/workspace-filesystem.integration.test.ts:6`, `packages/think-app/workspace/browser-workspace.ts:10`, `packages/think-app/workspace/local-folder-workspace.ts:4`, `packages/think-app/workspace/mcp-workspace.ts:11`, `packages/think-app/workspace/native-file-system.ts:2`, `packages/think-app/workspace/opfs-workspace.ts:3`, `packages/think-app/workspace/storage-layout.ts:1`, `packages/think-app/workspace/workspace-filesystem.ts:3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Shell no longer has `./browser/native-file-system`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Import from `@mcp-b/browser-workspace/native-file-system`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 28  | `WorkspaceFileSystem` from plain `@cloudflare/shell`: `packages/extension/src/offscreen/worker/agents/worker-agent.ts:72`, `packages/extension/src/offscreen/worker/connectors/github.ts:2` (type), `packages/extension/src/offscreen/worker/host/fixtures/browser/git-workspace.integration.test.ts:3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Shell's root export is upstream's basic adapter again: no `readFileRange`, no native `appendFileBytes`, and a `readdir` that neither follows intermediate symlinks nor consumes every page. It still compiles                                                                                                                                                                                                                                                                                                                                                        | Import it from `@mcp-b/browser-workspace`, so the worker's Git and file tools keep the fork's adapter                                                                                                                                                                                                                                                                                                                                                                            |
| 29  | `implements WorkspaceFsLike` (from `@cloudflare/shell`) on `packages/think-app/workspace/browser-workspace.ts:33`, `packages/think-app/workspace/local-folder-workspace.ts:33` and `packages/think-app/workspace/mcp-workspace.ts:18`, all of which implement `readFileRange` and `appendFileBytes`; `packages/think-app/workspace/workspace-filesystem.ts:189, 195, 307` calls `readFileRange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shell's `WorkspaceFsLike` no longer declares the two optional methods, and `WorkspaceFileSystem`'s constructor takes `RangeWorkspaceFsLike`, so `packages/extension/src/offscreen/worker/execution/bash-filesystem.ts` (constructor and `createBashFileSystem` parameter) stops compiling. The design system's `WorkspaceSource` is `WorkspaceFsLike & Pick<Workspace, "getWorkspaceInfo">`, so `packages/think-app/host/think-host.ts` no longer derives a `workspaceReadFileRange` callable from it and `packages/companion/src/think-host.ts` fails to type-check | Implement `RangeWorkspaceFsLike` from `@mcp-b/browser-workspace` instead, type `bash-filesystem.ts` against it, and declare `HostWorkspaceSource = WorkspaceSource & Pick<RangeWorkspaceFsLike, "readFileRange">` in `think-host.ts` for the callable derivation and the companion's remote source                                                                                                                                                                               |
| 30  | `packages/extension/src/offscreen/worker/host/vitest.browser.config.ts:283-284, 286` `optimizeDeps.include` lists `@cloudflare/shell/browser`, `@cloudflare/shell/browser/native-file-system` and `@cloudflare/shell/paths`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Those entry points no longer exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Replace them with `@mcp-b/browser-workspace`, `@mcp-b/browser-workspace/native-file-system` and `@mcp-b/browser-workspace/paths`                                                                                                                                                                                                                                                                                                                                                 |
| 31  | `packages/extension/src/offscreen/worker/host/vite-aliases.ts:26-38` `actorAwaitTransformInclude` lists `"**/node_modules/@cloudflare/think/dist/**"` and `"**/node_modules/@cloudflare/computer/dist/**"` but not Shell's dist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The code now runs from `@mcp-b/browser-workspace/dist` inside actors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Leave it out, as it was while the code lived in `@cloudflare/shell/dist`. Its OPFS operations await inside Web Locks callbacks, and gating them deadlocked delegated-run startup in Rook (#128)                                                                                                                                                                                                                                                                                  |
| 32  | `pnpm-workspace.yaml:26-30, 58-62` tarball catalog and overrides; `packages/think-app/package.json` and `packages/extension/package.json`; `packages/cli/package.json:45, 50` pins the `agents` and `@cloudflare/codemode` tarball URLs directly, and `docs/upstream-diff.md:20` and `docs/release-upgrade.md:16` name the release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The `rook-sdk-576d9f3fe35a` pre-release carries one more tarball, `mcp-b-browser-workspace-0.1.0.tgz`, which takes `@cloudflare/shell` as a peer dependency for types only                                                                                                                                                                                                                                                                                                                                                                                           | Swap URLs as in row 19 and add `@mcp-b/browser-workspace` to the catalog and overrides, plus `"@mcp-b/browser-workspace": "catalog:"` in both packages. A stale import of the three removed Shell entry points fails at build time instead of resolving silently. Update the CLI's direct URLs and the two docs too: CI's "Validate repository policy" step (`scripts/validate-workflows.mjs`) fails when `packages/cli/package.json` names a different release than the catalog |
| 33  | Rook docs naming the old specifiers: `docs/architecture.md:1259, 1288`, `docs/prior-art.md:56, 110, 112`, `docs/adr/0006-direct-opfs-decision-gate.md:26`, `docs/future/webmcp-toolbox-site.md:177`, `docs/shim-surface.md:100`; comments in `packages/think-app/workspace/virtual-path.ts:6, 10-11`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Same move                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Name `@mcp-b/browser-workspace` and its `/paths` and `/native-file-system` entries                                                                                                                                                                                                                                                                                                                                                                                               |

Rows 25-33 apply to the first SDK bump after the browser filesystem moved from
Shell to the fork-owned `@mcp-b/browser-workspace` (do-runtime #120, released
as npm `@mcp-b/do-runtime@0.13.1` plus `rook-sdk-576d9f3fe35a`). Their Rook sites come from Rook `4893fce9`,
with paths from the repository root. Applied in Rook `alex/sdk-0-32` (PR #251) as `e5a2f773` and `800a9b22` on 2026-11-08; the glob contract test needed no change because it pins Rook's port against Computer's dialect, not Shell's.

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
- **`node:fs`.** The example has no `node:fs` alias, and the
  node-stdlib-browser spread (`vite.config.ts:137-142`) covers only `crypto`,
  `buffer`, `stream` and `events`. Vite externalizes the import for the browser
  build, so `fs` resolves to a stub that warns and throws on first property
  access (`dist/think-probe.js` carries the `vite-browser-external` marker).
  Computer's main entry imports `node:fs`
  twice, `node:crypto` three times, `node:events` twice and `node:zlib` once
  (grep of `@cloudflare/computer@0.8.0/dist`); the browser code path never
  calls into `fs`, so the stub is never touched. Rook already maps `node:fs`
  to `shims/node-fs.ts`, `node:crypto` to crypto-browserify and `events` to
  node-stdlib-browser.
- **`node:zlib` (closed).** Rook covers it. `node:zlib` and `node:events` map to
  node-stdlib-browser (`host/vite-aliases.ts:55, 65`, expanded at 66-69),
  `node:fs` maps to `shims/node-fs.ts` (`vite-aliases.ts:100`) and
  `node:crypto` to crypto-browserify (`vite-aliases.ts:142`). The shim
  re-exports `unenv/node/fs` (`shims/node-fs.ts:3`), which covers the
  `existsSync`, `readFileSync`, `readdirSync` and `statSync` imports in
  Computer's `dist/index.js:14`.
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
- **Release ages.** `@cloudflare/computer@0.8.0` was published on
  2026-10-26 and its one dependency, capnweb 0.10.0, on 2026-07-07 (npm
  `time`). Neither needs a `minimumReleaseAgeExclude` entry. The only new entry
  is the `@mcp-b/do-runtime` tarball version (row 19).
- **SQLite schema.** Agents and Think add no `cf_*` tables and no columns
  (`CREATE TABLE` and `ALTER TABLE … ADD COLUMN` statements diffed between
  `abba5d67` and HEAD). The only schema change is ThinkHarness's: its three
  `cf_think_harness_{sessions,operations,tool_calls}` tables are now legacy
  and replaced by the `cf_think_harness_store_` prefix
  (`agents/src/harness/think/records.ts:113-118`). Rook never uses
  ThinkHarness, so its objects never created those tables.

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
  and `WorkspaceFileSystem`. OPFS, local folders and `WorkspaceFileSystem`
  now come from `@mcp-b/browser-workspace` (rows 25-29). The `prepareModel` and `workspaceAccepts*` policy
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
  - `list()` returns `{ ok: true, value: { skills: ListedSkill[], invalid } }`;
  - `readResource(skill, path)` returns `{ ok: true, value: SkillResource }` or
    `{ ok: false, error: new SkillResourceNotFoundError(skill, path) }`.
  - Write these as object literals. The `ok()` and `err()` helpers are
    `@internal` (`agents/src/skills/result.ts:14-23`), and `agents/skills`
    exports only `type SkillResult` (`agents/src/skills/index.ts:31`).
  - `filterSkills` and `selectSkills` become a wrapper that filters
    `list().value.skills`.
- **`/skills` (alternative).** Upstream's `workspace(target, { root: "/skills", id })`.
  - `target.fs` needs `find(dir, pattern?, { exclude? })` and
    `readFile(path) → ReadableStream<Uint8Array>`.
  - This drops Rook's agent-skills-ts-sdk validation.
- **Cache the `/skills` listing.** Either source is listed on every turn, which
  means an OPFS scan per turn. Key the cache on directory mtime or the set of
  `SKILL.md` files. A delegated run that also loads its own catalog in
  `beforeTurn` scans twice per turn; see "Delegated runs" in section 2.
- **No script runner.** `run_skill_script` does not exist, and scripts stay
  readable through `read_skill_resource`. No Rook source or bundled skill names
  `run_skill_script` (`git grep` on Rook `origin/main`, plus the installed
  `@rook/google-workspace/skills`). The bundled skills run scripts through
  Rook's own `execute` tool by path instead
  (`agent-skills/skill-creator/references/scripts.md:5`). User skills in
  `/skills` cannot be checked from the repository.

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

| Feature                                                                                | Upstream               | Runs in Rook today?                                                                                         | Why                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat recovery sealing and the `onExhausted` reason                                     | `05843e42`             | Yes, with the fork's hoist and filter                                                                       | A turn that keeps dying on offscreen teardown stops looping and burning tokens. This is the highest value item                                |
| Skills catalog: live re-listing, `read_skill_resource`, `manifest()`/`workspace()`     | `54ae3e86`             | Yes. `r2()` is not useful                                                                                   | Skills written into `/skills` appear next turn without fingerprint plumbing. Take it with the prefix fix under "Catalog delivery" (section 2) |
| Computer workspace tools: paged `read` with `nextOffset`, plus `ls`, `find` and `grep` | `8c720d3b`, `998ae40e` | Yes over the `.fs` adapter. `exec` and `publish` need a Computer runtime backend (UNVERIFIED for just-bash) | Large files stop blowing the context; native find and grep replace model-written loops                                                        |
| Codemode pending tool-call release; output schemas in generated types                  | `d6606fd5`, `7945da9c` | Yes, with the tarball                                                                                       | Stopped runs stop leaving tool calls pending; typed outputs help first-try code                                                               |
| Lifecycle startup fallback alarm                                                       | `f4045474`, `fc4cd249` | Yes                                                                                                         | Scheduled and long-running work resumes more reliably after eviction                                                                          |
| OpenTelemetry bridge                                                                   | `34cbd305`, `df85805e` | UNVERIFIED. It needs `nativeTracing` and the ALS `snapshot()` shim, neither of which has run                | Per-turn traces for diagnostics. Prove it in do-runtime first                                                                                 |
| MCP Client ID Metadata Documents                                                       | `a2d371ec`             | UNVERIFIED. It needs a hosted HTTPS metadata document and an `addMcpServer` option                          | Fewer orphaned dynamic client registrations                                                                                                   |
| `sideEffects` tree-shaking                                                             | `08747d9a`             | Yes, automatically                                                                                          | May offset the Computer bundle growth                                                                                                         |
| `agents/webfetch`, `agents/websearch`                                                  | 0.28                   | No. They need `env.AI` and AI Gateway, and `redirect: "manual"` yields `opaqueredirect` in a browser        | Rook reads pages through the real browser                                                                                                     |
| browserTool, Browser Run, `internalHosts`                                              | 0.28-0.31              | No. do-runtime has no Worker Loader transport                                                               | Rook is the browser                                                                                                                           |

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
  - `conversation-agent.ts:351-399` (catalog-delivery fix);
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
  - `mcp-context.integration.test.ts`;
  - `host/fixtures/browser/turn-context-replay.integration.test.ts`: add a
    `/skills` edit between turns (see "Catalog delivery");
  - `host/fixtures/browser/context-snapshot.integration.test.ts`. Its
    `toMatchFileSnapshot` target, the root `docs/context-snapshot.md`
    (test:327), will change. The activation result loses the "Bundled
    resources:" trailer (`docs/context-snapshot.md:1417`). The "Tools" section
    changes with Computer's tools. `list` becomes `ls`, and the file tools'
    descriptions change; compare `find` at `docs/context-snapshot.md:290-294`
    with Computer's `dist/shared-CbahGQgi.js:583`. The skill tools'
    descriptions and schemas are unchanged. The substring assertions at 317
    and 323 (`- correspondence:`, `<skill_content name="correspondence"`)
    still hold;
  - `fixtures/mock-model.ts:196-201, 633-643`, which reads `activate_skill` and
    `read_skill_resource` results. Check these against the 0.32 skill tools.
    They now throw on a miss instead of returning "Skill not found: …" or
    "Resource not found: …" strings
    (`agents/src/skills/tools/ai-sdk.ts:44, 59`; `registry.ts:395-445` at
    `abba5d67`), so a miss reaches the mock as an error result.
    `toolResultText` already accepts `error-text` (`mock-model.ts:1498`), and
    no Rook file matches the old strings.
- **Docs:**
  - `docs/shim-surface.md:78` and `docs/testing.md:186`, which mention
    `agents:skills`;
  - `docs/context-snapshot.md`, regenerated by the snapshot test;
  - `docs/architecture.md`;
  - ADRs 0015 and 0026.

Order:

1. Bump dependencies and install with `vp install`. Expect type errors only in
   the skills and workspace files.
2. Fix the type imports, add the `.fs` adapter, and delete `workspaceBash`.
3. Skills: add `bundled-skills.ts`, migrate `skill-source.ts` and
   `delegated-run-agent.ts`, apply the catalog-delivery fix in
   `conversation-agent.ts`, and delete the vitest shim and the fallow entry.
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
