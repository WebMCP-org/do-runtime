---
"agents": minor
"@cloudflare/think": patch
---

Refresh the package closure to Agents 0.27.0 / Think 0.20.1 (upstream
`e3351863`). AI Chat 0.12.1, Codemode 0.5.3, Voice 0.5.0 and Shell 0.4.3
remain unchanged.

Breaking: every `agents/channels*` entry point is removed. Slack, Telegram and
Email ingress move to `agents/experimental/channels/{slack,telegram,email}`;
`ChannelHost`, the fallback/fanout composites and the Voice, AI SDK and TanStack
AI helpers are gone. Agents adds opt-in
`agents/harness/{ai-sdk,think,container,opencode,store}`, `agents/models/opencode`,
`agents/websearch{,/pi,/ai-sdk,/tanstack-ai}`, `WebSockets.use`, and an `agents`
CLI bin. `MCPClientManager.removeServer` now deletes the server's saved OAuth
state. `browserTool` defaults to a 60-second run timeout.

Think keeps a newer auto-continuation scheduled while the previous continuation
streams, composed with the fork's Stop-aware continuation settlement. Streams
re-polls after a live batch, Tasks drops routed wakes for deleted facets, and
`useAgentChat` releases streaming protection when the socket closes. No existing
actor storage changes. Details are in `docs/audit/agents-sync-2026-10-09.md`.
