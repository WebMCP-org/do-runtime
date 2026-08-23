---
"@mcp-b/do-runtime": patch
---

Preserve `blockConcurrencyWhile` critical sections across transformed awaits so their continuations re-enter instead of deadlocking behind themselves.
