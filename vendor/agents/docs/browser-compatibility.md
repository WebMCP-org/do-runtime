# Current browser integrations

Keep DO/Agents/Shell behavior and its browser regressions here; keep Rook's
configuration, UI, workspace identities and Chrome policy in the host. Prefer
an upstream implementation plus a measured browser shim over a copied runtime.

## Channels

[Browser messengers](think/browser-messengers.md) extracts the native Slack and
Discord clients and their adapter shims. The tests cover socket retirement,
reconnect/resume, token checks, thread parents, HTTP failures, attachments and
real Worker module loading. Think continues to own channel policy and delivery.
Consumers import the browser leaves directly. Host configuration and live
Chrome resources remain in Rook; these transports have no Chrome dependency.

## Async context

`@mcp-b/do-runtime/browser/async-hooks` supplies independent ALS scopes and
static snapshots. The opt-in Vite await transform lowers async functions and
generators so continuations can capture those scopes; native browser `await`
cannot be shimmed by replacing `Promise.then` alone. Runtime admission, reentry,
critical sections and timers preserve callback context. Think also snapshots its
admitted turn when preparing inference options and binds model callbacks and
tool iterator operations: native stream callbacks can begin outside that scope.

The Think Chromium suite overlaps entries in one actor and separate actors,
checks `getCurrentAgent()` after suspension/rejection, and consumes traced
async generators from a different scope, including awaited early-return cleanup.
Real AI SDK mock-model streams also overlap ordinary and streaming tool turns,
checking inference hooks and resumed tool bodies. The native test caller checks
that no actor context leaks out. See
[the runtime setup and limits](../../../docs/browser-async-context.md).

## Outbound MCP and OAuth

`examples/extension/scripts/e2e.mjs` now connects the real built Agents MCP client
to a local protocol fixture inside an actual MV3 Worker. It lists tools, calls
three servers, rejects schema-invalid structured output, completes two OAuth
flows concurrently, and checks two overlapping PKCE scopes on the same provider.
Callback SQL writes prove that callbacks enter through `ActorContainer.fetch`.
The host explicitly supplies its outbound fetch port; actor fetches retain gate
and response-body handling.

The SDK already selects its worker-safe JSON Schema validator. No AJV-provider
alias is needed by this outbound client fixture, which runs under ordinary MV3
CSP without `unsafe-eval`. This does not prove that every other import of the MCP
SDK avoids AJV: audit each consumer's reachable server and sandbox modules
before removing an alias.

References: [Chrome MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[MCP tool output validation](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
and [MCP authorization and PKCE](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
Only the remote provider is a fixture; the SDK client, OAuth provider, actor
storage, network transport, browser and CSP are real.

## Shell OPFS

`@cloudflare/shell/browser` exports `OpfsWorkspace({ root })` over a host-selected
native directory. It reuses Shell path/glob/MIME helpers and plugs into the
existing `WorkspaceFileSystem` and `WorkspaceStateBackend` wrappers.
Mount registries, storage identities and `/mcp` projections remain in Rook.

The Chromium suite runs in dedicated Workers against real OPFS: shared filesystem
contracts, arbitrary bytes and UTF-8 paging, symlinks, listing/globs, copy/move,
concurrent writers, malformed metadata, and preservation after failed writes,
stream cancellation and append failures. Staged native writes replace the old
synchronous append shortcut, which could leave partially changed bytes after a
failure. See [Shell usage](../packages/shell/README.md#browser-opfs-workspace).

Run `pnpm --dir vendor/agents test:browser` for Think and Shell browser tests,
and `pnpm test:examples` for the extension integration. Root conformance continues
to own DO storage, gates and facets.
