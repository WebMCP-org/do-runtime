---
"@cloudflare/think": patch
---

Bind inference callbacks and streaming tool iterators to their originating
admitted turn. Native browser streams can invoke callbacks outside the creator's
async scope, dropping delegated progress and turn identity even when awaits
preserve context. Keep concurrent turns isolated with AsyncLocalStorage snapshots.
