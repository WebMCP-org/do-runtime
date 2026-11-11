---
"agents": patch
"@cloudflare/think": patch
---

Carry W3C trace context in JSON WebSocket calls and chat requests. Report the
first server receipt for a submitted message. Record queue wait and terminal
outcome on durable Think submissions. Settle obsolete reconnect handshakes
without losing buffered requests, and release acknowledged turns after an
authoritative idle reply. Ignore stream offers addressed to an earlier probe.
