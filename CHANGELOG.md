# Changelog

## 0.9.0

### Minor Changes

- 8a939e7: A root container now repairs, when it is next placed, an alarm its scheduler lost. An alarm outlet
  that reaches its scheduler over RPC cannot fail before the actor's local commit, so a failed
  request, or a worker killed at the wrong moment, could leave an alarm stored in the actor that
  never fires. The new optional `AlarmOutlet.reconcile(stored)` hook fixes this: `createActorContainer`
  calls it once, before construction, with the alarm the actor stored, and a rejection fails creation.
  Until the actor is placed again, a lost alarm that was its only wake source stays dormant, so a
  host that wants a prompt repair re-places a root whose container broke on a failed commit.
  
  `AlarmScheduler.hooks(id)` implements it, now typed `Required<AlarmOutlet>`: it sets the alarm only
  when the scheduler has none for the actor, or has a later one. Opening a container therefore never
  resets the ladder of, or queues a second delivery for, an alarm the scheduler already holds at or
  before the stored time. Alarms stay at-least-once: an alarm whose success was reported but whose
  deletion never committed runs again. Hosts that forward `scheduleRun` to a scheduler in another
  worker should forward `AlarmOutlet.reconcile` the same way and drop any re-push of `getAlarm()`
  after placement. That re-push reset the retry ladder and redelivered a failing alarm immediately,
  at retry count 0, on every alarm-triggered placement.
- 8a939e7: Remove package surface that nothing imports. This breaks a consumer that used any of it:
  
  - The `@mcp-b/do-runtime/server/alarm-scheduler` subpath is gone. Import `AlarmScheduler`, its
    types and its retry constants from `@mcp-b/do-runtime`, which already exports every one.
  - The `@mcp-b/do-runtime/conformance` subpath is gone. It exported this repository's conformance
    harness types and `substrate()` helper, which only its own lanes use.
  - The root no longer exports `installWebSocketGlobals` or `markWebSocketUsed`. The runtime calls
    both itself: `container.globals` and `installActorScope` carry the socket globals, and
    `installWebSocketUpgradeGlobals()` from `@mcp-b/do-runtime/browser` marks upgraded sockets.
  - `@mcp-b/do-runtime/gate` no longer exports `__gate`. `doRuntimeAwaitTransform` emits
    `__gateAwait`, `__resumeAwait` and `__gateAsyncIterable`, which stay.
- 8a939e7: Export `platformTimer` and `platformFetch` from `@mcp-b/do-runtime`: a `Timer` and a `FetchPort`
  over the platform's own `setTimeout`, `clearTimeout` and `fetch`, for `ports.timer`,
  `ports.fetch` and `AlarmScheduler`. The package captures them when it loads, which is before
  any `installActorScope` can replace the globals with gated ones built on those ports. A host no
  longer has to capture the timers at the top of its worker module before anything else runs. A
  port that read the installed globals would recurse. An aborted `afterDelay`, including one whose
  signal was already aborted, never settles.
- 8a939e7: The sqlite-wasm backend now grows its OPFS SAH pool when it opens a database, restores a snapshot
  or clones a facet's storage, so a pool that fills up no longer breaks the actors in it. Before each
  of these it calls the pool's `reserveMinimumCapacity()` so the pool holds every file plus a
  rollback journal for each connection the backend has open. Previously a full pool (for example,
  one holding facets that were never deleted) still let one more database open but left no slot for
  its journal. Every later write then failed with `SQLITE_CANTOPEN`, the actor's output gate broke,
  and re-placing the actor broke it again. A clone or restore could also use up the journal slots or
  fail with `No available handles to import to.`, and a failed facet clone left the facet empty.
  
  `initialCapacity` is now only the size a new pool starts at. The backend never shrinks a pool. If
  the browser refuses the storage, the operation fails with the driver's error.
  `OpfsSahPool.reserveMinimumCapacity` is now a required member. The driver's pool already has it,
  but a pool wrapper must forward it.
  
  Opens, restores and clones on one pool now run one at a time, so `open()` resolves a little later.
  Close the storage or delete it only after its `open()` calls have resolved. An `open()` still
  waiting its turn is not closed, and `importSnapshot()` refuses if that open lands first.
