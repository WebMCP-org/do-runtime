---
"@mcp-b/do-runtime": minor
---

Export `platformWebSocket` from `@mcp-b/do-runtime`: the platform's `WebSocket` constructor,
captured when the package loads, beside `platformTimer` and `platformFetch`. An installed actor
scope's `WebSocket` refuses construction because a native handshake cannot wait for the output
gate, so a host that opens its own transport and hands it to `acceptWebSocket` no longer has to
capture the constructor at the top of its worker module before `installActorScope` runs.
