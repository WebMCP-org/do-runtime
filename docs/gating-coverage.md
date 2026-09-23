# Gating coverage ledger

The invariant (§1.2, §1.3): **every await an actor performs must resume through a
runtime-owned seam, or its continuation returns with an empty invocation stack
and the next storage call throws** `no input lock available in this context`.

"We need all of JavaScript" is the fear; the actual surface is smaller and
finite. Pure JS is safe by construction: an input lock drains the whole
microtask checkpoint, so `Promise.resolve` chains, `queueMicrotask`, async
functions that never leave the checkpoint — all inherit the lock. What escapes
is exactly the set of **platform APIs that park a continuation on a macrotask**:
network, streams, timers, crypto, events. That set is enumerable, and this file
enumerates it. Every row is one of:

- **Gated** — a runtime seam exists and tests hold it.
- **Open hole** — reachable from gated flows today; needs a seam.
- **Fail-closed** — refused loudly rather than passed through ungated.
- **Foreign by design** — no runtime seam can exist; actor code must use
  `awaitIo` discipline (or, if the tail grows, the
  compile-time await transform below).
- **Not in contract** — realm globals a Durable Object should never touch;
  listed so the fall-through is a decision, not an accident.

## Gated

| Seam | Mechanism | Where |
| --- | --- | --- |
| `fetch` | output-gate wait, then `awaitIo`; response wrapped on resolve | `api/global-scope.ts` |
| Body consumers (`arrayBuffer` `blob` `bytes` `formData` `json` `text`) | `awaitIo` per read, on `Request` and `Response`, clones included | `api/http.ts` |
| Second-order `Blob` reads (`arrayBuffer` `bytes` `text` `stream` `slice`) | async members use `awaitIo`; streams and slices are recursively gated | `api/http.ts` |
| `body.getReader().read()` | gated reader proxy | `api/http.ts` |
| `body.values()` / async iteration | iterator reads through the gated reader; early return preserves native cancel and lock-release semantics | `api/http.ts` |
| Reader/stream lifecycle (`reader.closed`, both `cancel()` methods) | settlement uses `awaitIo`; `closed` is gated and registered once | `api/http.ts` |
| `body.tee()` | both halves re-gated | `api/http.ts` |
| Actor-created `ReadableStream` / `TransformStream` callbacks | constructor captures the current actor and async stores; `pull`, `transform`, `flush`, and `cancel` use `makeReentryCallback`; synchronous `start` retains its native timing and receiver | `api/global-scope.ts`; delayed input and external consumer regressions in `global-scope.test.ts`; the §1.2 outside-consumer conformance row |
| `body.pipeThrough()` / `pipeTo()` | returned readable re-gated (recurses through chains); settlement `awaitIo`d — native pipe machinery bypasses the `getReader` override and would launder the stream | `api/http.ts`, 0.2.2 |
| `setTimeout` / `setInterval` | arming captures the critical section; firing re-enters via `ctx.run` | `api/global-scope.ts` |
| `scheduler.wait()` / `scheduler.yield()` | scoped `Scheduler` over the same timer path | `api/global-scope.ts` |
| `crypto.subtle.*` | every method's promise gated; sync members pass through | `api/global-scope.ts` |
| Accepted `WebSocket` / `WebSocketPair` | classic listener delivery re-enters its captured context; hibernatable frames take fresh input locks; application sends snapshot binary input and wait for output confirmation; automatic replies bypass unrelated storage locks while preserving frame order. A 101 Response transfers its endpoint to the host. | `api/web-socket.ts` |
| storage / `sql` / alarms / `blockConcurrencyWhile` / `awaitIo` / `makeReentryCallback` / entry and loopback dispatch | the runtime's own primitives | `io/io-context.ts`, `server/actor-container.ts` |

## Transform

`@mcp-b/do-runtime/vite` provides `doRuntimeAwaitTransform()`, a post-transform
Vite plugin for actor-bundled modules. It rewrites every `await value` to route
through `@mcp-b/do-runtime/gate`, and wraps every `for await` source so
`next()`, `return()`, and `throw()` settlements re-enter the owning actor.

The gate helper fails open outside actor code. A development transform supplies
the module id and warns once if that path is reached; production keeps the helper
silent. Inside an actor, an await resumes where workerd would, except as below:

- **Settled while the actor still holds its input lock**, in the critical section
  the await ran under — a storage call, a plain value, or a resumption the runtime
  already admitted (a timer, `fetch`, actor RPC, the `blockConcurrencyWhile`
  hand-back). The continuation runs in that checkpoint, so it keeps the lock and
  the implicit transaction (§1.2, §1.7.1).
- **Settled anywhere else** — foreign I/O, a raw timer. The continuation re-enters
  through a fresh input-gated slice queued behind waiting events (§1.3). That slice preserves a surrounding `blockConcurrencyWhile`
  critical section so the section can await its own continuation without
  deadlocking.

The checkpoint ends at the runtime's `MessageChannel` hand-off, not at the end of
the microtask drain. A foreign promise that settles in the gap before that
hand-off therefore continues under the still-held lock, as an untransformed
continuation would. It can run ahead of this actor's earlier foreign
continuations already queued at the gate. A promise another actor resolves
resumes inline if this actor holds a lock; workerd defers it to this actor's own
turn. A promise resolved inside `blockConcurrencyWhile` resumes an await captured
outside the section only after the section ends, where workerd resumes it inside;
a section that waits on that continuation stalls until its 30-second deadline
breaks the actor.

