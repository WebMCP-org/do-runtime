---
"@mcp-b/do-runtime": patch
---

`BrowserWorkerSupervisor` now runs `discarded` even when tearing down a worker's sessions throws, and warns when a worker sends an event that fails protocol validation. `BrowserActorTree` accepts a `broken(request, reason)` option that reports a placed facet's container breaking.
