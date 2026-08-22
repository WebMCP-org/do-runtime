# Changelog

## 0.2.2

### Patch Changes

- 31cb2a6: Gate the streams `pipeThrough` and `pipeTo` produce. Native pipe machinery reads a gated body through internal spec operations and hands back a brand-new uninstrumented stream, so `res.body.pipeThrough(new TextDecoderStream()).getReader().read()` — the MCP SDK's SSE path — resumed foreign on every chunk and the next storage call threw "no input lock available in this context". `pipeThrough` now re-gates the readable it returns (recursively, so chains stay covered) and `pipeTo`'s settlement resumes gated.

## 0.2.1

### Patch Changes

- 5c91da1: Name the last gated site in the "no input lock available in this context" error. The throw lands at the next storage call, which can be several layers past the foreign await that actually dropped the lock; the error now carries where the gate was last engaged — an `awaitIo` call site with its stack, an `entry` dispatch with its method name, a re-entry callback's registration site — and how many milliseconds before the throw, which brackets the offending await between two coordinates.

## 0.2.0 — 2026-08-21

### Added

- Expose `createDurableObjectNamespace()` and its placement-channel types for standard named Durable Object bindings.
- Run Agents SDK `routeAgentRequest()`, `getAgentByName()` direct stubs, decorated callables, streaming RPC, email routing, and sub-agents through the MV3 extension host.

### Fixed

- Preserve named facet identities instead of re-hashing serialized Durable Object IDs.
- Re-enter the calling actor's input gate after outbound namespace-stub calls.
- Preserve browser WebSocket upgrade requests across PartyServer request clones.

## 0.1.2

### Patch Changes

- 5f26eb1: Expose the held input lock on `ActorContainer` as `hasCurrent()` so a host stub can identify the calling actor from a lock-holding continuation and route the call through its `awaitIo`.

## 0.1.1

### Patch Changes

- 5972b65: Preserve the native `ReadableStream` brand when gating response body reads so Chromium accepts tee branches as `Response` bodies.

## 0.1.0 — 2026-08-20

- Port workerd-style actor identity, input/output gates, SQLite KV and SQL, alarms, facets, Worker Loader, loopback exports, WebSockets, and gated host primitives to TypeScript.
- Add Node (`node:sqlite`) and browser (sqlite-wasm on OPFS) storage backends.
- Preserve rich structured-clone values and support streaming `sql.ingest()` in every lane.
- Add host-owned whole-actor snapshots for local restore and cold replica seeding.
- Run one conformance suite against pinned workerd, Node, and Chromium.
- Add real browser and MV3 Agents SDK demos, including exclusive host ownership, OPFS crash recovery, and `chrome.alarms` wake projection.
- Run Agents SDK sub-agents as same-worker browser facets, including nested children, durable schedules, and abort/delete lifecycle coverage in real MV3 Chromium.
- Type local container entry proxies as asynchronous `ActorEntry<T>` calls and centralize OPFS actor-storage lifecycle in the sqlite-wasm backend.
- Cover failed placement cleanup, clone-export safety, cross-root RPC gating, real OPFS pool exhaustion, and Agents SDK reconnect state in the browser lanes.
- Publish under FSL-1.1-MIT while preserving the Apache-2.0 terms for workerd-derived portions.
