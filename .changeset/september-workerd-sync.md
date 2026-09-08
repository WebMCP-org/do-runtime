---
"@mcp-b/do-runtime": minor
---

Sync runtime behavior with workerd 1.20260907.1 and its Workers types. Add alarm abort retry control, RPC error Durable Object IDs, compiled Wasm loader inputs, current Python loader flags, and the current no-op tracing API. Correct cancellation, WebSocket buffer ownership and automatic replies, retained close-handler tags, SQLite savepoint matching, and failed database setup cleanup.

Actor-global outbound WebSocket construction now refuses before a native handshake can bypass storage confirmation. WebSocket pairs and host-owned transports remain supported. The upstream audit documents remaining SQLite engine protections and native-platform differences.
