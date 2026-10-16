---
"agents": patch
---

Reject a `useAgent` call promptly when its socket closes from inside `send()`, instead of leaving it to the call timeout, and keep later queued calls for the next socket.