- 8a939e7: Add `browserHost({ include, asyncContext, facets })` and `workersModuleAliases()` to
  `@mcp-b/do-runtime/vite`: the Workers bundle contract every browser host wrote by hand. Register
  `...browserHost({ include })` in the application's `plugins`, in a browser-only config. It
  aliases `cloudflare:workers`, `cloudflare:email` and, by default, bare and `node:` `async_hooks`
  to the package's own files, ahead of the application's own aliases and including for
  dependencies Vite pre-bundles. Workers build as ES modules, keep class names (the Agents SDK
  routes and persists sub-agents by `constructor.name`), and run
  `doRuntimeAwaitTransform({ include, asyncContext: true })`. The application plugins run the
  transform only while serving, because unbundled development serves Worker modules through them,
  so production page builds no longer lower non-actor code. With
  `facets: { registry, match }`, Worker bundles turn code splitting off, matched chunks get
  `facetScopeBanner({ registry })` through the `banner` output hook, and the build fails when a
  matched chunk imports anything: an imported chunk's free `WebSocketPair`, streams and timers
  would bind to the root actor's scope. `workersModuleAliases()` returns just the two platform
  aliases, for configurations that run no transform.
  
  A second `asyncContext` transform in the same pipeline, such as a host's own beside
  `browserHost()`, no longer fails on the Oxc async-generator helper the first one corrected.
- ada5bd1: Ship the Worker half of the browser alarm protocol. `createBrowserAlarmProjector()`
  supplies the `AlarmScheduler`'s `projectWake` and an `acknowledge()` for the
  `BrowserAlarmCoordinator`'s `deliver()`. Projections leave one at a time, and each draws
  its generation only after the previous one was sent. A consumed wake is acknowledged only
  after the latest projection is accepted, no delivery or cleanup is active, and the next
  wake is absent or later. If the latest projection failed, `acknowledge()` sends it again
  first, so a scheduler with nothing new to project cannot leave the wake retrying forever.
  `nextGeneration()` must be durable across Worker restarts: the coordinator silently drops
  any projection older than the generation it journaled, so an in-memory counter would stall
  every wake after a restart. `parseBrowserAlarmProjection()` is now exported.
  
  Add `connectMessagePortWebSocket()` to `@mcp-b/do-runtime/browser`. It routes one
  MessagePort socket through a Workers-style `fetch` such as the Agents SDK's
  `routeAgentRequest()`. A socket nothing routes closes with 1011, and a refused upgrade
  closes with 1008 and the refusal's text when it is printable ASCII of at most 123 bytes.
  Previously every failure closed with a generic 1011 that dropped the Agent's reason.
  `serveMessagePortWebSockets()` now takes `(bridge, url) => Promise<void>`, such as
  `(bridge, url) => connectMessagePortWebSocket(bridge, url, route)`, instead of a function
  resolving a URL to a socket. It reports a connection failure after closing the client,
  and a socket that finishes connecting after `stop()` now closes with
  "MessagePort transport closed" instead of "host stopped".
  
  Gate a hibernatable socket that is a host transport, such as a `MessagePortWebSocket`
  rehydrated after a Worker restart. The actor used to receive the transport itself, so its
  `send()` and `close()` could leave before a preceding storage write was confirmed. It now
  receives one stable socket per transport that waits for the output gate like a
  `WebSocketPair` half; hibernation hosts still see the transport.
  
  `OffscreenDocumentAdapter` gains optional `ready()` and `replaceUnready()` hooks. The
  coordinator runs readiness in the same single flight as creation, for new and existing
  documents, and replaces a document that fails it at most once.
  
  Fix two `MessagePortWebSocket` hangs. A throwing `onmessage`, `onopen` or `onclose`
  handler skipped the `addEventListener` listeners behind it; during the open flush it also
  dropped the queued frames and held every later frame in the queue. Handler errors are now
  reported the way `EventTarget` reports a throwing listener. A throw while bridging a
  connected socket, such as a second `accept()`, left the brokered client connecting; it now
  closes with 1011.
- ada5bd1: Add `installSqliteWasmHost()` to `@mcp-b/do-runtime/backends/sqlite-wasm`. It installs an OPFS SAH
  pool through sqlite-wasm's `installOpfsSAHPoolVfs()` with the `name`, `directory`, `clearOnInit`
  and `initialCapacity` options, and returns the `{ pool, capi }` host the sqlite-wasm provider
  takes. Concurrent calls for one pool share a single install. Install pools through it:
  
  - It waits up to 10 seconds for a terminated worker to release the pool before installing, then
    rejects with a `NoModificationAllowedError`. Installing while the previous worker was still
    shutting down could delete the pool's directory and every database in it.
  - A transaction interrupted by worker termination is now rolled back when its database is
    reopened. Previously, reopening could expose the interrupted transaction's writes in place of
    committed rows and left the recovery journal behind, so snapshot export stayed refused.
