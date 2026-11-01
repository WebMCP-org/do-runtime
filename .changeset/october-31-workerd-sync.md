---
"@mcp-b/do-runtime": minor
---

Align the runtime with workerd 1.20261031.1: a move-later alarm whose request
completes after a commit stored an earlier alarm no longer reschedules its parked
time; an actor method's exception, sync or async, waits for the output gate
before it reaches the caller, and a broken gate's error replaces it; and a
hibernatable socket's `getTags()` throws once the socket's own close has been
written. `SqlStorageCursor.next()` is typed `IteratorResult<T, undefined>`. Pin
the conformance oracle and Workers types to the October 31 release.
