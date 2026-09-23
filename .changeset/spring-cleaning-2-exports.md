---
"@mcp-b/do-runtime": minor
---

Remove package surface that nothing imports. This breaks a consumer that used any of it:

- The `@mcp-b/do-runtime/server/alarm-scheduler` subpath is gone. Import `AlarmScheduler`, its
  types and its retry constants from `@mcp-b/do-runtime`, which already exports every one.
- The `@mcp-b/do-runtime/conformance` subpath is gone. It exported this repository's conformance
  harness types and `substrate()` helper, which only its own lanes use.
- The root no longer exports `installWebSocketGlobals` or `markWebSocketUsed`. The runtime calls
  both itself: `container.globals` and `installActorScope` carry the socket globals, and
  `installWebSocketUpgradeGlobals()` from `@mcp-b/do-runtime/browser` marks upgraded sockets.
- `@mcp-b/do-runtime/gate` no longer exports `__gate`. `doRuntimeAwaitTransform` emits
  `__gateAwait`, `__resumeAwait` and `__gateAsyncIterable`, which stay.
