---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
"@cloudflare/voice": minor
"@cloudflare/shell": minor
"@cloudflare/codemode": minor
---

Refresh the vendored SDK to the `agents@0.23.0` release. The six packages are
released as one coherent set because Think, AI Chat and Voice all declare
`agents >=0.23.0`; Shell and Codemode carry no fork change and move only to
keep the closure consistent.

Sessions, Streams and Tasks are now Lifecycle capabilities. `agents/sessions`
replaces `agents/experimental/memory/*`, which is **deleted** — `Session` and
`SessionMessage` come from `agents/sessions` and `truncateOlderMessages` from
`agents/chat`. `ResumableStream` is an adapter over `agents/streams`, and a
root Agent's chat turn and its recovery continuations run as Tasks.

Storage migrations run once on the first wake after the upgrade and are
**one-way**: schedules lift into `cf_agents_jobs`, `assistant_*` into
`cf_agents_session_*`, `cf_ai_chat_stream_*` into `cf_agents_streams`, Think's
`assistant_config` into `think_config`, and each source table is dropped once
its copy verifies. An object that has woken on 0.23 cannot be served by 0.22.

Duplicate-request protection changes shape with the stream cutover. There is no
cleanup alarm and no ten-minute completed-stream window: a turn's stream rows
are discarded when its message persists, so a chunkless receipt is now recorded
after every persisted turn and lives until that Agent's next stream starts.
A replay of the turn that just settled is still refused; one arriving after an
unrelated later turn has started is not.

`@cloudflare/voice` is deprecated. The implementation, its regressions and this
fork's dictation edits now live in `agents/voice`; the package is a re-export
wrapper, so `@cloudflare/voice{,/client,/react,/errors}` should move to
`agents/voice{,/client,/react,/errors}`. A build that aliases the Voice package
main to pinned source, or applies an await transform to it, must re-point at
`packages/agents/src/voice/**`.

Two fork-owned repairs ride along. `SessionMessage.createdAt` is declared on the
public type but never populated by 0.23's decode, so Sessions restores it —
the creation time in the stored JSON wins, the row's `created_at` column is the
fallback, and a stored `0` (what the legacy lift writes for an unparsable
timestamp) reads as no timestamp at all. And because
`Lifecycle.broadcast`/`Lifecycle.getConnections` were removed with the
WebSockets capability, `Agent` exposes its installed WebSockets capability to
subclasses as a protected `webSockets` getter for hosts whose facets accept
their own physical sockets.
