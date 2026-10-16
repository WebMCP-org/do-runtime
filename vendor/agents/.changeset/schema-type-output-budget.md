---
"@cloudflare/codemode": patch
---

The JSON Schema type printer stops after emitting 100,000 characters for one
schema and prints any further node as `unknown`, so definitions that inline
each other or nested index signatures can no longer grow a tool's types
exponentially. Ordinary schemas print exactly as before.
