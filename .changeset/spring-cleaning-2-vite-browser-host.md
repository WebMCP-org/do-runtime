---
"@mcp-b/do-runtime": minor
---

Add `browserHost({ include, asyncContext, facets })` and `workersModuleAliases()` to
`@mcp-b/do-runtime/vite`: the Workers bundle contract every browser host wrote by hand. Register
`...browserHost({ include })` in the application's `plugins`, in a browser-only config. It
aliases `cloudflare:workers`, `cloudflare:email` and, by default, bare and `node:` `async_hooks`
to the package's own files, ahead of the application's own aliases and including for
dependencies Vite pre-bundles. Workers build as ES modules, keep class names (the Agents SDK
routes and persists sub-agents by `constructor.name`), and run
`doRuntimeAwaitTransform({ include, asyncContext: true })`. The application plugins run the
transform only while serving, because unbundled development serves Worker modules through them,
so production page builds no longer lower non-actor code. With
`facets: { registry, match }`, Worker bundles turn code splitting off, matched chunks get
`facetScopeBanner({ registry })` through the `banner` output hook, and the build fails when a
matched chunk imports anything: an imported chunk's free `WebSocketPair`, streams and timers
would bind to the root actor's scope. `workersModuleAliases()` returns just the two platform
aliases, for configurations that run no transform.

A second `asyncContext` transform in the same pipeline, such as a host's own beside
`browserHost()`, no longer fails on the Oxc async-generator helper the first one corrected.
