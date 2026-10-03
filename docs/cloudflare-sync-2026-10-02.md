# Cloudflare refresh — October 2, 2026

This refresh advances the runtime oracle to
[workerd 1.20261002.1](https://github.com/cloudflare/workerd/releases/tag/v1.20261002.1)
and the six-package SDK fork to
[Agents 0.26.0](https://github.com/cloudflare/agents/tree/74570a19aafc676dd85831a31af047817e7bba12).
Think is 0.20.0, AI Chat 0.12.1, Codemode 0.5.3, Voice 0.5.0 and Shell 0.4.3.
Workers types match the oracle in the runtime, both examples and SDK workspace.

## Review and implementation

The [workerd audit](workerd-sync.md) covers all 688 intervening commits, with a
[complete disposition table](workerd-sync-2026-10-02.csv). The runtime ports
multi-observer output-gate failure, SQLite's 8 MiB plus 34-byte limit, and the
tracing name/status API. Unsupported distributed retry behavior remains outside
the local host contract.

The [SDK audit](../vendor/agents/docs/audit/agents-sync-2026-10-02.md) covers all
104 intervening commits. It records the exact merge base and target, imported
APIs, storage implications and reasons for retaining each local behavior.
Upstream replaces the original-method helper, React cleanup guard and most
deleted-facet routing patches. The [fork inventory](../vendor/agents/docs/fork-diff.md)
records the remaining owners and retirement conditions.

Integration fixes preserve completion metadata, Stop and cancellation evidence,
lossless stored/live replay, terminal-only delivery, and bounded recovery reads.
Browser compilation preserves async method identity so cold asynchronous RPC
initializes correctly while synchronous methods remain synchronous. Both
examples use a real browser implementation for Sessions' synchronous hashing.
The extension recovery assertion now checks one canonical assistant message
and its exact durable prefix plus continuation.

The root `sdk:test` command selects the same workerd binary as conformance.
The maintained SDK gate includes the new cold-RPC, model, browser capability,
terminal-order, metadata, prompt-cache and address-change regressions.

## Dependency work

The [security review](dependency-security.md) records every exact override,
advisory source, remaining dependency path and audit count. Compatible fixes
apply to the installed major versions. The pool and Wrangler remain on their
existing compatible versions; updating Wrangler alone would leave the pool's
older transitive copies installed. The export checker uses Node's built-in glob
instead of an otherwise-unused dependency.

The optional Evalite runner and its single credentialed scheduling evaluation
were removed after the user delegated that decision. Neither was part of the
maintained regression gate. This removes the remaining high and moderate
development-tooling advisories and two obsolete overrides without adding a
replacement framework. Runtime scheduling and its deterministic tests remain.
The lockfile drops 76 package versions and adds none; both workspaces now report
only the existing low-severity elliptic finding.

## Verification

| Gate | Result |
| --- | --- |
| Runtime unit suite | 1,022 tests passed |
| Native workerd conformance | 82 passed |
| Node conformance | 82 passed |
| Chromium conformance | 95 passed |
| Transformed Node / Chromium conformance | 82 passed in each lane |
| SDK regression gate | 3,162 passed in Linux CI: React 103, chat 639, Agents 989, AI Chat 111, Think 1,033, Voice 21, Shell 194, browser 72 |
| Final admission-failure regression | All 28 reconnect tests passed, including a new test proving an identical request can retry after terminal-state cleanup fails |
| Native browser connector | 24 passed with the local Browser Rendering simulator; teardown now targets only listening processes |
| SDK exports, formatting, lint and TypeScript | Passed for the maintained six-package closure |
| Evalite removal follow-up | Both frozen installs, all six SDK builds, `sdk:check` and 70 retained scheduling tests passed; fresh audits have no high or moderate findings |
| Runtime and example TypeScript | Passed |
| Runtime package | Build, publint, declaration checks and installed-package smoke passed |
| SDK packages | All six release tarballs packed; export targets exist and release dependency ranges contain no workspace/file references |
| Dependency installation and oracle | Both frozen lockfile installs and all four Workers type pins passed |
| Extension Chromium journey | Passed, including exact recovery content, Stop, host recreation and alarm watchdog |
| Vibe platform | Production build and Chromium journey passed, including exported Worker deployment dry run |

The tracing getter follow-up was verified separately in all three ordinary
conformance lanes after the full runtime gate. Windows launcher syntax was
reviewed; Windows execution was not tested. These are maintained
regression gates, not every optional upstream evaluation or live-provider test.

## Rollout policy

The release can proceed for existing 0.24 consumers without a browser export
migration: no retained package subpath was removed, `CdpSession` remains an
alias, and the deleted interaction contract was unexported. Think's AI 7 / React
SDK 4 peer floor already matches this fork. Native RPC users with unnamed
Durable Object IDs must adopt named addressing.

- **Forward-only upgrades:** the user explicitly chose not to support
  downgrades of migrated stores. Fixes roll forward; no downgrade compatibility
  layer or rollback project will be added. Existing forward migrations remain
  necessary to preserve stored user data during upgrades. Old 0.24 writes can
  leave the new Sessions content digest stale, and old recovery code does not
  recognize completed legacy-fiber markers. The
  [SDK audit](../vendor/agents/docs/audit/agents-sync-2026-10-02.md#storage-and-rollout)
  retains the exact source and scope of those unsupported downgrade behaviors.
- **Optional evaluation tooling:** remove Evalite and its optional live-model
  scheduling sample. The remaining low-severity browser-crypto finding is
  recorded in the security review; there is no pending Evalite migration.

No release was published and no application deployment or stored user data was
modified by this refresh. Work was isolated from the original checkout's
uncommitted README, lint configuration, package and tooling edits.
