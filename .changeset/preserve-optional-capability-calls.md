---
"@mcp-b/do-runtime": patch
---

Preserve optional method invocation in the browser async-context transform. Use
targeted Babel async plugins so callable RPC capabilities are invoked directly
instead of dispatching a remote `.call` property, retain optional `super` call
receivers and SDK async-method identity, and compose the original source maps.
Use Babel's canonical async-generator helper for awaited early-return cleanup.
