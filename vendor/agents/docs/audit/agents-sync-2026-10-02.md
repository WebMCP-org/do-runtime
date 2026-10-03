# Agents 0.26 refresh audit

The package snapshot advances from
[`c076e4c9` (Agents 0.24)](https://github.com/cloudflare/agents/tree/c076e4c9ff6cfb72931085226edfd3ee7965ac48)
to [`74570a19` (Agents 0.26)](https://github.com/cloudflare/agents/tree/74570a19aafc676dd85831a31af047817e7bba12).
The target was the latest stable npm release checked on October 2, 2026.
The range contains 104 commits. Review covered their subjects, bodies and touched
paths plus the complete retained-package endpoint diff; integration used a
three-way merge against the exact old pin, not 104 independent cherry-picks.
The [commit disposition table](agents-0.26-commit-dispositions.csv) includes every
SHA, upstream link, scoped paths and integration decision. It distinguishes
repository-only work from imported package work and does not imply each commit
was tested separately.

The six package versions are Agents 0.26.0, Think 0.20.0, AI Chat 0.12.1,
Codemode 0.5.3, Voice 0.5.0 and Shell 0.4.3.
[VENDOR.md](../../VENDOR.md) is the authoritative pin;
[the live fork inventory](../fork-diff.md) lists retained responsibilities.

## Replacements and retained contracts

| Area              | Decision and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method identity   | Remove the fork's original-method WeakMap and override helper. Upstream Think snapshots declared members before wrapping and handles both override checks ([#2326](https://github.com/cloudflare/agents/pull/2326)).                                                                                                                                                                                                                                                                                                                                                      |
| React lifecycle   | Use upstream result-cleanup pre-dispatch guard and address-change reset ([#2403](https://github.com/cloudflare/agents/pull/2403), [#2394](https://github.com/cloudflare/agents/pull/2394)). Keep absent-subscriber buffering and remount overflow recovery.                                                                                                                                                                                                                                                                                                               |
| Deleted facets    | Use upstream noncreating lookup, descendant checks and proactive socket closure ([#2024](https://github.com/cloudflare/agents/pull/2024)). Keep consumed dropped-connect gate rejection.                                                                                                                                                                                                                                                                                                                                                                                  |
| Stream settlement | Adopt persist → canonical transcript → done ([#2327](https://github.com/cloudflare/agents/pull/2327)). Preserve canonical terminal metadata when the observer accumulator settles. Keep the last completed stream through enclosing recovery Task settlement; submission outcomes do not cover plain WebSocket turns.                                                                                                                                                                                                                                                     |
| Resume            | Use upstream replay sequence tracking ([#2348](https://github.com/cloudflare/agents/pull/2348)). Keep fork continuation-prefix descriptors for a cold remount, but never reset a prefix after the ledger has already applied it. Store/broadcast stays synchronous. Offers track their request owner, so unrelated terminals and stale ACKs cannot release them. Buffered replay precedes terminal delivery, including without an ACK; exclusions still apply. Think holds ACK-driven `done` until canonical publication, verified by pausing its real assistant cutover. |
| Recovery          | Adopt upstream separate retry/continue paths, transient/rate-limit routing, branch-aware regeneration and pending response-hook recovery. Remove the fork's unified recovery helper. Preserve durable Stop epochs, admitted-request receipts and accepted partial history. A callback delivery failure cannot rewrite an already-persisted completed turn as failed.                                                                                                                                                                                                      |
| Delegation        | Preserve atomic roster/snapshot/live tails, durable cancellation and structured child output. Compose upstream unstored IDs and terminal-only delivery with those snapshots: terminal snapshots carry no content; pending unstored events must not be dropped or reordered behind a later stored snapshot.                                                                                                                                                                                                                                                                |
| Transcript        | Preserve server timing, completed-assistant authority, lossless legacy migration, compaction broadcasts, reasoning fields and output head/tail policy. Adopt upstream one-to-one tool-call reconciliation, metadata writers, usage and stepped truncation; custom writers do not replace reserved persisted timing.                                                                                                                                                                                                                                                       |
| Browser runtime   | Preserve async syntax/constructor names, browser messenger leaves and Shell OPFS. Cold-RPC wrapping must continue distinguishing lowered async methods from synchronous methods. Sessions' new synchronous SHA-256 content hash requires a real browser crypto implementation in integration bundles.                                                                                                                                                                                                                                                                     |

## Dependencies and public API changes

Think now requires AI SDK 7, React SDK 4 and Agents >=0.25; AI Chat also raises
its Agents peer floor. The fork already used AI 7. The obsolete Chat AI peer
exception is removed because Chat 4.38 accepts AI 7. The maintained Babel 7
exception remains covered by browser tests. Workers types advance to
5.20261002.1; the root runtime owns the deployed Workers toolchain update.

Agents adds optional `@earendil-works/pi-ai`, `pi-durable` and AI provider peers,
framework-neutral model transports and the Pi harness. The final export is
`agents/harness/pi`, after an intermediate plural namespace. These additions
are imported with the release; existing consumers do not opt into Pi merely by
upgrading. Model tests use mock transports and require no provider credentials.

The persistent `Browser` capability and session connector are additions. No
package export subpath was removed from the retained six-package closure.
`CdpSession` remains a deprecated alias of `CdpConnection`, and the existing
`agents/browser/ai` entry point remains available. The new tool entry points are
`agents/browser/ai-sdk` and `agents/browser/tanstack-ai`. The deleted interaction
contract was explicitly unexported, as documented by
[the upstream revert](https://github.com/cloudflare/agents/commit/9aec847d4ba2e0999ecf214346190f8061adb4e4);
it does not require a public-API migration. The TanStack adapter preserves
literal tool names and the browser input contract with maintained 0.54 types.

Cold asynchronous RPC calls now initialize before executing; synchronous methods
retain synchronous semantics. Native RPC consumers using unnamed Durable Object
IDs must use named addressing for initialization, just as routed entry points
already require. Existing examples use named objects.

## Storage and rollout

Upgrades are forward-only. Downgrading package pins against an upgraded actor
database is unsupported; rollback machinery and downgrade/re-upgrade tests are
outside this fork's maintenance scope. Keep the forward migrations that read
existing state, messages and queued work without losing data.

The 0.24 → 0.26 migrations add nullable Sessions `content_hash`, Think submission
message identity, parent/child Agent-tool `event_delivery`, and legacy fiber
`completed_at`, `outcome` and `error_message` columns. Existing rows remain
readable; timestamp-aware fork decoding stays intact. No additional destructive
migration is introduced by this refresh.

The downgrade findings remain historical evidence for this policy. A 0.24
Sessions update changes content without updating `content_hash`; 0.26 then
trusts a matching non-null digest and can incorrectly skip a later update.
[The digest change](https://github.com/cloudflare/agents/commit/040458edb8f2c87a25e5ac446709054a5f553e14)
and the prior update statement establish that limitation. Similarly, 0.24 does
not understand a completed legacy-fiber marker left after failed cleanup and
can rerun its recovery hook. These findings do not create a pending rollback
implementation project.

The existing 0.24 forward migration remains a rollout constraint: legacy
schedules and queues move into Lifecycle jobs, the old Think workflow-notification
outbox is removed, and invalid legacy queue payloads require the fork's
preservation policy. Deployments already on the recorded 0.24 pin have passed
that boundary; older deployments must account for it before skipping directly
to 0.26. The lossless forward migrations and their regressions remain maintained.

## Optional evaluation runner exclusion

The fork excludes Evalite, the `packages/agents/evals/` credentialed scheduling
evaluation, and its `evals` command. This was the runner's sole consumer in the
retained package closure and was outside the deterministic SDK gate. Maintaining
its separate application dependency graph to fix development-server advisories
would add work without exercising this fork's runtime contracts.

The local workspace manifests and Agents package snapshot own this exclusion.
Future upstream syncs must continue to omit the runner, evaluation file and
command. Runtime scheduling and its deterministic regressions remain in scope;
[the live fork inventory](../fork-diff.md#local-maintenance-policy) records the
same boundary. This removal closes the optional-tooling decision rather than
leaving an Evalite upgrade or replacement on the maintenance backlog.

## Verification

The maintained gate now includes all 34 chat unit files, cold native RPC,
browser capability/connector and model transport suites, four new AI Chat wire
regressions, and seven new Think metadata, prompt-cache, terminal-order,
channel and origin-ID suites. Native final runs use the October 2 workerd binary
through `MINIFLARE_WORKERD_PATH`; the pool package otherwise bundles an older
binary.

The final root `sdk:test` run passes all 3,161 tests in the maintained gate after
the security overrides and pending-resume ownership/terminal-order fixes:

| Suite         | Files | Tests |
| ------------- | ----: | ----: |
| React         |    10 |   103 |
| Shared chat   |    34 |   639 |
| Agents        |    50 |   989 |
| AI Chat       |    11 |   111 |
| Think         |    27 | 1,032 |
| Voice         |     1 |    21 |
| Shell         |     2 |   194 |
| Think browser |     6 |    64 |
| Shell browser |     1 |     8 |

Think includes all 105 messenger tests. The final `sdk:check` also passes all six
package export checks, formatting, lint and TypeScript checks. These are the
maintained suites named in `package.json`, not an exhaustive upstream test run;
provider-backed integrations and the optional Pi harness were not exercised by
this gate. Downgrade/re-upgrade is outside the forward-only support policy.

Final review restored the pre-stream admission cleanup around a failed terminal
record deletion. Its new regression failed before the restoration and then
passed with all 28 onconnect tests on the same October 2 binary. It proves that
the identical request can retry and persist one user/assistant pair after the
failure, with neither a stranded claim nor retained origin IDs. This adds one
regression after the 3,161-test full run above; focused formatting, lint and
Think TypeScript checks also pass.

The separate native Browser connector E2E gate also passed all 24 tests with
`--retry=0` and the October 2 binary. It starts real local `wrangler dev` with
the Browser Rendering simulator and Worker Loader, exercising CDP execution,
persistent named sessions, pause/resume and multi-socket lifecycle behavior.
Its teardown initially killed the Vitest worker after the tests passed because
`lsof -ti tcp:<port>` selected connected clients as well as the server. The
maintained harness restricts cleanup to `-sTCP:LISTEN`; the rerun exited cleanly,
and the dedicated port was free before and after. No credentials or remote
Cloudflare resources were required.
