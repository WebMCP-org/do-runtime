# Agents 0.27 refresh audit

The package snapshot advances from
[`74570a19` (Agents 0.26)](https://github.com/cloudflare/agents/tree/74570a19aafc676dd85831a31af047817e7bba12)
to [`e3351863` (Agents 0.27)](https://github.com/cloudflare/agents/tree/e335186331f99be12609a5eb0c64c7863c3ccafd).
The target was the latest stable npm release checked on October 8, 2026.
The range contains 34 commits; 28 touch the retained packages. Review covered
their subjects, bodies and touched paths plus the complete retained-package
endpoint diff; integration used a three-way merge against the exact old pin.
The [commit disposition table](agents-0.27-commit-dispositions.csv) lists every
SHA, upstream link, scoped paths and integration decision. It does not imply
each commit was tested separately.

The six package versions are Agents 0.27.0, Think 0.20.1, AI Chat 0.12.1,
Codemode 0.5.3, Voice 0.5.0 and Shell 0.4.3.
[VENDOR.md](../../VENDOR.md) is the authoritative pin;
[the live fork inventory](../fork-diff.md) lists retained responsibilities.

## Merge result

The endpoint diff touches 272 package files: 161 additions, 75 deletions and 36
modifications. 24 modified files were baseline-identical in the fork and
fast-forwarded. Eight merged without conflicts and were read against fork
divergences. Four conflicted:

| File                                     | Resolution                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `think/src/think.ts`                     | Upstream replaced the continuation `finally` body with `_settleContinuationTurn` ([#2495](https://github.com/cloudflare/agents/pull/2495)). The fork's idempotent `finish` runs from both the turn body and the admission promise. It keeps its ownership guard, which returns once Stop's `clearAll` released both slots, then calls the helper. |
| `think/src/tests/agents/client-tools.ts` | `beforeTurn` keeps the fork's `_lastTurnMessagesJson` capture and adds upstream's continuation-start latch.                                                                                                                                                                                                                                       |
| `agents/package.json`                    | Upstream's new OpenCode, Pi TUI and highlight.js entries are added beside the fork's newer dependency floors.                                                                                                                                                                                                                                     |
| `think/package.json`                     | Upstream's harness-compat scripts are added; the fork's browser test script stays and its removed `test:e2e` stays removed.                                                                                                                                                                                                                       |

Three deleted first-pass Channels tests differed from the base only by formatter
output. The clean `chat/react.tsx` merge adds upstream's close-time release of
streaming protection ([#2496](https://github.com/cloudflare/agents/pull/2496)).
The fork already resets that protection when the socket reopens, so all five
#2464 regressions pass with or without the new line; it is kept for parity.

The previous refresh imported package source but not the upstream package
documentation that each build copies into `packages/*/docs`. This refresh
three-way merges `docs/{agents,think,codemode,shell,voice}` from their recorded
0.24 base to 0.27, keeping the fork's documentation edits. This removes the
first-pass Channels page and adds model, harness, Web Search and multi-chat pages.

## Breaking and behavior changes

Every `agents/channels*` export is removed
([#2429](https://github.com/cloudflare/agents/pull/2429)). Slack, Telegram and
Email ingress move to `agents/experimental/channels/{slack,telegram,email}`;
`ChannelHost`, fallback/fanout and the Voice, AI SDK and TanStack AI helpers
have no replacement. The fork did not use these paths. Think's messenger
channels and `configureChannels()` are unrelated and unchanged.

`MCPClientManager.removeServer()` and `Agent.removeMcpServer()` now delete that
server's saved OAuth tokens, client information, verifiers and discovery state,
or call `invalidateCredentials("all")` on a custom provider
([#2475](https://github.com/cloudflare/agents/pull/2475)). A host that removes
and re-adds the same server ID must expect a fresh registration and
authorization.

`browserTool` uses its own description, defaults to a 60-second run timeout
and fails a screenshot result above 1 MB with guidance
([#2488](https://github.com/cloudflare/agents/pull/2488)). `WebSockets.use`
adds handlers that run before configured handlers and may claim a message.

Agents adds opt-in `agents/harness/{ai-sdk,think,container,opencode,store}`,
`agents/models/opencode`, `agents/websearch{,/pi,/ai-sdk,/tanstack-ai}`,
experimental Channels entry points, and an `agents` CLI bin whose dependencies
are bundled into `dist/cli.js`. New optional peers are `@opencode/plugin` and
`@opencode/sdk`. The container harness build embeds a generated daemon bundle;
it is gitignored and excluded from formatting and lint, matching upstream.

TanStack AI 0.54 types the new Web Search tool like the browser tool: its type
test uses `AnyServerTool`, and its failure test wraps an `execute` result typed
`unknown`. Workers types advance to 5.20261009.1 with the runtime oracle.

## Storage and rollout

Upgrades remain forward-only. This refresh adds no migration for existing
Agent, Think, Sessions, Streams, Tasks or MCP storage. Streams now rechecks that
the legacy v1 chunk table still exists before folding or deleting from it.
`removeServer` deletes KV keys for the removed server only. New harnesses and
Channels create their own prefixed tables only when a host installs them.

## Verification

The maintained gate adds the Streams capability, Web Search and MCP client
manager suites to `test:agents`, and the AI Chat React hook suite to
`test:ai-chat`. The OpenCode model transport suite joins through the existing
`src/tests/models/` entry. Native runs use the October 9 workerd binary through
`MINIFLARE_WORKERD_PATH`.

The final root `sdk:test` run passes all 3,519 tests in the maintained gate:

| Suite         | Files | Tests |
| ------------- | ----: | ----: |
| React         |    10 |   103 |
| Shared chat   |    34 |   639 |
| Agents        |    54 | 1,237 |
| AI Chat       |    11 |   111 |
| AI Chat React |     1 |   106 |
| Think         |    27 | 1,036 |
| Voice         |     1 |    21 |
| Shell         |     2 |   194 |
| Think browser |     6 |    64 |
| Shell browser |     1 |     8 |

Outside the maintained gate, the experimental Channels and AI SDK harness
suites (`src/tests/channels/`) passed with the candidate suites above: 28 files,
711 tests. Container, OpenCode and Think harness suites, x402 and provider-backed
integrations were not run.
