---
"@mcp-b/do-runtime": patch
---

`platformTimer`, `platformFetch` and `platformWebSocket` are now the platform's in a separately
bundled facet module too. Each facet bundle carries its own copy of the runtime and is evaluated
after its root's actor scope replaced the realm's globals, so its copy captured the refusing
`WebSocket` and the root's gated timer and `fetch`. The captures are now realm-shared: the first
copy to load, which is the host's, makes them, and every later copy reads them. The `crypto` and
stream constructors the actor scope wraps are captured the same way.
