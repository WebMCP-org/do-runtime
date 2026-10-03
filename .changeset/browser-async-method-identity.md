---
"@mcp-b/do-runtime": patch
---

Preserve native async-method identity when lowering browser awaits. This lets the Agents SDK keep synchronous methods synchronous while starting a cold Agent before its async methods run; lowered continuations still restore browser async context.
