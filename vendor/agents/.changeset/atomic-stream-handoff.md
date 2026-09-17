---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Store and broadcast each stream chunk before yielding to recovery bookkeeping, preventing resume from replaying a chunk just before its duplicate live delivery.