- ada5bd1: Export `ACTOR_SCOPE_GLOBALS` from `@mcp-b/do-runtime` and `facetScopeBanner()` from
  `@mcp-b/do-runtime/vite`. The banner binds every name `installActorScope()` writes to a
  facet bundle's own scope. Banners that bound only timers, `fetch` and `crypto` left
  `WebSocketPair` on the root actor's global, so a facet's socket frames waited on the root's
  output gate and could leave before the facet's own write committed.
  
  `doRuntimeAwaitTransform()` now resolves the imports it injects to the package's own files,
  ahead of any host alias for them, so hosts no longer alias `@mcp-b/do-runtime/gate` or
  `@mcp-b/do-runtime/browser/async-hooks`. Add a `@mcp-b/do-runtime/cloudflare-email` export,
  a data-only `EmailMessage` for hosts to alias `cloudflare:email` to.

### Patch Changes

- 8a939e7: `bridgeWebSocket()`, and so `connectMessagePortWebSocket()`, no longer throws inside the Worker
  when its MessagePort peer reports a close that `WebSocket.close()` refuses: 1006, which a host
  sends when a `chrome.runtime.Port` disconnects with `lastError`, as well as 1005, 1015, any
  other reserved code, a code from 0 to 999 or from 5000 to 65535, and a reason over 123 UTF-8
  bytes. The throw surfaced as an uncaught error on the Worker, which a host may treat as fatal
  to the actor. The actor's socket now sees a dropped connection instead: the host's code and
  reason, `wasClean: false`, and no close handshake. An `accept()`ed socket is already `CLOSED`
  when its `close` event fires, and a hibernatable actor receives
  `webSocketClose(ws, code, reason, false)` with the socket `CLOSING`, as after any peer close.
  A close that `close()` accepts still completes a handshake as before. `MessagePortWebSocket`
  now reports such a wire close with `wasClean: false`, so a socket rehydrated from a raw
  `MessagePortWebSocket` reports these closes the same way, and so do clients made by
  `createMessagePortWebSocketConstructor()`. That includes 1005 (no status received), whereas
  workerd treats a close frame without a status as clean. A wire close with a code outside
  0-65535 is instead a protocol error: the `MessagePortWebSocket` closes itself with 1002, so a
  bridged actor sees a clean 1002 close with a handshake. When a subclass calls the protected
  `disconnect()` on a bridged `MessagePortWebSocket` with a valid code, the pair is now dropped
  instead of completing a handshake.
- ada5bd1: Validate both `withEnvAndExports()` scopes before installing either. A non-object `exports`
  argument previously left the `env` scope installed for the whole realm, so every later `env`
  read resolved against it.
  
  Treat a `Timer.afterDelay` that rejects on abort, as `node:timers/promises` does, as
  cancellation. Replacing or deleting a waiting alarm previously raised an unhandled
  `AbortError`, which terminates a Node host by default. The `Timer` contract now states that
  an aborted wait may stay pending or reject, but must not resolve.
  
  Close the databases `createActorContainer()` opened when an open-time check refuses, such as
  storage written by a newer release. Each refused attempt previously leaked its handles: a
  retry opened another connection to the same OPFS file, and on Node the provider's
  `exportSnapshot()` refused from then on. A `FacetHost.abort` that throws is now recorded like a
  failed facet deletion instead of becoming an unhandled rejection.
  
  Report `rowsWritten` as 0 for statements without result columns that write nothing, in both
  SQLite backends. DDL previously repeated the last write's count, because SQLite does not
  reset `sqlite3_changes()` for it. `SqliteWasmActorStorage.copyFrom()` now reads every source
  file in the same task as its recovery-sidecar check, so a source that is still running cannot
  open a write transaction between the two.
