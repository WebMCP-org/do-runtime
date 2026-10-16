---
"@mcp-b/do-runtime": patch
---

Report a Chrome runtime.Port that fails during `send()` as closed after `send()` returns, so callers record what they sent before observing the close. Further sends on the lost port are dropped.
