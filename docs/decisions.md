# Invariants and decisions

Source comments and conformance tests cite the numbered entries below (`§1.2`,
`§2.4`, `decision 8`). The numbers are stable: do not renumber, and add rather
than rewrite. Behaviour is pinned by the conformance suite; this document is
the index the citations resolve to, not a second specification.

Workerd line citations throughout the source use release `v1.20260713.1`, commit
`03c396e9b14ea5644dfcfb696086d8df040a4efc` of
[cloudflare/workerd](https://github.com/cloudflare/workerd). The conformance
oracle is pinned separately to release `v1.20260820.1`, commit
`dea490edc7e6fbd7e38d6dbd797b8ff0f2687179`.

A few comments cite `divergence <n>` with n ≥ 100. Those numbers come from the
mechanical-substitution ledger kept while the port was written; each citation
restates the divergence in full where it appears, so the ledger is not needed
to read the code. The three that recur: **147** — resuming from a promise the
runtime does not own leaves the continuation with no input lock, so the next
storage call throws (`no input lock available in this context`); **149** — a
promise that can never settle is replaced by a named rejection, because a hang
nobody can observe is worse than an error; **154** — workerd metrics types
(`EventOutcome`, `waitUntilStatus()`) have no port, and failures they would
have carried are kept readable instead of logged.

## §1 — workerd invariants

### §1.1 Input and output gates

Every actor has its own input and output gates. The input gate is a refcount
with FIFO waiters; the output gate is a promise chain. They are different
mechanisms with different jobs.

### §1.2 Input-gate slices

Actor entry holds the input gate for the synchronous slice and the microtask
checkpoint it drains. Storage backpressure may retain that lock explicitly.
Ordinary outbound I/O releases it and resumes through a fresh gated slice.

### §1.3 Outbound I/O

An outbound operation that may expose confirmed state waits for required output
locks. Cross-actor RPC, fetch, and other host-provided asynchronous operations
use actor-owned I/O so the caller remains re-entrant while waiting and resumes
under its own container.

### §1.4 Synchronous SQLite

The SQLite-backed actor path executes locally and synchronously once admitted
to an actor slice. Storage and SQL still require the owning input lock.
Internal `_cf_` names remain reserved to the runtime.

### §1.5 Critical sections

`blockConcurrencyWhile()` uses a real nested `CriticalSection`. It blocks peer
entries, inherits through supported reentry callbacks, has the workerd
deadline, and permanently breaks the input gate on failure.

### §1.6 Abort and breakage

Breaking either gate makes the container unusable, abandons pending work, and
refuses later entry. A subsequent request may create a fresh instance over
committed storage. JavaScript cannot synchronously terminate the slice that
called `DurableObjectState.abort()`; that difference is recorded in the
divergence table.

### §1.7 Writes and the output gate

Writes coalesce behind one output-gate obligation. A reply or outbound request
that could reveal the write waits until the corresponding commit is durable.

### §1.7.1 Transaction boundary

The implicit transaction spans storage awaits that retain the input lock and
commits at the checkpoint hand-off that releases it. An ordinary timer,
cross-actor call, or other released I/O ends the transaction before
resumption.

### §1.8 Alarms and WebSockets

Alarm delivery and accepted WebSocket frames are actor events. They enter the
owning container and do not overlap another event admitted by its gate.
Hibernatable WebSockets are not available on this substrate.

### §1.9 `waitUntil`

`waitUntil` owns background tasks without using either gate as a serialized
event tail. Abort drains or abandons those tasks according to the container
lifecycle.

### §1.10 Facets

A facet is a separate actor identity with its own state, database, gates, and
descendant lifecycle. Facets in one tree share the root-owned synchronous tree
index. Breakage travels down to descendants, never up to the parent or
sideways to siblings.

### §1.11 Worker Loader

Worker Loader is a binding over a host-supplied isolate channel. `get()`
versus `load()` placement and caching belong to that channel, not
`ActorContainer`. Dynamically-loaded isolates cannot directly have storage;
durable state pairs a dynamic Worker with a facet.

### §1.12 `cloudflare:workers`

The package supplies the Workers module surface needed by hosted code and
fails closed for substrate features it cannot implement. `newRpcSession()`
reconciles the declared `RpcTarget` identity with Cap'n Web before opening a
MessagePort session.

## §2 — port invariants

### §2.1 One application-entry boundary

External methods enter through `ActorContainer.entry()` and non-method events
through `run()`. A genuine self-loopback reuses the current slice
(`isCurrentSlice()`). Cross-actor calls pass through the callee's entry
surface and actor-owned I/O. There is no serialized event tail, method-family
dispatch table, or off-tail exception list.

### §2.2 Worker placement is not actor identity

The runtime gives every actor or facet its own container. The host decides
whether a facet's callable target is local or a native remote capability.
Sharing a worker never means sharing gates, storage, or state.

### §2.3 Explicit actor scope

Timers, fetch, crypto, and host I/O are reached through the owning actor's
scope — `container.globals`, installed ambiently only where one realm hosts
one root (`installActorScope`). A raw host promise that application code must
await is wrapped once at its shared owner with `awaitIo`; it is not repaired
at every caller or by patching the realm. No mutable global or ambient field
may select an actor across an `await`.

### §2.4 Storage contract

The public storage surface is the Workers TypeScript contract. Runtime
internals use a small synchronous `SqlDatabase` seam, with `node:sqlite` and
sqlite-wasm backends. JSON-incompatible values are rejected before write
rather than stored lossily. A present browser SAH pool accepts only current
actor/facet logical database names and SQLite-owned companions; an unknown
name fails startup.

### §2.5 Fail-closed substrate boundaries

Hibernation, point-in-time recovery, replication, SQL ingest, actor-class stub
serialization, and unsupported module-scope Workers features throw named
errors. They do not return empty values or silently downgrade behavior.

### §2.6 Alarm ownership

One namespace scheduler owns `_cf_ALARM`, delivery, retry, backoff, and
abandonment. A host timer layer carries only a physical one-shot projection.
Facets have no independent alarm slot.

### §2.7 Facet lifecycle

The runtime owns stable ids, depth and name limits, start fencing, abort,
recursive clone, cascading deletion, durable deletion receipts, reference
epochs, and recovery after interruption. Per-id placement and abort tails are
shared by the root actor tree, so a parent deletion waits for already-started
descendant placements before physical removal or receipt clearing. The host
owns only placement and physical storage operations.

## Decisions

1. Hold the input gate for the synchronous slice and its microtask checkpoint.
2. Retain it across storage backpressure only; `allowConcurrency` selects the
   released form.
3. Use workerd-shaped `CriticalSection` semantics rather than a mutex or
   queue.
4. Implement `blockConcurrencyWhile()` with that critical section and its
   deadline.
5. Use a promise-chain output gate and wait before externally observable I/O.
6. Treat a broken gate as fatal to the current container; rebuild from
   committed storage.
7. Bound implicit transactions by the same hand-off that releases the input
   gate.
8. Carry explicit actor scope through application-owned code and route raw
   host promises through `awaitIo`. Do not restore a one-slot async-context
   shim, patch the realm with zones, or infer an actor from a realm-wide
   global that can mean more than one.
9. No stream pump or generic remote-facet protocol in the runtime. Facet
   placement is the host's; direct actor hops use native capabilities.
10. Store per-connection host bridges by connection id. Do not save and
    restore an ambient across an `await`.
11. Run one conformance suite against real workerd, the Node backend, and the
    browser backend; assert unavailable substrate behavior rather than
    skipping it.
12. Prefer generic upstream seams; record every intentional divergence beside
    its implementation.
13. Preserve critical-section inheritance with the runtime's reentry-callback
    primitive where a nested call returns to the same actor context.
14. Implement the complete facet lifecycle. A broken facet leaves its parent
    and siblings alive.
15. Keep Worker Loader as a host binding over an isolate channel; it is not a
    facet-placement or sandbox-policy abstraction.
16. Port workerd behavior first and record every intentional semantic or
    substrate divergence in reference docs and conformance tests.
17. Fail closed where this substrate cannot reproduce V8 value serialization
    or SQLite authorizer input.
18. Reconcile Workers and Cap'n Web `RpcTarget` identity inside
    `newRpcSession()` before every session.

## Deliberate divergences

| Difference from production workerd | Contract here |
| --- | --- |
| No hibernation while retaining sockets | Hibernatable WebSocket APIs throw; applications use memory-only sockets and reconnect |
| JavaScript cannot terminate the currently executing slice | `abort()` breaks later storage and entry, but the calling method can still return |
| No common V8 byte serializer across Node and the browser | Values JSON cannot faithfully round-trip are rejected at `put()` |
| The SQLite backends expose no authorizer callbacks | Reserved `_cf_` identifiers are detected from tokenized statement text and may reject more than workerd |
| `node:sqlite` exposes no `sqlite3_limit()` | Bound and returned strings and blobs enforce workerd's 4 MiB limit; SQL-computed values that are never returned may exceed it. The browser backend sets the native limit. |
| A response BYOB reader cannot be re-gated after `read(view)` | BYOB readers throw; callers use a default reader or `arrayBuffer()` |
| A workerd facet alarm appears to schedule and then breaks asynchronously ([workerd#6810](https://github.com/cloudflare/workerd/issues/6810)) | This runtime refuses facet `setAlarm()` synchronously |
| A host may lose a physical wake between durable and platform timer writes | The host timer journals an opaque one-shot token before arming; the scheduler remains authoritative |
| No jsg exception provenance in browser errors | An unclassified alarm failure stays retryable rather than being prematurely abandoned |
| Local SQLite has no PITR, replication, or ingest | Those APIs throw named errors; bookmarks remain development counters, not recovery points |
| Cap'n Web and the declared Workers module can create distinct `RpcTarget` identities | `newRpcSession()` reconciles them at the transport boundary |
