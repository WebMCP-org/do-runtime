---
"@cloudflare/shell": minor
---

Expose the existing filesystem method metadata and argument adapters through
`@cloudflare/shell/state-methods`. Hosts can consume this dependency-free entry
without loading the Codemode Worker runtime exported by `@cloudflare/shell/workers`.
