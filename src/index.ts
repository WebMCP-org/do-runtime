/**
 * `@mcp-b/do-runtime` — the browser implementation of the workerd Durable
 * Object contract. No knowledge of any host application.
 *
 * NO upstream correspondence: this file is the package facade. Everything it
 * re-exports has one.
 *
 * Gates, `IoContext`, storage internals, the facet index, and deletion receipts
 * stay private. Hosts use the `ActorContainer` lifecycle rather than holding a
 * runtime lock or table directly.
 *
 * The `api/` classes are not exported either, for the same reason and one more.
 * `DurableObjectStorage`, `DurableObjectState`, `SqlStorage` and `SyncKvStorage`
 * reach a consumer as `container.state` and its properties, already typed by
 * workers-types; handing out the constructors would let one be built over a
 * gate the container does not own. `FacetManager` is internal for the mirror
 * reason: it is what `server/` implements and `api/` consumes, and the seam a
 * consumer fills is `FacetHost` below it.
 *
 * Refusal messages used by conformance tests are exported so their specified
 * fail-closed behavior cannot drift. `createActorContainer` is asynchronous
 * because `SqlDatabaseProvider.open` is asynchronous; a returned container has
 * usable state and no hidden half-started storage phase.
 */

export type {
  SqlDatabase,
  SqlDatabaseProvider,
  SqlDatabaseSnapshot,
  SqlDatabaseSnapshotProvider,
  SqlResult,
  SqlValue,
} from "./util/sqlite";
export type { ReadOptions, WriteOptions } from "./io/actor-cache";
export type { AlarmOutlet } from "./io/actor-sqlite";
export type { Timer } from "./io/io-context";
/**
 * The Worker Loader (§1.11, decision 15). Exported where the `api/` classes are
 * not, and for the reason `AlarmScheduler` is: this one is a **binding**, so a
 * host has to construct it and put it in `env` — upstream compiles it from
 * `Global::WorkerLoader{channel}` the same way (`server/workerd-api.c++:748`) —
 * where every other `api/` class reaches a consumer through `container.state`.
 *
 * What a host supplies is `IsolateChannelFactory`, which is the whole substrate
 * seam: `loadIsolate` and the calling worker's own outbound. The scaffolding's
 * `IsolateHost` / `SandboxExecuteRequest` / `SandboxNamespaceDescriptor` /
 * `SandboxToolDispatch` are gone — see `api/worker-loader.ts`'s header for what
 * the C++ wanted instead.
 */
export type {
  EntrypointOptions,
  IsolateChannelFactory,
  LoadIsolateRequest,
  Module,
  WorkerCode,
  WorkerLoaderOptions,
} from "./api/worker-loader";
export {
  ALLOW_EXPERIMENTAL_MESSAGE,
  DEAD_LOAD_CONTEXT_MESSAGE,
  NO_MODULES_MESSAGE,
  NOT_BYTES_MESSAGE,
  STREAMING_TAILS_EXPERIMENTAL_MESSAGE,
  WorkerLoader,
  WorkerStub,
  jsModuleInPythonWorkerMessage,
  moduleFieldCountMessage,
  moduleNameMessage,
  notSerializableMessage,
  pythonModuleInJsWorkerMessage,
  typeScriptModuleNameMessage,
} from "./api/worker-loader";
export type {
  ActorClassChannel,
  CompatibilityDateValidation,
  CompatibilityFlagsRequest,
  DynamicWorkerSource,
  EntrypointRequest,
  ResourceLimits,
  WorkerStubChannel,
} from "./io/io-channels";
export type {
  Module as SourceModule,
  ModuleContent,
  ModulesSource,
  WorkerSource,
} from "./io/worker-source";
/**
 * The container's own surface. Every one of these is DECLARED in
 * `server/actor-container.ts` rather than here, and re-exported, because
 * TypeScript's project references run the same way workerd's Bazel targets do:
 * `src/` references `src/server/`, so a declaration in this file is one
 * `server/` may not import.
 */
export type {
  ActorContainer,
  ActorContainerOptions,
  ActorEntry,
  ActorPorts,
  FacetHandle,
  FacetHost,
  FacetId,
  FacetStartRequest,
  FacetTree,
} from "./server/actor-container";
export {
  createActorContainer,
  FACET_ALARM_UNIMPLEMENTED_MESSAGE,
  noFacets,
} from "./server/actor-container";
export type { ActorChannelFactory, GlobalActorRequest } from "./api/actor";
export { createDurableObjectNamespace } from "./server/actor-namespace";
export { ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE } from "./api/actor";
/**
 * The `ctx.exports` entries, exported where the rest of `api/` is not — for the
 * reason `WorkerLoader` and `AlarmScheduler` are: a HOST has to construct these.
 *
 * `ActorContainerOptions.exports` is a `Record<string, unknown>` a host fills,
 * and `DurableObjectFacets.get` discriminates its class switch by `instanceof`
 * against exactly these types (`api/actor-state.ts`). So a host that cannot build
 * one cannot register an actor class at all, and every consumer would have to
 * reach into `src/api/` past this facade to do it — which is worse than saying
 * here that these are the two a host is meant to have.
 *
 * They carry no gate and no context: a `LoopbackDurableObjectClass` holds an
 * `ActorClassChannelFactory`, which answers a `className` and nothing else. That
 * is why exporting them cannot reproduce the hazard the rest of `api/` is withheld
 * for — there is no container for one to be built over the wrong one of.
 */
