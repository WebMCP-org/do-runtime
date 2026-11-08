---
"@mcp-b/do-runtime": minor
---

`NodeSqlDatabase` (`@mcp-b/do-runtime/backends/node-sqlite`) and `SqliteWasmDatabase` (`@mcp-b/do-runtime/backends/sqlite-wasm`) are no longer exported. Open databases through `createNodeSqlProvider()` or `createSqliteWasmProvider(host, { prefix })`, which track every handle they open for `close()` and snapshots, and reserve pool headroom before a SAH-pool database opens.
