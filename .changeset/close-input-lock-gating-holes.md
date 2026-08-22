---
"@mcp-b/do-runtime": patch
---

Close three input-lock laundering paths in HTTP bodies. `ReadableStream` async iteration, second-order `Blob` reads, and reader or stream lifecycle promises could previously resume outside the actor's input gate and make the next storage call throw "no input lock available in this context". They now route every surfaced continuation through the actor's gated I/O seam while preserving native stream cancellation and lock-release behavior.
