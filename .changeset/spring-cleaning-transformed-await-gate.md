---
"@mcp-b/do-runtime": patch
---

Keep the input lock and the implicit transaction across transformed awaits that settle while
the actor still holds its lock. `doRuntimeAwaitTransform()` previously resumed every await
through a macrotask hop and a fresh input lock queued behind waiting events, including awaits
of storage calls and plain values. Another event could then run between `await
storage.get()` and the following `put()`, so two concurrent read-modify-writes lost an update.
The implicit transaction also committed at the await, so writes survived an abort that workerd
rolls back. A transformed `await ctx.blockConcurrencyWhile()` let queued events run before its
caller resumed. Every consumer that transforms the Agents SDK was exposed on its storage
sequences.

A transformed await now continues in the same checkpoint when its promise settles while the
actor holds its lock: storage calls, plain values, and resumptions the runtime already admitted.
Settled awaits no longer pay a macrotask each. An await on foreign I/O still re-enters through
a fresh lock. When another actor's continuation owns the checkpoint, the await waits for a later
task without releasing its lock, and its implicit transaction commits at that hand-off. Code that
relied on a storage-only await to let other events in now blocks them, as on workerd. The Node
and browser conformance lanes now also run the suite with the probe compiled by the transform.
