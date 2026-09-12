---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Refresh missed canonical history on reconnect and preserve the pre-continuation assistant boundary when replaying a running stream after a client remount. Avoid React cleanup state dispatches when there are no stale client tool results, and correctly detect the inherited default overflow classifier through Agent context wrappers.
