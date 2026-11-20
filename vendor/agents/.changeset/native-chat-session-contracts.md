---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/shell": minor
"@mcp-b/browser-workspace": minor
---

Validate incoming chat frames and reject malformed recognized protocol messages. Clear deadline timers on rejection and consolidate local request ownership, observer replay acknowledgements, and broadcast state in the native chat transport. Remove unused progress-credit APIs and require the resume host's connection and terminal predicates.

Expose `useAgentChatHistory` and `hasReceivedMessages` so applications load and adopt native transcripts without interpreting message-array identity. History follows `connectionKey`, retains successful reads across reconnects, retries interrupted first reads, and surfaces HTTP failures.

Replace Think's deprecated session facade with the native `agents/sessions` handle. Configure blocks through `configureContext`, frozen-prompt storage through `configurePromptStore`, and compaction error handling through `Session.onCompactionError`. Durable storage migrations remain intact. Export the pure schedule grammar at `@cloudflare/think/schedules`.

Export `WorkspaceSource` and branded `SkillSummary` contracts. Require native ranged reads and binary append in browser workspaces, and reject malformed pagination instead of reporting incomplete listings as successful. Client tool wire descriptions are strings and delegated execution preserves the required tool call ID.
