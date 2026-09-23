---
"@mcp-b/do-runtime": minor
---

Export `ACTOR_SCOPE_GLOBALS` from `@mcp-b/do-runtime` and `facetScopeBanner()` from
`@mcp-b/do-runtime/vite`. The banner binds every name `installActorScope()` writes to a
facet bundle's own scope. Banners that bound only timers, `fetch` and `crypto` left
`WebSocketPair` on the root actor's global, so a facet's socket frames waited on the root's
output gate and could leave before the facet's own write committed.

`doRuntimeAwaitTransform()` now resolves the imports it injects to the package's own files,
ahead of any host alias for them, so hosts no longer alias `@mcp-b/do-runtime/gate` or
`@mcp-b/do-runtime/browser/async-hooks`. Add a `@mcp-b/do-runtime/cloudflare-email` export,
a data-only `EmailMessage` for hosts to alias `cloudflare:email` to.