- ada5bd1: Keep the input lock and the implicit transaction across transformed awaits that settle while
  the actor still holds its lock. `doRuntimeAwaitTransform()` previously resumed every await
  through a macrotask hop and a fresh input lock queued behind waiting events, including awaits
  of storage calls and plain values. Another event could then run between `await
  storage.get()` and the following `put()`, so two concurrent read-modify-writes lost an update.
  The implicit transaction also committed at the await, so writes survived an abort that workerd
  rolls back. A transformed `await ctx.blockConcurrencyWhile()` let queued events run before its
  caller resumed. Every consumer that transforms the Agents SDK was exposed on its storage
  sequences.
  
  A transformed await now continues in the same checkpoint when its promise settles while the
  actor holds its lock: storage calls, plain values, and resumptions the runtime already admitted.
  Settled awaits no longer pay a macrotask each. An await on foreign I/O still re-enters through
  a fresh lock. When another actor's continuation owns the checkpoint, the await waits for a later
  task without releasing its lock, and its implicit transaction commits at that hand-off. Code that
  relied on a storage-only await to let other events in now blocks them, as on workerd. The Node
  and browser conformance lanes now also run the suite with the probe compiled by the transform.

## 0.8.3

### Patch Changes

- a423fd2: Preserve the creating actor's input gate and async context in ReadableStream
  and TransformStream callbacks. Delayed input and stream demand previously entered
  provider callbacks or tool execution without their creating scope, causing
  valid model turns, title actions, and routine actions to fail at storage access.

## 0.8.2

### Patch Changes

- 4346a6e: Refresh runtime and build dependencies, including SQLite WASM, Cap’n Web and
  structured clone. Validate conformance against workerd 1.20260911.1 and keep
  WebSocket readyState declarations aligned with the current DOM types.

## 0.8.1

### Patch Changes

- 43fafe5: Accept workerd server WebSocket close codes such as 1001, 1002, 1008 and 1011. The browser-only 1000/3000–4999 restriction caused Agent rejection and port-replacement shutdowns to throw instead of closing. Continue rejecting reserved wire codes and oversized reasons; shared workerd, Node and Chromium conformance tests verify the exact contract.

## 0.8.0

### Minor Changes

- 297b300: Sync runtime behavior with workerd 1.20260907.1 and its Workers types. Add alarm abort retry control, RPC error Durable Object IDs, compiled Wasm loader inputs, current Python loader flags, and the current no-op tracing API. Correct cancellation, WebSocket buffer ownership and automatic replies, retained close-handler tags, SQLite savepoint matching, and failed database setup cleanup.

  Actor-global outbound WebSocket construction now refuses before a native handshake can bypass storage confirmation. WebSocket pairs and host-owned transports remain supported. The upstream audit documents remaining SQLite engine protections and native-platform differences.

### Patch Changes

- ea578fb: Report active alarm deliveries and retain their projected deadlines through `projectWake` until completion, retry persistence, and abandonment finish. This keeps browser recovery armed when the native scheduler timer fires first or unrelated alarms change. Browser hosts can use the activity count with the acknowledged pending wake to confirm delivery cleanup. Preserve recoverable alarms when deletion, scheduler bookkeeping, or projection callbacks fail.
- 297b300: Add opt-in browser AsyncLocalStorage and Vite async-function lowering for Agents
  SDK context, tracing and OAuth. Preserve captured scopes across actor admission,
  reentry and timers; test overlapping browser entries and deferred generators.
- ae6a9a5: Retry failed alarm start and completion bookkeeping on the existing scheduler timer. Transient abandonment or metadata-write failures no longer leave an alarm retained without a live wake. Cleanup retries preserve the completed handler result and its retry budget, and cancellation or replacement retains the correct alarm owner and durable row.

## 0.7.0

### Minor Changes

- 3caa712: Move the reusable Chrome-host mechanics out of Rook: add a crash-safe browser alarm coordinator with durable transport recovery, package the MessagePort-backed WebSocket transport used between browser supervisors and actor workers, and share offscreen-document creation and stale-slot recovery.

### Patch Changes

- a2570d4: Ship a migration guide that separates Cloudflare Durable Object class lifecycle,
  Drizzle application schemas, persisted Agents state, and runtime-owned storage.
- 41b6ccc: Keep transformed foreign awaits visible to lifecycle checks until their continuations are published, and preserve native synchronous-iterable behavior in transformed `for await` loops.

  Restore WebSocket auto-response configuration and timestamps when a host recreates an actor from its hibernation mirror.

  Roll back failed SQLite WASM snapshot replacements and direct storage copies. If rollback also fails, retain the original database images in `SqliteWasmRestoreError.recoverySnapshot` for host recovery. This rollback is in memory; hosts needing replacement to survive process loss should restore into a fresh prefix before switching placement.

  Correct the minimal-host setup and verify its documented TypeScript configuration and code against the files included in the package.

