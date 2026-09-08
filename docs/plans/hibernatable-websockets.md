# Hibernatable WebSockets — implementation plan

**Historical plan.** The initial implementation shipped in
[PR #37](https://github.com/WebMCP-org/do-runtime/pull/37). Version targets,
source anchors, oracle observations and unchecked boxes below are retained as
the original design record, not current release requirements. Current behavior
and remaining differences are recorded in [decisions](../decisions.md) and
the [September workerd sync](../workerd-sync.md).

One hard cutover, one PR, one release (0.5.0). This package stops refusing the
hibernation surface and implements it completely: the eight `DurableObjectState`
methods, socket attachments, `WebSocketPair`, handler-method dispatch, and an
embedder contract for rebuilding a container with its accepted sockets intact.
The consumer flip (Rook) happens later, against the published package — nothing
in this plan touches think-browser-host.

TDD discipline, in this repo's own shape: the conformance suite runs one spec
against three lanes and the workerd lane is the oracle. **Specs are written and
proven green against real workerd BEFORE any `src/` change.** Unit tests for the
do-runtime-specific embedder contract are written red before implementation.

Everything in §4 was measured against workerd v1.20260820.1 (the pinned oracle)
or read from its source at commit `dea490edc7e6fbd7e38d6dbd797b8ff0f2687179` —
each row says which. Everything in §3 was read out of the installed
`partyserver@0.5.10` dist and the `agents@0.21.0` source; anchors are to
`node_modules/.pnpm/partyserver@0.5.10_@cloudflare+workers-types@5.20260820.1/node_modules/partyserver/dist/index.js`
(hereafter `partyserver/dist`) and to workers-types
`@cloudflare/workers-types@5.20260820.1/experimental/index.d.ts`.

## 1. Read these first

| File | Why |
|---|---|
| `src/api/web-socket.ts` (whole file, 233 lines) | The classic accept path you are extending: `RawWebSocket`, `AcceptedWebSocket`, the gating semantics (§1.8), the module-level `accepted` WeakSet you are replacing, the header comment you are rewriting. |
| `src/api/actor-state.ts:39-47`, `:95-98`, `:1090-1130` | The stub rationale, the throwing message constant, and the eight stubs being replaced. |
| `src/server/actor-container.ts:233-276` (ports), `:331-363` (options), `:372-580` (interface), `:1400-1433` (`entry()`), `:1507` + `:1632` (`hasAlarmHandler` / `deliverAlarm` — the dispatch template) | Where the new port, the new option, and the dispatch pattern live. |
| `src/io/io-context.ts:785` (`hasCurrent`), `:893` (`getTimeoutCount`), `:912` (`isOutputGateBroken`), `:992-1020` (`addWaitUntil` / `taskCount` / `waitUntilStatus` / `drainWaitUntil`), `:670-697` (`TaskSet`) | Quiescence internals; `run()`/`addWaitUntil` shapes for dispatch. |
| `src/io/io-gate.ts:98-103` (`InputGateHooks`), `:652-669` (`OutputGateHooks` + never-settling default) | The dead hooks seam `gateHooks` revives. |
| `conformance/host.ts`, `conformance/workerd/host.ts`, `conformance/node/host.ts`, `conformance/browser/` | The harness you are extending with `connect`/`evict`. Note `container.globals` is "the complete platform globals" and the node lane routes `globalThis.*` into it per-actor. |
| `conformance/fixtures/probe.ts` | Probe style: methods journal observations into storage; specs read them back. Dependency-free (`cloudflare:workers` only) — that property must survive your additions. |
| `examples/platform-shims/memory-websocket-pair.ts`, `examples/platform-shims/message-port-websocket.ts`, `examples/extension/src/worker/actor.worker.ts:383`, `:764-788` | The shim being mostly absorbed into the runtime, and the example wiring that flips to hibernate-default. |
| `docs/decisions.md` §1.8, §2.5, divergence table (`:84`, `:156`, `:236`); `README.md:187`, `:234` | The recorded stance this change reverses. |

House rules that bit before: comment style anchors claims to workerd source
(`← web-socket.c++:…`); error strings asserted in tests are pinned with
**literals**, never the exported constant (tautology); `toThrowError(string)` is
substring containment — wrap exact-match assertions as
`toThrowError(new Error(exact))`.

## 2. Design (locked — do not re-litigate)

**D1. Sockets and `WebSocketPair` become runtime API.** A new
`HibernatableWebSocket`-capable socket object (one class, or the existing
`AcceptedWebSocket` grown — implementer's choice, but ONE object identity per
socket end) that is: extensible (partyserver `Object.assign`s 6 props and
`defineProperties` 8 more onto it), carries `send` / `close` / `accept` /
`readyState` / writable `binaryType` / `addEventListener`, and supports
attachments. `WebSocketPair` is a runtime-provided constructor producing two
linked halves (index 0 = client, 1 = server) over an in-memory duplex —
absorbing `examples/platform-shims/memory-websocket-pair.ts`'s `MemoryWebSocket`,
including its pre-accept event queue. Exposed through `container.globals`
exactly as `setTimeout` is; the examples' shim shrinks to the `Response`-101
subclass and `withWebSocketUpgrade` (Request/Response emulation stays
embedder-side — `api/http.ts`'s division is unchanged).

**D2. The WebSocket global surface.** partyserver reads the **global**
`WebSocket` in two load-bearing ways: `WebSocket.READY_STATE_OPEN` (its
module-load shim at `partyserver/dist:4-13` short-circuits because platform
WebSocket has `OPEN`, leaving `READY_STATE_*` undefined — sockets then never
match and `getConnections()` silently yields nothing; think-browser-host
carries a patch for exactly this), and
`WebSocket.prototype.{serialize,deserialize}Attachment.call(ws)`
(`partyserver/dist:39-55` — deliberately bypassing the own-property shadows it
installs). So the runtime ships a global installer (part of the same scope
setup that installs the other globals): add `READY_STATE_CONNECTING/OPEN/
CLOSING/CLOSED` statics (equal to the standard 0/1/2/3) to the platform
`WebSocket`, and put `serializeAttachment`/`deserializeAttachment` on its
prototype, dispatching through a runtime WeakMap so `.call(anyRuntimeSocket)`
works. On a receiver the runtime has never accepted, behave as workerd does
(§4 row C7).

**D3. Two accept modes, one registry.** Classic `accept()` keeps today's
semantics untouched (listener delivery, critical-section capture, output-gated
pump — `web-socket.ts` as it stands). `state.acceptWebSocket(ws, tags)` puts
the socket in hibernatable mode in a **per-container registry** (replacing the
module-level `accepted` WeakSet, which dies — its double-accept refusal moves
into the registry so classic-vs-hibernatable cross-accept is refused too,
matching §4 rows A1–A2). The registry holds, per socket: tags, attachment
bytes, auto-response timestamp, open/closed state. `getWebSockets(tag)` returns
a **fresh snapshot array** of live socket objects (tag-indexed; the connection
id is just a tag — partyserver's only id→socket index is
`getWebSockets(id)`), with closed-socket eviction timed per §4 row B4.

**D4. Dispatch to handler methods, alarm-shaped.** Hibernatable events never
fire listeners (§4 row D1); they invoke `instance.webSocketMessage /
webSocketClose / webSocketError` through the `deliverAlarm` dispatch shape
(`actor-container.ts:1507`, `:1632`) but WITHOUT the alarm no-overlap rule:
a plain fresh-input-lock `ctx.run(...)` per event riding `addWaitUntil`.
Measured (§4 row D4): events do not wait for the previous handler's returned
promise — they wait only on in-flight storage ops and
`blockConcurrencyWhile`. Binary
frames deliver as `ArrayBuffer`, never `Blob`, regardless of `binaryType`
(agents relies on this — its own comment says so). Handler-missing behavior per
§4 row D2. The dispatch context must be a full event context:
`blockConcurrencyWhile`, storage, SQL, and `getWebSockets()` are all legal
inside `webSocketMessage` (partyserver's `onStart` + agents' MCP restore run
exactly there). `webSocketClose` must tolerate `ws.close(code, reason)` called
on the closing socket from inside the handler (partyserver's `closeQuietly` in
its `finally`) without a sync or async throw.

**D5. `send()` after the DO's own close throws synchronously.** The agents
SDK's `sendIfOpen` try/catches `connection.send()` and checks
`error instanceof TypeError && message.includes("WebSocket send() after close")`
— a deferred pump error would make it return `true` and lose the frame
silently. So hibernatable `send()` checks state synchronously and, measured
(§4 row D7): after the DO's OWN `close()` it throws workerd's exact
`TypeError`; after a PEER-initiated close it is a silent no-op (no throw)
until the DO reciprocates. The output-gate pump still governs the actual wire
write for live sockets, unchanged. `close()` itself validates code (1000,
3000–4999) and the 123-byte reason cap with workerd's exact errors (§4 row
D7+).

**D6. Attachments serialize at call time to bytes.** `serializeAttachment(v)`
runs the storage value codec immediately (errors and the size cap — §4 rows
C2–C3 — surface at the call), stores bytes in the registry, and mirrors bytes
out through the port (D7). `deserializeAttachment()` decodes fresh each call
(§4 row C4). This is the only durable per-connection channel partyserver and
agents have (`__pk` envelope + `__user` slot); if it is lost after a rebuild,
`isPartyServerWebSocket` returns null and every handler silently returns —
total silence, no error. Treat attachment fidelity as the highest-stakes
correctness property in this plan.

**D7. New optional port: `hibernation`.** Earns the seam by upstream precedent
(workerd's `Worker::Actor` takes its hibernation manager as a constructor
input, the same way alarms hooks arrive). Shape (mirror-out only; correlate by
socket reference, no invented ids — partyserver keeps its id inside the
attachment):

```ts
export interface HibernationHost {
  accepted(socket: RawWebSocket, tags: readonly string[]): void;
  attachment(socket: RawWebSocket, bytes: Uint8Array | null): void;
  autoResponse(pair: { request: string; response: string } | null): void;
  closed(socket: RawWebSocket): void;
}
// ActorPorts gains: hibernation?: HibernationHost;
```

Absent port = fully functional in-instance hibernation with nothing mirrored
(an embedder that never rebuilds needs nothing). Port callbacks fire outside
the gates (they are host bookkeeping, not actor I/O).

**D8. Rehydration option.** `ActorContainerOptions` gains:

```ts
webSockets?: readonly {
  socket: RawWebSocket;
  tags?: readonly string[];
  attachment?: Uint8Array;
  autoResponseTimestamp?: number;
}[];
```

Pre-registered as accepted before the instance constructor runs; visible in
`getWebSockets()` immediately; no upgrade, no re-accept, no connect-time
callback of any kind (after a real hibernation wake nothing re-runs
`onConnect` — partyserver rebuilds connections lazily from the attachment).
This is do-runtime-specific API (workerd's runtime layer does it internally),
so it is specified by unit tests plus the lane-host `evict()` implementations,
not by probe code.

**D9. Auto-response and event timeout: implemented, embedder-visible.**
`setWebSocketAutoResponse` stores the pair, answers matching frames in-runtime
without dispatching (§4 rows E1–E2), stamps per-socket timestamps
(`getWebSocketAutoResponseTimestamp`, §4 row E3), and mirrors the pair through
the port so a host can answer for a dead worker (Rook's host pump already
answers pings at its transport layer today). `WebSocketRequestResponsePair`
becomes a real exported class (constructor + `request`/`response` getters, §4
row G). `set/getHibernatableWebSocketEventTimeout` store and report per §4
row F. partyserver/agents call **none** of these (measured: zero hits) — they
exist for API completeness and for relay-shaped consumers; conformance pins
them.

**D10. Types, capability, quiescence.**
- Adopt workers-types signatures verbatim (they are reproduced in §3.4);
  `acceptWebSocket(ws: WebSocket, tags?: string[]): void`,
  `getWebSockets(tag?: string): WebSocket[]`, etc. The `never` types and the
  `HIBERNATION_UNAVAILABLE` message constant (exported at `src/index.ts:140`)
  are deleted — breaking, accepted. Delete the only stub assertion
  (`src/api/actor-state.test.ts:930-946`).
- Remove `"hibernation"` from `conformance/host.ts`'s `Capability` union and
  from `conformance/workerd/host.ts:44`'s set. No spec ever consumed it; after
  this change all three lanes are native and `substrate()` branching for it
  would be dead code.
- Rider (small, same release): `container.quiescence()` returning
  `{ armedTimers, pendingWaitUntil, inputLockHeld, outputGateBroken }` over
  `getTimeoutCount()` / a new `TaskSet.size()` / `hasCurrent()` /
  `isOutputGateBroken()`, and `ActorContainerOptions.gateHooks?:
  { input?: InputGateHooks; output?: OutputGateHooks }` threaded into
  `ActorImpl` (`actor-container.ts:825` — the constructors already take hooks;
  nothing passes them). Document in the same pass that `drainWaitUntil()`
  never settles under a live `setInterval` and `quiescence()` is the
  eviction-decision affordance.

## 3. The consumer contract (measured from partyserver 0.5.10 + agents 0.21.0)

`hibernate: true` is the **default** for every `Agent` subclass
(`agents/src/index.ts:1307-1309`, `:1828`; partyserver resolves it by walking
static `options` up the constructor prototype chain, `partyserver/dist:545-553`).
The examples currently pin `hibernate: false`
(`examples/extension/src/worker/counter.ts:48`,
`examples/extension/src/worker/counter-child.worker.ts:23,59`,
`examples/vibe-platform/src/worker/workspace.ts:152`) — those pins get deleted
in S5 and the default takes over.

### 3.1 Connect (inside `Server.fetch`, `partyserver/dist:583-625`)

1. `onStart` (inside `ctx.blockConcurrencyWhile`) before the pair exists.
2. `new WebSocketPair()`; server half is `Object.assign`ed with `id`, `uri`,
   `server`, `tags`, `state`, `setState` — **sockets must be extensible**.
3. `getConnectionTags()` awaited; then `HibernatingConnectionManager.accept`
   (`partyserver/dist:221-254`): `ctx.acceptWebSocket(ws, prepareTags(...))`
   where `tags[0]` is the connection id (client-supplied `?_pk=` or nanoid),
   ≤10 tags, each non-empty ≤256 chars (partyserver validates before calling —
   the runtime's own limits per §4 row A5 back it up).
4. `serializeAttachment({ __pk: { id, tags, uri }, __user: null })` — via the
   **prototype** method. Unconditional, destructive at accept.
5. `createLazyConnection` `defineProperties` 8 props (id/uri/tags/socket/state
   getters reading the attachment; setState/serialize/deserialize shadows).
6. `new Response(null, { status: 101, webSocket: clientHalf })` returned.
7. In hibernate mode **no listener is ever attached** and neither `accept()`
   nor `binaryType` is touched on the happy path. partyserver's error path
   (`:629-638`) DOES classic-`accept()` a fresh pair half — classic accept on
   pair halves must keep working.

### 3.2 Wake (`webSocketMessage` / `webSocketClose` / `webSocketError`, `partyserver/dist:641-676`)

Per event: `WebSocket.prototype.deserializeAttachment.call(ws)` (twice — the
`isPartyServerWebSocket` guard, then the cache miss), `defineProperties`
re-graft, `ctx.blockConcurrencyWhile(onStart)` **inside the handler**,
`ctx.storage.get/put("__ps_name")`, `ctx.id.name` read, `ws.server = name`
plain assignment, then `onMessage/onClose/onError`. `webSocketClose`'s
`finally` calls `ws.close(code, reason)` back unless code is 1005/1006/1015.
`webSocketError` reads `ws.readyState` (numeric 0-3) and matches benign
teardown by message. Agents' `onStart` additionally runs SQL and
`broadcastMcpServers()` → `ctx.getWebSockets()` **inside
`blockConcurrencyWhile` inside `webSocketMessage`**.

Never called anywhere: `ctx.getTags`, the auto-response family, the event
timeout family, `binaryType` in hibernate mode (agents assigns it inside
try/catch — a throwing setter is tolerated, a missing property is fine).

### 3.3 Queries

- `getConnections()` → `ctx.getWebSockets(tag?)` once, lazily, result cached
  and **indexed positionally** (`partyserver/dist:133-158`) — must be a
  snapshot array. Filters `readyState === WebSocket.READY_STATE_OPEN`.
- `getConnection(id)` → `ctx.getWebSockets(id)` — **id-as-tag is the only
  id→socket index**; ≥2 matches throws; no readyState filter, so closed
  sockets must leave `getWebSockets()` (timing per §4 row B4) or a client
  reconnecting with the same `_pk` breaks `getConnection`.
- `broadcast` → send per connection; any send throw → `close(1011,
  "Unexpected error")`.
- Facet isolation: `getWebSockets()` is actor-scoped; a facet must not see its
  root's sockets (agents #1677 carve-out depends on it).

### 3.4 workers-types signatures (adopt verbatim)

```ts
acceptWebSocket(ws: WebSocket, tags?: string[]): void;
getWebSockets(tag?: string): WebSocket[];
setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void;
getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null;
setHibernatableWebSocketEventTimeout(timeoutMs?: number): void;
getHibernatableWebSocketEventTimeout(): number | null;
getTags(ws: WebSocket): string[];
// WebSocket: serializeAttachment(attachment: any): void; deserializeAttachment(): any | null;
// declare class WebSocketRequestResponsePair { constructor(request: string, response: string);
//   get request(): string; get response(): string; }
// Handlers: webSocketMessage?(ws, message: string | ArrayBuffer);
//   webSocketClose?(ws, code: number, reason: string, wasClean: boolean);
//   webSocketError?(ws, error: unknown);
```

(do-runtime types keep its own `RawWebSocket`-compatible socket type in the
positions workers-types write `WebSocket`.)

## 4. Measured workerd semantics

Every row below was MEASURED against the pinned workerd binary
(v1.20260820.1, driven via miniflare 4 with `MINIFLARE_WORKERD_PATH` — the
technique in the appendix). These rows ARE the conformance assertions for S1.
Error strings are byte-exact — pin them with literals, including the two
malformed ones. If a spec run ever disagrees with a row here, the oracle run
wins; fix the spec/row, never fudge the implementation.

### 4.0 Ten measured contradictions of common claims — read first

1. **Attachment cap is 16384 serialized bytes, not 2048.** (2048 is the
   auto-response pair limit.)
2. **The input gate does NOT serialize `webSocketMessage` on the handler's
   promise.** Two messages 60ms apart both run inside a 200ms-awaiting handler
   concurrently. Delivery IS deferred while a storage op is in flight or
   inside `blockConcurrencyWhile`. Any "one message at a time" assumption is
   wrong — dispatch is a plain fresh-lock `ctx.run` per event, NOT the alarm
   no-overlap rule.
3. **`getWebSockets()` no-arg returns REVERSE accept order (LIFO, newest
   first); `getWebSockets(tag)` returns FORWARD accept order.** The asymmetry
   is real; reproduce it.
4. **`serializeAttachment`/`deserializeAttachment` work on ANY WebSocket** —
   classic-accepted, never-accepted, client halves — and still work after
   `close()`. No hibernation requirement.
5. **Accepting the client half is allowed.** workerd never checks which half.
6. **A missing or throwing handler is a silent no-op** — message dropped, no
   error frame, no close, socket stays open and listed, later messages still
   deliver. (A throw may be recorded internally — in do-runtime it can land in
   `waitUntilStatus()` — but nothing observable happens to the socket or
   client, and the actor does not break.)
7. **`webSocketClose` fires for the DO's OWN `close()`**, carrying the peer's
   echoed code/reason (`readyState` 3 in the handler). For a peer-initiated
   close: handler sees the peer's code, `wasClean: true`, `readyState` 2
   during the handler, and stays 2 until the DO reciprocates.
8. **Double-`acceptWebSocket` reports the wrong API in its message**
   (``…already accepted via `accept()` ``) — pin it byte-exactly anyway.
9. **`setWebSocketAutoResponse(null)` throws**; only the zero-arg /
   `undefined` form clears.
10. **The attachment-size error string is malformed** (no space:
    `…16384 bytes.'attachment' was…`) — pin the literal.

### 4.A `acceptWebSocket(ws, tags?)`

| id | behavior | verbatim error |
|---|---|---|
| A1 | Second `acceptWebSocket` on the same socket → `Error` | `` Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()` `` |
| A2a | classic `accept()` then `acceptWebSocket` → `Error` | identical string to A1 |
| A2b | `acceptWebSocket` then classic `accept()` → `TypeError` | `Can't accept() WebSocket after enabling hibernation.` |
| A3 | **REFINED during implementation (re-measured on the oracle):** the boundary is pair USE, not the event — an UNUSED pair stashed across events accepts fine in a later event (pinned green on workerd: `acceptSocketFromLaterEvent` → null). What throws is accepting a half whose pair was already used: peer accepted, sent, closed, or attached to a 101 Response | `` Cannot call `acceptWebSocket()` on this WebSocket because its pair has already been accepted or used in a Response. `` |
| A4 | Accepting the CLIENT half succeeds; no half validation | — |
| A5 | 11 tags → `Error` | `a Hibernatable WebSocket cannot have more than 10 tags` |
| A5 | 257-char tag → `Error`; message embeds the entire offending tag untruncated | `"<tag>" is longer than the max tag length (256 characters).` |
| A5 | `[""]` allowed (`getTags() === [""]`); non-string tags String()-coerced (`123`→`"123"`, `null`→`"null"`, `{a:1}`→`"[object Object]"`); duplicates de-duplicated; non-array tags → `TypeError` | `Failed to execute 'acceptWebSocket' on 'DurableObjectState': parameter 2 is not of type 'Array'.` |
| A6 | No pre-accept message queue exists — every path that lets the client send before accept also makes accept throw A3. Do not build a queue | — |
| I | Socket cap per instance: 32768 (measured) → `Error` | `only 32768 websockets can be accepted on a single Durable Object instance` |

### 4.B `getWebSockets(tag?)`

| id | behavior |
|---|---|
| B1 | New array each call; identical element objects (`a[i] === b[i] === ` the accepted socket) |
| B2 | No-arg: reverse accept order (LIFO), stable across calls |
| B3 | Tagged: forward accept order (FIFO). Exact string match only (`"ALPHA"`, `""`, prefixes → `[]`); non-string tag → `[]`, no throw. No-arg includes untagged sockets |
| B4 | **CORRECTED during implementation (re-measured on the oracle):** the closed socket leaves `getWebSockets()` BEFORE `webSocketClose` runs — `listedDuringHandler: false` is pinned green on the workerd lane (`hibernation.spec.ts` D5/B4, D6-D7). The original probe report claimed during-handler presence; the oracle run won, per this plan's own rule |

### 4.C Attachments

| id | behavior | verbatim error |
|---|---|---|
| C1 | Snapshot at call time — later mutation of the passed object invisible | — |
| C2 | Cap = **16384 bytes of the serialized form** (v8-serialize; ~5 bytes overhead on a bare ASCII string — 16379 chars pass, 16380 fail). Use the storage codec's byte length as the measured quantity | `A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16385 bytes.` (no space after the first period) |
| C3 | Function → `DataCloneError` `function foo() {} could not be cloned.`; Symbol → `Symbol(s) could not be cloned.`; full structured clone otherwise (Map/Date/BigInt/TypedArray/cyclic all round-trip) | — |
| C4 | `deserializeAttachment()` returns a fresh clone each call | — |
| C5 | Never-serialized → `null` (not `undefined`) | — |
| C6 | `serializeAttachment(undefined)` → deserialize returns `undefined` (distinct from never-set `null`); zero-arg call → `TypeError` | `Failed to execute 'serializeAttachment' on 'WebSocket': parameter 1 is not of type 'Value'.` |
| C7 | Both methods work on any socket (classic, unaccepted, client half, closed) | — |

### 4.D Dispatch

| id | behavior | verbatim |
|---|---|---|
| D1 | Handler methods only; `addEventListener` on a hibernation-accepted socket never fires | — |
| D2 | Missing handler → silent drop (no close, no error frame, socket stays open and listed, nothing delivered to the client). Throwing handler → same silence; later messages still delivered | — |
| D3 | Text → `string`; binary → `ArrayBuffer` (never `Uint8Array`, never `Blob`) | — |
| D4 | Concurrent delivery: events do NOT wait for the previous handler's promise. They DO wait on in-flight storage ops and on `blockConcurrencyWhile`. Implement as fresh-input-lock `ctx.run` per event riding `addWaitUntil` | — |
| D5 | Peer `close(4001,"bye")` → `webSocketClose(ws, 4001, "bye", true)`; `readyState === 2` during the handler | — |
| D6 | DO's own `close(4002,"server out")` → `webSocketClose` fires with the peer's echo `(4002, "server out", true)`, `readyState === 3` in the handler; client sees a clean 4002. Peer that never echoes → `(1006, "WebSocket disconnected without sending Close frame.", false)` | — |
| D7 | `send()` after the DO's OWN close → `TypeError: Can't call WebSocket send() after close().` — synchronous. After a PEER-initiated close, `send()` is a silent no-op (no throw) until the DO reciprocates | as shown |
| D7 | `readyState`: fresh pair half = 1 (never 0); after accept 1; own close → 2 then 3; peer close → 2 until reciprocated. Constants on constructor AND prototype: `READY_STATE_*` = 0/1/2/3 plus standard `CONNECTING/OPEN/CLOSING/CLOSED` | — |
| D7+ | `close()` validation: codes 1000, 3000–4999 OK; 999/1005/1006/5000 → `InvalidAccessError` `Invalid WebSocket close code: 1005.`; reason over 123 UTF-8 bytes → `SyntaxError` `WebSocket close reason must not be longer than 123 bytes when UTF-8 encoded.` | as shown |

### 4.E Auto-response

| id | behavior | verbatim |
|---|---|---|
| E1 | Matching text frame answered without invoking `webSocketMessage`; client receives the response | — |
| E2 | Exact whole-string match only; near-matches, case variants, and binary frames containing the request bytes all reach the handler | — |
| E3 | `getWebSocketAutoResponseTimestamp(ws)`: `null` before any match; `Date` after; per-socket; near-misses don't update; non-hibernatable/unaccepted sockets → `null`; bad arg → `TypeError: Failed to execute 'getWebSocketAutoResponseTimestamp' on 'DurableObjectState': parameter 1 is not of type 'WebSocket'.` | as shown |
| E4 | Zero-arg / `undefined` clears (get → `null`, handler resumes). `set(null)` → `TypeError` | `Failed to execute 'setWebSocketAutoResponse' on 'DurableObjectState': parameter 1 is not of type 'WebSocketRequestResponsePair'.` |
| E5 | `getWebSocketAutoResponse()` returns a brand-new pair object every call | — |
| E6 | Request and response each capped at 2048 bytes → `RangeError` | `Request cannot be larger than 2048 bytes. A request of size 2049 was provided.` / `Response cannot be larger than 2048 bytes. A response of size 2049 was provided.` |
| E7 | Applies retroactively to sockets accepted before the pair was set; replacement is immediate for all sockets | — |

### 4.F/G/H Event timeout, pair class, getTags

| id | behavior | verbatim |
|---|---|---|
| F1 | Default `getHibernatableWebSocketEventTimeout()` → `null` | — |
| F2 | `set(0)` clears (get → `null`); `set(1000)` → 1000; floats truncate; numeric strings coerce; `set(-1)` → `TypeError` `The value cannot be converted because it is negative and this API expects a positive number.`; `> 2**32-1` → `TypeError` `Value out of range. Must be less than or equal to 4294967295.`; in-range but over 7 days → `Error` `Event timeout should not exceed 604800000 ms.`; `NaN` → `TypeError` `The value cannot be converted because it is not an integer.` | as shown |
| G1 | `new WebSocketRequestResponsePair(request, response)`: args String()-coerced; extra args ignored; getters read-only (no setter); calling without `new` / non-string-coercible → `Failed to construct 'WebSocketRequestResponsePair': …`; `JSON.stringify` → `{}` | as shown |
| H1 | `getTags` on never-accepted socket → `Error: you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.`; on a classic-accepted socket → `Error: only hibernatable websockets can have tags.` | as shown |
| H2/H3 | No tags → `[]`; fresh array copy each call | — |

### 4.J The in-DO self-drive pattern (the suite's workhorse)

Confirmed to work completely — the whole API is drivable inside one DO method
with no network client and no harness changes:

```js
const pair = new WebSocketPair();
this.ctx.acceptWebSocket(pair[1], tags);  // MUST come first (reverse order throws A3)
pair[0].accept();                          // classic-accept the client half
pair[0].addEventListener("message", …);   // client observations
pair[0].send("hello");                     // → webSocketMessage(pair[1], "hello") on a LATER turn
```

- Delivery is on a later turn — journal observations and read them back from a
  second `actor.call`.
- `ws.send` from inside `webSocketMessage` reaches the in-DO client listener;
  `client.close(4000,"done")` → `webSocketClose(ws, 4000, "done", true)`;
  `getWebSockets()[0] === pair[1]`.
- Use in-DO clients to observe close codes: miniflare `dispatchFetch` sockets
  in Node deliver `message` but not `close` events. (Pool-workers stub sockets
  in the S1 eviction spec live inside workerd and do not have this limitation.)

### Unmeasured: the real eviction cycle

Standalone workerd cannot be made to evict. The S1 eviction-cycle spec IS that
measurement: `evictDurableObject(stub, { webSockets: "hibernate" })` in the
pool-workers lane forces real hibernation, and whatever it reveals about
attachment/tag/`getWebSockets` survival is the truth the node/browser rebuild
path must reproduce.

## Appendix: the oracle probe technique

Reusable for any follow-up question. Miniflare 4 outside the workers pool,
`MINIFLARE_WORKERD_PATH` at the pinned binary, `useSQLite: true` DO, results as
JSON over HTTP:

```js
import { Miniflare } from "miniflare";
process.env.MINIFLARE_WORKERD_PATH ??=
  "<repo>/node_modules/.pnpm/@cloudflare+workerd-darwin-arm64@1.20260820.1/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd";
const mf = new Miniflare({
  modules: true, scriptPath: "worker.js", compatibilityDate: "2026-08-20",
  durableObjects: { PROBE: { className: "Probe", useSQLite: true } },
});
await mf.ready;
const res = await mf.dispatchFetch("http://x/probe");   // worker returns JSON
```

The full probe scripts from this plan's measurement session (harness +
workers a–j) are at
`/private/tmp/claude-501/-Users-alexmnahas-personalRepos-WebMCP-org-do-runtime/d068ec0b-7147-44a6-9cea-39c1bb06642b/scratchpad/probe/`
while that scratchpad survives; the S1 conformance specs are their durable
replacement.

## 5. TDD sequence

**S1 — conformance first, oracle-green before any `src/` change.**
- Extend `conformance/fixtures/probe.ts` with hibernation methods (in-DO
  `WebSocketPair` self-drive where §4 row J allows: construct pair, hibernation-
  accept the server half, classically accept and drive the client half, journal
  observations to storage; probe stays dependency-free). Add a `fetch(request)`
  upgrade branch to the probe class (pair + `acceptWebSocket` with tags from
  the URL + 101 response) for the externally-connected specs.
- Extend the harness: `ConformanceHost` gains
  `connect?(actor, tags?): Promise<LaneClientSocket>` (workerd lane:
  `stub.fetch` with an Upgrade header → `response.webSocket.accept()`;
  node/browser lanes: the probe's same `fetch` through `entry()` with the
  Response-101/upgrade shims) and `evict?(actor): Promise<void>` (workerd lane:
  `evictDurableObject(stub, { webSockets: "hibernate" })` from
  `cloudflare:test` — present in the pinned `@cloudflare/vitest-pool-workers@0.18.8`;
  node/browser lanes: tear the container down and rebuild it with
  `options.webSockets` from state the lane host mirrored through
  `ports.hibernation` — the lane host IS the reference embedder).
- Write `conformance/suite/hibernation.spec.ts` asserting every §4 row plus
  the eviction cycle: connect externally → serialize attachment → evict →
  send → woken instance sees `webSocketMessage` with `getWebSockets()`, tags,
  and attachment intact, and `onConnect`-equivalent code did NOT re-run.
- Exit criterion: `pnpm test:conformance-workerd` green with the new spec, on
  a tree whose `src/` is untouched. node/browser lanes now fail — that is the
  red state.

**S2 — unit tests, red.** In `src/api/web-socket.test.ts` style
(`TestActor`/`FakeSocket` fixtures): registry lifecycle; cross-accept
refusals; attachment codec + cap + call-time snapshot; port callback timing
(accepted/attachment/closed, and that callbacks carry the same socket
reference); rehydration (container A → mirror → container B over fresh raw
duplexes → frame → handler + `getWebSockets` + `deserializeAttachment`
intact); auto-response answering without dispatch + timestamps; sync
`TypeError` on send-after-close; `quiescence()` counts; `gateHooks`
threading reaches both gates.

**S3 — implement** until unit + all three conformance lanes are green:
registry + socket class + `WebSocketPair` + global installer (D1–D3), dispatch
(D4–D5), attachments (D6), port (D7), rehydration (D8), auto-response/timeout
(D9), types/capability/quiescence/hooks (D10).

**S4 — lanes.** `pnpm test:unit`, `pnpm test:conformance-node`,
`pnpm test:conformance-browser`, `pnpm test:conformance-workerd`,
`pnpm check:oracle` (workerd pin untouched).

**S5 — examples flip.** Delete the three `hibernate: false` pins; shrink
`examples/platform-shims/memory-websocket-pair.ts` to the Response-101
subclass + `withWebSocketUpgrade` over the runtime's `WebSocketPair`; delete
the think-browser-host-style `READY_STATE_OPEN` hand-shim if the runtime
installer now owns it; `pnpm test:examples` green. The examples now run the
real agents SDK through `HibernatingConnectionManager` end-to-end — this is
the stand-in for the Rook flip.

**S6 — docs.** `docs/decisions.md` §1.8/§2.5 + divergence table rows;
`README.md:187` (eviction contract) and `:234` (hibernation stance — narrows
from "hibernation absent" to "frame protocol and byte accounting absent");
headers of `src/api/web-socket.ts` and `src/api/actor-state.ts:39-47`;
`docs/gating-coverage.md` if it enumerates the stubs.

**S7 — changeset.** Minor (0.5.0). Breaking notes: hibernation stubs replaced
with implementations; `HIBERNATION_UNAVAILABLE` export removed; `Capability`
union narrowed; state method types un-`never`ed.

## 6. File map

| File | Change |
|---|---|
| `src/api/web-socket.ts` | Registry-backed rewrite: keep classic `AcceptedWebSocket` semantics byte-for-byte; add hibernatable mode, attachments, `WebSocketPair`, the global installer; delete the module WeakSet; rewrite the header. |
| `src/api/actor-state.ts` | Eight stubs → real implementations delegating to the container/registry; delete the message constant; new header rationale. |
| `src/server/actor-container.ts` | `ports.hibernation`, `options.webSockets`, `options.gateHooks`, `quiescence()`, `deliverWebSocket*` dispatch beside `deliverAlarm`, registry ownership. |
| `src/io/io-context.ts` / `io-gate.ts` | `TaskSet.size()`; thread `gateHooks` into `ActorImpl`'s gate construction. |
| `src/index.ts` | Export the new surface; delete the stub-message export. |
| `conformance/host.ts`, `conformance/{workerd,node,browser}/host.ts` | `connect`/`evict` affordances; drop `"hibernation"` capability. |
| `conformance/fixtures/probe.ts`, `conformance/suite/hibernation.spec.ts` | New probe methods + the new spec (S1). |
| `src/api/web-socket.test.ts` + new unit file(s) | S2 tests. |
| `examples/platform-shims/memory-websocket-pair.ts`, `examples/*/src/worker/*.ts` | S5 shrink + pin deletion. |
| `docs/decisions.md`, `README.md`, `docs/gating-coverage.md` | S6. |

## 7. Acceptance checklist

- [ ] S1 spec green against real workerd BEFORE `src/` changed (the commit
      history should show it).
- [ ] All three conformance lanes + unit + examples e2e green.
- [ ] The eviction-cycle spec passes in all three lanes (workerd: real
      hibernation via `evictDurableObject`; node/browser: container rebuild
      through `ports.hibernation` + `options.webSockets`).
- [ ] partyserver contract rows §3.1–3.3 each covered by a spec or unit test —
      in particular: prototype-reachable attachment methods, snapshot
      `getWebSockets`, id-as-tag lookup, closed-socket eviction, sync
      send-after-close `TypeError`, ArrayBuffer-only binary delivery,
      no-listener dispatch, reciprocal-close tolerance, `blockConcurrencyWhile`
      + storage + `getWebSockets` legal inside handlers, `ctx.id.name`
      populated, facet isolation of `getWebSockets`.
- [ ] `WebSocket.READY_STATE_OPEN === 1` after the global installer runs (the
      partyserver silent-empty-iterator bug is pinned by a test).
- [ ] Error strings byte-match §4's verbatim rows (literal assertions).
- [ ] `pnpm check:oracle` unchanged; no new dependency added.

## 8. Out of scope, risks

Out of scope: the Rook flip (separate task against the published 0.5.0);
eviction policy (embedder's decision — `quiescence()` is the affordance);
the WebSocket frame protocol and byte accounting (the recorded boundary that
remains); `Request`/`Response`/101 emulation (stays embedder-side).

Risks to keep in view while implementing:
- Attachment loss after rebuild is **silent** total failure in partyserver
  (`isPartyServerWebSocket` → null → every handler returns) — this is why the
  eviction-cycle spec asserts through the attachment, not around it.
- The classic path's behavior is pinned by existing tests
  (`src/api/web-socket.test.ts`) — the rewrite must not disturb them.
- Dispatch ordering under the input gate (§4 row D4) interacts with
  `blockConcurrencyWhile`-inside-handler; get the conformance row green on
  workerd first and let it drive the implementation, not intuition.
