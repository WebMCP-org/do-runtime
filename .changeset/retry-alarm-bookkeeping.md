---
"@mcp-b/do-runtime": patch
---

Retry failed alarm start and completion bookkeeping on the existing scheduler timer. Transient abandonment or metadata-write failures no longer leave an alarm retained without a live wake. Cleanup retries preserve the completed handler result and its retry budget, and cancellation or replacement retains the correct alarm owner and durable row.
