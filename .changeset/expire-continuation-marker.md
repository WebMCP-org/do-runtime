---
"@mcp-b/do-runtime": patch
---

Stop a transformed await from capturing another actor in a task that runs before that actor's checkpoint hand-off. The await transform's continuation marker now expires inside the task that restored it, so untransformed code resuming from a Web Lock grant or an OPFS promise no longer gates its callees behind a foreign actor's input gate.
