---
"@mcp-b/do-runtime": patch
---

Keep async functions without their own `await` native when lowering browser awaits, so `Object.getPrototypeOf(async () => {}).constructor` stays the real `AsyncFunction`.
