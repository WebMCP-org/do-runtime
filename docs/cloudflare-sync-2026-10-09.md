# Cloudflare refresh — October 9, 2026

This refresh advances the runtime oracle to
[workerd 1.20261009.1](https://github.com/cloudflare/workerd/releases/tag/v1.20261009.1)
and the six-package SDK fork to
[Agents 0.27.0](https://github.com/cloudflare/agents/tree/e335186331f99be12609a5eb0c64c7863c3ccafd).
Think is 0.20.1; AI Chat 0.12.1, Codemode 0.5.3, Voice 0.5.0 and Shell 0.4.3
are unchanged. Workers types are 5.20261009.1 in the runtime, both examples and
the SDK workspace.

## Review and implementation

The [workerd audit](workerd-sync.md) covers all 124 intervening commits, with a
[complete disposition table](workerd-sync-2026-10-09.csv). The runtime ports
`spanContext()` on untraced spans. The experimental Durable Object snapshot API
is recorded with the oracle's measured errors rather than shimmed; the client
WebSocket lifetime fixes, retry diagnostics, TypeScript streams and V8
startup-snapshot work have no local counterpart.

The [SDK audit](../vendor/agents/docs/audit/agents-sync-2026-10-09.md) covers all
34 intervening commits, 28 of which touch the retained packages. Four files
conflicted. Think's continuation-settlement fix
([#2495](https://github.com/cloudflare/agents/pull/2495)) is composed behind the
fork's Stop-aware ownership guard, so Stop still releases both continuation
slots. An independent three-way review of every non-fast-forward file found no
mis-merge. The [fork inventory](../vendor/agents/docs/fork-diff.md) records the
remaining owners.

## Dependency work

Wrangler refreshes within range to 4.148.0; 4.149.0 was inside the release-age
window. `@cloudflare/vitest-pool-workers` moves to 0.23.0, which only adds a
deprecation notice for its rename to `@cloudflare/vitest-plugin`; that move is a
separate follow-up. The SDK workspace keeps its existing pool and Wrangler pins.
The root lockfile keeps rolldown 1.2.8: a re-resolution to 1.2.9 made the Think
browser-test config, which imports the root Vite plugin, exceed TypeScript's
type depth against the SDK workspace's 1.2.8.

## Verification

| Gate | Result |
| --- | --- |
| Runtime unit suite | 1,022 passed |
| Native workerd conformance | 83 passed |
| Node conformance | 83 passed |
| Chromium conformance | 96 passed |
| Transformed Node / Chromium conformance | 83 passed in each lane |
| SDK regression gate | 3,519 passed: React 103, chat 639, Agents 1,237, AI Chat 111, AI Chat React 106, Think 1,036, Voice 21, Shell 194, browser 72 |
| SDK exports, formatting, lint and TypeScript | Passed |
| Runtime and example TypeScript | Passed |
| Dependency installation and oracle | Both frozen installs and all four Workers type pins passed |
| Runtime package | Build, publint, declaration checks and installed-package smoke passed |
| SDK packages | All six release tarballs packed |
| Extension and vibe-platform Chromium journeys | Passed, including the exported Worker deployment dry run |

The new experimental Channels and AI SDK harness suites passed once outside the
maintained gate. Container, OpenCode, Think-harness, x402 and provider-backed
suites were not run.

## Rollout

No storage migration is added; the forward-only policy is unchanged.

- **Channels:** every `agents/channels*` export is removed; ingress adapters
  move to `agents/experimental/channels/*`. Neither this repository nor Rook
  imports them.
- **MCP removal forgets credentials:** `removeMcpServer()` now deletes the
  server's saved OAuth tokens, client information and discovery state
  ([#2475](https://github.com/cloudflare/agents/pull/2475)). A host that removes
  and re-adds a server to recover from a transient failure will send the user
  through authorization again. Rook's `#connectMcpConnector` does this for
  `failed` and `not-connected` servers and must reconnect in place instead.

No release was published and no application deployment or stored user data was
modified by this refresh.
