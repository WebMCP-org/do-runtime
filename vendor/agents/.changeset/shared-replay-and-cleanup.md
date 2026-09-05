---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/voice": patch
---

Reuse the Agent-tool replay buffer helper, consolidate Think channel
reconciliation, and simplify Voice close-error cleanup while preserving
replay, initialization, and final-transcript behavior.
