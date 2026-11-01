---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": patch
"@cloudflare/shell": minor
"@cloudflare/codemode": patch
---

Refresh the package closure to Agents 0.32.0 / Think 0.23.0 / AI Chat 0.12.2 /
Shell 0.5.0 / Codemode 0.5.6 (upstream `be174922`). Voice 0.5.0 is unchanged.
Think requires Agents >=0.28 and the new `@cloudflare/computer` ^0.8.0 peer;
Shell 0.5.0 only adds upstream's deprecation notice in favour of Computer.

Breaking: `agents/skills` loads skills from `workspace()`, `r2()` or
`manifest()` sources through `loadSkillCatalog`; `SkillRegistry`, the
`agents:skills` Vite virtual module and `agents/skills/compile` are gone, and the
Vite plugin rejects an `agents:skills` import. Think's workspace is a Computer
`Workspace` with Computer's workspace tools (`list` is now `ls`), and the
`@cloudflare/think/tools/workspace` entry point is removed. Agents adds
`agents/webfetch*`, `agents/browser/pi` and `agents/skills/tools/ai-sdk`;
`agents/websearch*` keeps its entry points over the new `web/` sources. The MCP
client and server move to 2.4.0 and the SDK to 1.32.2; `@modelcontextprotocol/sdk`
and `@modelcontextprotocol/server` are now optional peers. Agents also gains
`internalHosts` for the browser, an OpenTelemetry bridge in
`agents/observability`, and Pi 1.4 support, and marks itself side-effect free
apart from its CLI.

Chat recovery seals a turn after `chatRecovery.maxInterruptedAttempts`
interrupted attempts (default 5). The recovery incident's `oomAttempts` becomes
`interruptedAttempts` plus `attemptsInFlight`; both shapes stay readable and the
attempt budget resets once. Lifecycle arms a fallback alarm when startup fails.
New media-eviction markers live under `/workspace/attachments/evicted/`; existing
markers keep their paths. Think's skill fingerprint config rows are no longer
read. The only destructive lift, ThinkHarness's tables into
`cf_think_harness_store_*`, runs only when that harness opens.

Fork changes carried onto 0.32:

- Lifecycle's `#serializeAlarmWrite` (re-arm and startup fallback) awaits the prior write in its caller's continuation, so alarm writes keep do-runtime's input lock, and logs a failed startup-fallback write.
- A stopped or cancelled recovery turn is checked before `runRecoveryAttempt` admits it, so it is never sealed or reported to `onExhausted`, and a sealed incident stays sealed; `listRecoverableChatRequests` skips incidents sealed as exhausted.
- Think wraps Computer's `read` (`withWorkspaceReadMedia`, `createWorkspaceReadTool`) with `workspaceAcceptsImages`, `workspaceAcceptsPdfs` and `workspacePdfText`, checks declared image/PDF types against the file's bytes, and rereads Think 0.20 media results with a size check.
- Skills have no script runner: no `agents/skills/runner` entry point, no `run_skill_script` tool and no `getSkillScriptRunner()`.

Details are in `docs/audit/agents-sync-2026-10-31.md`.