export type {
  LoopbackDurableObjectClassOptions,
  LoopbackDurableObjectClassValue,
  ActorClassChannelFactory,
} from "./api/export-loopback";
export { asLoopbackDurableObjectClass, LoopbackDurableObjectClass } from "./api/export-loopback";
export {
  FACET_NAME_MAX_LENGTH,
  FACET_TREE_MAX_DEPTH,
  HIBERNATION_UNIMPLEMENTED_MESSAGE,
} from "./api/actor-state";
export { PITR_UNIMPLEMENTED_MESSAGE, REPLICATION_UNIMPLEMENTED_MESSAGE } from "./io/actor-cache";
/**
 * The alarm scheduler is exported where the gate is not, and the difference is
 * upstream's own: `AlarmScheduler` is a per-NAMESPACE object a supervisor builds
 * and wires into each actor's storage hooks (`server.c++:2325-2350`,
 * `:3199-3219`), not a per-actor internal. A host has to construct it, because a
 * host is what knows how to resolve an actor id to a container — so it is the
 * implementation a host puts behind `ActorPorts.alarms`, via `hooks(actorId)`,
 * rather than something `createActorContainer` could build for itself.
 */
export type {
  AlarmResult,
  AlarmSchedulerOptions,
  AlarmTarget,
  EventOutcome,
  GetActorFn,
} from "./server/alarm-scheduler";
export {
  ALARM_RETRY_MAX_TRIES,
  ALARM_RETRY_START_SECONDS,
  AlarmScheduler,
  RETRY_BACKOFF_MAX,
  RETRY_JITTER_FACTOR,
  alarmRetryDelayMs,
} from "./server/alarm-scheduler";
/**
 * The refusing outlet (`ActorSqlite::Hooks::DEFAULT` upstream) — the
 * `ports.alarms` for a host that schedules nothing, as `noFacets` is its
 * `ports.facets`. A real root actor gets `AlarmScheduler.hooks(id)` instead.
 */
export { DEFAULT_ALARM_OUTLET } from "./io/actor-sqlite";
/** The object an `alarm()` handler is called with (`api/global-scope.h:386-412`). */
export { AlarmInvocationInfo } from "./api/global-scope";
/**
 * The async primitives, which a host INSTALLS rather than constructs.
 *
 * `ActorGlobalScope` is exported as a type only, and `Scheduler` with it: both
 * reach a consumer as `container.globals`, already bound to that container's
 * `IoContext`. Handing out the constructor would let one be built over a context
 * the container does not own, which is the reason `DurableObjectState` and the
 * rest of `api/` are not exported either — and here it would be worse, because
 * the value would look right and gate the wrong actor.
 *
 * The two refusal messages ARE exported, for the reason the substrate-boundary
 * messages above are: they are the specified behaviour, and a message a test
 * re-types by hand is one that drifts.
 *
 * `acceptWebSocket` reaches a consumer as `container.acceptWebSocket` for the
 * same reason, so only its types are here.
 */
export type {
  ActorGlobalScope,
  ActorGlobalScopeOptions,
  ActorScopeBindings,
  FetchPort,
  Scheduler,
  SchedulerWaitOptions,
} from "./api/global-scope";
export {
  actorScopeBindings,
  FOREIGN_SLICE_MESSAGE,
  installActorScope,
  NO_GLOBAL_OUTBOUND_MESSAGE,
} from "./api/global-scope";
export type { AcceptedWebSocket, RawWebSocket } from "./api/web-socket";
export { ALREADY_ACCEPTED_MESSAGE } from "./api/web-socket";
export { BYOB_READER_UNGATABLE_MESSAGE, gateRequestBody } from "./api/http";
/**
 * The transport, for the same reason the loader binding and the scheduler are
 * here: the hops a host owns are not something `createActorContainer` could
 * construct for it. `newRpcSession` is the door onto capnweb, and a host still
 * needs it — the browser conformance lane's page↔actor session and its
 * actor↔actor routing through the page are both one — because those hops are
 * between SUPERVISED actors, which is a different question from where a facet
 * sits.
 *
 * `newRpcSession` is exported so that going around it is deliberate. It applies
 * decision 18's identity graft immediately before opening each session; see
 * `transport/rpc-session.ts`.
 */
export { newRpcSession } from "./transport/rpc-session";
