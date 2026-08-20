# Chrome MV3 extension example

One Durable Object actor, running for real inside a Manifest V3 extension: a
service worker that owns nothing, an offscreen document that supervises, a module
Worker that holds the actor, and SQLite on OPFS underneath it.

```
popup.html ──sendMessage──▶ service worker ──chrome.offscreen.createDocument──▶ offscreen.html
    │                       (owns no state)                                          │
    └──────────sendMessage("host-op")─────────────────────────────────────────▶      │
                                                                              new Worker(type: "module")
                                                                                     │
                                                                        ┌────────────▼────────────┐
                                                                        │ actor.worker.ts         │
                                                                        │  ActorContainer(Counter)│
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
- **Persistence that survives the page.** The e2e reloads the tab, which destroys
  the document, the Worker, the container and the instance, and finds the same
  counter and the same event rows in the new one.
- **Persistence that survives the *context*.** The last e2e step closes the tab
  and drives the popup instead, so the actor is re-placed inside a real offscreen
  document — a different renderer — and continues the same count.
- **A real `AlarmScheduler`, with its persisted retry ladder.** The alarm is armed
  in the actor's own storage, recorded in the scheduler's `_cf_ALARM` table, and
  delivered back into the actor as a gated event. The ladder — retry counts,
  exponential backoff, abandonment — is rows rather than process memory, which is
  the divergence from workerd that exists precisely because MV3 evicts its
  contexts.
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

**It drives a tab, not the offscreen document.** Playwright has no page handle for
an offscreen document — it is not a tab, a frame, or a worker target — so the same
`offscreen.html` is opened at its `chrome-extension://` URL and driven through
`window.__host`. Nothing on that page is conditional on being offscreen, so the tab
boots the same worker over the same pool. The final step closes the tab and goes
through the popup, which is what covers `chrome.offscreen.createDocument` itself.

## The files

| Path | What it is |
| --- | --- |
| `src/worker/counter.ts` | The actor. The only file a product would actually write. |
| `src/worker/actor.worker.ts` | The host: raw timers, the sqlite boot order, the container, the alarm scheduler. |
| `src/offscreen/offscreen.ts` | The supervisor: spawns the worker, holds the session, forwards extension messages. |
| `src/background.ts` | The service worker: `ensureOffscreen()` and nothing else. |
| `src/popup/popup.ts` | Four buttons and an output pane. |
| `src/protocol.ts` | The types both TypeScript projects compile. It imports nothing. |
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
files, so exactly one context in the extension may hold it. Opening
`offscreen.html` in a tab while the real offscreen document is live gives the
loser, immediately:

```
NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on
'FileSystemFileHandle': Access Handles cannot be created if there is another open
Access Handle or Writable stream associated with the same file.
```

That is a clean fail-closed, and it is why the e2e closes the tab before driving
the popup. When you want to debug the page as a tab, close the offscreen document
first (`chrome.offscreen.closeDocument()` from the service worker's console).

## Deliberately not shown

- **Projecting the scheduler's wake onto `chrome.alarms`.** As written, an alarm
  is delivered by a `setTimeout` inside the actor's worker, so it survives the
  service worker being evicted but not the whole extension being shut down or the
  browser being closed. The shape a production extension wants is to read the
  scheduler's current one-shot wait and mirror it onto a `chrome.alarms` alarm
  that wakes the service worker, which recreates the offscreen document — with the
  scheduler still authoritative for retry policy and delivery. See the root
  [README's Alarms section](../../README.md#alarms): a host may project the wait
  onto a physical timer but must not duplicate delivery policy.
- **Facets.** `ports.facets` here is the refusing host from the root README's
  quickstart. A host that places facets builds a child container per request; the
  worked example is `conformance/browser/actor.worker.ts`.
- **More than one actor, and actor-to-actor calls.** One worker hosts one root
  here. A supervisor with several actors keeps a registry and routes
  `alice → bob` through itself, which is what `conformance/browser/host.ts` does
  and what the offscreen document would grow into.
- **Outbound `fetch`.** `ports.fetch` is omitted, which is upstream's
  `globalOutbound: null` posture: `fetch` inside the actor refuses by name rather
  than reaching an ungated one that would appear to work.
- **Worker Loader / Code Mode.** No dynamic isolates.

## Rough edges

Written down because this example exists partly to find them.

- **`@cloudflare/workers-types` declares `cloudflare:workers` ambiently, and an
  ambient module declaration beats a `paths` mapping.** So `import { DurableObject }
  from "cloudflare:workers"` typechecks against Cloudflare's declarations while the
  bundler substitutes the runtime's port. Mostly harmless, except that Cloudflare's
  `DurableObject<Env = Cloudflare.Env>` defaults `Env` to an empty interface, and
  the container's `env: unknown` is not assignable to it —
  `src/worker/counter.ts` therefore writes `extends DurableObject<unknown>`.
- **`FacetHost` has no "places no facets" implementation in the package.**
  `noFacets` appears only as a snippet in the root README, so every host retypes
  four members to say the same thing.
- **`container.entry<T>(target: T): T` understates its own return type.** The proxy
  makes every method asynchronous; the type says otherwise. This example dodges it
  by declaring every method on `Counter` `async`, and the conformance lanes dodge
  it with a cast.
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
