---
"@mcp-b/do-runtime": minor
---

Align the runtime with workerd 1.20261009.1: untraced tracing spans now support
`spanContext()`, returning workerd's all-zero span identity. Pin the conformance
oracle and Workers types to the October 9 release.
