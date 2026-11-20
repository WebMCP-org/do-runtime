---
"@mcp-b/do-runtime": minor
---

Correct storage range and multi-key read ordering across BMP and astral keys, recover Node snapshot imports after partial filesystem failures, and attempt every owned resource cleanup when a finalizer fails. Simplify worker socket ownership, placement and alarm-task phases, and the internal SQLite KV contract while retaining workerd locking, alarm and hibernation invariants.

Remove the obsolete `jsModuleInPythonWorkerMessage` export: Python workers accept JavaScript modules, so this diagnostic no longer describes runtime behavior. Remove unused internal cache eviction and hypothetical backpressure paths; public Workers storage options remain accepted.
