---
"@mcp-b/do-runtime": minor
---

`HibernationHost.autoResponsePair` and `HibernationHost.autoResponseTimestamp` are now required. A custom host must restore the retained auto-response pair (or report `null`) and record auto-response timestamps, so `getWebSocketAutoResponseTimestamp()` survives hibernation. `HibernationMirror` already does both.
