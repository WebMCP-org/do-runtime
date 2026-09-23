---
"agents": minor
"@cloudflare/think": minor
---

Refresh the vendored SDK to the `agents@0.24.0` / `@cloudflare/think@0.19.0`
release (upstream `c076e4c9`). Only those two packages moved upstream; AI Chat
0.12.0, Voice 0.5.0, Shell 0.4.3 and Codemode 0.5.2 are unchanged, and Think now
declares `agents >=0.24.0`.

Queues are a Lifecycle capability (`agents/queue`). `Agent.queue()` returns
before its callback runs; the callback runs from the next alarm, one item at a
time, without the enqueuer's `connection` or `request`. `dequeue*` and
`getQueue*` return Promises, `QueueItem.created_at` is `createdAt`, and
`LifecycleServices.starting()` is `status()`. Think's submission drain, workflow
notifications, connection-less continuations and media eviction run as queue
items looked up by callback name.

State is a Lifecycle capability (`agents/state`) that owns `cf_agents_state`.
The fork's lossless `migratePersistedState` hook is re-homed onto the
capability's load path, so the connect-time state push sees migrated state and
a rejecting override still fails construction as before.

Storage changes on the first wake after the upgrade are **one-way**:
`cf_agents_queues` rows lift into the Lifecycle job queue and the table is
dropped (upstream removes this lift in the next minor, so deployments must pass
through 0.24), Agent's `cf_schema_version` row moves to the
`cf_agents:schema_version` KV key, and Think drops
`cf_think_workflow_notifications`. `cf_think_submissions` gains nullable
`result_status` and `output_json`, which 0.18 ignores. A 0.23 build reopening a
0.24 database recreates its tables harmlessly but drops due queue jobs.

`WebSockets` owns the Agent protocol's identity, state sync and per-connection
readonly/protocol flags, and gains a Cap'n Web transport. That transport is not
supported on do-runtime (see `docs/browser-compatibility.md`); the experimental
`?__agents_rpc=capnweb` endpoint and `callablesFromDecorated` are gone.
`agents/client` and `agents/react` now import `capnweb` statically.

Fork-owned fixes ride along. A persisted chat request that resolves `stale`
after `stopCurrentWork()` now records its completed-request receipt, so a
reconnecting client's replay is refused instead of running the stopped turn.
Child cancellation also dequeues a pending connection-less continuation, which
as a queue item was invisible to `cancelAgentToolRun` until the alarm ran it.
Stop semantics remain the fork's `stopCurrentWork`: a request admitted while
another turn runs is persisted as `uA, uB, aA` and its own turn ends with
Think's continuation prompt, and a per-request `cancel` arriving before the
message is persisted is dropped; both are pinned by tests.
