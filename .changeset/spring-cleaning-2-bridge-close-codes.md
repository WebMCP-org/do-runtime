---
"@mcp-b/do-runtime": patch
---

`bridgeWebSocket()`, and so `connectMessagePortWebSocket()`, no longer throws inside the Worker
when its MessagePort peer reports a close that `WebSocket.close()` refuses: 1006, which a host
sends when a `chrome.runtime.Port` disconnects with `lastError`, as well as 1005, 1015, any
other reserved code, a code from 0 to 999 or from 5000 to 65535, and a reason over 123 UTF-8
bytes. The throw surfaced as an uncaught error on the Worker, which a host may treat as fatal
to the actor. The actor's socket now sees a dropped connection instead: the host's code and
reason, `wasClean: false`, and no close handshake. An `accept()`ed socket is already `CLOSED`
when its `close` event fires, and a hibernatable actor receives
`webSocketClose(ws, code, reason, false)` with the socket `CLOSING`, as after any peer close.
A close that `close()` accepts still completes a handshake as before. `MessagePortWebSocket`
now reports such a wire close with `wasClean: false`, so a socket rehydrated from a raw
`MessagePortWebSocket` reports these closes the same way, and so do clients made by
`createMessagePortWebSocketConstructor()`. That includes 1005 (no status received), whereas
workerd treats a close frame without a status as clean. A wire close with a code outside
0-65535 is instead a protocol error: the `MessagePortWebSocket` closes itself with 1002, so a
bridged actor sees a clean 1002 close with a handshake. When a subclass calls the protected
`disconnect()` on a bridged `MessagePortWebSocket` with a valid code, the pair is now dropped
instead of completing a handshake.
