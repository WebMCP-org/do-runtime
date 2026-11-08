---
"@mcp-b/do-runtime": minor
---

`serveMessagePortWebSockets` and `createMessagePortWebSocketConstructor` are removed from `@mcp-b/do-runtime/browser/message-port-websocket`, and `MessagePortWebSocket` no longer accepts the private `{ type: "open" }` frame, which a peer now receives as an invalid message (close 1002). Route sockets with `connectMessagePortWebSocket()` from `serveBrowserWorker`'s `connect` and open the client end yourself, as a default `MessagePortWebSocket` does.
