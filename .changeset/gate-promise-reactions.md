---
"@mcp-b/do-runtime": patch
---

Bind `then`/`catch`/`finally` reactions in transformed code to the actor that registered them, so detached storage writes keep the input lock as they do on workerd.
