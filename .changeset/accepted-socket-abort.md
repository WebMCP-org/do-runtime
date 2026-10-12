---
"@mcp-b/do-runtime": patch
---

An accepted socket now drops its connection when the actor that accepted it aborts. A classic
socket belongs to its actor's context, as it does in workerd, but until now an aborted context only
discarded the socket's queued writes: `readyState` stayed `OPEN`, every later `send()` vanished,
and a caller that kept the socket, such as a facet's module re-used by its next placement, waited
forever. The socket now reports `CLOSED` and closes its transport; a `WebSocketPair` half aborts its
pair so the peer hears an unclean 1006. Events that reach an aborted context are dropped instead of
surfacing as a `waitUntil` failure. Hibernatable sockets are unchanged.
