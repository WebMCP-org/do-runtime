# Chrome MV3 extension example

One Agents SDK actor and its local sub-agents, running for real inside a Manifest
V3 extension: a service worker that owns nothing, an offscreen document that
supervises, a module Worker that holds the actor tree, and SQLite on OPFS
underneath it.

```
popup.html ──sendMessage──▶ service worker ──chrome.offscreen.createDocument──▶ offscreen.html
    │                       (offscreen lifecycle + chrome.alarms)                    │
    └──────────sendMessage("host-op")─────────────────────────────────────────▶      │
                                                                              new Worker(type: "module")
                                                                                     │
                                                                        ┌────────────▼────────────┐
                                                                        │ actor.worker.ts         │
                                                                        │  ActorContainer(Counter)│
                                                                        │  FacetHost(children)    │
                                                                        │  AlarmScheduler         │
                                                                        │  OPFS SAH pool          │
                                                                        └─────────────────────────┘
```

## What it demonstrates

- **The runtime under MV3's content security policy.** `'wasm-unsafe-eval'` in
  `script-src` is what lets sqlite-wasm compile at all. Measured, by loading the
  same build with three CSPs:

  | `extension_pages` | Result |
  | --- | --- |
  | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';` | works |
  | the key omitted entirely (MV3's default) | `CompileError: … violates the following Content Security policy directive because neither 'wasm-eval' nor 'unsafe-eval' is an allowed source` |
  | `script-src 'self'; object-src 'self'; worker-src 'self';` | the same `CompileError` |
  | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` | **works** — see below |

  `worker-src 'self'` turns out **not** to be required: CSP3 falls `worker-src`
  back to `child-src` and then to `script-src`, which already says `'self'`. It is
  kept in the manifest as an explicit statement of what this extension loads, not
  as a workaround. Either way the effective policy is `'self'`, which a
  `chrome-extension://` script URL satisfies and a `blob:` URL does not — so
  `worker: { format: "es" }` in `vite.config.ts` is the part that matters, since
  the classic-worker fallback wraps the bundle in a blob.
- **An OPFS SAH pool inside the extension origin.** No `SharedArrayBuffer`, no
  COOP/COEP headers, no cross-origin isolation — measured, none of it is needed.
  The extension origin gets its own OPFS, so the actor's database is private to
  the extension and invisible to every page.
- **Persistence that survives the context.** The e2e closes and recreates the real
  offscreen document, destroying its Worker, container, and instance, then finds
  the same `Agent.setState()` counter and event rows in the replacement renderer.
- **A real `AlarmScheduler`, with its persisted retry ladder.** The alarm is armed
  through `Agent.schedule()`, recorded in both Agent storage and the scheduler's
  `_cf_ALARM` table, and delivered back as a gated event. The ladder — retry counts,
  exponential backoff, abandonment — is rows rather than process memory, which is
  the divergence from workerd that exists precisely because MV3 evicts its
  contexts.
- **A physical MV3 wake.** The scheduler projects only its earliest durable wait
  through the offscreen supervisor onto `chrome.alarms`. The e2e destroys the
  offscreen document before that alarm is due and proves Chrome wakes the service
  worker, recreates the host, and lets the scheduler deliver the stored event.
- **The Agents SDK queue.** The e2e enqueues an increment and observes its state
  write through `snapshot()`, exercising the SDK's SQLite-backed queue rather
  than a host callback.
- **Real Agents SDK sub-agents.** The root uses the public `subAgent()`,
  `parentAgent()`, `abortSubAgent()`, and `deleteSubAgent()` APIs. The e2e proves
  sibling isolation, overlapping awaits, nested children, restart persistence,
  abort-versus-delete storage semantics, and a child schedule delivered after
  Chrome recreates an evicted host.
- **A real non-hibernating `AgentClient` connection.** The offscreen page opens
  the SDK client over a `MessagePort`-backed WebSocket, while the actor receives
  the server half through `routeAgentRequest()` and
  `container.acceptWebSocket()`. The e2e proves standard named routing,
  `getAgentByName()` direct stubs, server-to-client state broadcasts,
  client-to-server `setState()`, a decorated `@callable()` method, and a
  streaming callable's chunks and final value.
- **The SDK's stateless MCP handler.** The actor serves `createMcpHandler()` and
  exposes a real `McpServer` tool that reads its current state. The e2e performs
  MCP `tools/list` and `tools/call` requests through the gated actor fetch path.
- **Inbound Agents email routing.** The same real local namespace binding
  carries an in-memory `ForwardableEmailMessage` through `routeAgentEmail()` to
  the actor's `onEmail()` hook. Forwarding and replies still refuse because this
  host has no outbound email binding.
- **Offscreen corpse recovery.** A crashed offscreen document disappears from
  `chrome.runtime.getContexts` while still holding the one offscreen slot.
  `src/background.ts` catches the resulting "single offscreen document" error —
  the error string is Chrome's only report of the corpse — closes it, and retries
  once.

## Load it unpacked

```bash
pnpm --filter do-runtime-example-extension build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, and choose `examples/extension/dist`.
4. Click the extension's toolbar icon. The popup has **Increment**, **Read**,
   **Arm alarm (5s)** and **Status**.
5. Arm the alarm, close the popup, wait five seconds, reopen it and press
   **Read**: the alarm's event row is there and the counter moved.

To watch the actor's own console, open `chrome://extensions`, find the card, and
click the **offscreen.html** link under "Inspect views".

## Run the end-to-end test

```bash
pnpm --filter do-runtime-example-extension e2e
# or, equivalently
cd examples/extension && node scripts/e2e.mjs
```

It builds first, launches a headless Chromium with a throwaway profile in
`.e2e-profile/`, loads `dist/` as an unpacked extension, and prints a `PASS`/`FAIL`
line per assertion. It exits non-zero on the first failure.

`playwright` resolves from the repository root's `node_modules`, which is why the
script is plain `.mjs` with a dynamic import rather than a dependency of this
package.

Playwright has no page handle for an offscreen document, so the test drives the
real one through `chrome.runtime.sendMessage`. It opens `offscreen.html` in a tab
only as a competing supervisor and asserts that Web Locks refuse it before OPFS.

## The files

| Path | What it is |
| --- | --- |
| `src/worker/counter.ts` | The root actor and its typed sub-agent class token. |
| `src/worker/counter-child.worker.ts` | The real bundled child and nested-child classes. |
| `src/worker/actor.worker.ts` | The host: raw timers, sqlite boot order, root/facet placement, and alarm scheduler. |
| `src/offscreen/offscreen.ts` | The supervisor: spawns the worker, holds the session, forwards extension messages. |
| `src/background.ts` | The service worker: offscreen lifecycle and `chrome.alarms` projection. |
| `src/popup/popup.ts` | Four buttons and an output pane. |
| `src/protocol.ts` | The types both TypeScript projects compile. It imports nothing. |
| `../platform-shims/memory-websocket-pair.ts` | A local WebSocket pair for the Agents server path. |
| `../platform-shims/message-port-websocket.ts` | The client-side WebSocket adapter carried over a `MessagePort`. |
| `public/manifest.json` | Copied verbatim into `dist/` by Vite's `publicDir`. |

Two `tsconfig`s, because `"DOM"` and `"WebWorker"` declare incompatible versions of
the same globals and no one project can check both halves:

```bash
# from the repository root
pnpm exec tsc -p examples/extension/tsconfig.page.json
pnpm exec tsc -p examples/extension/tsconfig.worker.json
```

## The boot order in `actor.worker.ts` is load bearing

Every step is where it is because moving it was measured to fail.

1. **Capture raw `setTimeout`/`clearTimeout` at module scope, first.**
   `installActorScope` replaces `globalThis.setTimeout` with the container's
   gated one, which is built *on* the `Timer` port — so a `Timer` reading the
   installed global arms a timeout to implement a timeout and recurses to
   `RangeError: Maximum call stack size exceeded`.
2. **Set `globalThis.sqlite3ApiConfig` before `sqlite3InitModule()`.** It is read
   once, at bootstrap. Disabling the `opfs` and `opfs-wl` VFSes keeps the proxy
   workers this host does not use out of the picture; `opfs-sahpool` must stay
   enabled.
3. **Install sqlite and the pool *before* `installActorScope`.**
   `installOpfsSAHPoolVfs` probes the other OPFS VFSes on the way in and those
   probes arm watchdogs through the global `setTimeout`. Installing the actor
   scope first hands the actor's gate to a storage library.
4. **`installActorScope(globalThis, resolve)` where `resolve` throws.** One
   worker hosts one root, so "no container" cannot mean "outside any actor" — it
   can only mean the container was torn down mid-flight, and handing that
   continuation a raw timer would resume it ungated.
5. **Consume `container.onBroken`.** A host that ignores it gets an actor that
   answers nothing and logs nothing.
6. **Boot the worker with one raw `postMessage` carrying the `MessagePort` in the
   transfer list.** A port is not a value capnweb can serialise. The DOM side
   opens capnweb directly; the actor side uses the runtime's `newRpcSession` so
   Workers `RpcTarget` values get the required prototype graft.

Two values here are permanent:

- `UNIQUE_KEY` — every `DurableObjectId` is derived from it and the id names the
  storage. Changing it silently orphans everything the extension has stored.
- `POOL_NAME` — it becomes an OPFS directory name, so it may not contain `/`.

## One holder per pool

An OPFS SAH pool takes an **exclusive** sync access handle on every one of its
files, so exactly one context in the extension may hold it. A Web Lock elects
that owner before the worker starts. Opening `offscreen.html` in a tab while the
real offscreen document is live gives the loser, immediately:

```
another extension page owns this Durable Object host
```

When you want to debug the page as a tab, close the offscreen document first
(`chrome.offscreen.closeDocument()` from the service worker's console).

## Deliberately not shown

- **More than one actor, and actor-to-actor calls.** One worker hosts one root
  here. A supervisor with several actors keeps a registry and routes
  `alice → bob` through itself, which is what `conformance/browser/host.ts` does
  and what the offscreen document would grow into.
- **Outbound `fetch`.** `ports.fetch` is omitted, which is upstream's
  `globalOutbound: null` posture: `fetch` inside the actor refuses by name rather
  than reaching an ungated one that would appear to work.
- **Worker Loader / Code Mode.** No dynamic isolates.

## Agents compatibility boundary

The self-contained demo runs every Agents SDK surface that has a faithful local
substrate. Cloudflare-managed products remain explicit integration boundaries:

| Runs in this host | Needs a Cloudflare service or separate integration |
| --- | --- |
| HTTP and durable state | Workflows: a real Workflow binding and Workflow runtime |
| Non-hibernating WebSockets and bidirectional state sync | WebSocket hibernation: platform-owned socket survival across eviction |
| Decorated callable and streaming RPC | AI chat and tool approval: `@cloudflare/ai-chat` plus a model provider |
| SQLite-backed queue and root/sub-agent `Agent.schedule()` | Outbound email: an Email Routing send binding |
| Local sub-agents, nesting, restart, abort, and delete | |
| Stateless MCP server and tools | |
| Inbound `routeAgentEmail()` and `onEmail()` | |

## Rough edges

Written down because this example exists partly to find them.

- **The Agents SDK root entry eagerly imports Workers-only Node and email modules.**
  Vite maps the Node imports through `unenv`; `cloudflare:email` remains a
  fail-closed shim. The inbound test supplies a host-created
  `ForwardableEmailMessage`; its forwarding and reply methods refuse because the
  demo has no outbound Email Routing binding. Both demos disable Agent WebSocket
  hibernation because this runtime deliberately refuses hibernatable sockets.
- **The facet entry repeats the Agents SDK bundle.** The root worker and
  `counter-child.js` each carry their own copy (about 1.3 MB unminified for the
  child in this readable demo build). The separate entry is intentional: its
  output banner binds the complete chunk—including SDK internals—to that
  facet's async primitives. A product build can minify it; sharing the SDK chunk
  would reintroduce the parent-global bug this e2e catches.
- **Vite emits the sqlite proxy workers even when they are disabled.** The driver
  references `sqlite3-opfs-async-proxy.js` and `sqlite3-worker1.mjs` through
  `new URL(..., import.meta.url)`, so both land in `dist/assets/` (~600 kB) even
  though `sqlite3ApiConfig` turns those VFSes off. The `sqlite3.wasm` binary is
  emitted correctly with no plugin and no `locateFile` override, which is the good
  half of the same mechanism.
- **A failed pool install tries to delete the pool directory.** The second holder
  above also logs `removeVfs() failed with no recovery strategy: … 'removeEntry' …`.
  It fails, because the first holder has the directory open — but a cleanup path
  that reaches for `removeEntry` on shared storage after a failed acquisition is
  worth knowing about before it succeeds on some other platform.
- **Two `ensureOffscreen()` callers can close a healthy document.** Not the
  runtime's, but a trap for anyone copying this shape: `onInstalled` and the
  popup's first message arrive together, both see no document, the loser gets
  "single offscreen document", and the corpse-recovery path then closes the
  winner's live document. `src/background.ts` serialises on an in-flight promise
  for exactly this reason.
- **`chrome.offscreen.createDocument` can resolve before the document listens.**
  A message sent right after it is answered `undefined` rather than queued, so
  `src/popup/popup.ts` retries once — and only for that outcome.
- **`chrome-types` models `chrome.offscreen.Reason` and
  `chrome.runtime.ContextType` as types, not runtime enums.** The dotted form
  Chrome's own docs use does not compile; string literals do.
