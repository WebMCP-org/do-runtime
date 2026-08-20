# vibe-platform

A vibe-coding platform with no server: the page edits a front-end and a **user-authored Agents SDK
Agent**, runs each half in-tab, and exports the unchanged sources as a deployable Wrangler project.
Reload the tab or edit the Agent class and its SQLite-backed state is still there.

```
pnpm --filter do-runtime-example-vibe-platform dev     # http://localhost:5173
pnpm --filter do-runtime-example-vibe-platform build   # dist/, both wasm files included
node examples/vibe-platform/scripts/e2e.mjs            # the whole loop, headless

# Two TypeScript projects, from the repo root (see tsconfig.page.json for why two):
pnpm exec tsc -p examples/vibe-platform/tsconfig.page.json
pnpm exec tsc -p examples/vibe-platform/tsconfig.worker.json
```

## What it demonstrates

**A workspace Durable Object with real actor semantics, in a browser tab.** `src/worker/workspace.ts` is a
`class Workspace extends DurableObject` that imports `cloudflare:workers`, keeps its files in
`ctx.storage.sql`, and answers `fetch()`. It would run on Cloudflare unchanged. Underneath it are
the input gate (one event at a time, so the read-modify-write in a `PUT` needs no lock), the
implicit transaction (every write in one event commits together), and the output gate (the response
that says "saved" cannot outrun the bytes reaching OPFS). Storage is **synchronous** SQLite —
`sql.exec` returns rows, not a promise — which is why the actor lives in a Web Worker: OPFS sync
access handles exist nowhere else.

**The Durable Object addressed as an origin.** The page never touches the database. It sends
`GET /files`, `GET /file?path=…`, `PUT /file?path=…` to `http://workspace.invalid`, and the worker
turns each one into a real `Request`, calls `container.entry(instance).fetch(req)` — one gated
event — and sends the `Response` back. `src/wire.ts` is that protocol, and it is the piece of this
example most worth stealing: an actor that speaks HTTP is an actor you can move to the edge later
without changing its callers.

**The bundler is in the page.** `@rolldown/browser` builds `/src/main.tsx` with a nine-line plugin
whose `resolveId`/`load` are HTTP requests to the actor. Bare imports (`react`, `react-dom/client`)
stay external and are resolved at runtime by an import map pointing at esm.sh, so the bundle
contains only the code you wrote.

**The authored Agent runs here too.** `/server/agent.ts` imports `Agent` from `agents`, declares
`initialState`, updates it with `setState()`, and handles HTTP through `onRequest()` exactly as the
deployed source does. Rolldown strips its TypeScript without changing the stored file and maps the
SDK external to the browser host; `agent.worker.ts` blob-imports the result and places the exported
class through `createActorContainer`. Saving any `server/*` file drains requests, releases storage,
and places a new instance over the same SQLite files, so code is volatile while state is durable.

**The sandbox has one narrow capability.** The preview keeps `sandbox="allow-scripts"`. Its `fetch`
wrapper sends only `/api/*` requests to the parent over a one-request `MessageChannel`; the page
forwards the flattened request to the authored actor and returns its real status, headers, and body.
The starter guestbook renders state served by that path.

**Persistence you can check by hand.** Sign the guestbook, edit a harmless string in
`server/agent.ts`, and save. The log says `agent restarted; storage intact`, and the count remains.
The workspace starter is also seeded exactly once, under boot semantics.

**Export is a real Wrangler project.** The Export button downloads a store-only ZIP made with no
dependency. `server/*` and `src/*` are byte-for-byte the workspace rows; generated `worker.ts` routes
`/api/*` to the Durable Object and other requests to the built front-end assets. `wrangler.jsonc`
contains the Durable Object binding, `new_sqlite_classes` migration, assets configuration, and the
Agents SDK's `nodejs_compat` flag; `package.json` pins the same Agents SDK version tested here.

## Shape

