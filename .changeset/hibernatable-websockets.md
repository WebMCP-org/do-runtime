---
"@mcp-b/do-runtime": minor
---

Replace the fail-closed Durable Object WebSocket stubs with workerd-compatible hibernatable WebSockets.

`WebSocketPair`, `WebSocketRequestResponsePair`, all eight `DurableObjectState` WebSocket methods, tags, structured-clone attachments, auto-responses, event timeouts, close state, and `webSocketMessage`/`webSocketClose`/`webSocketError` dispatch now run through actor input and output gates. `installActorScope()` installs the three WebSocket globals alongside the existing actor-scoped primitives.

Embedders that evict live actors can mirror socket state through the new optional `ports.hibernation` callbacks and rehydrate it through `ActorContainerOptions.webSockets` before the next constructor runs. `container.quiescence()` exposes the non-blocking eviction signals, and `gateHooks` makes both gates observable.

This is a breaking replacement for the exported hibernation-unavailable error and the previous `never`-typed methods. Hosts should remove reconnect-only fallbacks; applications can use the Agents SDK and PartyServer hibernation defaults.
