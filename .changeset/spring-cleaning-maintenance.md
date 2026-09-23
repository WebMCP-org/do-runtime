---
"@mcp-b/do-runtime": patch
---

Validate both `withEnvAndExports()` scopes before installing either. A non-object `exports`
argument previously left the `env` scope installed for the whole realm, so every later `env`
read resolved against it.

Treat a `Timer.afterDelay` that rejects on abort, as `node:timers/promises` does, as
cancellation. Replacing or deleting a waiting alarm previously raised an unhandled
`AbortError`, which terminates a Node host by default. The `Timer` contract now states that
an aborted wait may stay pending or reject, but must not resolve.

Close the databases `createActorContainer()` opened when an open-time check refuses, such as
storage written by a newer release. Each refused attempt previously leaked its handles: a
retry opened another connection to the same OPFS file, and on Node the provider's
`exportSnapshot()` refused from then on. A `FacetHost.abort` that throws is now recorded like a
failed facet deletion instead of becoming an unhandled rejection.

Report `rowsWritten` as 0 for statements without result columns that write nothing, in both
SQLite backends. DDL previously repeated the last write's count, because SQLite does not
reset `sqlite3_changes()` for it. `SqliteWasmActorStorage.copyFrom()` now reads every source
file in the same task as its recovery-sidecar check, so a source that is still running cannot
open a write transaction between the two.
