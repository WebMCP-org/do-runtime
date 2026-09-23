---
"@mcp-b/do-runtime": minor
---

The sqlite-wasm backend now grows its OPFS SAH pool when it opens a database, restores a snapshot
or clones a facet's storage, so a pool that fills up no longer breaks the actors in it. Before each
of these it calls the pool's `reserveMinimumCapacity()` so the pool holds every file plus a
rollback journal for each connection the backend has open. Previously a full pool (for example,
one holding facets that were never deleted) still let one more database open but left no slot for
its journal. Every later write then failed with `SQLITE_CANTOPEN`, the actor's output gate broke,
and re-placing the actor broke it again. A clone or restore could also use up the journal slots or
fail with `No available handles to import to.`, and a failed facet clone left the facet empty.

`initialCapacity` is now only the size a new pool starts at. The backend never shrinks a pool. If
the browser refuses the storage, the operation fails with the driver's error.
`OpfsSahPool.reserveMinimumCapacity` is now a required member. The driver's pool already has it,
but a pool wrapper must forward it.

Opens, restores and clones on one pool now run one at a time, so `open()` resolves a little later.
Close the storage or delete it only after its `open()` calls have resolved. An `open()` still
waiting its turn is not closed, and `importSnapshot()` refuses if that open lands first.
