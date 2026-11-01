# Cloudflare refresh — October 31, 2026

This refresh moves the runtime oracle to
[workerd 1.20261031.1](https://github.com/cloudflare/workerd/releases/tag/v1.20261031.1)
and the six-package SDK fork to
[Agents 0.32.0](https://github.com/cloudflare/agents/tree/be1749221ab3efc8be4e976d8e7d8344d1446032).
The other packages land at:

- Think 0.23.0;
- AI Chat 0.12.2;
- Shell 0.5.0;
- Codemode 0.5.6;
- Voice 0.5.0 (unchanged).

Workers types are 5.20261031.1 in the runtime, both examples and the SDK
workspace. Wrangler is `^4.156.0`. Think now requires
`@cloudflare/computer ^0.8.0`, Cloudflare's new workspace package. It is
published separately, and 0.8.0 is npm `latest`.

The SDK covers five upstream releases, 0.28 through 0.32. The user chose to take
all five in one PR, committed by area rather than by upstream release.

## Review and implementation

**workerd.** The [workerd audit](workerd-sync.md) covers 794 commits, with a
[complete disposition table](workerd-sync-2026-10-31.csv). The runtime ports
four changes:

- a move-later alarm parked behind an in-flight write (`src/io/actor-sqlite.ts`);
- `entry()` and `bindReentryTarget()` waiting for the output gate
  (`src/server/actor-container.ts`);
- releasing a hibernatable socket when its own close completes after the close
  was dispatched, so `getTags()` throws one turn after `webSocketClose()`, and
  keeping a closed socket listed until that handler's synchronous part returns;
- `Cursor.next()` returning `IteratorResult<T, undefined>`.

**SDK.** The [SDK audit](../vendor/agents/docs/audit/agents-sync-2026-10-31.md)
covers all 121 upstream commits. Each one has a row in the
[commit dispositions](../vendor/agents/docs/audit/agents-0.32-commit-dispositions.csv):

| Disposition | Commits |
| --- | --- |
| Taken as-is | 54 |
| Taken with a fork adaptation | 28 |
| Overridden by the fork | 3 |
| Deferred | 2 |
| Outside the retained packages | 34 |

Eighteen files conflicted.

Upstream rewrote three areas the fork had patched, so the merge would have
silently dropped or broken each fork behaviour. Each was hand-ported with a
regression test that fails on the upstream shape.

- **Alarm writes.** Lifecycle's alarm-write queue and the alarm job driver keep
  the caller's do-runtime input lock. This hazard is latent today, because
  do-runtime's `setAlarm` resolves at once. It becomes live only with a storage
  wrapper compiled with the await transform. A new
  `agents/src/do-runtime-tests/` lane runs the case against a real actor
  container.
- **Chat recovery.** Upstream's 0.29 recovery budget seals a turn after five
  interrupted attempts. The fork now checks Stop and per-request cancel before
  the budget counts the attempt.
  - A stopped turn is therefore never sealed, and a sealed turn stays sealed.
  - The recovery engine re-checks cancellation after an at-budget admission
    syncs storage.
  - The fork-only `listRecoverableChatRequests` skips sealed turns.
- **Workspace media.** Think's file tools now come from Computer.
  - The fork's model-gated image and PDF handling is re-ported as a wrapper
    around Computer's `read` (`think/src/workspace-read.ts`). The existing
    `workspaceAccepts*` and `workspacePdfText` options keep working.
  - Think 0.20 media results are re-read instead of failing.

Two more changes are adaptations rather than hand-ports:

- **Skills.** The skills catalog follows upstream's `manifest()`, `workspace()`
  and `r2()` sources without the new script runner. The browser host has no
  Worker Loader to run one.
- **Codemode.** Codemode keeps the fork's single type printer.

Three reviews checked the hand-ports and the whole tree against upstream:

- one on lifecycle and recovery;
- one on workspace and skills;
- a merge-fidelity audit of every file that differs from upstream.

They found one high-severity issue, a stale test, and one medium issue: a stale
callback could unseal a sealed turn. Both are fixed. The remaining findings were
ledger wording, dead files, uncopied docs and tooling drift, all now resolved
or recorded. The [fork inventory](../vendor/agents/docs/fork-diff.md) records
the current owners. New rows cover `workspace-read.ts`, `job-driver.ts`,
`Think.codemode?` and tooling.

## Dependency work

- **MCP.** MCP client and server move to 2.4.0 and the SDK to 1.32.2. The
  SDK and server are now optional peers of Agents. `examples/extension` pins
  server 2.4.0.
- **Pi.** Pi moves to 1.4. The SDK workspace mirrors upstream's `allowBuilds`
  entries for pi-ai's provider SDKs.
- **Root lockfile.** It keeps rolldown 1.2.8, as in the October 9 refresh.
- **Tooling.** The SDK workspace stays on oxlint 1.71 and oxfmt 0.67. Upstream
  moved to oxlint 1.89 and oxfmt 0.74, and its React-tests lint override needs
  the newer oxlint. The gap is recorded in the fork inventory's Tooling row.

## Verification

The orchestrator fills these numbers from the final gate run.

| Gate | Result |
| --- | --- |
| Runtime unit suite | 43 files / 1086 tests pass |
| Native workerd conformance | 86 / 86 pass against workerd 1.20261031.1 |
| Node conformance | 86 / 86 pass |
| Chromium conformance | 101 / 101 pass |
| Transformed Node / Chromium conformance | 86 / 86 and 86 / 86 pass |
| SDK regression gate | react 108, chat 664, agents 1675 (+2 todo) + do-runtime lane 2, ai-chat 194 + 106, think 1340, voice 21, codemode 108 + 9, shell 203, browser 68 + 18; think and agents run twice with no flake delta |
| SDK exports, formatting, lint and TypeScript | exports 6/6 valid, oxfmt 1443 files clean, oxlint 0 findings, 6 tsgo projects clean |
| Runtime and example TypeScript | root typecheck (build:package + 7 tsc projects) clean |
| Dependency installation and oracle | frozen installs pass at root and vendor/agents; `check:oracle` pins agree on v1.20261031.1 |
| Runtime package | `build:package` clean |
| SDK packages | `sdk:build` 6 packages, `sdk:sync` clean |
| Extension and vibe-platform Chromium journeys | extension e2e 93 PASS / 0 FAIL (first try); vibe-platform e2e 16 PASS / 0 FAIL |

These suites were not run:

- node-tests;
- otel-runtime;
- the container, OpenCode, Think-harness and Pi harness suites;
- the Codemode runtime lane;
- the do-runtime alarm lane in Chromium;
- provider-backed suites.

## Worth sending upstream

- **Alarm logging.** Lifecycle swallows a failed startup-fallback alarm write
  with `.catch(() => {})`. The fork logs it and still surfaces the startup
  error. The eager form of `#serializeAlarmWrite` is optional upstream, because
  workerd cannot lose an input lock on a detached promise reaction.
- **Recovery ordering.**
  - `runRecoveryAttempt` admits and counts an attempt before the callback checks
    Stop or cancel. A cancelled turn near the budget is therefore sealed and
    reported to `onExhausted`.
  - Upstream's own `cancelChat` has the same ordering in Think and AI Chat.
  - The fork's fix has two parts:
    - check before admission;
    - an optional `isRecoveryAttemptCancelled` engine hook, re-checked after the
      at-budget sync.
- **Think doc comment.** `think.ts:3991` (upstream `:3794`) has
  `import { createAITools } …` pasted inside the `workspace` JSDoc example.
- **Skills metadata doc.** `SkillManifestEntry.metadata` says nested values make
  the entry invalid. The loader actually keeps the entry and emits a
  `SkillWarning`.
- **Computer media detection (optional).** `detectMedia` trusts the file
  extension before the bytes. A `.png` that holds JPEG or HTML is sent with the
  wrong media type, and some providers reject the request.

## Deferred

The code for these features is in the packages, but do-runtime cannot run it
yet. They stay opt-in, so nothing breaks by default.

- **BrowserProvider and Browser Run interop, browserTool and `internalHosts`.**
  These need a Worker Loader transport. do-runtime's `src/api/worker-loader.ts`
  defines the interface only, and both isolate channels refuse
  `getEntrypoint`. Upstream's provider set is closed. Rook can use
  `BrowserSource` today.
- **`agents/webfetch` and `agents/websearch`.**
  - HTML conversion needs `env.AI.toMarkdown()`.
  - Web search needs an AI binding.
  - In a browser, the direct fetch source's `redirect: "manual"` yields
    `opaqueredirect`.
  - The private-host check matches host literals only.
- **OpenTelemetry bridge (`experimental_registerOpenTelemetry`).** It relies on
  `AsyncLocalStorage.snapshot()`. do-runtime shims that
  (`src/browser/async-hooks.ts:53`), but no test has run it. Add a smoke test
  when Rook first uses `agents/observability`.
- **Tooling bump.** oxlint 1.89, oxfmt 0.74 and upstream's React-tests lint
  override, recorded in the fork inventory's Tooling row.

## Rollout

No storage migration is added; the forward-only policy is unchanged. The SDK
audit lists the eight durable-state changes that arrive with upstream. Only
ThinkHarness's table lift is destructive, and it runs only when that harness
opens.

Rook's full work plan is in
[`vendor/agents/docs/rook-0.32-migration.md`](../vendor/agents/docs/rook-0.32-migration.md).
In short, the change touches about 25 files.

- **Skills.**
  - The `agents:skills` imports now fail the build.
  - Bundled skills move to `manifest()` through an `import.meta.glob` recipe.
  - `SkillRegistry` becomes `loadSkillCatalog`.
  - Rook's `/skills` source becomes a two-method `SkillSource`.
- **Workspace.**
  - `@cloudflare/think/tools/workspace` is removed.
  - Rook's browser workspace needs a `.fs` adapter.
  - `workspaceBash` is gone.
  - The model's `list` tool is now `ls`.
  - The media overrides compile unchanged.
- **Packaging.**
  - `@cloudflare/computer` 0.8.0 is a required peer wherever Think is installed.
  - Computer's main entry pulls `node:crypto`, `node:events`, `node:fs`,
    `node:zlib`, `cloudflare:workers` and a second capnweb, so Rook's bundler
    aliases must cover them.
  - MCP pins move to client 2.4.0, SDK 1.32.2 and server 2.4.0.
- **Recovery.**
  - No Rook change is needed for correctness.
  - Rook must decide the interruption budget. The default is 5, and every
    extension reload counts as an attempt.
  - Rook must also decide what a sealed turn shows the user.
- **MCP redirects.** Remote MCP connections now follow redirects only within the
  same origin.

No release was published and no application deployment or stored user data was
modified by this refresh.
