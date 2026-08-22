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
| `body.getReader().read()` | gated reader proxy | `api/http.ts` |
| `body.tee()` | both halves re-gated | `api/http.ts` |
| `body.pipeThrough()` / `pipeTo()` | returned readable re-gated (recurses through chains); settlement `awaitIo`d — native pipe machinery bypasses the `getReader` override and would launder the stream | `api/http.ts`, 0.2.2 |
| `setTimeout` / `setInterval` | arming captures the critical section; firing re-enters via `ctx.run` | `api/global-scope.ts` |
| `scheduler.wait()` / `scheduler.yield()` | scoped `Scheduler` over the same timer path | `api/global-scope.ts` |
| `crypto.subtle.*` | every method's promise gated; sync members pass through | `api/global-scope.ts` |
| `WebSocket` | frames each take a fresh input lock at the `accept()` loop; `send` carries its own output-gate promise (§1.8) | `api/web-socket.ts` |
| storage / `sql` / alarms / `blockConcurrencyWhile` / `awaitIo` / `makeReentryCallback` / entry dispatch | the runtime's own primitives | `io/io-context.ts`, `server/actor-container.ts` |

## Open holes, ranked

1. **`ReadableStream` async iteration** — `for await (const chunk of body)` and
   `.values()`. The same launder as `pipeThrough`: the async iterator acquires
   its reader through the internal spec operation, not the instrumented
   `getReader` property, so every chunk resumes foreign. **In live use**: `ai@6`
   iterates streams with `for await`. Fix: define `Symbol.asyncIterator` and
   `values` on gated streams to loop over the gated reader.
2. **Second-order `Blob` reads** — the gated `res.blob()` consumer returns a
   raw `Blob`; `blob.text()` / `arrayBuffer()` / `bytes()` / `stream()` are new
   foreign promises (upstream these are jsg promises, gated by construction).
   Same for `File` entries in a `formData()` result. Fix: wrap the returned
   Blob's async members.
3. **Reader lifecycle promises** — `reader.closed`, `reader.cancel()`,
   `stream.cancel()` settle ungated. Narrow (nothing observed awaiting them
   before storage), cheap to `awaitIo`.
4. **`WritableStream` seams** — none handed out by the runtime today, so no
   hole yet; the moment an API returns one, `writer.write()` / `ready` /
   `close()` need the same treatment. This row exists so that PR adds the seam.

## Fail-closed

| Surface | Why |
| --- | --- |
| `getReader({ mode: "byob" })` | `read(view)` returns the caller's own buffer; there is no seam to gate, and a working-but-ungated reader is the silent failure this layer exists to prevent |

## Foreign by design

No runtime seam can exist for promises the actor manufactures itself. The
discipline: resolve them through `ctx.awaitIo(...)`, or deliver events through
`makeReentryCallback`. Provenance (0.2.1) names the window when the discipline
slips.

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
4. **The total answer, if the tail gets long**: a compile-time await transform
   over actor-owned modules (rewrite every `await x` to the gated equivalent).
   That is the only "all of JavaScript" guarantee; everything above is the
   surgical version, kept small by the microtask-inheritance fact at the top.
