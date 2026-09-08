---
"@mcp-b/do-runtime": patch
---

Add opt-in browser AsyncLocalStorage and Vite async-function lowering for Agents
SDK context, tracing and OAuth. Preserve captured scopes across actor admission,
reentry and timers; test overlapping browser entries and deferred generators.
