---
"@mcp-b/do-runtime": patch
---

Preserve the creating actor's input gate and async context in ReadableStream
and TransformStream callbacks. Delayed input and stream demand previously entered
provider callbacks or tool execution without their creating scope, causing
valid model turns, title actions, and routine actions to fail at storage access.
