# Vendor fork audit

> This is the audit record imported with the fork from Rook's prepared 0.22
> checkout. App-relative paths describe that source checkout. The SDK source
> and maintained gate now live in this repository.

## 2026-08-31 extraction

- Retained only the six-package Rook closure: Agents, AI Chat, Think, Voice,
  Shell, and Codemode.
- Removed the fork's three test-only dependencies on the outer Rook install.
  Agents and Think now resolve Codemode from this workspace.
- The two runtime examples consume the built local Agents package. The runtime
  package itself still has no SDK dependency.
- Fresh verification passed six package-export checks, the selected lint and
  type gates, and 1,317 tests across 42 files with retries disabled. The native
  Agents files run serially because their existing fixed-delay bridge tests
  have a recorded parallel-worker flake.

Status: reconciled 2026-08-31 against released upstream commit
`676b3d35a82db3147c7aa1505f7f2d5ef48f359b` (Think 0.17.0 /
Agents 0.22.0 / AI Chat 0.11.0 / Codemode 0.5.1 / Voice 0.4.0 / Shell 0.4.3).
Earlier release audits and measurements below are historical.

[Upstream diff](upstream-diff.md) records _why_ each retained edit exists and
[shim surface](shim-surface.md) records _what_ each compatibility shim covers.
This file records release-by-release overlap decisions and measures how much
of the fork is browser adaptation or product code. Re-measure it at every
vendor refresh rather than trusting the historical numbers below.

## 2026-08-31 commit-by-commit recheck: 0.21 → 0.22

