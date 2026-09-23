---
"@mcp-b/do-runtime": minor
---

Ship the Worker half of the browser alarm protocol. `createBrowserAlarmProjector()`
supplies the `AlarmScheduler`'s `projectWake` and an `acknowledge()` for the
`BrowserAlarmCoordinator`'s `deliver()`. Projections leave one at a time, and each draws
its generation only after the previous one was sent. A consumed wake is acknowledged only
after the latest projection is accepted, no delivery or cleanup is active, and the next
wake is absent or later. If the latest projection failed, `acknowledge()` sends it again
first, so a scheduler with nothing new to project cannot leave the wake retrying forever.
`nextGeneration()` must be durable across Worker restarts: the coordinator silently drops
any projection older than the generation it journaled, so an in-memory counter would stall
every wake after a restart. `parseBrowserAlarmProjection()` is now exported.

Add `connectMessagePortWebSocket()` to `@mcp-b/do-runtime/browser`. It routes one
MessagePort socket through a Workers-style `fetch` such as the Agents SDK's
`routeAgentRequest()`. A socket nothing routes closes with 1011, and a refused upgrade
closes with 1008 and the refusal's text when it is printable ASCII of at most 123 bytes.
Previously every failure closed with a generic 1011 that dropped the Agent's reason.
`serveMessagePortWebSockets()` now takes `(bridge, url) => Promise<void>`, such as
`(bridge, url) => connectMessagePortWebSocket(bridge, url, route)`, instead of a function
resolving a URL to a socket. It reports a connection failure after closing the client,
and a socket that finishes connecting after `stop()` now closes with
"MessagePort transport closed" instead of "host stopped".

Gate a hibernatable socket that is a host transport, such as a `MessagePortWebSocket`
rehydrated after a Worker restart. The actor used to receive the transport itself, so its
`send()` and `close()` could leave before a preceding storage write was confirmed. It now
receives one stable socket per transport that waits for the output gate like a
`WebSocketPair` half; hibernation hosts still see the transport.

`OffscreenDocumentAdapter` gains optional `ready()` and `replaceUnready()` hooks. The
coordinator runs readiness in the same single flight as creation, for new and existing
documents, and replaces a document that fails it at most once.

Fix two `MessagePortWebSocket` hangs. A throwing `onmessage`, `onopen` or `onclose`
handler skipped the `addEventListener` listeners behind it; during the open flush it also
dropped the queued frames and held every later frame in the queue. Handler errors are now
reported the way `EventTarget` reports a throwing listener. A throw while bridging a
connected socket, such as a second `accept()`, left the brokered client connecting; it now
closes with 1011.