## 0.6.1

### Patch Changes

- 55bae81: Export the shared in-memory hibernation mirror and browser WebSocket-upgrade adapter so embedders can reuse the reference host behavior instead of copying example shims.

## 0.6.0

### Minor Changes

- 0821d6e: Replace the fail-closed Durable Object WebSocket stubs with workerd-compatible hibernatable WebSockets.

  `WebSocketPair`, `WebSocketRequestResponsePair`, all eight `DurableObjectState` WebSocket methods, tags, structured-clone attachments, auto-responses, event timeouts, close state, and `webSocketMessage`/`webSocketClose`/`webSocketError` dispatch now run through actor input and output gates. `installActorScope()` installs the three WebSocket globals alongside the existing actor-scoped primitives.

  Embedders that evict live actors can mirror socket state through the new optional `ports.hibernation` callbacks and rehydrate it through `ActorContainerOptions.webSockets` before the next constructor runs. `container.quiescence()` exposes the non-blocking eviction signals, and `gateHooks` makes both gates observable.

  This is a breaking replacement for the exported hibernation-unavailable error and the previous `never`-typed methods. Hosts should remove reconnect-only fallbacks; applications can use the Agents SDK and PartyServer hibernation defaults.

## 0.5.0

### Minor Changes

- bef6bd8: `storage.put()` now reads its arguments the way JSG does, instead of silently dropping writes.

  A non-string, non-object key previously fell into the multi-key overload, where `Object.entries` on a primitive is `[]` — so the call resolved having written nothing. It now stringifies the key as the `kj::String` alternative does: `put(123, v)` writes `"123"`, `put(null, v)` writes `"null"`, `put(undefined, v)` writes `"undefined"`, `put([["a", 1]], v)` writes `"a,1"`, and a symbol key throws V8's own conversion error.

  Once the key does unwrap as a dictionary, a second argument that is a non-null primitive is now refused with upstream's own message rather than spread into the options — `put({a: 1}, "v")` wrote key `a` with `{0: "v"}` for options. The refusal models workerd's all-optional options struct exactly: `null`, arrays and functions all unwrap to default options and the write proceeds, as measured on real workerd. Functions take the dictionary alternative in the KEY position too, so `put(function f(){}, v)` is refused rather than writing a row keyed on the function's source text.

  Measured on real workerd and pinned by a conformance row that runs on all three lanes.

- bef6bd8: `sql.exec()` and `sql.ingest()` now refuse the SQL forms workerd's authorizer refuses but its regulator never sees. SQL that uses them throws where it previously ran.

  `ATTACH`, `DETACH`, the temp-schema creations, and virtual-table modules outside upstream's four reach SQLite action codes rather than `SqlStorageRegulator` callbacks, so porting the regulator whole left them unguarded. Each refuses with workerd's own message, `not authorized: SQLITE_AUTH`, except `VACUUM`, which carries SQLite's `cannot VACUUM from within a transaction: SQLITE_ERROR` because upstream refuses it by the transaction a Durable Object always has open.

  `ATTACH` was an isolation boundary and not only a fidelity gap: both backends open a real database file, so application SQL could attach another actor's database and read every application table in it — the reserved-name scan sees only the submitted statement — and `VACUUM INTO` could write any file the process can. The temp schema is refused by both of its spellings, `CREATE TEMP TABLE` and `CREATE TABLE temp.t`; the second was the live gap, where the table was created, written and read back. Of the virtual-table modules, `dbstat` is the one that mattered: it reports a row per table, so it enumerated the runtime's own `_cf_` tables and their sizes without the statement ever naming them. The table name and the module accept every quoting SQLite does — double quotes, backticks, brackets, and the misquoting feature's single-quoted string — with the module resolved before the allowlist, exactly as workerd's authorizer sees it; a `CREATE VIRTUAL TABLE` whose module cannot be read is refused outright.

  A leading `;` now counts as trivia for every leading-keyword refusal in the file, including the pre-existing transaction-control and pragma checks. `node:sqlite` reports an empty first statement as part of the span it compiled, so `;ATTACH …` read as a statement whose keyword was `;` and passed all three.

  `PRAGMA page_size` is now allowed with no argument, as upstream's allowlist has it for the R\*Tree module's own internal read; `PRAGMA page_size = N` is still refused. That was a false refusal — code that runs on Cloudflare failed here.

  Every form, refused and allowed alike, was measured on real workerd and is pinned by a conformance row that runs on all three lanes.

