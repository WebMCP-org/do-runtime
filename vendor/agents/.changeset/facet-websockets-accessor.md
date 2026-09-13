---
"agents": minor
---

Expose the Agent's installed WebSockets capability to subclasses as a
protected `webSockets` getter. Hosts whose facets accept their own physical
sockets broadcast to them through it, replacing the `Lifecycle.broadcast`
call that 0.23 removed.
