---
"@mcp-b/do-runtime": minor
---

Add `installSqliteWasmHost()` to `@mcp-b/do-runtime/backends/sqlite-wasm`. It installs an OPFS SAH
pool through sqlite-wasm's `installOpfsSAHPoolVfs()` with the `name`, `directory`, `clearOnInit`
and `initialCapacity` options, and returns the `{ pool, capi }` host the sqlite-wasm provider
takes. Concurrent calls for one pool share a single install. Install pools through it:

- It waits up to 10 seconds for a terminated worker to release the pool before installing, then
  rejects with a `NoModificationAllowedError`. Installing while the previous worker was still
  shutting down could delete the pool's directory and every database in it.
- A transaction interrupted by worker termination is now rolled back when its database is
  reopened. Previously, reopening could expose the interrupted transaction's writes in place of
  committed rows and left the recovery journal behind, so snapshot export stayed refused.
