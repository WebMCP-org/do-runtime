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
  `awaitIo` / `makeReentryCallback` discipline (or, if the tail grows, the
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
| `body.pipeThrough()` / `pipeTo()` | returned readable re-gated (recurses through chains); settlement `awaitIo`d — native pipe machinery bypasses the `getReader` override and would launder the stream | `api/http.ts`, 0.2.2 |
| `setTimeout` / `setInterval` | arming captures the critical section; firing re-enters via `ctx.run` | `api/global-scope.ts` |
| `scheduler.wait()` / `scheduler.yield()` | scoped `Scheduler` over the same timer path | `api/global-scope.ts` |
| `crypto.subtle.*` | every method's promise gated; sync members pass through | `api/global-scope.ts` |
| `WebSocket` | frames each take a fresh input lock at the `accept()` loop; `send` carries its own output-gate promise (§1.8) | `api/web-socket.ts` |
| storage / `sql` / alarms / `blockConcurrencyWhile` / `awaitIo` / `makeReentryCallback` / entry dispatch | the runtime's own primitives | `io/io-context.ts`, `server/actor-container.ts` |

## Transform

`@mcp-b/do-runtime/vite` provides `doRuntimeAwaitTransform()`, a post-transform
Vite plugin for actor-bundled modules. It rewrites every `await value` to route
through `@mcp-b/do-runtime/gate`, and wraps every `for await` source so
`next()`, `return()`, and `throw()` settlements re-enter the owning actor.

The gate helper fails open outside actor code. Inside an actor it publishes each
continuation through a fresh input-gated slice, including awaits of plain values;
the actor identity exists only for that continuation's microtask and is cleared
before another publication. Publications are serialized across actors so two
promises settling in the same checkpoint cannot overwrite each other's identity.

The transform covers every syntactic await in modules selected by the consumer's
include policy, including top-level await and async generators. It does not cover
bare `.then()` chains on foreign promises or code outside the filter. The runtime
itself is excluded: its internal promise machinery must keep using raw awaits.
Every seam row above remains defense in depth for untransformed consumers and for
promise continuations that do not pass through syntax the transform can rewrite.

## Open holes, ranked

1. **`File` entries returned by `formData()`** — the FormData consumer itself is
   gated, but its `File` values are raw second-order Blobs. Covering every path
   requires wrapping `get`, `getAll`, `entries`, `values`, `forEach`, and both
   iteration protocols; no current consumer calls `formData()`, so that proxy is
   deferred rather than silently claiming the Files are covered.
2. **`WritableStream` seams** — none handed out by the runtime today, so no
   hole yet; the moment an API returns one, `writer.write()` / `ready` /
   `close()` need the same treatment. This row exists so that PR adds the seam.

## Fail-closed

| Surface | Why |
| --- | --- |
| `getReader({ mode: "byob" })` | `read(view)` returns the caller's own buffer; there is no seam to gate, and a working-but-ungated reader is the silent failure this layer exists to prevent |

## Foreign by design

For modules outside the transform, no runtime seam can exist for promises the
actor manufactures itself. The discipline: resolve them through
`ctx.awaitIo(...)`, or deliver events through `makeReentryCallback`. Provenance
(0.2.1) names the window when the discipline slips.

- `new Promise` resolved from an event: `MessagePort.onmessage`,
  `addEventListener`, `FileReader`, `AbortSignal` `"abort"`.
- User-constructed streams read outside a gated chain: `new ReadableStream`,
  a `TransformStream` / `TextDecoderStream` / `CompressionStream` read directly
  rather than via a gated body's `pipeThrough`.
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
   edits carry their `upstream-diff.md` entry.
2. **Provenance is the tripwire**: every escape now reports the last gated site
   and the milliseconds elapsed — it points at the row to file.
3. **Dist audits find holes before production does**: grep consumer bundles for
   `for await`, `.pipeThrough(`, `.getReader(`, `new Promise(` near ports and
   events. Both the pipeThrough hole and the async-iterator hole were findable
   this way; one of them was found this way.
4. **The total answer**: the [transform](#transform) rewrites every syntactic
   await in actor-owned modules. The rows above remain the independently tested
   surgical layer underneath it.
