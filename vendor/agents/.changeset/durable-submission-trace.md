---
"@cloudflare/think": patch
---

Carry the trace parent across Think's durable submission queue on hosts that support trace context. See the [SDK divergence inventory](../docs/fork-diff.md#chat-replay-and-recovery).

Retain terminal submission notifications on Workerd versions without span status support.
