---
"@mcp-b/do-runtime": minor
---

Move the reusable Chrome-host mechanics out of Rook: add a crash-safe browser alarm coordinator with durable transport recovery, package the MessagePort-backed WebSocket transport used between browser supervisors and actor workers, and share offscreen-document creation and stale-slot recovery.
