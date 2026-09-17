---
"@cloudflare/think": patch
---

Broadcast canonical chat history after manual, automatic and direct-overlay
compaction so connected clients use the existing stream-safe chat update path.
Remove the fork's legacy session status/error notification bridge.
