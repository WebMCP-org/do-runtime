---
"@mcp-b/do-runtime": minor
---

`ActorGlobalScopeOptions.crypto` is removed. An actor's gated `crypto` always delegates to the platform's WebCrypto, captured when the module loads.
