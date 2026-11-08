# Vendor provenance

Upstream: <https://github.com/cloudflare/agents>

Release pin: `agents@0.32.0`
(`be1749221ab3efc8be4e976d8e7d8344d1446032`).

The package versions match the 0.32 release:

- `agents@0.32.0`
- `@cloudflare/think@0.23.0`
- `@cloudflare/ai-chat@0.12.2`
- `@cloudflare/voice@0.5.0`
- `@cloudflare/shell@0.5.0`
- `@cloudflare/codemode@0.5.6`

`packages/browser-workspace` (`@mcp-b/browser-workspace`) is fork-owned and
has no upstream counterpart, so syncs leave it alone.

This fork contains only the package closure used by Rook. Compare future
upstream releases against the commit above, reconcile
[current divergences](docs/fork-diff.md), update each affected row in place
(remove retired rows; Git preserves history), then run `pnpm build && pnpm check &&
pnpm test` here and the runtime's example gate.

A sync covers more than `packages/` and `docs/`: copy any vendor-root helper the
package tests import (0.32 added `scripts/vitest/expose-workerd-gc.ts`), and run
`oxfmt` over copied upstream changelogs, which do not pass the fork's format
check as published.

`packages/agents/src/do-runtime-tests/` holds lifecycle tests that run only on
do-runtime: a Node project with a real actor container and the await
transform, appended to `test:agents`. Add a test there only when the behavior
depends on do-runtime's input lock, which a transformed `await` re-acquires in
the caller's continuation and a detached promise reaction does not. workerd
cannot lose an input lock that way, so its upstream lane passes on both shapes
and cannot catch the regression. Upstream has no such directory, so a sync must
keep it; the package `tsconfig.json` excludes it.
