# Agents 0.32 refresh audit

The fork moves from
[Agents 0.27.0 (`e3351863`)](https://github.com/cloudflare/agents/tree/e335186331f99be12609a5eb0c64c7863c3ccafd)
to
[Agents 0.32.0 (`be174922`)](https://github.com/cloudflare/agents/tree/be1749221ab3efc8be4e976d8e7d8344d1446032).
The range has 121 upstream commits. Each one has a row in the
[commit dispositions](agents-0.32-commit-dispositions.csv), which name the
ledger row or working note behind the call. A row records how the commit landed
in the merged tree. It does not mean the commit was tested on its own.

The packages land as Agents 0.32.0, Think 0.23.0, AI Chat 0.12.2, Voice 0.5.0
(unchanged), Shell 0.5.0 and Codemode 0.5.6. The pin is in
[VENDOR.md](../../VENDOR.md). Think gains a required peer,
`@cloudflare/computer ^0.8.0`, from a separate Cloudflare repository. Computer
0.8.0 is npm `latest`, even though its `publishConfig.tag` says
`unreleased`.

Five releases lie between the two pins:

| Release               | Commit                 | Notes                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------- |
| 0.28.0 / Think 0.20.2 | `48d9c36f`             | web fetch, web search move, pi-durable browserTool                        |
| 0.28.1                | `b1e3614b`             | MCP 2.3.1 / SDK 1.32.1, same-origin MCP redirects                         |
| 0.29.0 / Think 0.21.0 | `fc7f59fb`             | Computer workspace, chat-recovery sealing (#2615)                         |
| 0.30.0, 0.30.1        | `e18c094d`, `a40b8b4a` | Pi 1.4, Lifecycle startup fallback alarm                                  |
| 0.31.0 / Think 0.22.0 | `e4a38e93`             | browserTool without Codemode, `internalHosts`, optional MCP peers         |
| 0.32.0 / Think 0.23.0 | `be174922`             | skills rewrite (breaking), `sideEffects`, OpenTelemetry bridge, MCP 2.4.0 |

## Dispositions

| Disposition                | Commits |
| -------------------------- | ------: |
| taken as-is                |      54 |
| taken with fork adaptation |      28 |
| fork-overridden            |       3 |
| deferred                   |       2 |
| not applicable to the fork |      34 |

- **Not applicable to the fork:** the commit touches no retained package or
  docs path. These are examples, Gardener, triage, CI and root dependency
  bumps.
- **Taken as-is** includes commits whose files already carry fork rows,
  such as `package.json`, `AGENTS.md`, `scripts/build.ts` and the test worker.
  In those commits the change itself landed unchanged.
- **Fork-overridden:**
  - `52e4f835`: the fork pins Workers types 5.20261031.1;
  - `7b6ecccd`: Think keeps Vite `^8.3.0`;
  - `d69277b5`: the fork does not carry the tsrs typecheck script.
- **Deferred:** `4d8bf303` (oxfmt 0.74 / oxlint 1.89) and `d81b8186` (the
  React-tests oxlint override). Both wait for the fork's tooling bump. See the
  fork-diff "Tooling" row.
- **Runtime adoption deferred:** the browserTool, `internalHosts` and
  OpenTelemetry commits are counted as taken, because the code is in the
  package. do-runtime cannot run them yet; their CSV notes say so.

## Merge result

Upstream changed 344 files under `packages/`:

| Result                | Files |
| --------------------- | ----: |
| Fast-forward          |   174 |
| Added                 |    98 |
| Deleted               |    24 |
| Merged clean          |    29 |
| Conflicted (36 hunks) |    18 |
| Skipped               |     1 |

The skipped file is `agents/src/tests/skill-runner.test.ts`, which the fork
omits on purpose. Of the 29 files under `docs/`, 25 fast-forwarded, 2 were
added, 1 already matched head and 1 merged cleanly.

| Conflicted file                                                                  | Resolution                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents/package.json` (4 hunks)                                                  | Upstream's OTel dependency, optional MCP peers and TanStack `<2.0.0` range, merged with the fork's babel plugin and its React and zod floors                 |
| `ai-chat/package.json`, `codemode/package.json`                                  | Fork floors kept, upstream SDK version taken, Codemode stays on TanStack 0.54                                                                                |
| `think/package.json` (4 hunks)                                                   | Shell and just-bash dropped. Computer `^0.8.0` added as a peer and dev dependency. Fork adapters and Vite `^8.3.0` kept. Peer range `agents >=0.28.0 <1.0.0` |
| `think/scripts/build.ts`                                                         | Fork messenger entries kept; `src/tools/workspace.ts` dropped                                                                                                |
| `think/src/tests/vitest.config.ts`                                               | Fork alias list kept, plus `agents/skills/tools/ai-sdk` and `agents/webfetch`; Shell aliases dropped                                                         |
| `think/src/think.ts` (5 hunks)                                                   | Skills imports moved to the 0.32 layout without a runner. Media field docs re-ported with the `read` wrapper. `prepareModel` kept                            |
| `agents/src/index.ts`                                                            | Both sides' imports kept                                                                                                                                     |
| `agents/src/harness/think/tests/worker.ts`                                       | Upstream's version; the fork side was formatting only                                                                                                        |
| `agents/src/tests-d/browser-tool.test-d.ts`, `agents/src/browser/tanstack-ai.ts` | TanStack 0.54's `AnyServerTool`; browserTool now in `browser/tools/`                                                                                         |
| `agents/src/lifecycle/durable-object-lifecycle.ts`                               | Hand-ported (see below)                                                                                                                                      |
| `agents/src/skills/index.ts`, `agents/src/tests/skills.test.ts`                  | Hand-ported for the runner omission                                                                                                                          |
| `agents/src/vite.ts`                                                             | Upstream's version. The fork's `Buffer.from(readFile)` sat in code that upstream deleted                                                                     |
| `codemode/src/tanstack-ai.ts`                                                    | The fork's inferred `createCodeTool` type kept                                                                                                               |
| `codemode/src/tool-types.ts`, `codemode/src/tests/tool-types.test.ts`            | Hand-ported (see below)                                                                                                                                      |

Changes made outside the conflict hunks:

- `agents/src/browser/tools/tanstack-ai.ts` is an upstream addition. It
  carries the fork's explicit
  `toolDefinition<typeof core.inputSchema, undefined, TName>`.
- `scripts/vitest/expose-workerd-gc.ts` was copied from the vendor root,
  because the agents tests import it.
- Upstream CHANGELOGs were run through oxfmt.
- `scripts/use-ai-sdk-major.mjs` and `.oxfmtrc.json` were aligned with
  upstream.
- `.oxlintrc.json` stays on the fork version, because oxlint 1.71 rejects
  upstream's React-tests override.
- The dead `browser/cdp-session.ts` and `browser/session-manager.ts` files were
  removed; upstream deleted them in 0.27.
- `docs/AGENTS.md` and `docs/index.md` were copied in.

Divergences retired in this refresh, where the fork now equals upstream:

- `agents/src/{client.ts, dynamic-agents/types.ts, vite.ts}`;
- `harness/think/tests/worker.ts`;
- the Channels AI SDK test;
- `docs/think/{channels.md, lifecycle-hooks.md}`.

The fork's websearch edits are also gone, because upstream now does the
`Promise.resolve` wrap itself.

## Hand-ports

### Alarm writes keep the caller's input lock

**Lifecycle change.** `#serializeAlarmWrite`
(`agents/src/lifecycle/durable-object-lifecycle.ts:846`) keeps the fork's eager
form:

```ts
const prior = this.#alarmRearmQueue;
const next = (async () => {
  await prior.catch(() => {});
  await write();
})();
```

It replaces upstream's `this.#alarmRearmQueue.catch(() => {}).then(write)`.

- **Callers:** both callers use the eager form: `rearmAlarm()` (`:831`) and the
  new failed-startup `armStartupFallback()` (`:747`).
- **Logging:** a failed fallback write is now logged as
  `Error in <class>:<name> startup fallback alarm:`. Upstream swallowed it with
  `.catch(() => {})`. The write does not rethrow, because upstream's five
  alarm-startup-failure cases assert the startup error itself.
- **Merge trap:** the three-way merge flagged only the rearm hunk. Taking
  "theirs" compiles but silently reverts the fork row; taking "ours" does not
  compile.

**job-driver.ts.** `agents/src/lifecycle/job-driver.ts:232-248`
`trackAlarmWork` settles tracked work in an async block that starts
synchronously and awaits the work. Upstream uses
`void work.then(...)` (`be174922` `job-driver.ts:237`). The settle writes strike
storage, so it must keep the alarm's input lock too. The merge-fidelity audit
found this divergence with no ledger row; it is now in the "Alarm callback
context" row.

**Latent on do-runtime today.** `setAlarm` and `deleteAlarm` return
`Promise.resolve()` (`src/io/actor-state.ts:539, 548`), so upstream's shape
loses nothing in the current runtime. The lock check (`src/io/io-context.ts:200-203`)
fails only when an alarm write outlasts the microtask checkpoint. That happens
with an async storage wrapper compiled with the await transform. An
untransformed wrapper loses the lock on either shape, and the fix does not help
it. Rook wraps no storage today (Rook `origin/main` `b9467a95`).

**Test.** A new lane, `agents/src/do-runtime-tests/`, runs the real
`createActorContainer` in Node with a transformed Lifecycle and holds each
alarm write for 10 ms. Its two cases are:

- re-arming jobs queued with no `await` between them;
- arming the startup fallback behind an in-flight re-arm.

The lane is appended to `test:agents` and excluded from the package
`tsconfig.json`; [VENDOR.md](../../VENDOR.md) says when to add to it.

| Tree                     | Result                  |
| ------------------------ | ----------------------- |
| Upstream shape           | Fails 10/10 runs        |
| Fork shape               | Passes 10/10 runs       |
| Mutant runs after review | Fail on assertions only |

The Chromium lane was not run. The direct `setAlarm` in `job-driver.ts` `runAlarm` is
unchanged.

### Chat recovery: Stop and cancel before admission

Upstream 0.29 (`05843e42`) wraps each recovery callback in `runRecoveryAttempt`.
That function counts the attempt and runs `storage.sync()` before the callback
runs. The fork's Stop and cancel checks lived inside the callback. A stopped or
cancelled turn near the budget was therefore sealed as
`interrupted_attempts_exceeded` and reported to `onExhausted`. Upstream's own
`cancelChat` has the same ordering in Think and AI Chat.

**Hoist.** `_dispatchChatRecovery` (`think/src/think.ts:6257-6300`) now runs
`_cancelRecoveryIfStopped(stopEpoch, incidentId)` and then
`_recoveryCancelled(payload)` before `runRecoveryAttempt`. The checks inside
the callbacks remain.

**Sealed stays sealed.** This was review finding M1. The first version of the
hoist let a stale callback after Stop rewrite an `exhausted` incident to
`skipped`. The fork had done the same before the refresh, and it undoes
upstream's 0.29 guarantee. The guard now lives at the engine's writers, behind
the opt-in adapter flag `sealedIncidentsAreFinal` (Think sets it, AI Chat does
not):

- `updateIncident` is a no-op on an `exhausted` record (post-review fix);
- `beginIncident` returns an `exhausted` record as `sealed` instead of
  re-evaluating the budget, so a replayed fiber or a later stall writes
  nothing, emits nothing and does not terminalize again; the replay only closes
  the orphaned stream and clears the recovering flag, and Think's stall path
  keeps the partial and skips the second banner (second-pass fix);
- `rescheduleAfterStableTimeout` declines on an `exhausted` record (second-pass
  fix);
- `runRecoveryAttempt`'s entry guard (`recovery-engine.ts`, upstream) already
  returned on one.

Without the flag every writer behaves as upstream does, including the budget
re-evaluation that reopens an `exhausted` record as `attempting`.

**Engine hook.** `recovery-engine.ts` has a new optional adapter method,
`isRecoveryAttemptCancelled?(data)` (`:170`).

- After an at-budget admission's `syncStorage`, the engine re-checks the
  incident's cancel marker and the hook (`:499-514`).
- If either reports a cancel, it runs the callback untracked instead of calling
  `exhaustRecoveryGiveUp`.
- Think implements the hook with its Stop epoch (`think.ts`, the
  `isRecoveryAttemptCancelled` adapter entry near `:18020`).

**Exhausted filter.** `listRecoverableChatRequests` (`think.ts:13558`) is
fork-only. It now skips callbacks whose incident is `exhausted`. Rook calls it
at `conversation-agent.ts:1183`. Without the filter, a sealed turn would show
"recovering" forever.

**Residual.** A Stop that lands while admission's `syncStorage` is in flight is
counted against `maxInterruptedAttempts`, but it is never sealed or reported.

| Test                                                                                                                                                                                    | Result             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `think/src/tests/recovery-stop-seal.test.ts` (Stop and cancel near budget, sealed stays sealed in `continue` and `retry`, exhausted filter), on the merge baseline before the hand-port | 6/7 cases failed   |
| Same file, hoist reverted                                                                                                                                                               | 4/7 failed         |
| Same file, now                                                                                                                                                                          | 9/9 pass           |
| `recovery-engine.test.ts`: four new cases under "a cancel that lands while an at-budget admission syncs"                                                                                | Suite passes 68/68 |
| `ai-chat/src/tests/durable-chat-recovery.test.ts`, now in `test:ai-chat`                                                                                                                | Passes             |

**`prepareModel` kept.** It is declared at `think.ts:6996` and awaited at
`:7845`; `:7943` reads the result. Dropping it would be a compile error in Rook,
not a silent fallback.

### Workspace media on Computer's `read`

Think 0.23 builds its file tools from Computer's
`createAITools({ workspace })`. Computer's `read` has no capability hooks and
sends image and PDF parts to every model. The fork's 0.20 `read` tool, with its
gates, PDF text and size preflight, is gone. The fork re-ports the behaviour as
a wrapper rather than a fork of the tool.

`think/src/workspace-read.ts` is new (491 lines). It exports two functions,
both re-exported from `@cloudflare/think`:

- `withWorkspaceReadMedia(tools, workspace, opts)` replaces only `read` in a
  tool set;
- `createWorkspaceReadTool` builds a standalone gated `read`.

The wrapper keeps Computer's `execute` and wraps only `toModelOutput`. Gating
therefore happens at render time, and saved history is never rewritten.
`think.ts:7848` wraps `createAITools` with the three kept fields:

- `workspaceAcceptsImages` (default `true`);
- `workspaceAcceptsPdfs` (default `true`);
- `workspacePdfText` (default `undefined`).

`workspace-files.ts` equals upstream.

| Output                                               | Rendering                                                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                                                | Inline only for PNG, JPEG, GIF and WebP when the model accepts images; otherwise a note                                                                                       |
| PDF                                                  | Inline when accepted. Otherwise page text from `workspacePdfText`, windowed by offset and limit and cached by SHA-256 (64 entries), or a note                                 |
| Declared type that does not match the first 12 bytes | A mismatched image is relabelled with the sniffed type; anything else renders a note and is not sent                                                                          |
| `kind: "file"` that is not `application/pdf`         | Passed to Computer's renderer unchanged                                                                                                                                       |
| Think 0.20 media result saved without bytes          | Re-read, checking the current size before a bounded read. An inaccessible file renders `Could not read file bytes: <path>: <reason>` as `error-text` without touching history |
| Think 0.20 result recorded over the limit            | Stays an error even if the file later shrinks                                                                                                                                 |

The last row has a reason. Computer's own oversize result also has no bytes,
so the two cannot be told apart. Re-reading would reload every new oversize
result on each render. The model recovers by calling `read` again.

Other behaviour changes:

- **HEIC and SVG.** HEIC now renders as Computer's binary result with
  `unsupported: true`. SVG is read as text. The fork used to render a "convert"
  note for both.
- **Relative paths.** Computer's tools pass a relative path to `workspace.fs`
  verbatim. Think's host bridge resolves it under `/workspace` with
  `resolveWorkspacePath`.

**Tests.**

- `think/src/tests/workspace-read-media.test.ts`: unit cases covering the gates,
  PDF text, size preflight, the 0.20 re-read and the byte-type check.
- The `workspace-tools.test.ts` agent wiring.
- `think-session.test.ts`, an upstream test the fork edited. Its "old read
  tool" replay is now two cases: re-read, and an error for a missing file.
  Upstream expects `error-text` for every old image read.

**Examples.**

- `examples/extension/src/worker/think-probe.ts` drops `workspaceBash`, which
  no longer exists.
- `examples/vibe-platform/src/main.ts:568` reports `0.32.0`.

### Skills without a script runner

Upstream 0.32 (`54ae3e86`) replaces `SkillRegistry`, the `agents:skills`
virtual module and `agents/skills/compile` with `loadSkillCatalog` over
`workspace()`, `r2()` and `manifest()` sources. It also adds an optional
script runner. The fork has no Worker Loader in the browser, so it omits the
runner.

- **Agents exports.** `agents/skills` exports no `SkillScript*` or
  `SkillRunContext` types. `createSkillTools(catalog)` takes one argument, so
  `run_skill_script` never exists, and passing options is a type error.
- **Build entry.** `./skills/runner` is gone from both `agents/package.json` and
  `scripts/build.ts`.
- **Think.** Think's `skills.ts` drops the runner re-export, which keeps
  Codemode, just-bash and Worker Loader out of Think bundles.
  `getSkillScriptRunner()` stays absent.
- **Unreachable sources.** `skills/{runner,script,script-workspace}.ts` stay
  byte-identical to upstream but are unreachable, so they add no sync diff.
- **Vite plugin.** `vite.ts` equals upstream. It throws on any `agents:skills`
  import.

Tests:

- **`agents/src/tests/skills.test.ts`:** the runner is absent; `manifest()`
  accepts the 0.27 compiled shape; nested metadata yields a `SkillWarning`.
- **`think/src/tests/skills-runner-omission.test.ts` and
  `think/src/tests-d/skills-namespace.test-d.ts`.**
- **`think/src/browser-tests/skills.test.ts`:** the Rook recipe, which uses
  `import.meta.glob` with `?raw` plus `parseSkill` and `manifest()`. Its
  `isBundledSkillFile()` filter keeps `SKILL.md` and the 0.27 resource roots
  (`references/`, `scripts/`, `assets/` and five asset folders) and drops other files. The fixture
  proves it: `index.ts` and `notes/draft.md` beside a `SKILL.md` are excluded.

Two upstream-new test helpers were also edited:
`tests-d/skills-namespace.test-d.ts` and `tests/memory-skill-workspace.ts`.

### Codemode type printer

Upstream's new `jsonSchemaToTypeDecl` body (`7945da9c`) is replaced by an alias
of the fork's shared `jsonSchemaToType` (`codemode/src/tool-types.ts:138-144`).
Input, output and adapter declarations therefore print the same way.

- **Empty object.** Upstream's new test expects `type GetLengthInput = {}` for
  `z.object({})`. The fork prints `Record<string, never>`, which
  `schema-conversion.test.ts:1095` already pins. The expectation was changed,
  and an index-signature case was added.

### Kept fork field: `Think.codemode?`

The merge brought back upstream's type-only `codemode?` field
(`think.ts:4011`), which the 0.20 fork had removed. It stays on purpose.

- **Why it stays.** 0.32's `ExecuteToolAgent` has no other member, so without
  the field, `createExecuteTool(this)` stops type-checking for every Think
  subclass.
- **No readers.** Nothing in Think reads the field.
- **Still omitted.** The Codemode runtime and approval composition.

## Fork-side defaults

These three defaults are reversible. They follow from taking all of 0.32 / 0.23
in one PR.

1. **Workspace: follow upstream's Computer `Workspace` and drop the
   `think/tools/workspace` subpath.**
   - Rook's media overrides compile unchanged because the media `read` behaviour
     was re-ported.
   - The alternatives were a Rook-side `read` override, which moves model policy
     into Rook, and keeping the 0.20 tool. The 0.20 tool would mean a permanent
     patch in the highest-churn area upstream.
2. **Skills: upstream `manifest()`, `workspace()` and `r2()`, with no runner.**
   - The fork never had an isolate loader.
   - Keeping an `agents:skills` plugin would fight upstream's throwing guard.
3. **Recovery: upstream defaults.**
   - `maxInterruptedAttempts` is 5, and a reload counts as an attempt.
   - Rook owns the budget and the `onExhausted` UX.

## Review findings and resolutions

Three reviews ran: R1 on lifecycle and recovery, R2 on workspace and skills,
and R3 on whole-tree merge fidelity. The review files are working notes and are
not in the repository.

**R1 found 0 High, 1 Medium and 4 Low.**

| Finding                                                           | Resolution                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| M1: a stale callback after Stop un-seals an exhausted incident    | Fixed, see "Sealed stays sealed"                                                        |
| L1: the alarm ledger row said "any async wrapper"                 | Reworded to transform-compiled wrappers                                                 |
| L2: the recovery row said "never counted"                         | Reworded to "never sealed or reported to `onExhausted`", with the sync-window exception |
| L3: the lane fixture left a rejected promise unhandled            | Fixed                                                                                   |
| L4: a 10 ms hold could pass broken code under an event-loop stall | Accepted; a comment records it                                                          |

R1's informational notes:

- the eager form behaves the same on workerd;
- "latent, not live" is correct;
- the exhausted filter hides nothing Rook needs;
- both files pass the clean-merge audit.

**R2 found 1 High and 6 Low.**

| Finding                                                                | Resolution                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| F1 (High): `think-session.test.ts` expected upstream's replay-as-error | Test now covers both the re-read and the missing-file error |
| F2: `Think.codemode?` came back                                        | Kept on purpose and recorded in the ledger                  |
| F3: a 0.20 result recorded over the limit never recovers               | Documented, not ported                                      |
| F4: declared media type not checked against the bytes                  | Fixed                                                       |
| F5: PDF text cache thrashes past 8 PDFs                                | Cache raised to 64                                          |
| F6: `kind: "file"` assumed to be PDF                                   | Fixed                                                       |
| F7: the glob recipe did not filter resource roots                      | Fixed with `isBundledSkillFile()`                           |

R2's informational notes:

- I1: an upstream doc bug, reported below;
- I2, I4: Rook's overrides compile, and Rook never had compiled skills JSON;
- I3: re-listing skills every turn is not a regression;
- I6: PDF text has no byte budget, the same as before;
- I7: HEIC and SVG changes, described above.

**R3 found 4 Medium, 6 Low and 2 Info.**

| Finding                                                                  | Resolution                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1. `job-driver.ts` divergence had no ledger row                          | Added to "Alarm callback context"                         |
| 2. The changeset linked this missing file                                | This file                                                 |
| 3. Think's main entry pulls `node:*` built-ins through Computer          | Documented for Rook (`../rook-0.32-migration.md`)         |
| 4. Dead browser files                                                    | Removed                                                   |
| 5. `.oxlintrc` React-tests override missing                              | Deferred to the oxlint bump ("Tooling" row)               |
| 6. Unreachable `runner.ts`                                               | Kept, noted in omissions                                  |
| 7. Stale `vendor-fork-audit.md` baseline                                 | Updated                                                   |
| 8. `docs/AGENTS.md` and `docs/index.md` never copied                     | Copied                                                    |
| 9. Tooling drift                                                         | "Tooling" row; `use-ai-sdk-major.mjs` taken from upstream |
| 10. `docs/agents/configuration.md` says Think's `bash` uses just-bash    | Left as upstream text                                     |
| 11. The OTel bridge relies on the ALS `snapshot()` shim, never exercised | Deferred                                                  |
| 12. browserTool and `internalHosts` need a Worker Loader transport       | Deferred                                                  |

## Storage and rollout

No migration was added, and the forward-only policy is unchanged. Eight
durable-state changes arrive with upstream:

| Change                                                                             | Effect                                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ThinkHarness tables lifted into `cf_think_harness_store_*`                         | Destructive, but runs only when that harness opens. Not on Rook's path                               |
| Recovery incident `oomAttempts` becomes `interruptedAttempts` + `attemptsInFlight` | Readable both ways; the attempt budget resets once                                                   |
| Pi 1.4 pi-durable schema                                                           | Migrates on Pi harness open. Not on Rook's path                                                      |
| Browser `internalHosts` KV keys                                                    | Additive                                                                                             |
| Default Think workspace becomes a Computer `Workspace`                             | Old Shell-workspace files are not migrated. Rook overrides `workspace`, so its storage is unaffected |
| New media-eviction markers under `/workspace/attachments/evicted/`                 | Existing markers keep their paths                                                                    |
| `skillsFingerprint` and `skillsWorkspaceFingerprint` config rows                   | Orphaned, no longer read                                                                             |
| `armStartupFallback` alarm written at alarm start                                  | An extra firing is a no-op                                                                           |

Rook's migration is in [`../rook-0.32-migration.md`](../rook-0.32-migration.md).

## Verification

These counts are from the refresh's final gate run.

| Suite                                           |  Files |                                                                Tests |
| ----------------------------------------------- | -----: | -------------------------------------------------------------------: |
| `test:react`                                    |     10 |                                                                  108 |
| `test:chat`                                     |     34 |                                                                  668 |
| `test:agents` (workerd lane)                    |     73 |                                                        1675 + 2 todo |
| `test:agents` (do-runtime lane)                 |      1 |                                                                    2 |
| `test:ai-chat` (plus React)                     | 12 + 1 |                                                            194 + 106 |
| `test:think`                                    |     56 |                                                                 1340 |
| `test:voice`                                    |      1 |                                                                   21 |
| `test:codemode` (plus Node)                     |  4 + 2 |                                                              108 + 9 |
| `test:shell`                                    |      2 |                                                                  203 |
| `test:browser`                                  |  7 + 2 |                                                              68 + 18 |
| `sdk:check` (exports, format, lint, TypeScript) |      — |          exit 0: exports 6/6, oxfmt clean, oxlint 0, 6 tsgo projects |
| `sdk:build` and frozen installs                 |      — | exit 0: 6 packages built; root and vendor frozen installs up to date |

These suites were not run:

- node-tests;
- otel-runtime;
- the container, OpenCode, Think-harness and Pi harness suites;
- the Codemode runtime lane;
- the do-runtime alarm-context test in Chromium;
- provider-backed suites.

From a fresh clone at `d4d7bead`, `pnpm install --frozen-lockfile` in
`vendor/agents`, with or without `--ignore-scripts`, exits 1 with
`ERR_PNPM_IGNORED_BUILDS` for `@mongodb-js/zstd@7.0.0` and `node-liblzma@2.2.0`
and writes placeholder lines into `pnpm-workspace.yaml`. The install fix below
makes both forms exit 0 with a clean tree.

## Post-review fixes

A merge-fidelity review after `d4d7bead` found no lost upstream change but
several ledger gaps. The follow-up commits:

- harden the recovery seal, so a sealed incident stays sealed, and gate AI
  Chat's matching parity hook the same way;
- gate workspace media by the file's bytes and read a PDF's header within a
  bounded window;
- revert the workerd `getTags` change in do-runtime;
- correct the Rook guide (`../rook-0.32-migration.md`);
- close the ledger gaps in `../fork-diff.md`: recovery incident and indicator
  ownership, the errored-stream late ACK, Agent-tool run-change hook and
  progress time, eager async entry outside Lifecycle, facet record cleanups,
  context-wrapper async detection, React tool-result cleanup dependencies,
  dependency ranges, and corrected Package identity, Tooling and Codemode
  test statements; sync `AGENTS.md` with upstream 0.32 plus the fork notes;
- add `@mongodb-js/zstd` and `node-liblzma` to the vendor `allowBuilds` (both
  `false`, as the root workspace has them) and drop the unused
  `nanoid@5.1.16` and `postal-mime@2.7.5` release-age exclusions.

A second review pass, two fresh reviewers on the three code fix commits only
(the workerd socket release; the recovery seal and workspace media), found:

- two more engine writers that could reopen a sealed incident with
  `sealedIncidentsAreFinal` set: `beginIncident` re-evaluated the budget on a
  replayed fiber, which turns an `exhausted` record back into `attempting`, and
  `rescheduleAfterStableTimeout` wrote `scheduled` over it. Both are guarded at
  the writer (see "Sealed stays sealed"); the replay and Think's stall path no
  longer terminalize a sealed incident a second time. Engine tests cover
  `beginIncident`, the reschedule and the fiber replay, with and without the
  flag;
- a false parity claim: AI Chat does not set the two engine fields, but the
  owner-scoped recovering clear in `recovery-incident.ts` applies to both
  packages. The recovery row in `../fork-diff.md` says so now;
- the coupled WebSocket pair (the production network shape through
  `upgradeWebSocket`) was still released after its own close and the client's
  echo, where workerd keeps the tags. Fixed in do-runtime with a conformance
  row (see `docs/workerd-sync.md` in the repository root).

Outside the curated `test:ai-chat` list, `src/tests/ai-chat-eviction.test.ts`
(one case: the fork's `createdAt` on rebuilt messages) and the fork-only
`src/tests/agent-tools.test.ts` (four cases: a leading `snapshot` event and a
duplicated stored chunk) fail on this branch before and after the second-pass
fixes, and fail the same way on `main` (abba5d67) before the refresh. Not
touched here.

Known dead references, left in code:

- 30 comment lines in 29 comments cite dated entries of the
  [previous chronological ledger](https://github.com/WebMCP-org/do-runtime/blob/ff87e9ef1d38f8beaa579b3a53d445e62df96837/vendor/agents/docs/fork-diff.md)
  that `fork-diff.md` no longer has: 2026-07-24, 2026-07-31, 2026-08-12,
  2026-08-14, 2026-08-23, 2026-08-30, 2026-09-05 and 2026-09-11. They sit in
  `think/src/think.ts` (10 lines), `ai-chat/src/index.ts` (4), `agents/src/sessions/core.ts` (3)
  and test files in AI Chat, Think and `agents/src/tests/sessions/`. Each entry
  still exists in that record.
- `think/src/messengers/chat-sdk.ts:847` keeps upstream's comment that the
  sub-agent stub's `bindActiveDeliverySurface` must not be offered to delivery.
  The method remains on Think (`think.ts:5809`), but the fork's delivery target
  no longer declares it; Think binds the surface inside
  `chatWithMessengerDelivery`, so the comment guards a path the fork's types
  already exclude.