## 0.4.0

### Minor Changes

- 053b995: `sql.exec()` and `sql.ingest()` now enforce workerd's pragma allowlist. Every pragma outside `util/sqlite.c++`'s `ALLOWED_PRAGMAS` — `user_version`, `writable_schema`, `journal_mode`, `max_page_count`, and the rest — refuses with workerd's message, `not authorized: SQLITE_AUTH`, and the `pragma_*` table-valued functions follow the same list. Previously every pragma passed straight through, which no code written for Cloudflare could have relied on, and which let application SQL overwrite the runtime's storage version stamp or rewrite `sqlite_master` via `writable_schema`. The allowlist, including argument-signature rules, is pinned by a conformance row that runs against real workerd.

### Patch Changes

- 053b995: SQL cursor iterators now match workerd's observable shape, not just its helpers. `sql.exec(...).raw()` and the cursor's own iterator sit on `%IteratorPrototype%` — so `raw().toArray()`, which Drizzle's `durable-sqlite` migrator and driver call, works as it does on Cloudflare — and, like upstream's jsg iterators, they expose `next` and nothing else: no `return`/`throw`, so an early exit (`break`, partial destructuring, `take()`) does not close a retained iterator; results are `{done, value}` in that key order with an own `value: undefined` when done; `Symbol.toStringTag` reads `RawIterator`/`RowIterator`/`Cursor`; and `columnNames` is a prototype accessor, so a cursor JSON-stringifies to `{}`. Pinned by two conformance rows on all three lanes and an end-to-end Drizzle migration test.
- 053b995: Version runtime storage per database file. Every database the runtime opens — an actor's, the facet tree's, an alarm scheduler's — is stamped with `PRAGMA user_version` and brought forward through forward-only migration steps at open, before any event can enter (the Agents SDK's `_ensureSchema` pattern, one layer down). Pending steps and the stamp commit as one transaction, and a step that issues transaction control of its own is refused by name. A file stamped by a newer release refuses with the database and the remedy named, at open and again at `importSnapshot()`, so the operation that brought a too-new image in is the one that fails. The stamp itself is unreachable from application SQL (see the pragma allowlist change). Note for embedders constructing `AlarmScheduler` directly: the database you pass is now stamped too; host tables sharing that file are untouched — migration steps confine themselves to runtime-owned tables, and a test pins that.

## 0.3.6

### Patch Changes

- 059433a: Serialize transformed await publication until the owning continuation resumes so overlapping actors cannot overwrite each other's ambient identity.

## 0.3.5

### Patch Changes

- 28366a5: Add `ActorContainer.resolveLoopback()` so in-realm actor bindings use the raw instance only for exact self-calls. Other calls enter the target gate and resume through the exact current, transformed, or structurally supplied caller, including separately bundled runtime copies.

  Verify await-transform coverage against final build modules and warn on development fail-open paths. Reject failed critical sections with `BrokenActorError`, expose queued-entry cancellation, align the `cloudflare-workers` declaration path with its JavaScript entry, and remove the ineffective scheduler WAL pragma.

## 0.3.4

### Patch Changes

- 6616bcb: Restore actor context at the first instruction after each transformed await so delayed continuations cannot outlive their captured input lock.

## 0.3.3

### Patch Changes

- 9484c98: Let transformed actor code re-enter containers created by a separately bundled copy of the runtime.

## 0.3.2

### Patch Changes

- 9b747e8: Prevent a transformed await waiting on one actor's input gate from blocking transformed continuations in other actors.

## 0.3.1

### Patch Changes

- c23aada: Preserve `blockConcurrencyWhile` critical sections across transformed awaits so their continuations re-enter instead of deadlocking behind themselves.

## 0.3.0

### Minor Changes

- 9170766: Add `/gate` runtime helpers and a `/vite` transform that makes actor continuations re-enter the input gate after every transformed await.

## 0.2.3

### Patch Changes

- e4b1be6: Close three input-lock laundering paths in HTTP bodies. `ReadableStream` async iteration, second-order `Blob` reads, and reader or stream lifecycle promises could previously resume outside the actor's input gate and make the next storage call throw "no input lock available in this context". They now route every surfaced continuation through the actor's gated I/O seam while preserving native stream cancellation and lock-release behavior.

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
