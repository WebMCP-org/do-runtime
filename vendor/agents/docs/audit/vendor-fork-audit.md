# Current SDK fork audit

Audited 2026-09-11 (Pacific), including the fixes below. The footprint compares
the current source against the released upstream baseline in
[VENDOR.md](../../VENDOR.md). Three parallel reviews traced Rook browser seams,
SDK chat/delegation, and SDK platform/integration changes through real callers
and existing tests. The [current inventory](../fork-diff.md) records each live
behavior once. Historical measurements and release-by-release reasoning remain
in [Git history](https://github.com/WebMCP-org/do-runtime/blob/ff87e9ef1d38f8beaa579b3a53d445e62df96837/vendor/agents/docs/audit/vendor-fork-audit.md).

## Findings

The ledgers overstated the live surface by retaining removed implementations
and superseding corrections. No retained correctness patch was proved safely
deletable from the **currently pinned** SDK. That is not proof every patch is
minimal: the audit found a missed sibling caller, an inherited React cleanup
failure and a continuation replay gap. All three now have failing-before,
passing-after regressions and fixes at their existing SDK owners.

| Priority                       | Evidence                                                                                                                                                                                                                                                                                                                                        | Smallest next action                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method identity — fixed        | The real native `chat()` regression emits two provider errors with reactive recovery enabled and the inherited default classifier. Before the fix, the expected one-time warning never fires. [#2165](https://github.com/cloudflare/agents/issues/2165#issuecomment-5629567318) describes the same sibling comparison.                          | Both skills and reactive overflow now use `_isAgentMethodOverride`. The regression and all 209 native Think Session tests pass with retries disabled; no second wrapper strategy.                                                                                                                                                                                                                                          |
| React cleanup dispatch — fixed | A long unthrottled stream, one queued socket task per frame, and a busy transcript reproduce `Maximum update depth exceeded` through the real hook. The unconditional cleanup dispatch remains in the audited upstream; [#2217](https://github.com/cloudflare/agents/issues/2217) supplies the exact lead.                                      | Check the committed map before dispatch and include it in effect dependencies. The functional updater filters current state, preserving concurrent results still in history. The long-stream and public result-retention/pruning checks pass; all 11 related React tests pass. The replay-burst check waits for the replayed prefix before live data instead of requiring a 20 ms paint; throttle is unchanged.            |
| Continuation replay — fixed    | A real hook remount reproduced duplicate live text, reasoning and tool parts through both transport resume and observer replay. Native Think and AI Chat tests verify the producer boundary; a stale replay also reproduced transcript loss. [#1951](https://github.com/cloudflare/agents/issues/1951) describes the same continuation overlap. | Store the assistant ID and original part lengths in the existing continuation start chunk. Restore that prefix at the transport snapshot or accumulator seed boundary, after request ownership checks. Plaintext and SSE consumers need a text-start even when server persistence reuses a text part. Legacy chunks without the descriptor remain readable with their prior behavior; no row rewrite or storage migration. |
| Upstream owner simplification  | Agents 0.23 / Think 0.18 introduce Streams, Tasks recovery, Sessions and derived progress. The old per-chunk KV progress counter disappears upstream.                                                                                                                                                                                           | Upgrade the package closure coherently, then run retained replay/Stop/storage tests against the new owners and remove replaced mechanisms. Preserve store/broadcast ordering; the new producer still awaits an async helper.                                                                                                                                                                                               |
| Product default in SDK         | Think hardcodes `keepRecent: 2`, versus upstream's 4. The old objection about adding a typed option predates consumption of built fork packages.                                                                                                                                                                                                | Expose a narrow upstreamable option and let Rook select 2 when changing this policy. Keep head/tail truncation separate from opaque provider-output correctness.                                                                                                                                                                                                                                                           |

The fixes stay in the SDK owners. They add no Rook shim, transcript store or
application storage migration. Package publication and consumer verification
use the gates below.

## Measured production footprint

| Package   | Changed source files | Added lines | Removed lines |
| --------- | -------------------: | ----------: | ------------: |
| Agents    |                   26 |       2,631 |           598 |
| AI Chat   |                    1 |          85 |            39 |
| Think     |                   15 |       2,510 |         1,130 |
| Voice     |                    3 |          75 |            27 |
| Shell     |                    9 |       1,917 |            80 |
| Codemode  |                    0 |           0 |             0 |
| **Total** |               **54** |   **7,218** |     **1,874** |

These are textual differences, not a count of independent patches or removable
code. Thirteen new browser-messenger/OPFS files account for 2,631 added lines;
those implementations moved out of Rook and now have one SDK owner. Tests,
fixtures, declarations outside `src`, build scripts, manifests, dependencies and
documentation are excluded. Removing an unused upstream skill integration also
counts as a source difference. The six-package build/export configuration
remains part of the maintained surface even though it is excluded here.

Measured with `git diff --no-index --numstat`, one file at a time, between
upstream `676b3d35a82db3147c7aa1505f7f2d5ef48f359b` and this fork. Include
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` under the six `packages/*/src` trees;
exclude paths with `test` or `fixture` in any component and `__mocks__`.
Count files present on only one side against `/dev/null`. This classification
was independently recounted and cross-checked against all retained source rows.
For refreshes, compare against the exact release, not a moving `main`.

## Upstream research

Source and issue comments were checked directly on GitHub. The latest release
at audit time was
[Agents 0.23.0](https://github.com/cloudflare/agents/releases/tag/agents%400.23.0),
with Think 0.18.0, at
[`5f7ad7e4`](https://github.com/cloudflare/agents/tree/5f7ad7e4edac2ec8dd1d6a31758f251cb52373fa).
Main was
[`43a58a10`](https://github.com/cloudflare/agents/tree/43a58a1014fbe6f1fe3a1fcc38ad08d53bb5b112).
An issue being closed is not enough: match its reproduction, changed owner and
release inclusion to the retained behavior.

| Primary source                                                                                                                                                                                                                                                                            | What it establishes                                                                                                                                                                | Decision for this fork                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#1951 continuation replay](https://github.com/cloudflare/agents/issues/1951)                                                                                                                                                                                                             | Open; contributor recommends immutable pre-continuation seed or segment identity.                                                                                                  | Producer-declared boundaries restore the exact prefix for transport and observer remounts. Legacy starts retain their prior behavior.                                                                                                |
| [#1733 / #1742 duplicate resume](https://github.com/cloudflare/agents/issues/1733), [#1837 / #1838 finalizer overlap](https://github.com/cloudflare/agents/issues/1837), [#1361 burst updates](https://github.com/cloudflare/agents/issues/1361)                                          | Older closed reports: #1742/#1838 fixes precede our baseline; #1361 was closed as apparently resolved without identifying a fix. Similar symptoms do not establish the same cause. | Do not restore extra ACK guards, initial-loader workarounds or explicit throttle defaults. They do not close #2217.                                                                                                                  |
| [#2217 React cleanup](https://github.com/cloudflare/agents/issues/2217), [contributor change](https://github.com/Konan69/agents/commit/ce283f35)                                                                                                                                          | Open; the reporter identifies unconditional cleanup dispatch. A queued-task long-stream reproduction confirms the same failure in our real hook.                                   | Fixed with a pre-dispatch stale-entry check, a functional updater over current results and complete dependencies. The regression verifies stream completion; a public-hook check preserves visible results and prunes removed calls. |
| [#2166 terminal snapshot](https://github.com/cloudflare/agents/issues/2166)                                                                                                                                                                                                               | Open; suggests a text-prefix mitigation for accumulator/replay overlap.                                                                                                            | Do not add it: text prefixes cannot establish reasoning/tool identity. Prevent duplicate producers and test terminal reconciliation.                                                                                                 |
| [#1983 optimistic user snapshot](https://github.com/cloudflare/agents/issues/1983)                                                                                                                                                                                                        | Open; visible optimistic messages can be erased by reconnect snapshots.                                                                                                            | A trailing-user merge concerns UI reconciliation, not server request acceptance; it cannot replace the outbox.                                                                                                                       |
| [#2132](https://github.com/cloudflare/agents/issues/2132), [#2196 Sessions](https://github.com/cloudflare/agents/pull/2196)                                                                                                                                                               | Closed via the new released Sessions change feed; comments separate additional sync/reparent cases.                                                                                | Evaluate the new owner. Do not import private `_syncMessages`/`_broadcastMessages` overrides into Rook.                                                                                                                              |
| [#2173 Streams](https://github.com/cloudflare/agents/pull/2173), [#2194 Tasks recovery](https://github.com/cloudflare/agents/pull/2194), [#2216 atomic cutover](https://github.com/cloudflare/agents/pull/2216), [#2223 derived progress](https://github.com/cloudflare/agents/pull/2223) | Released structural replacements for stream/session/recovery storage and bookkeeping.                                                                                              | Real opportunity to remove old machinery on a coherent upgrade. Keep acceptance, replay ordering and cancellation regressions as the contract.                                                                                       |
| [#2165 method identity](https://github.com/cloudflare/agents/issues/2165)                                                                                                                                                                                                                 | Open; discussion identifies both the skills warning and reactive-overflow sibling comparison. The native regression confirms the missing warning.                                  | Fixed both callers with the existing original-method helper; no second wrapper layer. All 209 Think Session tests pass.                                                                                                              |
| [#2206 / #2233 facet connect state](https://github.com/cloudflare/agents/pull/2233)                                                                                                                                                                                                       | Released fix waits queued connection operations after `onConnect`.                                                                                                                 | Keep that fix on upgrade. It replaces none of our refusal, deleted-child, cleanup or no-resurrection guards; those move to `DynamicAgentsInternal`.                                                                                  |
| [#1677 native facet history](https://github.com/cloudflare/agents/issues/1677)                                                                                                                                                                                                            | Later comments confirm upstream #1679 fixed the original reproduction, before our baseline.                                                                                        | Do not revive earlier suggestions to write internal SQL, clear context or defer mounting the socket.                                                                                                                                 |
| [#1894 routing](https://github.com/cloudflare/agents/issues/1894#issuecomment-5255204682)                                                                                                                                                                                                 | Maintainer recommends separate conversation DOs and discusses Worker-level routing.                                                                                                | Aligns with Rook's namespace conversation ownership; no need for a second session overlay.                                                                                                                                           |
| [#2106 recovered delivery](https://github.com/cloudflare/agents/issues/2106), [#1842 repeated apology](https://github.com/cloudflare/agents/issues/1842)                                                                                                                                  | Related messenger recovery reports remain distinct from live completion/capability lifetime.                                                                                       | Do not overclaim the retained delivery hooks solve every recovery route.                                                                                                                                                             |
| [#1849 voice settlement](https://github.com/cloudflare/agents/issues/1849), [#2225 voice/channel move](https://github.com/cloudflare/agents/pull/2225)                                                                                                                                    | Response-pipeline settlement workaround is a different boundary; new release moves Voice ownership.                                                                                | Port final-audio flush/error/meter contracts to `agents/channels/voice`; do not add the unrelated settled-promise workaround.                                                                                                        |
| [#2179 State capability](https://github.com/cloudflare/agents/pull/2179)                                                                                                                                                                                                                  | Main-only at audit time; moves the old corrupt-row fallback into `agents/state`.                                                                                                   | A new port target, not a lossless migration fix. Keep the single application migration hook and untouched-row-on-failure contract.                                                                                                   |
| [#2014 truncation](https://github.com/cloudflare/agents/issues/2014), [#1997 persistence failure](https://github.com/cloudflare/agents/issues/1997)                                                                                                                                       | Open reports suggest host before-step restoration and an external database retry.                                                                                                  | Do not stack those workarounds here. Fix opaque output at its SDK owner; external Postgres retry is not evidence for a native Agent SQL retry layer.                                                                                 |

No exact upstream browser-messenger or Shell OPFS replacement was found.
Storage-extensibility issue [#1554](https://github.com/cloudflare/agents/issues/1554)
is not an OPFS implementation. Rook's own current shim inventory covers MCP
browser-validator and AI SDK multipart-media issue findings; those are separate
upstream repositories and local package-resolution/provider boundaries.

## Upgrade and verification boundary

Keep a behavior only if its caller and regression still require it after an
upstream refresh. Do not mechanically replay chronological commits around new
Streams, Sessions, Tasks, DynamicAgents or State owners. Preserve frozen released
storage fixtures; a failed fixture calls for a migration, not regeneration.
Tests for request acceptance, ordinary and continuation replay, Stop with a
possibly live child, retained tails, malformed state and browser callback context
are the deletion criteria.

Run the actual scripts in `vendor/agents/package.json`: `pnpm build && pnpm check
&& pnpm test`, then root runtime conformance/examples/package checks. Rook
verifies the built SDK package release and its browser/application contracts.
Its UI must not carry a second dedupe or storage migration implementation.

The audited runtime source previously passed
[SDK CI 34626049531](https://github.com/WebMCP-org/do-runtime/actions/runs/34626049531)
and Rook's pin passed
[CI 34665711668](https://github.com/WebMCP-org/rook/actions/runs/34665711668).
Those runs establish the pre-fix tested baseline. The SDK
fixes have the local red/green checks described above; publishing
them still requires the owning package gates. Documentation edits require
formatting and link checks.
