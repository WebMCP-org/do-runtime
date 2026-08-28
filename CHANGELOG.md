# Changelog

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
