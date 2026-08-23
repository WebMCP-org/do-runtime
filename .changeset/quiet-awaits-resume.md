---
"@mcp-b/do-runtime": patch
---

Restore actor context at the first instruction after each transformed await so delayed continuations cannot outlive their captured input lock.
