---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
"@cloudflare/shell": patch
"@cloudflare/codemode": patch
"@cloudflare/voice": patch
---

Refresh supported dependencies and preserve external package boundaries with
current tsdown. Align Chat adapters on 4.38, the last release before Node-only
networking initialization breaks browser workers. Update TanStack AI and Vite
integration types while retaining all existing AI SDK and provider versions.
