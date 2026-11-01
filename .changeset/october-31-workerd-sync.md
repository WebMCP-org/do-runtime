---
"@mcp-b/do-runtime": minor
---

Align the runtime with workerd 1.20261031.1: a move-later alarm whose request
completes after a commit stored an earlier alarm no longer reschedules its parked
time; an actor method's exception, sync or async, waits for the output gate
before it reaches the caller, and a broken gate's error replaces it; and a
hibernatable socket that sent its own close is released, so `getTags()` throws,
once that close completes after the close event was dispatched. A message
received after the own close keeps the tags readable. A closed socket stays in
`getWebSockets()` until its close handler's synchronous part returns, and its
tags stay readable unless the socket is released. A `WebSocketPair` half
returned in a 101 `Response` closes like a network transport, including a close
sent before the `Response` was returned, and `accept()` on a pair half answers a
close that arrived before it. `SqlStorageCursor.next()` is
typed `IteratorResult<T, undefined>`. Pin the conformance oracle and Workers
types to the October 31 release.
