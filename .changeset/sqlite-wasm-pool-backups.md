---
"@mcp-b/do-runtime": minor
---

Add idle whole-pool SQLite snapshots across actor and facet prefixes. Validate every image and native filename before replacement, reject newer runtime storage on import, reserve pool capacity, and share the existing rollback implementation with scoped provider snapshots and cloning. Exports remain available to rescue databases written by newer runtimes.
