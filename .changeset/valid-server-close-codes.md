---
"@mcp-b/do-runtime": patch
---

Accept workerd server WebSocket close codes such as 1001, 1002, 1008 and 1011. The browser-only 1000/3000–4999 restriction caused Agent rejection and port-replacement shutdowns to throw instead of closing. Continue rejecting reserved wire codes and oversized reasons; shared workerd, Node and Chromium conformance tests verify the exact contract.
