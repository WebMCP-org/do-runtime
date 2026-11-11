---
"@mcp-b/do-runtime": minor
---

Carry W3C trace context in browser worker bootstrap and record actor RPC and WebSocket timing for configured hosts. Report whether a handoff attached valid context, and keep host recorder failures from changing actor results.
Preserve the caller's context when a host cannot record an intermediate span.
