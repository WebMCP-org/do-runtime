---
"@mcp-b/do-runtime": patch
---

Preserve the native `ReadableStream` brand when gating response body reads so Chromium accepts tee branches as `Response` bodies.
