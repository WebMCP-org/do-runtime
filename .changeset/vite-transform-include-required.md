---
"@mcp-b/do-runtime": minor
---

`doRuntimeAwaitTransform()` from `@mcp-b/do-runtime/vite` now requires `include`, and its `exclude` option is removed. `browserHost()` no longer takes `asyncContext`: it always aliases `async_hooks` to the browser shim and lowers async functions for it.