The tokenized actor identity is realm-shared so separately bundled actor and host
copies agree. It exists only while the captured context still holds its input
lock, the synchronous current slice always wins, and the marker clears at that
context's checkpoint boundary. One actor's continuations own a checkpoint, so two
actors' promises settling in the same checkpoint cannot overwrite each other's
identity. The other actor's continuation waits for a later task; if it had its
lock, it keeps holding it, so none of that actor's other events can run first. Its
implicit transaction still commits at the hand-off. It happens whenever another
actor's continuation ran earlier in the same task, with or without a call between
them.

At build end the plugin reads the final Rollup module graph, after later
transforms, and compares fully wrapped awaits with total awaits per included
module. It logs the aggregate and fails the build with each incomplete module's
transformed/total count. `await using` is counted as uncovered rather than
silently claimed. The transform covers ordinary syntactic awaits selected by the
consumer's include policy, including top-level await and async generators. It
does not cover bare `.then()` chains on foreign promises, null-byte virtual
modules, or code outside the filter. The runtime itself is excluded: its
internal promise machinery must keep using raw awaits.
Every seam row above remains defense in depth for untransformed consumers and for
promise continuations that do not pass through syntax the transform can rewrite.

## Open holes, ranked

1. **`File` entries returned by `formData()`** — the FormData consumer itself is
   gated, but its `File` values are raw second-order Blobs. Covering every path
   requires wrapping `get`, `getAll`, `entries`, `values`, `forEach`, and both
   iteration protocols; no current consumer calls `formData()`, so that proxy is
   deferred rather than silently claiming the Files are covered.
2. **Actor-created `WritableStream` sinks** — actor-constructed stream callbacks
   are in scope (the Gated row above), but only `ReadableStream` and
   `TransformStream` are wrapped. A sink fed by native pipe machinery, such as
   `gatedBody.pipeTo(new WritableStream({ write(chunk) { … } }))`, runs `write`,
   `close` and `abort` with no input lock, so a storage call inside them throws.
   The seam is the same constructor proxy, extended to those three callbacks.

## Fail-closed

| Surface | Why |
| --- | --- |
| `getReader({ mode: "byob" })` | `read(view)` returns the caller's own buffer; there is no seam to gate, and a working-but-ungated reader is the silent failure this layer exists to prevent |
| Actor-global `new WebSocket(url)` | The native constructor starts its handshake immediately, before output confirmation. Refused before construction; hosts supply transports and actor code can use `WebSocketPair`. |

## Foreign by design

For modules outside the transform, no runtime seam can exist for promises the
actor manufactures itself. The discipline: resolve them through the `awaitIo`
the host hands actor code — `actorScopeBindings(...).awaitIo`, or the host's own
wrapper over `container.awaitIo()`. Provenance (0.2.1) names the window when the
discipline slips.

- `new Promise` resolved from an event: `MessagePort.onmessage`,
  `addEventListener`, `FileReader`, `AbortSignal` `"abort"`.
- Direct reads of user-constructed streams outside a gated chain: a
  `new ReadableStream`, `TransformStream`, `TextDecoderStream` or
  `CompressionStream` read directly rather than via a gated body's
  `pipeThrough`. An actor-created stream's callbacks are gated (the row above);
  reads from it are not.
- `AbortSignal.timeout()` — a platform timer; use `scheduler.wait` + an
  `AbortController` instead.
- One-shot platform promises: dynamic `import()`, `WebAssembly.instantiate`,
  `createImageBitmap`, `OffscreenCanvas.convertToBlob`, `FontFace.load`,
  `Atomics.waitAsync`.

## Not in contract

Realm globals the scope does not bind fall through **ungated**. A Durable
Object has no business with them; if one becomes load-bearing it moves up into
a gated row, in the same PR that exposes it.

`caches` (edge facility; the browser's is a different contract — see
`api/cloudflare-workers.ts`), IndexedDB, OPFS / `navigator.storage`,
`navigator.locks`, `XMLHttpRequest`, `EventSource`, `BroadcastChannel`,
`scheduler.postTask` (the scope's assignment replaces Chrome's scheduler, so
this one is absent rather than ungated).

## How this ledger stays honest

1. **Same-PR rule**: any change that exposes a new async platform surface to
   actor code adds or moves a row here in the same commit, the way vendored
   edits carry their `vendor/agents/docs/fork-diff.md` row.
2. **Provenance is the tripwire**: every escape now reports the last gated site
   and the milliseconds elapsed — it points at the row to file.
3. **Dist audits find holes before production does**: grep consumer bundles for
   `for await`, `.pipeThrough(`, `.getReader(`, `new Promise(` near ports and
   events. Both the pipeThrough hole and the async-iterator hole were findable
   this way; one of them was found this way.
4. **The total answer**: the [transform](#transform) rewrites every syntactic
   await in actor-owned modules. The rows above remain the independently tested
   surgical layer underneath it.
