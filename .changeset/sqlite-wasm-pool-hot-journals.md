---
"@mcp-b/do-runtime": patch
---

Whole-pool SQLite export and restore now let SQLite roll back a hot journal left by a terminated worker instead of refusing the pool. A sidecar that recovery cannot remove is still refused, and the error names the operation that refused it.
