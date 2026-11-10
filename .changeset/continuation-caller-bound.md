---
"@mcp-b/do-runtime": patch
---

Stop a transformed continuation's actor being read as the caller after its microtask checkpoint. The marker cleared at the runtime's `MessageChannel` hand-off, and a task of another source (a Web Locks grant, an OPFS settlement) can run before that. Untransformed code resuming there took a neighbouring actor as its own and gated its awaits on it, which deadlocked a facet whose startup waited on a lock the misattributed code held. The marker now names the caller for a bounded run of microtask turns, which cannot cross a task.