Reviewed all **21 commits** in the
[released range](https://github.com/cloudflare/agents/compare/agents@0.21.0...agents@0.22.0),
excluding `d4249450` and including `676b3d35`, against the reconciled Rook
worktree based on `a8547bd3`. Each commit's changes were checked for overlap
with Rook's consumers and retained fork patches. This is a release-integration
and redundancy audit, not a security audit of every new provider or example.
The active product checkout gained concurrent uncommitted changes during this
pass. They were not modified or incorporated here; integration must reconcile
those changes with this isolated upgrade.

No additional production workaround was identified that 0.22 makes safe to
delete. The prior cleanup already removed the PartyServer integration,
private alarm-reconciliation call, retained reply-bridge workaround, duplicate
transcriber-readiness API, recovery-off branches, and explicit default chat
throttle. The remaining differences below cover behavior the release does
not supply. The parallel-test failures and local package paths remain open
verification and release issues; this is not an unconditional all-green verdict.

| #   | Upstream commit                                                                                                                   | Current-fork verdict                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [b038440 — branch-local compactions](https://github.com/cloudflare/agents/commit/b0384407915cacc9d81951e369466feae4389db0)        | Adopted selected-branch bounds and deterministic overlay ordering. Local transcript timestamps, role/FTS updates, and explicit SQL projections address other behavior. Bounded SQL history reads are already upstream, not a local patch to retain.                                                                        |
| 2   | [3982ce9 — submission status RPC](https://github.com/cloudflare/agents/commit/3982ce93bd645773156ad138e1cfc52eced45454)           | Changes the private `agent-think` service, wrapping the existing inspection API. It adds no public Think transport or acknowledgement/liveness guarantee that replaces Rook's submission handling.                                                                                                                         |
| 3   | [d5973c0 — orphaned execution outcomes](https://github.com/cloudflare/agents/commit/d5973c0bb351fd77240550e27a4be4eeb2aa74d5)     | Adopted provider-safe projection of framework execution notes without rewriting stored history. Local model preparation, truncation metadata, and cancellation semantics remain separate.                                                                                                                                  |
| 4   | [b7c7696 — agent span identity](https://github.com/cloudflare/agents/commit/b7c76964b329b9b5911c0c9a34b8b0f514fffafd)             | Uses upstream observability code unchanged. No parallel application implementation of these span attributes was found.                                                                                                                                                                                                     |
| 5   | [bf94bb2 — partial tracing support](https://github.com/cloudflare/agents/commit/bf94bb2f8242f2ad46f6c6c88e56ee5e196cc706)         | Uses upstream's `startActiveSpan` capability check and no-op fallback. Browser module/platform shims still supply APIs absent from Chrome; the fallback does not replace them.                                                                                                                                             |
| 6   | [9620b58 — unconditional recovery](https://github.com/cloudflare/agents/commit/9620b58fcc78035e1dd9a65a647455f83328bc28)          | Recovery-off branches are gone. Every turn uses the recovery fiber. Durable Stop state, turn ownership, and exhaustion policy still determine whether recovery may resume inference.                                                                                                                                       |
| 7   | [d536067 — composable Lifecycle](https://github.com/cloudflare/agents/commit/d536067ce69dfbe82db6c31f4b4d5042792088de)            | PartyServer dependencies, aliases, and prototype broadcast adaptation are gone. Agent composes upstream Lifecycle. The retained alarm-queue edit preserves browser actor context across awaits; it does not add another lifecycle implementation.                                                                          |
| 8   | [a0e134b — request routing ownership](https://github.com/cloudflare/agents/commit/a0e134bbc327fc8a519b5aa66cb8ce4038815d05)       | Uses unchanged `agent-routing.ts` and the established `routeAgentRequest` API. No intermediate Lifecycle router or duplicate public router remains.                                                                                                                                                                        |
| 9   | [e87ad62 — asynchronous facet replies](https://github.com/cloudflare/agents/commit/e87ad62bb6df735cc2910f7dc20edd62111b6410)      | Uses upstream per-frame reply context and tracked streaming delivery. The old retained-bridge workaround is removed. Failed-connect cleanup and stale-child guards protect different connection states.                                                                                                                    |
| 10  | [dab4e75 — AI SDK v6 test bound](https://github.com/cloudflare/agents/commit/dab4e75e23e2e40ab8b099c7de4053ab15bc7e12)            | CI compatibility-matrix change, with no runtime replacement. It caps the tested v6 range below 6.0.260; it is not a reason to downgrade Rook's v7 path.                                                                                                                                                                    |
| 11  | [4890dc6 — stateless Channels](https://github.com/cloudflare/agents/commit/4890dc69c2763a0eb04d4ed57281813820387ad8)              | Evaluated ingress, host, and delivery contracts. Rook does not consume this new package. It does not replace durable messenger reconciliation, attachment policy, or Chrome's Slack Socket Mode/Discord Gateway connections. Adopting another ingress path would be separate work.                                         |
| 12  | [3b43c33 — replay batching](https://github.com/cloudflare/agents/commit/3b43c337f468688f30d7ea0ff78fdff37d9a5163)                 | Uses upstream `ReplayBatch` unchanged. Pre-subscription buffering, overflow hydration, request ownership, and immutable continuation seeds cover loss/duplication around admission and reconnect, not replay render batching.                                                                                              |
| 13  | [381b9bb — default chat throttle](https://github.com/cloudflare/agents/commit/381b9bb319e2123771eaa82ad485d0f2d28652f1)           | Explicit `experimental_throttle: 50` is removed; upstream supplies the default and current-store update semantics. Rejected-hydration cache eviction and replay seed reset remain necessary.                                                                                                                               |
| 14  | [4ba9a37 — MCP capability](https://github.com/cloudflare/agents/commit/4ba9a375208c2e8209fb407aa3567553e3644067)                  | Uses the single upstream MCP manager for schema, restore, and OAuth callback handling. Manual OAuth setup still has to persist client information, including a supplied secret, before connection; automatic provider construction does not do that.                                                                       |
| 15  | [bd43240 — resolved WIP removal](https://github.com/cloudflare/agents/commit/bd432404bfe4fadc866c1bea50c25d83ad9c2679)            | Upstream-only obsolete artifacts are removed. No new runtime API replaces Rook's application policy or browser adaptations.                                                                                                                                                                                                |
| 16  | [ded09c6 — no-op CLI removal](https://github.com/cloudflare/agents/commit/ded09c6f7b35326b8907ae3552ce9228b88089d2)               | Retired CLI and stale files stay removed. Rook's existing build/test commands do not call the deleted placeholders.                                                                                                                                                                                                        |
| 17  | [f08ee06 — Voice lifecycle and diagnostics](https://github.com/cloudflare/agents/commit/f08ee06fd610756de0d8abf539dfe9b746bdd7c5) | Reuses upstream readiness and fatal-error callbacks, including dictation overflow reporting. Final-audio flushing, passing failures to shared call-end state, accepted-audio metering, and browser async context still require the retained edits.                                                                         |
| 18  | [2f957bc — delayed facet operations](https://github.com/cloudflare/agents/commit/2f957bc2a3ffb7aee14792bb3cb658ad3176ed93)        | Uses upstream per-connection ordering and durable-root fallback. Local guards prevent rejected connects falling through, failed/throwing handlers retaining entries, and stale traffic recreating deleted children. Two unchanged upstream test assertions are intermittent under concurrent load; see verification below. |
| 19  | [29b0107 — Scheduler composition](https://github.com/cloudflare/agents/commit/29b01079e4cf1ae82918b019f97a247317f49912)           | Scheduler source is unchanged. Existing schedule rows and parsed callback payloads are compatible; Rook uses the public scheduling methods and `lifecycle.rearmAlarm()`. Chrome alarm projection supplies the platform wake mechanism, not another SDK callback scheduler. Lifecycle's browser-context queue fix remains.  |
| 20  | [ad2f338 — live Channels smoke tests](https://github.com/cloudflare/agents/commit/ad2f33887b8b3569231f48f2da2c74ecdd89e44b)       | Test-only change, no production overlap. Not run: these tests need disposable provider credentials and clear messages in the configured channels.                                                                                                                                                                          |
| 21  | [676b3d3 — release versions](https://github.com/cloudflare/agents/commit/676b3d35a82db3147c7aa1505f7f2d5ef48f359b)                | Package versions match the released pin. Agents 0.22.0, Think 0.17.0, AI Chat 0.11.0, Voice 0.4.0, and Channels 0.1.0 introduce no additional logic in this commit. Machine-local application package overrides still need portable replacements before merge/remote CI.                                                   |

The final release copies of Scheduler, MCP, observability, routing,
`ReplayBatch`, and chat-throttle modules have no local source edits. Stop,
retained-run projection, browser replay/hydration, model preparation, messenger
state, workspace adaptation, and dictation remain the material fork areas.
Nothing in this range replaces the browser host with a general Cap'n Web
Agent transport. Post-release transport and job-queue changes are excluded.

### Fresh verification and open issues

This recheck made no runtime, dependency, or test changes. In addition to the
earlier cleanup results below, it ran 316 native checks covering Lifecycle,
Scheduler, routing, sub-agent replies, MCP, tracing, and Session compaction:

- Concurrent run, retries disabled: **314 passed, 2 failed** across 23 files.
  Both failures are state assertions in the unmodified upstream
  `sub-agent-rpc-bridge.test.ts`: “keeps a live-frame state update behind an
  older queued update” and “persists connection state”.
- The entire bridge file passed unchanged in isolation: **17/17**, retries
  disabled. The same expanded set passed with only file parallelism disabled:
  **316/316 across 23 files**, retries disabled.
- Both assertions read after fixed waits (350 ms and 100 ms). The setter's RPC
  acknowledgement does not await the queued root state write. Test timing is
  a plausible cause, but these runs do not distinguish it conclusively from
  an intermittent runtime ordering bug. No retry increase, quarantine, or
  runtime workaround was introduced. Both cases are recorded in
  [the flake ledger](flaky-tests.md).

Before calling the parallel gate clean, establish a deterministic completion
boundary for those assertions and rerun under concurrent load. The existing
native configuration defaults to three retries; the zero-retry runs above
were deliberate. The earlier passing maintained gate does not erase this gap.

Other limits remain unchanged: credentialed provider tests and the full
packaged E2E suite were not run, the standalone whole-upstream check lacks some
built package exports, and two application dependency overrides are local
artifacts. No additional runtime deletion is recommended from this released
range; resolving these verification and packaging issues is separate from
removing redundant SDK code.

## 2026-08-31 audit follow-through

The 0.22 refresh is now based on current Rook `a8547bd3`, including the newer
model-preparation and replay-overflow fixes. The earlier upgrade and active
product checkouts were not modified by the reconciliation. The current UI
artifact is preserved; the Agents artifact is rebuilt from the reconciled
source. Both overrides still
use machine-local paths and need published replacements before merge or CI
on another machine. A direct SDK link is not equivalent: it exposes the
vendor workspace's different Vite peer types to the application.

The host now reports a fatal dictation overflow through Voice's public callback
and relies on the SDK's default chat throttle. Five existing upstream regression
files join `test:vendor`. No post-release transport or job-queue API is used,
and no released storage fixture is regenerated.

The cleanup recheck found one more error-propagation gap: VoiceInput reported
transcriber startup failures to its socket but passed `null` to Rook's call-end
hook. That left shared dictation state idle without an error. Forwarding the
existing error fixes the private lifecycle owner in one line. The browser meter
test now first verifies the unauthenticated startup error, then supplies test
credentials and proves the next generation resumes metering. It failed before
the fix and passed afterward; no new test framework or runtime state was added.
Two unused type imports were also removed from Think's messenger adapter. The
existing vendor gate now runs upstream's installed linter over Agents, Think,
and Voice source, which application lint excludes.

The first browser pass exposed an invalid streaming test: it requested a
60-second probe, but the mock accepts at most 30 seconds. It could therefore
connect before inference or race an ordinary quick completion. The test now
uses a supported delay and waits for a forwarded model delta, then closes the
parent observer before dialing the child. The completed-run test also dials
at admission, covering fast completion during connection setup.

The reconciled fork, measured against the release with dependencies and build
output excluded: production **+4,059 / −1,723 in 35 files**; tests and fixtures
**+6,074 / −1,385 in 51 files**. Rook-side consumer changes are not in this count.

Cleanup verification (`ci:verify` plus the new source-lint step):

- The dictation contract failed on the missing callback before the fix; all
  six contract cases now pass.
- `ci:bootstrap` passes with the final packaged dependency overrides.
- `vp check` passes on 405 files. Workspace typechecking passes.
- `test:vendor` passes 1,317 tests across 42 files, plus all three source and
  fixture typechecks.
- `test:integration` passes 921 tests: 402 contract, 82 offscreen, 47 host,
  149 browser-host, and 241 shared-package/companion checks. The full browser
  rerun and four consecutive focused connection pairs pass after correcting
  the streaming test. No diagnostic logging or connection-runtime change remains.
- Seven packaged Chrome journeys pass with retries disabled: first-message
  handoff, worker hibernation, delegated drill-in and Stop, both scheduled-wake
  scenarios, stale MCP-session recovery, and OAuth token refresh after host
  recreation.

The full packaged E2E suite and credentialed providers were not run. Publishing
the two local package artifacts remains a release prerequisite, not a test result.

The additional standalone upstream `pnpm run check` stops at missing built
exports for AI Chat, Channels, Hono Agents, Voice, and Worker Bundler. Rook's
selective bootstrap does not build those entries; it loads the consumed Voice
source directly. This is not a passing whole-upstream check. Scoped source lint,
formatting (560 files), and explicit Voice/Think source typechecks pass.

## 2026-08-30 release refresh

The isolated upgrade starts from Rook's pre-rebase snapshot `b37250d9` and
preserves its local patches. It has not been merged into the rebased product
branch. The existing design-system package override is unchanged; the Agents
override points to a freshly built local 0.22.0 package so declarations include
the retained APIs. These machine-local package overrides must be replaced with
published artifacts before merging or running CI on another machine.

Storage audit from `d4249450` to `676b3d35`:

- Agent `CURRENT_SCHEMA_VERSION` remains **11**. `_ensureSchema` delegates the
  existing schedules and MCP tables to their new capability owners. Existing
  columns and schedule copy migrations remain; there is no application table
  replacement or Rook state-version change.
- Scheduler adds the KV marker `cf_agents:schedules_schema_version = 1` and
  adopts existing `cf_agents_schedules` rows. Its callback receives parsed
  payloads; durable payload encoding remains JSON text. Alarm reconciliation
  uses Lifecycle after restoring facets.
- MCP keeps `cf_agents_mcp_servers`; persisted server options gain optional
  RPC-binding `bindingName` and `props`. Existing HTTP registrations remain
  readable. The package's files move from `mcp/*` to client/server submodules.
- Think's provider-safe execution-outcome projection does not rewrite stored
  history. Branch-local compactions and deterministic ordering change reads,
  not table shapes. Rook's retained cancellation and cursor fields are unchanged.
- Voice changes have **no persisted storage shape delta**. No released storage
  fixture was regenerated. Upstream retired CLI and example files are deleted
  only where they matched the old pin; local-only files are retained.

At that snapshot, the fork measurement against the release, excluding
dependencies and build output: production **+4,002 / −1,702 in 35 files**; tests and fixtures
**+5,746 / −1,383 in 50 files**. The extra production file is Lifecycle's
alarm queue; the remaining edits carry the existing fork forward.

Verification:

- Agents and Think source typechecks, native fixture typechecks, Rook workspace
  typechecking, lint, and the extension build pass.
- The final `vp run test:vendor` gate and updated `vp run ci:bootstrap` pass.
- Targeted vendor suites: 274 chat/recovery checks, 294 native Agent checks,
  606 Think checks, 40 React checks, 11 AI Chat checks, 42 Lifecycle/Scheduler
  checks, and 19 VoiceInput checks pass.
- Rook: 387 contract, 72 offscreen, 46 host, and 143 browser-host checks pass.
  The browser suite includes unchanged released-state/workspace fixtures.
- Packed Chrome: first-message handoff, an open client surviving worker
  hibernation, and delegated transcript drill-in plus Stop pass (three tests).
- Replay and final-voice-flush regressions were each demonstrated red before
  restoring the fixes. Browser dictation was rerun after the final Voice changes.
- The full packed E2E suite and credentialed providers were not run. Browser
  harness warnings about Buffer externalization and transformed host awaits
  remain; the failing storage/input-lock errors are absent after the queue fix.

The bootstrap now builds Codemode, Agents, Shell, and Think declarations before
source checking; a fresh vendored install otherwise has unresolved package
self-imports. This does not restore Codemode to Rook's execution path.

## 2026-08-30 maintainability pass (before refresh)

The comparison separates the uncommitted vendor work from the entire carried
fork. The former includes untracked files and compares against Rook commit
`1b35ddf13ed728d6c6f9f32b341dfc9463515a2a`; the latter compares package source
against the unchanged upstream pin. Neither count includes the Rook application or
design-system changes. The SDK example adaptation is listed separately below.

| Surface                                   | Before cleanup                          | After cleanup                           |
| ----------------------------------------- | --------------------------------------- | --------------------------------------- |
| Uncommitted package production source     | +1,862 / −616; net +1,246 in 9 files    | +2,091 / −996; net +1,095 in 9 files    |
| Uncommitted tests and test infrastructure | +2,849 / −151; net +2,698 in 22 files   | +3,418 / −155; net +3,263 in 25 files   |
| Entire fork, production source            | +3,843 / −1,368; net +2,475 in 34 files | +4,072 / −1,748; net +2,324 in 34 files |
| Entire fork, tests and fixtures           | +5,102 / −1,377; net +3,725 in 45 files | +5,666 / −1,381; net +4,285 in 47 files |

The pass removes **151 net library production lines**. Think loses 154 lines through
shared recovery and admission ownership; explicit cancellation results and
monotonic shutdown confirmation add three net lines to Agents. No additional
library production file or parallel runtime owner was introduced. The textual patch
does grow: combining two existing recovery callback bodies changes more lines
than leaving their duplication intact. This is less code to maintain, not a
claim that a future rebase touches fewer upstream lines.

The SDK example also needs a small consumer adaptation: +11/−5 lines in
`examples/agents-as-tools/src/client.tsx` preserve and label the newly exposed
`starting` state instead of displaying an error. Including that example, the
pass removes 145 net production lines. It adds no runtime mechanism.

The retained production changes have three responsibilities:

- **Cancellation belongs to native run ownership.** The parent SQL row retains
  the accepted terminal result and whether a child may still execute. Both
  explicit Stop and recovery teardown use one acknowledgement path. A late
  shutdown acknowledgement cannot be undone by older replay observations.
  These private SDK boundaries cannot be repaired by a browser shim.
- **Think owns admission, recovery, and accepted writes.** The existing admission
  helper owns its keepalive lease. One recovery driver serves the existing
  persisted retry and continue callback names. Stop keeps the interaction write
  chain so accepted tool results cannot overwrite each other; Clear retains its
  history invalidation semantics. Resumable streams receive their existing
  continuation flag at creation.
- **The SDK projection owns retained work.** Collection events now encode the
  required roster or error for their status. React and the standalone reducer
  consume that contract directly. Source identities, replay cursors, and
  in-flight ownership were retained because they protect demonstrated races;
  removing them would shrink the diff by restoring bugs.

The added tests exercise held native RPCs, real Session writes, cancellation
failure with an empty diagnostic, late shutdown confirmation during replay, and
existing stream-resume behavior. Invalid collection shapes also fail the source
typecheck, which is now part of Rook's maintained vendor gate. Tests and fixture
registration account for the larger test footprint; they are not production
runtime complexity. The five existing changesets are metadata and are excluded
from the table.

For the entire-fork comparison, count code files under `packages/*/src` using
`git diff --no-index --numstat`. Exclude dependencies, build output, package
documentation, and metadata. All test directories, fixtures, test configuration,
and type tests count as tests, including their worker entrypoints. This corrects
the August 20 classification that counted some fixture workers as production.
The uncommitted test-infrastructure row also includes non-code fixture
configuration such as `wrangler.jsonc`.

## 2026-08-21 do-runtime hard cutover

The remaining measurement and release-audit sections describe 2026-08-20,
unless explicitly dated later. Their version-drift and unreleased-commit claims
are not current release guidance. That measurement preceded replacement of the
browser host's hand-written Durable Object layer with npm `@mcp-b/do-runtime@0.1.0`.
The cutover first moved the vendored fork by its additive resolved-messenger
target (`think/src/messengers/chat-sdk.ts` +4,
`think/src/tests/messengers.test.ts` +31/−1, plus its changeset). The later
2026-08-25 upstream-alignment pass also added Agents' protected persisted-state
validation hook and Think's channel reconciliation/delivery-surface seams,
with regressions in their owning vendor suites. The measured rows below are
therefore stale by all three additive changes. What is now historical is every
claim about _how_ a Workers API is replaced, and every host path a Rook-impact
cell names:

- **The Durable Object surface is a dependency, not a shim.** State, storage,
  SQL, facets, alarms, and the `cloudflare:workers` module come from the runtime
  package. `host/{state,storage,storage-sqlite-wasm}.ts`,
  `shims/cloudflare-workers.ts`, `shims/agent-tool-tail.ts`,
  `shims/retained-sub-agent-connection-bridge.ts`, and
  `runtime/remote-agent-capability.ts` are deleted. `host/shims/` itself is not:
  it still holds the Node-builtin, Slack, Discord, MCP-validator,
  `cloudflare:email`, facet-broadcast, and wasm-loading shims, which is all that
  "substituted behind the vite alias table in `host/shims/`" now covers.
- **`partyserver` is no longer replaced.** The extension installs stock
  `partyserver@0.5.10`. Agents' public request router owns socket admission;
  the host supplies only the browser's missing WebSocket-upgrade primitives.
  The former pnpm patch and local implementation under `shims/partyserver/`
  are gone.
- **The tracing row's premise inverted.** With `shims/cloudflare-workers.ts`
  deleted, `tracing` is whatever `@mcp-b/do-runtime` exports — a present object
  whose `startActiveSpan` runs the callback under a permanently untraced span,
  not the `undefined` that used to select upstream's no-op tracer.
- **The host adaptation size row counts deleted files.** `storage.ts` alone was
  642 of its 3,457 lines, and the local PartyServer tree was 750 of the 1,495 it
  attributes to `shims/`. That row needs a fresh measurement, not an adjustment.
- **Several Rook-impact cells name files that no longer exist**, including
  `host/shims/retained-sub-agent-connection-bridge.ts`,
  `host/fixtures/transport.integration.test.ts`, and the five
  `chatRecovery = false` fixtures the not-yet-released table plans work on. No
  fixture passes `chatRecovery = false` today.

Current truth for the platform layer is the dated do-runtime section at the end
of [shim surface](shim-surface.md) and
[the cutover decision log](do-runtime-cutover-decisions.md). The August 30 section
above replaces the source counts. The historical host-size rows below have not
been remeasured.

## Reproducing the measurement

```bash
curl -fsSL -o upstream.tar.gz "https://codeload.github.com/cloudflare/agents/tar.gz/$(sed -n 's/.*commit \([0-9a-f]\{40\}\).*/\1/p' vendor/agents/VENDOR.md)"
mkdir up && tar xzf upstream.tar.gz -C up --strip-components=1
git diff --no-index --numstat -- up/packages vendor/agents/packages
```

From a local clone of upstream, `git -C <clone> archive <commit> packages |
tar -x -C up` produces the same tree without a network fetch.

Per-file counts come from `git diff --no-index --numstat` after excluding
package documentation, generated output, and dependencies. Test files are
`*.test.ts` or `*.test.tsx`, `*.test-d.ts`, anything under `runtime-tests/` or
`tests/agents/`, and `vitest.config.ts`; everything else counts as production.
Run the diff against a tree with no `dist/` or `node_modules/` under
`vendor/agents/packages`, or exclude those paths, because the vendored build
output is untracked and otherwise counts as thousands of added lines.

## Vendor refresh checklist

| Check               | Required evidence                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage shape delta | Diff `_ensureSchema` and `CURRENT_SCHEMA_VERSION`, every `CREATE`/`ALTER`/`DROP` in the refresh range, and every persisted-JSON shape change; record **none** explicitly when there is no delta. |

## Measurements

| Surface                                   | Size                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| Vendored fork, production                 | **+1,964 / −797** across 29 modified files                     |
| Vendored fork, test                       | **+2,014 / −1,148** across 21 modified files, 2 new, 1 deleted |
| …of that, `vendor/agents/packages/agents` | **+2,505 / −485** across 30 modified files plus 2 new          |
| Host adaptation layer                     | **~3,500 lines**                                               |
| Host product code                         | **~42,500 lines (92%)**                                        |

The deleted test file is `agents/src/tests/skill-runner.test.ts` (−948), which
belongs to the 2026-08-16 Codemode cutover and was missed then; it is excluded
from the `packages/agents` row so that row stays comparable with the previous
measurement. Nothing else in the vendored tree deletes an upstream file.

This measurement includes the 2026-08-19 subagent rework, the 0.21.0 refresh,
and the 2026-08-20 minimality pass, which reverted an unconsumed turn-status
delta and four cosmetic hunks to upstream bytes and made every vendored file
pass upstream's own `oxfmt --check`; the numbers moved a few lines in both
directions from that pass. Production deletions are concentrated in five
files: `think/src/think.ts` (−381) and `agents/src/skills/registry.ts` (−66)
from the 2026-08-16 Codemode cutover, `agents/src/index.ts` (−68) across the
Agent Tool and sub-agent seams,
`agents/src/experimental/memory/session/providers/agent.ts` (−56) where SQLite
triggers replace upstream's second-phase JavaScript FTS writes, and
`agents/src/agent-tools.ts` (−41) where the terminal projection is lifted out of
`agentTool()`'s `execute`.

Per package: `agents` +2,505 / −485 across 32 files, `think` +1,154 / −455
across 11, `ai-chat` +231 / −27 across 5, `voice` +81 / −27 across 3, `shell`
+7 / −3 across 1, and `codemode` byte-identical to pinned upstream.

The production-file inventory was cross-checked against
[upstream diff](upstream-diff.md) during this measurement, hunk by hunk. All
twenty-nine differing production files are named by at least one entry that
owns their retained behavior — including `ai-chat/src/tests/worker.ts` (+4),
the fixture worker for the retained request-id suite, which the classification
rule above counts as production because it is not a `*.test.ts` file.

The host adaptation layer is production source under
`offscreen/worker/host/` (3,457, of which `shims/` is 1,495 and `storage.ts` is
642), plus `shared/shims/browser-buffer.ts` (60). Host product code is every
other `.ts`/`.tsx` file under `packages/`, excluding generated files,
`*.test.*`, `*.spec.*`, and the `e2e/`, `fixtures/`, `test/`, and `tests/`
directories — about 46,000 lines total (46,257 with `*.gen.*` as the only
generated-file exclusion), of which the adaptation layer is 8%.

## Browser platform adaptation stays outside the vendored tree

The runtime package supplies Durable Object storage, alarms, facets, SQL, and
`cloudflare:workers`. Stock PartyServer runs through Agents' public request
router; one local shim supplies the browser-missing WebSocket-upgrade
primitives. **Zero lines of those browser implementations live in vendored
source.** The larger Agents diff exposes generic adapter seams already present
in upstream behavior: Agent Tool result projection, typed sub-agent bridge
installation, protected state validation and recovery, and Think messenger
reconciliation. Browser-specific retention, tail pumping, and request shaping
remain local. The fork also retains the earlier type/export fixes and
method-identity `WeakMap` that undoes a regression from Cloudflare's own
[PR #1949](https://github.com/cloudflare/agents/pull/1949).

This is the property that makes vendor refreshes mechanical, and it is the one
most likely to erode quietly. A refresh that starts resolving compatibility
gaps by editing vendored source instead of adding a shim row should be treated
as a regression in its own right, whatever the diff size says.

The 0.21.0 refresh removed one of those seams rather than carrying it forward.
The Agent Tool dispatch-preparation hook (`prepareRun`) had no host consumer
after the subagent rework, so `agents/src/agent-tools.ts` now retains only the
exported `projectAgentToolResult()` projection, and the local
`AgentPathStep` declaration in `agents/src/index.ts` is gone because upstream
[#2037](https://github.com/cloudflare/agents/pull/2037) exports it.

## The dead Codemode product fork is gone

| Cluster                                      | Production lines added |
| -------------------------------------------- | ---------------------- |
| Chat timing, replay, and Agent Tool dispatch | **1,636**              |
| Everything else combined                     | **359**                |
| Rook-specific Codemode behavior              | **0**                  |

The first cluster is `think/src/think.ts`, `agents/src/index.ts`,
`agents/src/react.tsx`, `agents/src/agent-tools.ts`, `ai-chat/src/index.ts`, and
every file under `agents/src/chat/`. The second is the Session provider,
messengers, workspace, voice, Shell Git, and the skills barrel.

The 2026-08-16 cleanup restored the retained files under
`vendor/agents/packages/codemode` to pinned upstream and removed the
Codemode-specific execute/approval fork from Think. The package remains as
upstream reference and for its own vendor suites, while the active Think and
skills barrels no longer reach it. Rook's extension does not execute it;
historical entries in
[upstream diff](upstream-diff.md) retain the provenance of the deleted fork.

The largest retained cluster is `think/src/think.ts` (+565), `agents/src/index.ts`
(+305), `agents/src/react.tsx` (+160), `agents/src/chat/ws-chat-transport.ts`
(+155), the Session provider (+112), `agents/src/chat/resume-handshake.ts`
(+73), `agents/src/chat/pre-stream-turns.ts` (+55), and
`agents/src/agent-tools.ts` (+52), plus the smaller chat buffering and resume
entries. Those are timing facts,
replay buffering, and delegation seams that upstream already owns — the
entries in [upstream diff](upstream-diff.md) all argue they belong there.
It is expected to shrink at a release rather than harden into a permanent fork.

## Retained upstreamable edits have not been submitted

Historical entries in `docs/upstream-diff.md` include edits removed by the
Codemode cleanup. Every `cloudflare/agents/pull/*` link in `docs/` points at a
Cloudflare-authored PR; none originated here.

The visibility-only edits remain the cheapest available reduction in refresh
cost. `agents@0.21.0` uses `isInternalJsStubProp` internally but does not export
an `agents/utils` package subpath, so Rook's root re-export is still retained.
`AgentPathStep` left this list at 0.21.0: upstream now exports it from
`agents` through `./sub-routing`, and the local declaration is gone.
Ranked by effort:

1. **Visibility-only exports.** `isInternalJsStubProp`,
   `tryParseDeclaredTaskSchedule`, and the `MCPServer.state` widening. Each is
   a plain export or a type that already describes existing behavior.
   `isBlockedHost` left this list at the refresh: it lost its last consumer in
   the Codemode cut, so `think/src/tools/fetch.ts` is upstream-identical again.
   `RootFacetRpcSurface` left it on 2026-08-21: the do-runtime cutover deleted
   the root-RPC dispatch table that needed the key set, so the type is
   unexported again.
2. **Straight bug fixes.** `think/src/tools/workspace.ts` — think 0.16.0 took
   the `image-data` part itself in
   [#2082](https://github.com/cloudflare/agents/pull/2082), so what remains
   local is the raster-type allowlist (SVG, TIFF, or a mislabeled stat
   `mimeType` still reaches OpenAI as an unreadable `input_image` upstream) and
   the model-capability gate —
   `agents/src/chat/sanitize.ts` (reasoning replay under `store: false`),
   `agents/src/chat/react.tsx` (stop is a no-op while observing a broadcast
   turn, and a rejected hydration promise is cached forever), and the
   method-identity `WeakMap`. All four are bugs on Workers too.

Dropping the `isInternalJsStubProp` re-export in isolation is not worth a deep
import: the published package exposes no `agents/utils` path, and
`agents/src/index.ts` retains other edits either way. Bundle it with getting the
rest of that file upstream.

## What not to cut

The retained fork carries **2,007 added test lines against 1,995 production
lines**. Coverage remains in upstream's own suites rather than a parallel local
suite, so a refresh conflict surfaces as a failing test instead of a silent
behavior change. Adding a vendor edit without extending the upstream suite that
covers it is the actual regression to watch for.

Two vendored suites outside the `test:vendor` list were red before this refresh
and are red after it, so neither is merge damage; both are debt the next
cleanup should pay. `ai-chat/src/tests/ws-transport-resume.test.ts`
fails 15 cases against the fork's unacknowledged-request outbox in
`agents/src/chat/ws-chat-transport.ts` (2026-08-14 entry) — that edit's
coverage lives in the fork-only `agents/src/chat/__tests__/ws-chat-transport.test.ts`,
and the ai-chat suite was only partially reconciled with it: its
`handleStreamPending(pendingFrame)` call shape was adapted to the new
transport signature, its expectations were not.
`think/src/tests/hooks.test.ts` times out 8 Codemode-approval cases and
`think/src/tests/tsconfig.json` reports 8 type errors, all in fixtures the
2026-08-16 Codemode cut orphaned (`tests/agents/execute-{hitl,tool}.ts`,
`tests/action-types.test-d.ts`, and `messengers.test.ts`'s `fakeHost.chat`).
The think lane gained `messengers.test.ts` at this refresh; the ai-chat file
stays off the list until it is reconciled, so the lane stays green and honest.

## Version drift at time of measurement

| Package                | Pinned | Latest released |
| ---------------------- | ------ | --------------- |
| `agents`               | 0.21.0 | 0.21.0          |
| `@cloudflare/think`    | 0.16.0 | 0.16.0          |
| `@cloudflare/ai-chat`  | 0.10.2 | 0.10.2          |
| `@cloudflare/codemode` | 0.5.1  | 0.5.1           |
| `@cloudflare/voice`    | 0.3.6  | 0.3.6           |
| `@cloudflare/shell`    | 0.4.3  | 0.4.3           |

`@cloudflare/think@0.16.0` and `@cloudflare/voice@0.3.6` both declare
`agents >=0.20.2`, so 0.21.0 is the first coherent set that satisfies them; the
previous pin could not be advanced one package at a time.

`@mcp-b/react-components@0.45.0` (catalog `^0.45.0`) declares coherent peers for
`agents@^0.21.0`, `@cloudflare/think@^0.16.0`, `@cloudflare/voice@^0.3.6`, and
`ai@^6.0.228`. Rook resolves those lines without a peer override.

## Merged PR audit since the previous pin

Audited 2026-08-19 across the 37 first-parent commits from the previous pin
`413011e` through the release commit `d4249450`, extending the 2026-08-10 audit
(`ffc2d958` through `48eeba71`) rather than replacing it. The **Released**
column names the pinned release a change first shipped in, so the rows that read
"No" in the previous revision now read 0.21.0. **Vendored source** answers the
question a source vendor has to ask separately from "does the feature matter":
which internals moved, were renamed, or disappeared under `packages/*/src`.

The checked-in snapshot stops at `d4249450`. Upstream `main` carries six
unreleased commits after it, listed under "Landed upstream, not yet released"
below; this repository vendors only coherent published releases.

| PR                                                                                                        | Released | Vendored source                                                                                                                                                                                                                                                                                                                                                                       | Rook impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1981](https://github.com/cloudflare/agents/pull/1981) Browser Run recycling                             | 0.20.1   | `agents/src/browser/connector.ts` only.                                                                                                                                                                                                                                                                                                                                               | None. It changes Cloudflare Browser Rendering sessions; Rook drives local Chrome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [#1557](https://github.com/cloudflare/agents/pull/1557) MCP SDK v2                                        | 0.20.1   | Split `agents/src/mcp/` into catalog, connection, invoker, runtime, and stateless-handler modules; added the `agents/mcp/server` entry.                                                                                                                                                                                                                                               | **Handled.** Root MCP calls use the v2 two-argument client signature and the browser test bundle resolves the split v2 client/server packages. The retained Codemode package now uses its exact pinned-upstream connector shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [#1985](https://github.com/cloudflare/agents/pull/1985) version packages                                  | 0.20.1   | None.                                                                                                                                                                                                                                                                                                                                                                                 | Release metadata only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [#1987](https://github.com/cloudflare/agents/pull/1987) stable MCP dependencies                           | 0.20.1   | `agents/src/mcp/worker-transport.ts` lost 161 lines as SSE keepalives moved into the upstream transports.                                                                                                                                                                                                                                                                             | **Handled with #1557.** The lockfile pins SDK 1.30.0 plus client/server 2.0.0, matching upstream exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [#1982](https://github.com/cloudflare/agents/pull/1982) invocation-scoped observability                   | 0.20.1   | Span lifetimes rewritten across `agents/src/index.ts`, `observability/ai/v6/*`, `ai-chat/src/index.ts`, and `think/src/think.ts`.                                                                                                                                                                                                                                                     | **Handled.** It adds `AsyncLocalStorage`-backed span lifetimes and probes optional `cloudflare:workers.tracing`. Browser builds use the existing async-hooks compatibility module and the Workers shim explicitly exports unavailable `tracing`, selecting upstream's no-op tracer without a missing-export warning.                                                                                                                                                                                                                                                                                                                                                                                    |
| [#1988](https://github.com/cloudflare/agents/pull/1988) version packages                                  | 0.20.1   | None.                                                                                                                                                                                                                                                                                                                                                                                 | Final 0.20.1 / Think 0.15.1 release metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [#1994](https://github.com/cloudflare/agents/pull/1994) one AI SDK tracing path                           | 0.21.0   | `observability/ai/v6/` and `v7/` collapse into one `wrapper/` directory (6 files moved, 3 deleted); `createAISDKTelemetry()` is removed from `agents/observability/ai`; `IntegrationName` and the `cloudflare.agents.call.id` attribute are deleted from `observability/genai/`.                                                                                                      | None. `wrapAISDK` is the only export the bundle graph reaches (`think/src/think.ts:121`) and it survives; `vite-aliases.ts` maps the directory index, so the internal split is invisible. The no-op tracing shim still exports only `tracing: undefined` from `host/shims/cloudflare-workers.ts`. No tracing fork was carried, as predicted.                                                                                                                                                                                                                                                                                                                                                            |
| [#1996](https://github.com/cloudflare/agents/pull/1996) Workers Types v5                                  | 0.21.0   | `partyserver` dependency `^0.5.8` → `^0.5.9`; `think/src/cli/init.ts` and `think/src/tests/tsconfig.json`.                                                                                                                                                                                                                                                                            | None. `packages/extension/package.json` and `packages/companion/package.json` already install `@cloudflare/workers-types@^5.20260811.1`, and `partyserver` is replaced wholesale by `host/shims/partyserver/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [#2001](https://github.com/cloudflare/agents/pull/2001) immutable Workspace preview                       | 0.21.0   | None under `packages/*/src`.                                                                                                                                                                                                                                                                                                                                                          | `agent-think` preview packaging only; Rook does not consume that preview app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [#2000](https://github.com/cloudflare/agents/pull/2000) deprecate x402                                    | 0.21.0   | Comment text in `agents/src/mcp/x402.ts`.                                                                                                                                                                                                                                                                                                                                             | Documentation change, fully reverted by #2017.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [#2004](https://github.com/cloudflare/agents/pull/2004) full Workers AI STT keyterms                      | 0.21.0   | `voice/src/workers-ai-providers.ts` only.                                                                                                                                                                                                                                                                                                                                             | Rook's dictation uses `CodexOAuthTranscriber`, not the Workers AI Flux/Nova providers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [#2017](https://github.com/cloudflare/agents/pull/2017) restore x402 docs                                 | 0.21.0   | Restores #2000's comment text.                                                                                                                                                                                                                                                                                                                                                        | Reverts #2000; net zero for Rook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [#2016](https://github.com/cloudflare/agents/pull/2016) worker-bundler tarball roots                      | 0.21.0   | `worker-bundler/src/installer.ts` only.                                                                                                                                                                                                                                                                                                                                               | Rook does not use `worker-bundler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [#2023](https://github.com/cloudflare/agents/pull/2023) terminal error frames in `useAgentChat` observers | 0.21.0   | `agents/src/chat/react.tsx`: the observer branch gains an `data.error` short-circuit that clears replay-resume ids, calls `handleServerTurnCompleted`, clears `isRecovering`, runs the broadcast `clear` transition, and resets tool continuation before the body is JSON-parsed.                                                                                                     | **Handled by the refresh.** Rook drives the observer path: `packages/think-app/host/think-host.ts:311` calls `useAgentChat` from `@cloudflare/think/react`, which wraps `agents/chat/react`, and both the extension side panel and the companion mount that one host. The fix arrives with no local edit; the retained early-offer case in `src/react-tests/resume-overlap-race.test.tsx` sits alongside upstream's new observer-error cases in the same file.                                                                                                                                                                                                                                          |
| [#2034](https://github.com/cloudflare/agents/pull/2034) Browser extraction schema key                     | 0.21.0   | `agents/src/browser/{ai,quick-actions}.ts`.                                                                                                                                                                                                                                                                                                                                           | Cloudflare Browser connector only; Rook's extension-owned Chrome and checked-code contracts are separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [#2035](https://github.com/cloudflare/agents/pull/2035) Browser argument validation                       | 0.21.0   | `agents/src/browser/{ai,connector}.ts`.                                                                                                                                                                                                                                                                                                                                               | Same boundary as #2034; no local Chrome path uses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2037](https://github.com/cloudflare/agents/pull/2037) canonical Agent URL builders                      | 0.21.0   | `agents/src/sub-routing.ts` gains `AgentPathStep`, `BuildAgentPathOptions`, `buildAgentPath()`, `buildAgentUrl()`, and the internal `buildSubAgentPath`/`buildSubAgentPathUnchecked` encoders; `react.tsx`'s local `buildSubPath` now delegates to the unchecked encoder; `index.ts` re-exports the new names and drops its local `AgentPathStep` alias, as does `workflow-types.ts`. | **Handled, and it retires a fork line.** `host/shims/retained-sub-agent-connection-bridge.ts:1` imports `AgentPathStep` from `agents`; the fork's local `export type` for it is deleted because upstream now exports it. The builders themselves stay unadopted: they live only on the root `agents` barrel (there is no `agents/sub-routing` subpath), so `companionSeatAgentsPrefix` in `packages/companion/shared/protocol.ts:74` keeps its literal: the Worker and the extension both bundle that file.                                                                                                                                                                                             |
| [#2049](https://github.com/cloudflare/agents/pull/2049) messenger text boundaries                         | 0.21.0   | New `agents/src/chat/text-segment-joiner.ts`, exported from `agents/chat`; `think/src/messengers/delivery.ts` replaces `textDeltaFromStreamChunk()` with a `TextSegmentJoiner` loop and **removes that export** from `@cloudflare/think/messengers`; `voice/src/text-stream.ts` deletes its own boundary bookkeeping.                                                                 | **Handled by the refresh.** The fork never carried a word-gluing workaround, so upstream's path is taken verbatim. No Rook source imports `textDeltaFromStreamChunk`, so the removed export breaks nothing; `agents/chat` is already aliased to the vendored `chat/index.ts`, which now carries `TextSegmentJoiner`. Rook's retained `onReplyComplete` hook sits in the same rewritten function, and the host-facing `TextStreamCallback` / `wasCompleted()` API is unchanged.                                                                                                                                                                                                                          |
| [#2048](https://github.com/cloudflare/agents/pull/2048) Plivo adapter                                     | 0.21.0   | None under the consumed packages; new `voice-providers/plivo`.                                                                                                                                                                                                                                                                                                                        | New telephony provider; unused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [#2052](https://github.com/cloudflare/agents/pull/2052) framework-neutral chat transport                  | 0.21.0   | New `agents/src/chat/transport.ts` and the `agents/chat/transport` export subpath; `ai-chat/src/ws-chat-transport.ts` re-exports from it instead of `agents/chat/react`; React peers become optional.                                                                                                                                                                                 | None. No extension bundle imports either transport subpath, so their defensive alias rows and the importerless ambient declaration are deleted. Vendored suites resolve the workspace package's own exports map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [#2043](https://github.com/cloudflare/agents/pull/2043) Python support                                    | 0.21.0   | `worker-bundler` only.                                                                                                                                                                                                                                                                                                                                                                | Worker-bundler/package tooling only; unused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [#2066](https://github.com/cloudflare/agents/pull/2066) public voice provider packages                    | 0.21.0   | `private: true` dropped from five `voice-providers/*` manifests.                                                                                                                                                                                                                                                                                                                      | Package publication metadata; Rook imports the existing voice-input API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [#2082](https://github.com/cloudflare/agents/pull/2082) AI SDK 6 workspace images                         | 0.21.0   | `think/src/tools/workspace.ts`: `createReadTool()`'s `toModelOutput` returns an `image-data` part for `kind === "image"` before the `file-data` branch.                                                                                                                                                                                                                               | **Partly dissolved.** Upstream adopted the branch Rook retained since 2026-07-25, so that half of the local edit is gone, and the fork's hunk in `think/src/tests/assistant-tools.test.ts` merged to zero delta because it was byte-identical to upstream's new test. What still differs is the `acceptsImages` capability gate and the `MODEL_IMAGE_MEDIA_TYPES` raster allowlist inside upstream's image block; see the refresh entry in [upstream diff](upstream-diff.md).                                                                                                                                                                                                                           |
| [#2083](https://github.com/cloudflare/agents/pull/2083) voice turn context                                | 0.21.0   | `voice/src/voice.ts` snapshots `getConversationHistory()` into `priorMessages` before `saveMessage("user", …)` on both the audio and text turn paths.                                                                                                                                                                                                                                 | None. Full `withVoice` agents only. Rook uses STT-only `withVoiceInput`, which has no `onTurn` history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [#2091](https://github.com/cloudflare/agents/pull/2091) flexible agent tool schemas                       | 0.21.0   | `agents/src/agent-tools.ts`: `SchemaLike` becomes `ParseSchema`, a new `AgentToolOutputSchema` union accepts AI SDK `FlexibleSchema`, `inputSchema` is typed `FlexibleSchema<Input>`, `agentTool()` gains two overloads, and output validation moves into a new **async** `validateOutput()`. Zod stops being an `@cloudflare/ai-chat` peer.                                          | **Handled by the refresh.** The retained `projectAgentToolResult()` is re-extracted on top of upstream's async validator and is therefore now `async`. Both Rook call sites are inside async functions — `offscreen/worker/connectors/agents.ts:148` and `offscreen/worker/think-host.worker.ts:4906` — so no call-site change was required.                                                                                                                                                                                                                                                                                                                                                            |
| [#2063](https://github.com/cloudflare/agents/pull/2063) remove the convention framework                   | 0.21.0   | Deletes `think/src/cli/`, `think/src/framework/`, `think/src/vite.ts`, `think/src/server-entry.ts` (~4,700 lines; ~7,800 with their suites); removes the `think` bin and the `./framework`, `./server-entry`, and `./vite` export subpaths; drops the `aywson`, `smol-toml`, `yargs`, `vite`, and `create-think` dependencies.                                                        | None to the bundle, plus two alias rows and two dependencies retired. No file under `packages/` imports a removed subpath; Rook's think imports are the root, `/extensions`, `/react`, `/messengers`, and `/tools/*`. After this, nothing Rook bundles imports `aywson` or `yargs` — `yargs` survives only in `agents/src/cli/create.ts`, which is upstream's own CLI and is not aliased into the worker — so the `aywson` and `yargs` rows are gone from `vite-aliases.ts`, both packages are gone from the extension's dependencies and fallow suppressions, and a `wxt build` confirms neither reaches `.output/`. The `smol-toml` row stays: it is a `just-bash@3.2.0` dependency, not a think one. |
| [#2092](https://github.com/cloudflare/agents/pull/2092) restore valibot lock entries                      | 0.21.0   | None; `pnpm-lock.yaml` only.                                                                                                                                                                                                                                                                                                                                                          | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2062](https://github.com/cloudflare/agents/pull/2062) tool call repair                                  | 0.21.0   | `think/src/think.ts` adds `TurnConfig.repairToolCall`, forwarded to `streamText` as `experimental_repairToolCall` (the option name common to AI SDK v6 and v7).                                                                                                                                                                                                                       | None today, available later. `BrowserThinkConversation.beforeTurn` builds a `TurnConfig` at `think-host.worker.ts:3965` and sets no repair function; the new field is additive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [#2094](https://github.com/cloudflare/agents/pull/2094) flexible-schema notes in guides                   | 0.21.0   | None; two `docs/agents/*.md` files.                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2051](https://github.com/cloudflare/agents/pull/2051) stream forwarded bodies into sub-agents           | 0.21.0   | `Agent._cf_forwardToFacet` and `routeSubAgentRequest` set `forwardInit.body = req.body` instead of `await req.arrayBuffer()`, so a `/sub/` hop no longer materialises the body in the parent. Backpressure now reaches the client.                                                                                                                                                    | None. Rook now enters through `routeAgentRequest()`, but its `/sub/` traffic is WebSocket admission with no request body; the browser upgrade shim preserves that signal across request clones. Ordinary streamed request bodies remain outside the extension transport.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [#2093](https://github.com/cloudflare/agents/pull/2093) worker-bundler tidy-up                            | 0.21.0   | `worker-bundler` only.                                                                                                                                                                                                                                                                                                                                                                | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2097](https://github.com/cloudflare/agents/pull/2097) vitest and nx bump                                | 0.21.0   | Root `vitest` 4.1.9 → 4.1.10, `@vitest/browser*` ^4.1.10, `@cloudflare/vitest-pool-workers` ^0.19.1, `nx` ^23.1.1; `resolve.dedupe: ["vitest"]` added to `agents/src/tests/vitest.config.ts` and `ai-chat/src/tests/vitest.config.ts`.                                                                                                                                                | **Handled.** `vp run test:vendor` executes the vendored workspace's own vitest, so the lane moves to 4.1.10 — matching the repo catalog, which already pins `vitest: 4.1.10`. The fork's Codemode aliases live in the `agents` and `think` test configs — so `agents` carries aliases plus `dedupe`, `ai-chat` carries upstream's `dedupe` byte-identical, and `think` carries aliases only.                                                                                                                                                                                                                                                                                                            |
| [#2109](https://github.com/cloudflare/agents/pull/2109) Agents guidance corrections                       | 0.21.0   | None; four `docs/agents/*.md` files.                                                                                                                                                                                                                                                                                                                                                  | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2098](https://github.com/cloudflare/agents/pull/2098) Kitesurf in Browser Tools                         | 0.21.0   | `agents/src/browser/{ai,browser-run,connector,tanstack-ai}.ts`: a `session.browser: "kitesurf"` option, a `kitesurf:` synthetic-session marker prefix with its own sweep, redaction of large base64 outside the canonical `{ type: "browser_screenshot", mediaType, data }` shape, and a compact TanStack screenshot summary.                                                         | None. Nothing under `packages/` imports `agents/browser`; its unused defensive alias is deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [#2113](https://github.com/cloudflare/agents/pull/2113) allow scuffi/flue runs                            | 0.21.0   | None; `agent-think/src/run-context.ts`.                                                                                                                                                                                                                                                                                                                                               | None. Cloudflare's own bot app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [#2110](https://github.com/cloudflare/agents/pull/2110) agent doc corrections                             | 0.21.0   | None; three `docs/agents/*.md` files.                                                                                                                                                                                                                                                                                                                                                 | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2112](https://github.com/cloudflare/agents/pull/2112) package doc corrections                           | 0.21.0   | None; `packages/agents/{AGENTS,README}.md`, `packages/ai-chat/README.md`, `packages/hono-agents/README.md`.                                                                                                                                                                                                                                                                           | None. Those files ride the vendored snapshot; no Rook doc mirrors them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [#2111](https://github.com/cloudflare/agents/pull/2111) integration doc corrections                       | 0.21.0   | None; six `docs/agents/*.md` files.                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2115](https://github.com/cloudflare/agents/pull/2115) hono-agents WebSocket rejections                  | 0.21.0   | `hono-agents/src/index.ts` plus a new test suite.                                                                                                                                                                                                                                                                                                                                     | None. Rook does not use `hono-agents`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [#1948](https://github.com/cloudflare/agents/pull/1948) workflow `retention`                              | 0.21.0   | `RunWorkflowOptions.retention` in `workflow-types.ts`, forwarded to `workflow.create()` in `index.ts`.                                                                                                                                                                                                                                                                                | None. The `cloudflare:workers` shim's `WorkflowEntrypoint` throws `NotSupportedInBrowserHost`; no workflow runs here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#2116](https://github.com/cloudflare/agents/pull/2116) WebMCP React template                             | 0.21.0   | None; a new `examples/webmcp-react`.                                                                                                                                                                                                                                                                                                                                                  | None, and nothing to adopt. Noted because the standard it demonstrates began with the WebMCP extension this repository's author wrote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [#2125](https://github.com/cloudflare/agents/pull/2125) migration notes in the release changesets         | 0.21.0   | None; `.changeset/*.md`.                                                                                                                                                                                                                                                                                                                                                              | None directly. This is where the 0.21.0 changelog's migration tables come from, so it is the text to read before the next refresh, not a code change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#1995](https://github.com/cloudflare/agents/pull/1995) version packages                                  | 0.21.0   | None.                                                                                                                                                                                                                                                                                                                                                                                 | Release metadata. This is the commit the vendor pin now names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Two rows from the previous revision resolved as predicted: #2023's observer
cleanup and #2049's word separation arrived in the release without a
speculative backport, so no local fork was ever carried for either. #2037 also
resolved as predicted — the manager route shipped on the released routing
`prefix` seam, and the canonical builders remain a later simplification rather
than a dependency.

## Landed upstream, not yet released

Six first-parent commits sit on upstream `main` after `d4249450`. None is
vendored. They are listed so the next refresh starts from a known set, not to
suggest tracking `main`.

| PR                                                                                           | What landed                                                                                                                                                                                                                                                                                                     | Why it matters here                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#2071](https://github.com/cloudflare/agents/pull/2071) unconditional durable chat recovery  | Every chat turn runs in a recovery fiber; `chatRecovery` accepts `true` or a config object and **`false` is no longer supported** — compiled JavaScript that still passes `false` silently receives the default configuration. Touches `agents/src/index.ts`, `ai-chat/src/index.ts`, and `think/src/think.ts`. | The production agent already passes a config object (`think-host.worker.ts:3804`). Five test fixtures pass `chatRecovery = false` (`host/fixtures/{messenger-capability,messenger-pipeline,think,transport}.integration.test.ts` and `host/fixtures/browser/think-opfs.worker.ts`); at the next refresh those silently gain recovery instead of opting out, so plan `onChatRecovery()` returning `{ continue: false }` for them. |
| [#2120](https://github.com/cloudflare/agents/pull/2120) branch-local compactions             | Session compaction overlays stay scoped to their selected conversation branch, with deterministic ordering for overlays created in the same second. Touches `agents/src/experimental/memory/session/{session.ts,providers/agent.ts}`.                                                                           | `providers/agent.ts` is a retained fork file (the SQLite FTS/compaction triggers). Expect the next refresh's real conflict here, and re-verify that the trigger that deletes a session's compactions still agrees with branch-scoped overlays.                                                                                                                                                                                   |
| [#2059](https://github.com/cloudflare/agents/pull/2059) preserve orphaned execution outcomes | Orphaned durable execution outcomes become framework-authored notes projected into user context, so provider transcript validation cannot reject their position. Touches `think/src/think.ts`.                                                                                                                  | `think.ts` is the largest retained fork file. The behavior itself concerns durable execution outcomes, which this host still produces through Think.                                                                                                                                                                                                                                                                             |
| [#2131](https://github.com/cloudflare/agents/pull/2131) tracing capability check             | Falls back to no-op tracing when a Workers runtime exposes `tracing` without `startActiveSpan`. Touches `observability/tracing/cloudflare.ts`.                                                                                                                                                                  | The browser shim exports `tracing: undefined`, which already selects the no-op tracer; this makes the same fallback reachable from a partially present object.                                                                                                                                                                                                                                                                   |
| [#1978](https://github.com/cloudflare/agents/pull/1978) identify agent spans                 | Adds SDK and agent-identity attributes to SDK-created spans, in a new `observability/agent-span-attributes.ts` plus the `wrapper/` files #1994 created.                                                                                                                                                         | No product effect under a no-op tracer, same as #1994.                                                                                                                                                                                                                                                                                                                                                                           |
| [#2126](https://github.com/cloudflare/agents/pull/2126) submission status over RPC           | `agent-think` app only.                                                                                                                                                                                                                                                                                         | None.                                                                                                                                                                                                                                                                                                                                                                                                                            |
