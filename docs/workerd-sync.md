# workerd sync: September 7, 2026

The oracle and Workers types are pinned to `1.20260907.1` and `5.20260907.1`.
This audit compares the source-comment baseline
[`v1.20260713.1`](https://github.com/cloudflare/workerd/tree/03c396e9b14ea5644dfcfb696086d8df040a4efc)
with [`v1.20260907.1`](https://github.com/cloudflare/workerd/tree/beb7bd5c370d898e5ea81947aaa80ba5f48cd47e).
The [full comparison](https://github.com/cloudflare/workerd/compare/v1.20260713.1...v1.20260907.1)
contains 1,114 commits and a net diff of 1,408 files, 151,669 added lines and
38,177 removed lines. The previous oracle,
[`v1.20260820.1`](https://github.com/cloudflare/workerd/compare/v1.20260820.1...v1.20260907.1),
accounts for 408 of those commits.

The review indexed the commit history and changed paths, then inspected added
and removed lines, callers, and upstream regression tests for the surfaces this
runtime implements. The wider July range catches missed ports that an oracle
version bump alone would not reveal. Native V8/JSG machinery, third-party
engines, build infrastructure, and separate Cloudflare products are classified
below; their implementation lines are not a TypeScript porting checklist.

History was fetched without a shallow boundary. Path histories use
`git log --full-history --no-merges`; ordinary history simplification hid some
merged changes. Endpoint diffs determine the final behavior, including reverts
and restorations. Commit author dates alone do not establish release inclusion.

The [September 7 release diff](https://github.com/cloudflare/workerd/compare/v1.20260906.1...v1.20260907.1) adds only the release stamp and raises the maximum compatibility date from September 13 to September 14. All behavioral changes below were present in the September 6 tree.

## Changes brought into this runtime

| Area / upstream change | Local result and regression evidence |
| --- | --- |
| [Alarm abort retry control, `67dd86ade`](https://github.com/cloudflare/workerd/commit/67dd86ade) | `abort(reason, { retryAlarm: false })` marks a terminal alarm abort. Default/true remains retryable. Delivery checks the original context reason as well as the immediate error and reports `aborted`, including when the JS handler returns after calling abort. Shared oracle tests exercise both retry choices. |
| [Alarm abandonment, `67dd86ade`](https://github.com/cloudflare/workerd/commit/67dd86ade) | Terminal and exhausted aborts perform abandonment. A queued replacement survives cleanup and restart; cleanup cannot delete a different entry that replaced the old one. The new restart assertion initially lost the durable alarm despite a live in-memory timer. |
| [Aborted context admission, `e7b2192`](https://github.com/cloudflare/workerd/commit/e7b2192) | Recheck abort after acquiring the input lock, refuse entry, and release the acquired lock. A regression aborts while admission is queued, then verifies the next waiter can enter. Supplied lock ownership follows the same refusal path. |
| [Real abort algorithms, `8652427e1`](https://github.com/cloudflare/workerd/commit/8652427e1), [`a35f6b8cf`](https://github.com/cloudflare/workerd/commit/a35f6b8cf) | Gates and `scheduler.wait()` subscribe through a private native dependent signal. Synthetic source events cannot cancel a wait, and a source listener's `stopImmediatePropagation()` cannot suppress genuine cancellation. Unit and three-lane conformance tests exercise both cases. |
| [RPC exception IDs, `e55b437bf`](https://github.com/cloudflare/workerd/commit/e55b437bf) | Root actor method and callback failures acquire `durableObjectId`. Facets do not invent one; broken-input-gate errors retain their provenance. The existing posted-rejection conformance test now checks the ID against `ctx.id` through workerd, Node, and the browser RPC transport. Cap'n Web already preserves enumerable error properties. |
| [Immediate WebSocket payload ownership, `8457bac`](https://github.com/cloudflare/workerd/commit/8457bac) | Binary sends snapshot the supplied ArrayBuffer/view before waiting for output confirmation. Mutation and detachment tests cover full buffers, typed-array subranges, and DataView subranges. |
| [Auto-responses after close, `a451899`](https://github.com/cloudflare/workerd/commit/a451899), [`aa80e1d`](https://github.com/cloudflare/workerd/commit/aa80e1d) | A matching ping after our close is consumed and timestamped without sending or throwing. Automatic replies share the send queue but bypass unrelated output locks, preserving earlier application-frame order. A held-gate test measures both halves of that contract. |
| [Retained socket tags, `4b289d6`](https://github.com/cloudflare/workerd/commit/4b289d6), [`cbb2dd6`](https://github.com/cloudflare/workerd/commit/cbb2dd6) | Socket metadata owns tags after removal from the active registry. Shared tests verify tags remain available in peer-close and own-close callbacks while `getWebSockets()` excludes the closed socket. |
| [Handshake output gating, `db27a34`](https://github.com/cloudflare/workerd/commit/db27a34) | Actor-global outbound `new WebSocket(url)` now throws before native construction. A native handshake cannot wait for storage confirmation, and later acceptance cannot undo it. Tests hold the output gate and prove no host constructor runs. Pairs and host-owned transports remain available. |
| WebSocket response coupling and actor eviction | `upgradeWebSocket(response)` transfers the endpoint into a distinct host wrapper, releasing its old actor context and disabling the actor's retained reference. Repeated extraction returns the same host socket. Host delivery stays asynchronous so a buffered initial state waits until the MessagePort bridge opens. Tests cover retained references, initial SDK state, and successive evictions with aborted old contexts. |
| [Queued sends after initialization abort, `525ca33d6`](https://github.com/cloudflare/workerd/commit/525ca33d6), [`2d6d1e787`](https://github.com/cloudflare/workerd/commit/2d6d1e787) | Constructor failure now aborts within its gated synchronous slice; queued WebSocket writes check that captured context after output confirmation. Tests cover throwing constructors, including primitive failures, and abort while send/close wait on an output lock. The existing Promise-returning factory behavior remains supported. |
| [Compiled Wasm inputs, `9cdf38052`](https://github.com/cloudflare/workerd/commit/9cdf38052) | Worker Loader accepts both a direct `WebAssembly.Module` and `{ wasm: module }`. Source representation retains the compiled object; byte-backed inputs retain copy ownership. Both forms failed before the port. The unchanged upstream Wasm loader test also passes on the pinned workerd binary. |
| [Mixed Python packages, `78ce78923`](https://github.com/cloudflare/workerd/commit/78ce78923), [Python flags, `66db82b4c`](https://github.com/cloudflare/workerd/commit/66db82b4c) | Python packages may include ES/CommonJS modules. The loader supplies `python_workers` and defaults to `disable_python_external_sdk` before host compatibility compilation, preserving explicit flags and caller arrays. Python execution remains the isolate host's responsibility. |
| [Facet/default alarm diagnostics, `3bb33af7a`](https://github.com/cloudflare/workerd/commit/3bb33af7a) | Facets report `Facets currently cannot set alarms.` Unconfigured root hooks report `Alarms have not been configured for this Durable Object.` The existing earlier synchronous facet refusal remains documented. |
| [SQLite case comparison, `001f015`](https://github.com/cloudflare/workerd/commit/001f015) | Savepoint bookkeeping folds ASCII case only. Distinct nested `Étage` and `étage` names now restore the same alarm cache that SQLite restores on rollback. Existing ASCII pragma/module/name handling already matched. |
| [Failed SQLite initialization, `4035108`](https://github.com/cloudflare/workerd/commit/4035108) | WASM constructor/reset share setup that closes a newly opened handle if setting the native length limit fails. Both failure paths previously leaked a handle. Raw driver-open failures remain driver-owned. |
| [Tracing manual spans, `4b2fe1943`](https://github.com/cloudflare/workerd/commit/4b2fe1943), [chaining, `d50808bb9`](https://github.com/cloudflare/workerd/commit/d50808bb9), [active spans, `25994428c`](https://github.com/cloudflare/workerd/commit/25994428c), [exceptions, `19aa13b3c`](https://github.com/cloudflare/workerd/commit/19aa13b3c) | Complete the existing no-op tracing shape: `startSpan`, `getActiveSpan`, `enterSpan`, argument forwarding, chainable attributes, and `recordException`. Nested synchronous scopes restore identity after return or throw. A shared oracle row verifies the synchronous API. No observer or async span propagation is claimed. |

The new abort tests also corrected conformance-host lifecycle: failed actors
are removed before replacement, Node root/facet database providers are closed,
and concurrent root placement requests share one placement. These are host
repairs needed to measure teardown/recovery, not substitute alarm semantics.

## Already covered or implemented by the host

| Upstream area | Disposition |
| --- | --- |
| [SQLite R*Tree, `0d251c0`](https://github.com/cloudflare/workerd/commit/0d251c0), [4 MiB values, `9e5da19`](https://github.com/cloudflare/workerd/commit/9e5da19) | Already ported before this audit: R*Tree modules, `rtreecheck()`, read-only `page_size`, native WASM length limits, and bound/returned Node value limits. Existing unit/conformance coverage retained. Node's unreturned SQL-computed values remain outside its adapter limit. |
| Facet callback context and weak ownership (`a593b6c0b`, `619d28ead`, `2f6a1ae05`, `ea18c59f2`, `c790519e9`) | Local objects retain their explicit `IoContext`; JavaScript owns closure/string lifetimes. No thread-local or borrowed C++ pointer to replace. Existing subtree break/deletion and loader-abort tests cover reachable local behavior. |
| Worker Loader functor lifetime (`fff6c92dc`) | Loading already passes through `awaitIo` and races context abort, so an aborted load rejects rather than leaving an unsettled stub. |
| Native SQL/cache ownership (`37a62df`, `81c43a0`, `736c8a6`) | Strings are immutable owned JS values; local statements recompile from retained SQL. The remote ActorCache LRU and JSG statement cache do not exist here. |
| Native HTTP/body/stream representation (`3056d44`, `497a197`, `ea0ee50`, `966cd87`, `f47c85f`, `999e22e`, `dfe66f5`) | Body moves to JsReadableStream and bridges native/experimental stream frontends. Local Request, Response, Blob, and WHATWG streams remain native; wrappers gate exposed continuations. No second stream implementation was added. |
| Stream/Blob memory and cancellation (`3354a8d`, `9502032`, `0d5fa40`, `8457bac`, `ef0f686`, `2486ab8`, `7876a08`, `d1e9d04`, `342b1bd`, `49a9317`, `fc138ff`, `e25810a`, `5908951`, `289bd1352`, `d48598269`, `93ca4f529`) | Native GC, MPK buffer ownership, BYOB bounds, controller reentrancy, and pending KJ pump lifetime belong to the host's stream implementation. The locally owned WebSocket buffer gap was fixed above. Gated BYOB remains an explicit refusal. |
| Stream fast paths/compression (`ffca648`, `0006475`, `3c1f142`, `0fbba45`, `5c85630`, `5620ad8`, `ae4575a`) | Native synchronous sink/source optimization and zlib-rs routing. No corresponding native handle exists in the TypeScript adapter. |
| EventTarget/Event/AbortSignal (`527fab1ea`, `d3f320b7b`, `517c5b91a`, `04e05af1b`, `895a5e1`, `79e36b4`, `c1a453082`, `ccd6dafa0`, `b1a224a2e`, `d8c9f92d4`, `0dc8a6c55`) | Native event constructors, listener dispatch, signal dependencies, and trusted-event flags remain host behavior. Handwritten cancellation adapters were corrected above. Managed on-handler positioning changes affect AbortSignal/EventSource/MessagePort; target workerd WebSocket retains its legacy handler-first dispatch. The local socket wrapper still calls its on-handler after registered listeners; this predates the range. Synthetic socket events cannot become trusted UA events, and native EventTarget does not reproduce workerd's listener-exception/fail-socket policy. |
| RPC wire hydration (`6f295da`, `d8089f4`, `7668f09`, `7b94e1a`, `11ee128`) | Native socket/stream branding and Cap'n Proto externals differ from Cap'n Web's protocol. There is no local TCP Socket binding to serialize. Public error-ID behavior was separately ported. |
| [RPC property depth, `69cb7bb29`](https://github.com/cloudflare/workerd/commit/69cb7bb29) | Workerd lowers its chained-property limit from 5120 to 64. Local proxies use Cap'n Web's protocol and do not enforce that workerd-specific limit. |
| Worker/isolate lifecycle and validation (`0471e912e`, `19149a564`, `5144596ac`, `522e611f9`) | Isolate lock scheduling, module registry agreement, CPU budgets, bootstrap, deployment validation, and observer callbacks have no local V8 embedder. The loader forwards module/configuration decisions to its host. |
| Reverts, source/test moves, build/include cleanup | Compared final trees before assigning behavior. Removed experimental stream adapters and migrated test suites do not mean the local public wrappers should be deleted. |

A final whole-history pass checked security and serialization changes outside
the main API paths: JSG stream external hooks/native casts (`861ae70a8`,
`7dca45727`), persistent multi-hop capability restoration (`f58c99c05`),
cross-isolate MPK context identity (`55dc2b229`), and promised-capability/async
scope ownership (`2476f5030`, `29d2b7b61`). These require native JSG/Cap'n Proto
facilities absent here; they add no separate local serializer or context port.

## SQLite engine work still required

Workerd now builds SQLite 3.53.4 ([`ddfde6c`](https://github.com/cloudflare/workerd/commit/ddfde6c))
and applies two additional semantic patches:

- [`70e4ecf`](https://github.com/cloudflare/workerd/commit/70e4ecf) rejects internal SQL functions reached from user expressions, including defaults.
- [`4456d7c`](https://github.com/cloudflare/workerd/commit/4456d7c) invokes function authorization for column defaults during creation, omitted-column inserts, replacement/foreign-key defaults, and related expression loading.

The installed Node 24.11.1 contains SQLite 3.50.4. The pinned and latest
published `@sqlite.org/sqlite-wasm` package at review time is `3.53.0-build1`,
containing SQLite 3.53.0; no published 3.53.4 package was available. Neither
engine has the above workerd patches.

Direct probes on both engines found:

- Native authorizer callbacks exist. Node exposes [`DatabaseSync.setAuthorizer`](https://nodejs.org/api/sqlite.html#databasesetauthorizercallback); WASM exposes `sqlite3_set_authorizer`. The runtime currently omits this callback seam.
- A native callback denying `sqlite_version()` rejects a direct SELECT, but a table with `DEFAULT(sqlite_version())` still inserts the engine version without that authorization.
- A default using `sqlite_drop_column(0, 'CREATE TABLE target(a, b)', 0)` still evaluates. Workerd's new regression requires insertion to fail.

Closing this gap requires patched engines and the native authorization policy,
including separation of trusted runtime SQL from application SQL. Exposing
callbacks alone closes some existing direct-function/name-resolution gaps but
does not supply the new default-expression protection. A text scanner cannot
implement those engine rules. The existing function allowlist omission and
these new engine differences remain explicit in the README and decisions.

## Changes requiring facilities this runtime does not supply

| Upstream area | Required facility / local boundary |
| --- | --- |
| Distributed actor fetch retries (`b27da2362`, `bbb8ded54`, `883c5bf36`, `376759b0e`, `515d89867`, `27238d649`, `f9c099a8a`, `afcbdc1e6`, `0201370a5`, `3441243ab`, `08e353e76`, `bdb81ee57`, `f2300a540`, `c36c8b505`, `a2e3c6679`) | Request nonce/deadline, delivered-state evidence, claim/deduplication protocol, replayable bodies, and replica routing. Local fetch/RPC ports lack that protocol. Blindly copying retries could repeat side effects. |
| Hibernation across code generations (`b36ab06`, `b374d17`) | Server holder tokens, parked loopback/event-ID registries, version re-resolution, and bounded deployment handoff. Local embedders explicitly supply per-actor mirrors and replacement sockets; there is no code-deployment service. Ordinary eviction/rehydration remains tested. |
| Trace delivery (`30c444dec`, `477f106ab`, `641862732`, `2264636ac`, `f436d9b94`, `5c9926b39`), SQLite Sentry routing (`54359a9`, `5844f17`) | Request/span observers, async context, trace transport, billing, and native exception-routing sinks. Only the existing public no-op tracing API was updated. |
| D1 RPC (`8cf8bb748`, `bf60ab740`), wrapped bindings (`b3b584c26`) | D1 service queries/bookmarks and serializable native service-binding identity. D1 is separate from local Durable Object `SqlStorage`. |
| Workflows RPC/deletion/subscriptions/location hints (`e54a45305`, `ae596b63a`, `aeb83ff65`, `d1b895fca`, `6fc037595`, `5ca9fbdd8`, `26531531f`) | A Workflows service binding and engine. Local entrypoint/step declarations do not implement that service; updated Workers types supply the ambient binding types. |
| Images/Markdown (`9c97ada7d`, `63393f681`, `355b03f97`, `adbfacdac`, `81681765a`, `93173cd10`, `67ff5430b`, `2c86b876a`) | Remote image transformation/list/upload/text rendering and Markdown conversion services. Host bindings remain responsible. |
| Docker Containers (`0d55e4e59` and server container changes), Hyperdrive (`a30d6b9`), Access/debug-port (`5ef8a1f`, `47eb376`) | Native container/TCP/deployment/authentication services; unrelated to this package's actor execution container. |
| DigestStream (`20aa62715`, `6e54da279`, `d414e8f1a`, `66ddc9bdb`), EventSource (`1883e0fcd`) | Workerd-specific native digest/CRC/WTF-8 bootstrap and EventSource adapters. The local crypto scope exposes gated native WebCrypto; it does not implement DigestStream or EventSource.from. |
| Node compatibility modules, Python interpreter/packages, Rust/V8/KJ, schemas, build/release tooling | Host or upstream implementation dependencies. Dynamic loader input semantics were reviewed and ported independently of interpreter/compiler implementation. |

## Validation

Behavioral changes used the existing test framework with failing regressions
before implementation. Observable cross-runtime contracts were first measured
against the pinned workerd oracle, then exercised through Node and browser
hosts. Native engine limitations above were measured directly rather than
hidden by skipped parity assertions.

Final validation used Node 24.11.1 in an isolated checkout of main `170a111`
plus this sync. Concurrent SDK and async-context work in the shared checkout
was excluded; these results describe the sync independently of that work.

| Check | Result |
| --- | --- |
| Unit tests | 925 passed across 35 files |
| workerd conformance, `1.20260907.1` | 74 passed across 10 files |
| Node conformance | 74 passed across 10 files |
| Browser conformance and host smoke tests | 82 passed across 14 files |
| `pnpm sdk:setup` / `pnpm sdk:sync` | Passed |
| `pnpm typecheck` | Passed, including both examples |
| `pnpm check:oracle` | Pins agree on `v1.20260907.1` |
| `pnpm check:package` | Passed, including packed consumer smoke |
| `pnpm test:examples` | Extension and vibe-platform end-to-end runs both passed |
| `git diff --check` | Passed |

The 1,155 unit/conformance tests use the repository's existing Vitest configs.
Package and example builds ran sequentially because they share `dist`.