| Path | What it is |
| --- | --- |
| `index.html`, `src/main.ts` | The page: supervisor, editor, two builds, preview bridge, export. Plain DOM. |
| `src/wire.ts` | The page↔actor protocol, and why it is shaped for capnweb. |
| `src/worker/host.worker.ts` | The workspace host: pool, ports, container, RPC. |
| `src/worker/agent.worker.ts` | The authored-class host: evaluation, stable pool, container, RPC. |
| `src/worker/workspace.ts` | The actor. Knows nothing about browsers. |
| `src/zip.ts` | The store-only ZIP writer used by Export. |
| `scripts/e2e.mjs` | The full edit, restart, recovery, export, and Wrangler dry-run loop. |

The page is the supervisor and owns no storage, exactly as `conformance/browser/host.ts` is and
does. One worker hosts one root actor, which is what lets `installActorScope` put the runtime's
gated `setTimeout`/`fetch`/`scheduler` on the worker's `globalThis` without any ambient lookup.

## Cross-origin isolation: for the bundler, not the runtime

The dev server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`, and it is worth being precise about who needs them:

- **`@rolldown/browser` needs them.** It is a Rust bundler compiled to WASI with threads, so it
  needs `SharedArrayBuffer`, which a browser only hands to a cross-origin-isolated document.
- **The Durable Object runtime does not.** Neither does the OPFS SAH pool. Synchronous SQLite comes
  from `createSyncAccessHandle` in a dedicated worker and needs no isolation of any kind. Delete the
  bundler from this example and both headers can go.

`credentialless` rather than `require-corp` on purpose: the preview iframe pulls React from esm.sh,
and under `require-corp` every one of those responses would need a `Cross-Origin-Resource-Policy`
header that esm.sh does not send.

On a static host that cannot set headers, the usual workaround is
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), which installs a service worker
that re-serves the page with them. This example does not ship it; `vite dev` and `vite preview` both
set the headers directly.

## Three things that will bite you

**One tab at a time.** Each OPFS SAH pool takes exclusive sync access handles — that exclusivity is
what makes SQLite synchronous here — so a second tab cannot install the workspace or user-agent
pool. An agent edit closes SQLite and pauses its VFS before replacing the worker; both installers
still retry for reloads and crashes, where the old worker cannot acknowledge release. Close the
other tab and reload; measured, it recovers.

**The preview needs the network.** React comes from esm.sh at preview time. Offline, the bundle
still builds and the workspace still saves and persists — the iframe just renders nothing. The e2e
detects this and prints `SKIP` for the three steps that need a rendered React app rather than
failing; `VIBE_E2E_OFFLINE=1 node scripts/e2e.mjs` takes that path on purpose.

**This is the Agents SDK's HTTP state path, not its whole platform.** The SDK eagerly imports Node
and email modules, so Vite maps the Node imports through `unenv` and a fail-closed email shim. The
starter disables Agent WebSocket hibernation because this runtime refuses hibernatable sockets.

## Deploying an export

Extract the ZIP, run `pnpm install`, then:

```
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler deploy
```

The dry run bundles the Worker, validates its Durable Object migration and asset manifest, and
writes local output without credentials or an upload. It does **not** create the Durable Object
namespace, exercise the deployed `/api/*` route, validate your Cloudflare account, or prove that a
later real deployment will succeed.

## Deliberately not shown

- **Alarms.** `ports.alarms` is a named refusal here. A real one is an `AlarmScheduler` over a
  database of its own, which in a browser means a second worker with a second pool and delivery
  routed back through the page.
- **Agents SDK WebSockets, schedules, workflows, MCP, and email.** The real SDK is loaded, but this
  demo intentionally proves the smallest useful slice: `initialState`, `state`, `setState()`, and
  `onRequest()` through an actor restart, page reload, and deploy dry-run.
- **Facets.** `ports.facets` refuses too. Facets are child actors with their own gates and their own
  database inside the parent's pool — the mechanism you would reach for to give each *project* in a
  platform its own storage under one root.
- **A multi-project scheduler.** The page supervises one workspace actor and one authored actor.
  Placement registries, eviction, and actor-to-actor routing are shown in `conformance/browser/host.ts`.
- **Multi-file editing niceties**: no create/rename/delete in the UI, though the actor already
  implements `DELETE /file`.
