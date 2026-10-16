# Hosting browser actor workers

A dedicated worker owns the SQLite synchronous access handles and actor
containers. Its page or MV3 offscreen document owns worker placement, RPC
sessions, and client transports. These lifetimes are different: an idle worker
can terminate while its clients stay connected.

## Worker supervisor

Import `BrowserWorkerSupervisor` and `serveBrowserWorker` from
`@mcp-b/do-runtime/browser/worker-supervisor`. The supervisor takes an
application configuration and a typed worker service:

```ts
const supervisor = new BrowserWorkerSupervisor<Address, ActorService>({
  key: addressKey,
  createWorker: () => new Worker(new URL("./actor.worker.ts", import.meta.url), {
    type: "module",
  }),
  hostExports: (address, context) => new HostTarget(address, context),
  removeStorage: removeActorPool,
  idleGraceMs: 30_000,
});

using actor = await supervisor.resolve(address);
await actor.doWork();
```

The service implements `prepareHibernation()`, returning either `null` while
busy or a `WorkerHibernationSnapshot`. An application can return `null` for a
worker that must remain resident. A lifecycle report schedules the idle probe;
`BrowserWorkerHostContext.reportLifecycle()` binds that report to the exact
physical worker, so an old worker cannot mark a replacement idle.

`reference(address)` returns a Cap'n Web `RpcTarget` with `resolve()`. Each
resolution returns a separately owned capability. The reference survives idle
eviction and restart. `delete(address)` invalidates previously captured
references synchronously, stops the worker, and serializes physical storage
removal. New resolution waits for the deletion barrier. A host with hierarchical
addresses supplies its actual ancestry predicate to `delete(address, includes)`;
the runtime never guesses ancestry from key prefixes.

`connect(address, { id, url, peer })` retains the client transport and returns
its `receive` and `close` controls. `connectPort()` provides the same lifetime
for a native `MessagePort`. Peer adapters absorb sends to an already disconnected
physical transport and close idempotently. The supervisor queues frames during
startup and hibernation, checks that the snapshot describes exactly the current
transport IDs, and transfers fresh ports to the replacement. Transport IDs are
independent of application WebSocket tags. Reusing an active ID retires the old
connection and rejects the new attempt so a reconnect cannot produce duplicate
actor connections.

The host keeps authorization, trusted client roles, URL conventions, maintenance
admission policy, and browser resource cleanup. `discarded` releases resources
owned by a terminated worker whose finalizers cannot execute. `closeSockets`
lets admission policy end existing transports without waking an idle worker.

## Worker bootstrap

`serveBrowserWorker()` validates the runtime envelope and delegates only the
configuration payload to the application's parser. `initialize(configuration,
host, rehydration)` constructs the application service. `connect({id, url,
port})` routes a new socket to the actor. The helper owns readiness, initialization
failure, and both Cap'n Web sessions. Raw `postMessage` carries only the initial
ports, new socket ports, and pre-session ready/failure signals; ordinary calls
and callbacks use the RPC sessions.

Restore `rehydrateWorkerSockets(rehydration.root)` before constructing the root
container. Supply facet snapshots to `BrowserActorTree.attach()` before restoring
facets. The snapshot contains native mirror facts: tags, serialized attachment
bytes, auto-response timestamps and pairs, plus canonical facet start requests.
The application supplies each socket's transport ID when taking its snapshot.

## Facet placement and activity

`BrowserActorTree` implements `FacetHost` over a backend storage factory and a
module loader. Attach it to the root container's canonical `facetTree`; the
runtime owns facet containers, scopes, storage handles, cancellation, and mirror
restoration. A loader registers a capability with `scope.use()` before module
evaluation when the module can make host calls. Failed or aborted placement
releases that capability, including a resource acquired after an abort.

`ActorContainer.quiescence()` includes full pending events, background work,
timers and explicit activity leases. Releasing the input gate at an await does
not finish the event. `onActivityChange()` observes these native facts;
`isActorQuiescent()` and `BrowserActorTree.isQuiescent()` use the same predicate.
`acquireActivity()` covers a real host operation which begins outside an actor
entry. A lease keeps the worker live without acquiring an input or output gate.
The host need not maintain another event counter or wrap every actor method.

The [MV3 extension example](../examples/extension/src/offscreen/offscreen.ts)
uses the supervisor and bootstrap. The browser conformance
[worker restart test](../conformance/browser/hibernation-worker-restart.smoke.spec.ts)
keeps one transport across a real worker termination and verifies attachment,
SQL, arbitrary tags and automatic-response state after recovery.
