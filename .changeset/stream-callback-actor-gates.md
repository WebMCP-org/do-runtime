---
"@mcp-b/do-runtime": patch
---

Preserve the creating actor's input gate and async context in TransformStream
callbacks. Delayed model response chunks previously entered tool execution
without a lock, causing valid title and routine actions to fail at SQL access.
