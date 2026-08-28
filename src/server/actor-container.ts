/**
 * ← workerd `src/workerd/server/server.c++` — `ActorNamespace::ActorContainer`
 * (`:2383-2968`), which is at once the supervisor's per-actor record, its
 * `Worker::Actor::FacetManager`, and the code that builds the storage engine.
 *
 * Composes the gates, the context, the storage engine and the facet tree into
 * one actor. Constructs the Durable Object class under workerd's boot
 * semantics, and on break aborts facets, abandons scheduled writes, refuses
 * re-entry, and surfaces `onBroken`.
 *
 * **The three line ranges this file was handed are all in the wrong class, and
 * the right ones are above.** `server.c++:1199-1214`, `:1225-1237` and
 * `:1293-1297` are all inside `Server::DiskDirectoryService` (`:1058`) — the
 * directory-listing branch of a static-file handler, its entry-type switch, and
 * a `sendError(501, "Not Implemented")`. None of them has anything to do with
 * actors. The three things they were offered for are real, and are at
 * `:2864-2877` (alarm hooks installed only `if (parent == kj::none)`, with
 * `// TODO(someday): Support alarms in facets, somehow.`), `:2885-2897`
 * (`afterReset`, where `deleteAll()`'s cascade to descendant facet storage
 * lives) and `:2603-2620` / `:2953-2956` (`getFacetContainer` and
 * `actorClass->newActor`, the two halves of facet actor construction). Every
 * citation in this file was checked line by line against
 * `e8f1e125bd48f048a3e82c48d37e5e3902fffbd6`, which is the tree Section 6a's
 * citations were taken from and agree with.
 *
 * **Ordering, because it is the part that cannot be read off upstream.**
 * Upstream builds the actor lazily inside `getActor()`, so `ctx.storage` does
 * not exist until the first request arrives and nothing can observe the gap.
 * Here `ActorContainer.state` is a plain property that promises a
 * `DurableObjectState` answering `.storage`, and the database behind it opens
 * asynchronously (`SqlDatabaseProvider.open`, Section 3's seam). Something has to
 * give, and the honest one is the factory: `createActorContainer` returns a
 * promise, and everything it returns is fully built. The alternative — a `state`
 * property that throws until `start()` — is a worse lie, because it makes the
 * one declared field of the public interface conditional on a call the type
 * system cannot see.
 *
 * Spec: §1.6, §1.10, decisions 6 and 14 in
 * docs/decisions.md.
 */

import { DurableObjectState, DurableObjectStorage } from "../api/actor-state";
import { DurableObjectId } from "../api/actor";
import { RpcTarget } from "../api/cloudflare-workers";
import type { FetchPort } from "../api/global-scope";
import {
  ActorGlobalScope,
  AlarmInvocationInfo,
  actorScopeBindings,
  isAlarmFailureUserError,
} from "../api/global-scope";
import type {
  AcceptedWebSocket,
  HibernationHost,
  RawWebSocket,
  RehydratedWebSocket,
} from "../api/web-socket";
import { acceptWebSocket, HibernatableWebSocketRegistry } from "../api/web-socket";
import type { IsolateChannelFactory, WorkerLoaderOptions } from "../api/worker-loader";
import { WorkerLoader } from "../api/worker-loader";
import type { AlarmOutlet } from "../io/actor-sqlite";
import { ActorSqlite, DEFAULT_ALARM_OUTLET } from "../io/actor-sqlite";
import type { AlarmResult } from "./alarm-scheduler";
import type { Actor, Timer } from "../io/io-context";
import { IoContext, captureGateStack, tryCurrentIoContext } from "../io/io-context";
import type { InputGateHooks, OutputGateHooks } from "../io/io-gate";
import { InputGate, OutputGate } from "../io/io-gate";
import type { FacetManager, FacetStartInfo } from "../io/worker";
import { asFacetStub } from "../io/worker";
import type { SqlDatabase, SqlDatabaseProvider } from "../util/sqlite";
import { hasCurrentSqliteTable, SqliteDatabase } from "../util/sqlite";
import { ensureRuntimeStorageVersion } from "../util/sqlite-migrations";
import { ActorIdFactoryImpl } from "./actor-id-impl";
import type { IndexFile } from "./facet-tree-index";
import { FacetTreeIndex } from "./facet-tree-index";
import type { FacetDeletionReceipt } from "./facet-deletion";
import {
  FacetDeletionController,
  FacetDeletionReceiptStore,
  FacetReferenceEpochs,
  SerializedSubtreeDeletionQueue,
} from "./facet-deletion";

export type FacetId = number;

export type FacetStartRequest = {
  id: FacetId;
  /** The `facets.get` name, `class\0name` form preserved. */
  name: string;
  /** Resolved against `ctx.exports` by `api/actor-state.ts`. */
  className: string;
  /** This facet's depth. The container enforces <= 4 including the root. */
  depth: number;
  /**
   * The `ctx.id` the child was told to take, present only when the startup
   * options supplied one. Absent means the child inherits the parent's, which
   * is upstream's `ioCtx.getActorOrThrow().cloneId()` (`actor-state.c++:1026`).
   *
   * The scaffolding called this "the DurableObjectId name". It is not
   * necessarily a name: `FacetStartupOptions.id` is `DurableObjectId | string`
   * (`actor-state.h:453`), so this carries a named id's stable name, an unnamed
   * id's 64-hex string, or the string the app supplied. The host decides what to
   * do with it, exactly as upstream's `Worker::Actor::Id` leaves that to the
   * supervisor.
   */
  routedId?: string;
};

export interface FacetHandle {
  /**
   * The placement's outcome, resolving to what `facets.get` will call —
   * Fetcher-shaped per §1.10: no id, no name.
   *
   * `start` is synchronous because `facets.get` is, but placing an actor is not: a database
   * has to open and a constructor has to run. Upstream has exactly this shape and
   * does not have to say so — `getFacetContainer` hands `ActorChannelImpl` a
   * `kj::Promise<ClassAndId>` (`server.c++:2603-2620`) and the channel is
   * returned before it resolves, so a failure to construct reaches the caller at
   * the first call on the stub. Measured on workerd 1.20260722.1: a facet whose
   * constructor throws returns a stub from `facets.get()`, rejects the first call
   * with the constructor's own message, and leaves the parent untouched.
   *
   * Keeping the placement promise here makes construction failures observable at
   * the first call and leaves `asFacetTransport` as the sole deferral layer.
   */
  stub: Promise<object>;
  /**
   * Rejects when a RUNNING facet breaks — the signal upstream gets from
   * `actor.onBroken()` and monitors in `monitorOnBroken`
   * (`server.c++:2767-2800`).
   *
   * **A break travels DOWN and never up, so nothing here reaches the parent.**
   * `ActorContainer::abort` (`:2565-2589`) and `monitorOnBroken` each loop
   * `for (auto& facet: facets)` and abort the container's OWN children; a broken
   * child takes itself and its subtree, and nothing above it notices.
   * `conformance/suite/facets.spec.ts` guards this against workerd: the parent and
   * its other facets remain live.
   *
   * `FacetManagerImpl` consumes this signal for `monitorOnBroken`'s two local
   * effects: tell the host to tear down the broken placement (which aborts its
   * descendants), and erase it from the PARENT's facet map (`:2777-2780`,
   * `:2794-2798`). That frees the name for a fresh placement without changing
   * the parent or its siblings.
   *
   * **A placement that never completed does not belong here** — it is a start
   * that failed, not a break, and it travels through `stub`. Measured on
   * workerd: a facet whose construction fails does not break its parent, and the
   * next `facets.get` runs the startup callback again.
   */
  broken: Promise<never>;
}

/**
 * The facet port. Substrate is only placement, the callable stub across that
 * placement, and physical storage deletion for children a parent cannot open.
 *
 * NOT substrate, and therefore not in this interface: naming, ids, the
 * depth/name/count limits, deletion receipts and epochs, and `clone()`
 * orchestration. Those are package-owned. In particular there is no
 * addressing-strategy port: once
 * the package speaks facet ids, the app-address mapping is the browser
 * adapter's private business and needs no interface at all.
 *
 * This is NOT the interface `api/actor-state.ts` consumes. That one is
 * `io/worker.ts`'s `FacetManager`, upstream's own `Worker::Actor::FacetManager`,
 * which this file implements on top of this port — see that file's header for
 * why the two were conflated and why the fix was to widen rather than reshuffle.
 * The `clone()` orchestration named above is `cloneFacet`'s body, and the
 * limits named above are enforced by `DurableObjectFacets` where upstream
 * enforces them.
 *
 * One host serves a whole actor tree, as upstream's `ActorNamespace` does: every
 * `FacetId` it is handed is an id in the root's index, so a facet's own host
 * must be able to place and remove any of its descendants.
 */
export interface FacetHost {
  /**
   * Synchronous, like `facets.get` itself — but the placement it begins is not,
   * and `FacetHandle.stub` is where that is declared. A host reports a placement
   * it could not finish by rejecting that promise, and reports nothing about it
   * on `broken`: see `FacetHandle`.
   *
   * A synchronous throw is still legal and still means the same thing — the
   * facet cannot be started — and `getFacet` turns it into the same rejected
   * stub. What is no longer possible is a host that fails asynchronously and has
   * nowhere to say so.
   */
  start(request: FacetStartRequest): FacetHandle;
  /**
   * Kills the instance; storage survives (measured on workerd).
   *
   * **Never called while a placement for `id` is in flight**, and never before
   * that placement's `stub` has settled. The container orders the two against
   * each other, so a host needs no queue of its own and is never handed an abort
   * for a facet it is still placing — which it could only no-op, its placement
   * map having no entry for the id yet.
   *
   * It may still be called for an id that never ran: a placement that failed, or
   * one refused before `start` was reached. Upstream's is too — `abortFacet`
   * finds the container whether or not its `kj::Promise<ClassAndId>` ever
   * resolved (`server.c++:2635-2640`) — so a host that has nothing to kill
   * should return, not throw.
   */
  abort(id: FacetId, reason?: string): void;
  /**
   * Physical removal, descendants included. `subtree` is the descendants alone,
   * deepest first — upstream removes children before the parent
   * (`server.c++:2754-2759`) — and `id` is the facet itself.
   */
  deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void>;
  /**
   * Physical copy of one facet's storage onto another, for `cloneFacet`. The
   * recursive walk of the source subtree is this file's; copying one database
   * is the substrate's, the same split `deleteStorage` already makes.
   */
  copyStorage(src: FacetId, dst: FacetId): Promise<void>;
}

/**
 * The `FacetHost` for a host that places no facets — the shape of every first
 * integration, provided so hosts stop re-typing it. `start` refuses by name.
 * `abort` returns, per its contract above: a host with nothing to kill returns.
 * The storage operations refuse, because a call to either proves a facet once
 * existed — which this host could not have placed.
 */
export const noFacets: FacetHost = {
  start(): FacetHandle {
    throw new Error("this host places no facets");
  },
  abort(): void {},
  deleteStorage(): Promise<void> {
    return Promise.reject(new Error("this host places no facets"));
  },
  copyStorage(): Promise<void> {
    return Promise.reject(new Error("this host places no facets"));
  },
};

/**
 * The five ports. Each one is a seam workerd itself takes as a constructor
 * input; a port that would exist only because our code is currently shaped
 * badly is an invented seam and was rejected. Rejected, for the record:
 * a transport port (one implementation per substrate, forever), a logger port
 * (fail closed — errors throw, breakage surfaces on `onBroken`), a value-codec
 * port (giving lanes different codecs would make the Node lane lie about the
 * browser), and an addressing-strategy port (unnecessary once the package
 * speaks facet ids).
 *
 * A fifth, `isolates?: IsolateHost`, was here from the scaffolding and Section 7b
 * removed it. A Worker Loader is a **binding**, not a port: upstream builds it
 * from `Global::WorkerLoader{channel}` alongside every other binding
 * (`server/workerd-api.c++:748`) and it reaches an application through `env`,
 * exactly as `DurableObjectNamespace` and `ctx.exports` already do here. A host
 * constructs `WorkerLoader` over its own `IsolateChannelFactory` and puts it in
 * `env`; the container never sees one. See `api/worker-loader.ts`'s header.
 */
export type ActorPorts = {
  sql: SqlDatabaseProvider;
  /**
   * Root containers only — facets have no alarm slot (§1.10).
   *
   * `AlarmScheduler.hooks(actorId)` is the implementation to put here: upstream
   * builds one `AlarmScheduler` per namespace and gives each actor a
   * three-line `ActorSqliteHooks` adapter over it (`server.c++:2325-2350`,
   * `:3199-3219`), which is the same composition.
   */
  alarms: AlarmOutlet;
  facets: FacetHost;
  timer: Timer;
  /**
   * ← the global outbound `Fetcher` a Worker's `fetch` resolves
   * (`api/global-scope.c++:1160`), which `container.globals.fetch` gates.
   *
   * Optional, and absence is upstream's `globalOutbound: null` posture rather
   * than a missing port: a Worker configured that way has no ambient `fetch` at
   * all, which is how Code Mode forces every I/O through connectors (§1.11).
   * `fetch` then refuses by name instead of reaching a `fetch` this package does
   * not own — an ungated one that works is the failure this layer exists to
   * prevent.
   */
  fetch?: FetchPort;
  hibernation?: HibernationHost;
};

export type { HibernationHost } from "../api/web-socket";

/**
 * The whole-tree facet state, which belongs to the root container and is shared
 * by every container in one actor tree.
 *
 * Upstream keeps the same thing in the same place — "FacetTreeIndex for this
 * actor. Only initialized on the root" (`server.c++:2680-2681`), reached from a
 * facet by `root.ensureFacetTreeIndex()` (`:2697`) — and can do so with a plain
 * reference because every facet of an actor is an object in one process. None of
 * these methods can cross a worker boundary: `facets.get()` is synchronous all
 * the way down, so `getId` has to answer without yielding. A facet in another
 * worker cannot be handed this object and therefore cannot have facets of its
 * own. Every host here
 * now places in the parent's realm and passes the root's object straight through.
 *
 * It is an interface rather than a plain reference anyway, because a facet
 * container is constructed on its own and the root's index is the one piece of
 * state it cannot build for itself: ids are sequential across the whole tree. A
 * host that does not supply one gets a facet that cannot have facets of its own
 * and says so, rather than a per-parent counter that would collide the storage.
 */
export interface FacetTree {
  /** ← `FacetTreeIndex::getId`. Assigns on first sight, stable thereafter. */
  getId(parent: FacetId, name: string): FacetId;
  /** ← `FacetTreeIndex::forEachChild`, collected. Ordered by the child's UTF-8 name. */
  children(parent: FacetId): readonly { readonly id: FacetId; readonly name: string }[];
  /** ← `deleteDescendantStorage`'s recursion, as a list: descendants only, deepest first. */
  descendants(id: FacetId): FacetId[];
  /**
   * Records the intent durably now, then removes `id` and its descendants after
   * the current parent and descendant operations represented by `waitBeforeDelete`.
   */
  deleteSubtree(id: FacetId, waitBeforeDelete: Promise<unknown>): Promise<void>;
  /** Copies the whole `src` subtree onto `dst`, minting `dst`'s children as it goes. */
  copySubtree(src: FacetId, dst: FacetId): Promise<void>;
  /** Runs one placement or abort after every earlier operation on the same stable facet id. */
  runOperation(id: FacetId, operation: () => Promise<void>): void;
  /** Snapshots the current operation tail for `id` and every indexed descendant. */
  subtreeOperationBarrier(id: FacetId): Promise<void>;
  /**
   * Resolves once no queued deletion still covers `id`, which is what makes a
   * facet re-created under a name that is still being deleted safe to start.
   */
  settled(id: FacetId): Promise<void>;
  /** Every capability captured before an ancestor abort or delete goes stale here. */
  readonly epochs: FacetReferenceEpochs;
  /** ← boot. Carries out every deletion a previous session recorded and did not finish. */
  recoverDeletions(): Promise<void>;
}

/**
 * ← `IoContext::awaitIo`, as the one primitive a host needs in order to build a
 * platform async primitive of its own.
 */
export type ActorContainerOptions = {
  /** The DurableObjectId name. */
  id: string;
  /**
   * The namespace's unique key, upstream's `uniqueKey` configuration field
   * (`server.c++:2919`, read from `config::Worker::DurableObjectNamespace::Durable`).
   * `ActorIdFactoryImpl` derives its factory key as `SHA256(uniqueKey)` and an
   * id as 16 bytes of base plus 16 bytes of `HMAC-SHA256(key, base)`.
   *
   * **The host must keep this stable forever.** `ctx.id` is
   * `idFromName(options.id)` under this key, and the id names the actor's
   * storage, so a key that changes across a restart changes every id and every
   * actor loses its data. There is no default and it is not optional, because a
   * default is exactly the shape that would let a host acquire this obligation
   * without noticing it. This package cannot check the property for itself —
   * nothing it can observe distinguishes "a new key" from "a new actor" — so
   * this comment is the whole of the enforcement.
   */
  uniqueKey: string;
  /** The `ctx.exports` class registry. Keys are the consumer's concern. */
  exports: Record<string, unknown>;
  env: unknown;
  ports: ActorPorts;
  webSockets?: readonly RehydratedWebSocket[];
  gateHooks?: { input?: InputGateHooks; output?: OutputGateHooks };
  /** Present when this container hosts a facet rather than a root. */
  facet?: {
    /** Root is 0, a direct child of the root is 1. `getDepth()` answers with it. */
    depth: number;
    /** This facet's own id, the one its parent allocated from the tree index. */
    id: FacetId;
    /** The root-owned tree this facet and every descendant share. */
    tree: FacetTree;
  };
};

/** The local entry proxy: data properties stay local; every method becomes one async event. */
export type ActorEntry<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : T[K];
};

export interface ActorContainer {
  /** Implements the workers-types interface. No `as unknown as` cast (§2.4). */
  readonly state: DurableObjectState;

  /**
   * The actor tree this container belongs to, which a root builds for itself and
   * a facet is handed.
   *
   * It is on the interface because the host is the only thing that can carry it
   * from a parent to a child: `FacetHost.start` builds the nested container, and
   * a facet that may have facets of its own needs the root's index rather than
   * one of its own (see `FacetTree`). Upstream needs no equivalent because a
   * facet reaches `root.ensureFacetTreeIndex()` through a plain reference
   * (`server.c++:2697`), and every facet of an actor is an object in one process.
   *
   */
  readonly facetTree: FacetTree;

  /**
   * Whether this container owns the synchronous actor slice on the JS stack.
   * This is the narrow identity check a host loopback needs to call the raw
   * instance instead of queueing behind the lock it already holds. It resolves
   * no container and carries no state into continuations.
   */
  isCurrentSlice(): boolean;

  /**
   * Whether this actor's input lock is on the current invocation stack.
   *
   * ← `IoContext::hasCurrent()`. Wider than `isCurrentSlice()`: a slice ends
   * when its synchronous body returns, but the lock it took drains the whole
   * microtask checkpoint (§1.2), so actor code chained one promise past a gated
   * resumption is lock-holding without being slice-current. That window is
   * where an outbound call must resume through the caller's `awaitIo`, or the
   * code after it comes back with no input lock and its next storage call
   * throws. Lock state is not caller identity: a parent and its running facet
   * can both return true. `resolveLoopback()` owns that decision.
   */
  hasCurrent(): boolean;

  /**
   * Resolve an in-realm actor call without making the host infer caller identity.
   * A call from this exact actor context uses the raw instance; every other call
   * uses its gated entry, routed through the caller's output gate and `awaitIo`
   * when there is one. The runtime resolves a current slice or
   * transformed continuation first; `caller` is the lock-holding structural
   * fallback for untransformed post-await code. Both callbacks are lazy: only
   * the selected invocation runs.
   */
  resolveLoopback<Result>(
    invokeDirect: () => Result,
    invokeEntry: () => Promise<Awaited<Result>>,
    caller?: ActorContainer,
  ): Result | Promise<Awaited<Result>>;

  /**
   * Construct the instance under workerd's boot semantics: the input gate is
   * held for the constructor's synchronous slice, and boot-time
   * deletion-receipt replay precedes it.
   */
  start<T extends object>(construct: (ctx: DurableObjectState, env: unknown) => T): Promise<T>;

  /**
   * THE door for RPC targets. A proxy whose every method invocation is one
   * gated event. This single wrapper is what replaces the serialised tail,
   * all three dispatch tables, and the 33 hand-written exemptions.
   *
   * EVERY call queues, including one made while this actor is holding its own
   * lock across an await. That is §1.2's whole content and the suite pins it: a
   * second event posted while a storage await holds the gate must not interleave,
   * and a door that reused the held lock could not tell that event apart from a
   * call the actor made to itself. `resolveLoopback()` makes that distinction:
   * an actor reaching its own `DurableObjectNamespace` binding from its exact
   * current context skips this door because the lock it would take is the one
   * it holds. `signal` is bound to the returned proxy and cancels invocations
   * that are still waiting for admission; it does not interrupt an admitted
   * method or its output-gate drain.
   */
  entry<T extends object>(target: T, signal?: AbortSignal): ActorEntry<T>;

  /**
   * The door for events that are not method calls — one WebSocket frame, one
   * host-originated callback. Upstream: `IoContext::run`. `signal` cancels only
   * while the event is queued for an input lock.
   */
  run<T>(event: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T>;

  /**
   * ← `IoContext::awaitIo`. The form a HOST-PROVIDED async primitive must take,
   * and the only gate primitive this package makes public.
   *
   * Every platform async thing an application can await — `scheduler.wait`, a
   * `fetch`, a WebSocket round trip — is an io-context primitive upstream, which
   * is why "resuming from an await re-enters the isolate with a fresh input
   * lock" needs saying nowhere in workerd: there is no other kind of await.
   * There is here. A raw `setTimeout` resolves a promise the runtime does not
   * own, the application's continuation resumes with an empty invocation stack,
   * and its next `ctx.storage` call throws `no input lock available in this
   * context` — the README's divergence 147. Wrapping the promise in this makes
   * the continuation resume inside a gated slice, which is what upstream's does.
   *
   * It releases the input gate for the duration, per §1.3, so the actor stays
   * re-entrant while it waits. The holding form,
   * `IoContext::awaitIoWithInputLock`, is deliberately NOT public: that one is
   * the transaction boundary of §1.7.1, it belongs to the four async storage
   * calls, and a host holding it by hand is the serialised tail growing back.
   */
  awaitIo<T>(promise: Promise<T>): Promise<T>;

  /**
   * ← `ServiceWorkerGlobalScope`, the async-primitive half: this actor's
   * `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `fetch` and
   * `scheduler` (`api/global-scope.ts`).
   *
   * **This is what "own the primitives in the worker global" means, and the
   * ownership is the point.** `awaitIo` above is the primitive a host needs to
   * build one of these; this is the set already built, so a host installs rather
   * than reimplements the surface.
   *
   * **One scope per actor, installed lexically, and never resolved from an
   * ambient.** Upstream's globals read `IoContext::current()` because acquisition
   * is structural there; this one holds its context. A host puts it where its
   * actor's code reads it — `globalThis` for a class in the worker's own module
   * graph, a module-scoped binding for a class that arrived as a
   * dynamically-loaded Worker source, which is upstream's own arrangement (§1.11:
   * a dynamic Worker has its own global scope bound to its own context). What
   * happens when a facet reaches past its binding to a parent's scope is
   * `ActorGlobalScope`'s `requireOwnSlice`.
   */
  readonly globals: ActorGlobalScope;

  /**
   * ← `WebSocket::accept()` / `state.acceptWebSocket()`
   * (`api/web-socket.c++:133`, `:426`), whose gating is `api/web-socket.ts`.
   *
   * Separate from `globals` because accepting is an act rather than a binding:
   * the critical section is captured at THIS call, so a socket accepted inside
   * `blockConcurrencyWhile` delivers its frames inside that section (§1.8).
   */
  acceptWebSocket(socket: RawWebSocket): AcceptedWebSocket;

  /**
   * ← `WorkerInterface::runAlarm(scheduledTime, retryCount)`
   * (`io/worker-interface.h:107`), which is what `AlarmScheduler` calls and what
   * `ServiceWorkerGlobalScope::runAlarm` answers. Strictly serialised (§1.8).
   *
   * It reports rather than throws, because the two bits the scheduler's ladder
   * turns on — retry, and whether the retry counts against the limit — are not
   * derivable from "the promise rejected".
   *
   * `retryCount` reaches the handler as `AlarmInvocationInfo`. It is the
   * scheduler's `countedRetry` for this alarm, so the container takes it as an
   * argument exactly as upstream's `runAlarm` does.
   */
  deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult>;

  /**
   * ← `WorkerInterface::abandonAlarm` (`io/worker-interface.h:114`), forwarded to
   * `ActorSqlite::abandonAlarm` (`io/actor-sqlite.c++:1039-1060`).
   *
   * Called when the scheduler has given up retrying, so the actor clears its own
   * alarm state and `getAlarm()` stops reporting a time that will never fire.
   * Answers the actor's stored alarm time when it differs from `scheduledTime` —
   * meaning the application set a different one — and null when the alarm was
   * cleared or there was none.
   */
  abandonAlarm(scheduledTime: number): Promise<number | null>;

  /**
   * Output-gate wait for outbound sends that do not ride an `entry()` reply.
   * A broadcast path calls this before each frame (decision 5).
   */
  waitOutputLocks(): Promise<void>;

  /** For the host's idle check — today's `drainWaitUntil`. */
  drainWaitUntil(): Promise<void>;

  quiescence(): {
    armedTimers: number;
    pendingWaitUntil: number;
    inputLockHeld: boolean;
    outputGateBroken: boolean;
  };

  /**
   * ← `WorkerdApi::compileGlobals`'s `Global::WorkerLoader` arm
   * (`server/workerd-api.c++:748-752`), which is the step that turns a configured
   * loader channel into the JS binding an application finds in `env`.
   *
   * **The one binding the runtime has to construct, and the reason is the
   * context.** Upstream's `WorkerLoader` holds a channel number and a
   * validation mode and nothing else, because `get()` and `load()` read
   * `IoContext::current()` when they are called. This package deliberately has no
   * ambient of any kind, so the context is a constructor input — and it must be
   * *this* container's, since `makeReentryCallback` inherits the critical section
   * a `blockConcurrencyWhile` is holding (decision 13). `IoContext` is not
   * exported, on purpose (see `src/index.ts`'s header), so this method is how a
   * host gets a loader bound to the right one.
   *
   * The host still owns the name: assign the result onto the `env` object it
   * passed in, which is what upstream's binding compilation does one layer down.
   * A container whose host never calls this simply has no loader binding, exactly
   * as a Worker with no `workerLoader` in its config does.
   */
  workerLoader(channel: IsolateChannelFactory, options: WorkerLoaderOptions): WorkerLoader;

  /**
   * Rejects when either gate breaks, or when a facet the parent did not abort
   * breaks (decisions 6 and 14). The host consumes this: terminate the worker,
   * respawn on the next event.
   */
  readonly onBroken: Promise<never>;

  /** The programmatic `ctx.abort()` path. */
  abort(reason?: unknown): void;
}

// =======================================================================================
// Constants

/** ← the database `ports.sql` opens for the actor's own KV and SQL. */
const ACTOR_DATABASE_NAME = "root";

/**
 * ← `<actor-id>.facets` (`server.c++:2711-2714`), as a database rather than a
 * file.
 *
 * Upstream opens a second file beside the actor's SQLite database and calls four
 * `kj::File` members on it. There is no `kj/filesystem` port and the browser
 * cannot give a supervisor a synchronous file handle at all — OPFS sync access
 * handles are worker-only, measured — so the bytes live in a second database
 * from the same provider, which the actor's own worker already has open.
 *
 * A **second** database rather than a table in the actor's own, and the reason is
 * not tidiness. `SqliteKv::deleteAll()` calls `db.reset()`, which replaces the
 * actor's database file wholesale; upstream's index survives that because it is a
 * separate file, and decision 14's "stable ids across delete-and-recreate"
 * depends on it surviving. An index inside the actor's database would also be
 * written inside whatever transaction happens to be open — the implicit one, or a
 * `transactionSync` savepoint — so a rolled-back transaction would take an id
 * assignment with it while the facet holding that id kept running. Upstream's
 * index write is `datasync`'d immediately and is in no transaction at all, and a
 * separate connection is what reproduces that.
 */
const FACET_DATABASE_NAME = "facets";

/** ← the storage the tree index's bytes live in. One row, holding the whole file. */
const INDEX_TABLE = "_cf_FACET_INDEX";
const CREATE_INDEX_TABLE = `CREATE TABLE IF NOT EXISTS ${INDEX_TABLE} (
  k INTEGER PRIMARY KEY CHECK (k = 0),
  bytes BLOB NOT NULL
)`;

/** ← `JSG_KJ_EXCEPTION(FAILED, Error, "Facet was deleted.")` (`server.c++:2644`). */
const FACET_DELETED_MESSAGE = "Facet was deleted.";

/**
 * A facet has no alarm slot, and this is where that becomes visible.
 *
 * `server.c++:2864-2877` installs alarm hooks only `if (parent == kj::none)` and
 * gives a facet `ActorSqlite::Hooks::getDefaultHooks()`, whose `scheduleRun`
 * throws — so on workerd a `setAlarm()` inside a facet appears to succeed and
 * then breaks the whole actor asynchronously, which is open bug
 * https://github.com/cloudflare/workerd/issues/6810. This runtime refuses at the
 * call instead, as recorded in §2.7. A deliberate semantic
 * divergence: the observable behaviour is a synchronous throw naming the facet
 * where workerd's is a destroyed actor three turns later.
 */
export const FACET_ALARM_UNIMPLEMENTED_MESSAGE =
  "A facet has no alarm slot. Alarm hooks are installed only on a root Durable Object, so a " +
  "facet cannot schedule one: record the wake on the root and route the work back down.";

// =======================================================================================
// The tree index, over a database

/**
 * ← the `kj::File` `FacetTreeIndex` is constructed over, backed by one BLOB.
 *
 * `datasync()` is a no-op and that is a property of the substrate rather than a
 * shortcut: nothing else ever opens a transaction on this connection, so every
 * statement below is its own implicit SQLite transaction and is durable by the
 * time `exec` returns. The read-modify-write is O(file) per append, which is
 * what upstream's own bound makes affordable — the format is four bytes plus a
 * name per facet and there can be at most 65,535 facets over an actor's whole
 * lifetime (`facet-tree-index.h:19-22`).
 */
export function newDatabaseIndexFile(db: SqlDatabase): IndexFile {
  hasCurrentSqliteTable(db, INDEX_TABLE, CREATE_INDEX_TABLE);
  db.exec(CREATE_INDEX_TABLE, []);

  const read = (): Uint8Array => {
    const value = db.exec(`SELECT bytes FROM ${INDEX_TABLE} WHERE k = 0`, []).rawRows[0]?.[0];
    if (value === undefined) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    throw new Error("the facet tree index row is not a BLOB");
  };

  const store = (bytes: Uint8Array): void => {
    db.exec(
      `INSERT INTO ${INDEX_TABLE} (k, bytes) VALUES (0, ?)
       ON CONFLICT(k) DO UPDATE SET bytes = excluded.bytes`,
      [bytes],
    );
  };

  return {
    readAllBytes: read,

    write(offset: number, data: Uint8Array): void {
      const current = read();
      // kj's file grows on a write past the end and zero-fills the gap.
      const size = Math.max(current.length, offset + data.length);
      const next = new Uint8Array(size);
      next.set(current, 0);
      next.set(data, offset);
      store(next);
    },

    truncate(size: number): void {
      const current = read();
      if (size === current.length) return;
      const next = new Uint8Array(size);
      next.set(current.subarray(0, Math.min(size, current.length)), 0);
      store(next);
    },

    datasync(): void {
      // See the note above: one statement is one transaction on this connection.
    },
  };
}

// =======================================================================================
// ActorTree

/**
 * The root container's copy of everything that is true of the tree rather than
 * of one actor: the index, the deletion receipts, the serialization of physical
 * deletion, and the reference epochs.
 */
class ActorTree implements FacetTree {
  readonly #index: FacetTreeIndex;
  readonly #host: FacetHost;
  readonly #deletions: FacetDeletionController;
  readonly #queue = new SerializedSubtreeDeletionQueue();
  /**
   * One operation tail per stable facet id, shared by every manager in the
   * tree. A parent deletion must see a descendant manager's placement before
   * asking the host to unlink that descendant's storage.
   */
  readonly #operations = new Map<FacetId, Promise<void>>();
  readonly epochs = new FacetReferenceEpochs();

  constructor(db: SqlDatabase, host: FacetHost) {
    this.#index = new FacetTreeIndex(newDatabaseIndexFile(db));
    this.#host = host;
    this.#deletions = new FacetDeletionController(new FacetDeletionReceiptStore(db), (receipt) =>
      this.#removeSubtree(receipt),
    );
  }

  getId(parent: FacetId, name: string): FacetId {
    return this.#index.getId(parent, name);
  }

  children(parent: FacetId): readonly { readonly id: FacetId; readonly name: string }[] {
    const found: { id: FacetId; name: string }[] = [];
    this.#index.forEachChild(parent, (id, name) => {
      found.push({ id, name });
    });
    return found;
  }

  /**
   * ← `deleteDescendantStorage` (`server.c++:2754-2759`), flattened. Upstream
   * recurses into a child before removing it, so the deepest storage goes first;
   * this list is in that order and the caller removes `id` itself afterwards.
   */
  descendants(id: FacetId): FacetId[] {
    const out: FacetId[] = [];
    for (const child of this.children(id)) {
      out.push(...this.descendants(child.id));
      out.push(child.id);
    }
    return out;
  }

  deleteSubtree(id: FacetId, waitBeforeDelete: Promise<unknown>): Promise<void> {
    return this.#deletions.delete(id, waitBeforeDelete);
  }

  async copySubtree(src: FacetId, dst: FacetId): Promise<void> {
    // A copy touches every id in both subtrees, so it queues behind — and blocks — any deletion
    // that overlaps either one. Nothing else may be walking these files while it runs.
    const touched = [src, dst, ...this.descendants(src), ...this.descendants(dst)];
    await this.#queue.run(touched, () => this.#copyInto(src, dst));
  }

  runOperation(id: FacetId, operation: () => Promise<void>): void {
    const pending = this.#operations.get(id);
    // Both outcomes chained: an abort is not conditional on the placement before it succeeding.
    const done = pending === undefined ? operation() : pending.then(operation, operation);
    this.#operations.set(id, done);
    void done.finally(() => {
      if (this.#operations.get(id) === done) this.#operations.delete(id);
    });
  }

  async subtreeOperationBarrier(id: FacetId): Promise<void> {
    const pending = new Set<Promise<void>>();
    for (const target of [id, ...this.descendants(id)]) {
      const operation = this.#operations.get(target);
      if (operation !== undefined) pending.add(operation);
    }
    await Promise.all([...pending].map((operation) => operation.catch(() => undefined)));
  }

  recoverDeletions(): Promise<void> {
    return this.#deletions.recoverAll();
  }

  /** Waits out any deletion covering `id`, which is what makes a re-created facet safe to start. */
  settled(id: FacetId): Promise<void> {
    return this.#queue.waitFor(id);
  }

  #removeSubtree(receipt: FacetDeletionReceipt): Promise<void> {
    const subtree = this.descendants(receipt.id);
    return this.#queue.run([receipt.id, ...subtree], () =>
      this.#host.deleteStorage(receipt.id, subtree),
    );
  }

  async #copyInto(src: FacetId, dst: FacetId): Promise<void> {
    await this.#host.copyStorage(src, dst);
    for (const child of this.children(src)) {
      await this.#copyInto(child.id, this.getId(dst, child.name));
    }
  }
}

// =======================================================================================
// The Actor

/** ← `Worker::Actor::Impl::classInstance` (`io/worker.c++:4091-4115`). */
type ClassInstance =
  | { readonly kind: "before-ctor" }
  | { readonly kind: "initializing" }
  | { readonly kind: "running"; readonly instance: object }
  | { readonly kind: "failed"; readonly exception: unknown };

/**
 * ← `Worker::Actor`, restricted to the four members `io/io-context.ts` names.
 *
 * The gates are constructed here because upstream constructs them here:
 * `Worker::Actor::Impl` owns its own `InputGate` and `OutputGate`
 * (`worker.c++:3784`), and that is per-facet rather than shared with the parent,
 * which is the whole mechanism behind §1.10's parent↔child re-entrancy.
 */
class ActorImpl implements Actor {
  readonly #inputGate: InputGate;
  readonly #outputGate: OutputGate;
  readonly #isFacet: boolean;

  /** Assigned after construction; `storage` is a WXT auto-import in extension bundles. */
  actorStorage: ActorSqlite | undefined;

  classInstance: ClassInstance = { kind: "before-ctor" };

  constructor(
    isFacet: boolean,
    hooks: ActorContainerOptions["gateHooks"] = {},
  ) {
    this.#isFacet = isFacet;
    this.#inputGate = new InputGate(hooks.input);
    this.#outputGate = new OutputGate(hooks.output);
  }

  getInputGate(): InputGate {
    return this.#inputGate;
  }

  getOutputGate(): OutputGate {
    return this.#outputGate;
  }

  /** ← `Worker::Actor::shutdownActorCache`. Abandons scheduled writes rather than flushing (§1.6). */
  shutdownActorCache(reason: unknown): void {
    this.actorStorage?.shutdown(reason);
  }

  /**
   * ← `Worker::Actor::assertCanSetAlarm()` (`io/worker.c++:4090-4116`), one arm
   * per state of its `classInstance` switch.
   *
   * `NoClass` has no arm because this runtime has no class-less actor: every
   * container is built around a constructor. The facet refusal at the top is the
   * divergence `FACET_ALARM_UNIMPLEMENTED_MESSAGE` documents; everything below
   * it is upstream's, message for message.
   */
  assertCanSetAlarm(): void {
    if (this.#isFacet) throw new Error(FACET_ALARM_UNIMPLEMENTED_MESSAGE);

    switch (this.classInstance.kind) {
      case "before-ctor":
        throw new Error("setAlarm() invoked before Durable Object ctor");
      case "initializing":
        // We don't explicitly know if we have an alarm handler or not, so just let it happen.
        // We'll handle it when we go to run the alarm.
        return;
      case "running":
        if (!hasAlarmHandler(this.classInstance.instance)) {
          throw new TypeError(
            "Your Durable Object class must have an alarm() handler in order to call setAlarm()",
          );
        }
        return;
      case "failed":
        // We've failed in the ctor, might as well just throw that exception for now.
        throw this.classInstance.exception;
    }
  }
}

function hasAlarmHandler(instance: object): boolean {
  return typeof (instance as { alarm?: unknown }).alarm === "function";
}

// =======================================================================================
// FacetManagerImpl

/** One name in the parent's facet map. ← the `ActorMap facets` entry (`server.c++:2686`). */
type FacetEntry = {
  readonly id: FacetId;
  readonly started: Promise<FacetHandle>;
  handle: FacetHandle | undefined;
};

/** For awaiting a promise's settlement without adopting its outcome. */
const noop = (): void => {};

/**
 * ← `ActorContainer`'s `Worker::Actor::FacetManager` half (`server.c++:2622-2654`).
 *
 * Upstream's `getFacet` hands the child container a `kj::Promise<ClassAndId>` and
 * returns an `ActorChannelImpl` immediately, so the stub exists before the
 * startup callback has run. `FacetHost.start` is synchronous and wants a resolved
 * request, so the deferral moves here: the stub returned is a proxy that awaits
 * the start and then forwards. Same observable shape — `facets.get()` returns
 * synchronously, and the first call on the result waits for the class.
 *
 * A broken facet is monitored without escalating the break. Upstream
 * `monitorOnBroken` (`server.c++:2767-2800`) aborts that container's own
 * children and erases it from its parent's map; it does not abort the parent.
 * Here the host owns the child container, so `#monitorOnBroken` asks the host to
 * tear it down and removes only the matching entry. `#forgetIfNeverRuns` is the
 * separate path for a placement that never became a running facet.
 */
class FacetManagerImpl implements FacetManager {
  readonly #container: ActorContainerImpl;
  readonly #host: FacetHost;
  readonly #selfId: FacetId;
  readonly #depth: number;
  readonly #tree: FacetTree;
  readonly #facets = new Map<string, FacetEntry>();

  constructor(
    container: ActorContainerImpl,
    host: FacetHost,
    selfId: FacetId,
    depth: number,
    tree: FacetTree,
  ) {
    this.#container = container;
    this.#host = host;
    this.#selfId = selfId;
    this.#depth = depth;
    this.#tree = tree;
  }

  /** ← `getDepth()` (`server.c++:2622-2627`). */
  getDepth(): number {
    return this.#depth;
  }

  /** ← `getFacet()` (`server.c++:2629-2633`) plus `getFacetContainer()` (`:2603-2620`). */
  getFacet<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name: string,
    getStartInfo: () => Promise<FacetStartInfo>,
  ): Fetcher<T> {
    const existing = this.#facets.get(name);
    if (existing !== undefined) {
      return asFacetStub<T>(asFacetTransport(existing, this.#container));
    }

    const tree = this.#tree;
    const id = tree.getId(this.#selfId, name);
    const epoch = tree.epochs.capture(id);
    const depth = this.#depth + 1;

    // The entry has to exist before the placement runs, so that it can write the handle back onto
    // it; a resolver pair is what lets `started` stay a plain `Promise<FacetHandle>` rather than
    // becoming optional for the one turn it takes to fill in.
    const { promise, resolve, reject } = Promise.withResolvers<FacetHandle>();
    const entry: FacetEntry = { id, handle: undefined, started: promise };

    const place = async (): Promise<void> => {
      let handle: FacetHandle;
      try {
        const info = await getStartInfo();
        // A facet re-created under a name that is still being deleted must not open its database
        // while the old one is being removed. Nothing above this layer can see the difference,
        // which is exactly why it has to be waited for here.
        await tree.settled(id);
        if (!tree.epochs.isCurrent(id, epoch)) {
          throw new Error(`Facet "${name}" was torn down before it finished starting.`);
        }
        handle = this.#host.start({
          id,
          name,
          className: info.actorClass.className,
          depth,
          ...(info.id === this.#parentId() ? {} : { routedId: info.id }),
        });
        entry.handle = handle;
        this.#monitorOnBroken(name, entry, handle);
      } catch (exception) {
        // Everything up to a usable handle, so a failure reaches `started` and nothing else. The
        // queue must not be the one to carry it: an id whose placement failed is idle, not broken.
        reject(exception);
        return;
      }
      resolve(handle);
      // `started` settles where it always did — the moment the host accepted the placement — and
      // the id stays busy PAST it, until the placement itself has landed. `start` returning is not
      // the facet running, and an abort
      // delivered inside it reaches a host that has nothing yet to abort.
      await handle.stub.then(noop, noop);
    };

    // Attached before the placement runs, and it is the whole of this entry's failure handling —
    // see its own comment.
    this.#forgetIfNeverRuns(name, entry);
    tree.runOperation(id, place);
    this.#facets.set(name, entry);
    return asFacetStub<T>(asFacetTransport(entry, this.#container));
  }

  /**
   * ← the fact that a facet which failed to start is **not running**, and
   * `getFacet` "runs the startup callback only when the facet is not already
   * running" (§1.10, workerd PR #4431) therefore runs it again.
   *
   * Measured on workerd 1.20260722.1 rather than inferred: a name whose first
   * `facets.get` supplied a class that throws in its constructor accepts a
   * working class on the very next `facets.get`, with no `abort()` in between,
   * and the facet then counts its own storage from 1. A map entry kept after a
   * failed placement would answer every later get with the same dead handle, so
   * the name would be poisoned for the life of the actor.
   *
   * Both failures count, because both leave the same nothing behind: a `start`
   * that rejected before the host was called at all (a startup callback that
   * threw, or a tear-down that invalidated the reference epoch), and a placement
   * the host accepted and could not finish.
   *
   * It is also the handler that keeps either from being reported as an unhandled
   * rejection when nobody ever calls the stub — the same thing `IoContext` does
   * for its abort promise — without hiding it from a real caller, which reaches
   * it through `asFacetTransport`.
   */
  #forgetIfNeverRuns(name: string, entry: FacetEntry): void {
    void entry.started
      .then(async (handle) => {
        await handle.stub;
      })
      .catch(() => {
        // Only if this entry is still the one under that name: a tear-down removes it first, and
        // a later `getFacet` may already have put a fresh entry in its place.
        if (this.#facets.get(name) === entry) this.#facets.delete(name);
      });
  }

  /**
   * ← `monitorOnBroken` (`server.c++:2767-2800`): tear down the broken container
   * (and therefore its own descendants), then free its name in the parent's map.
   * The identity check keeps a late rejection from touching a replacement that
   * already occupies the stable facet id.
   */
  #monitorOnBroken(name: string, entry: FacetEntry, handle: FacetHandle): void {
    void handle.broken.catch((reason: unknown) => {
      if (this.#facets.get(name) !== entry) return;
      this.#facets.delete(name);
      this.#teardown(entry, describeReason(reason));
    });
  }

  /** ← `abortFacet()` (`server.c++:2635-2640`). */
  abortFacet(name: string, reason: unknown): void {
    const entry = this.#facets.get(name);
    if (entry === undefined) return;
    this.#facets.delete(name);
    this.#teardown(entry, describeReason(reason));
  }

  /**
   * ← `deleteFacet()` (`server.c++:2642-2655`): abort any running facet, then
   * delete the underlying storage, descendants first.
   *
   * Upstream's second half is a synchronous `directory->remove`. Ours is a
   * durable receipt plus an asynchronous removal, which is what
   * `server/facet-deletion.ts` exists for — the record is synchronous, so the
   * `void` return still means "this will happen", and a session that dies
   * between the two replays it at boot.
   */
  deleteFacet(name: string): void {
    const tree = this.#tree;
    this.abortFacet(name, new Error(FACET_DELETED_MESSAGE));

    // Note that upstream skips this entirely when the index has never been written, on the grounds
    // that "if there's no facet index then there couldn't possibly be any child storage". `getId`
    // assigns on first sight, so asking for a name that was never created costs one index entry
    // and then deletes nothing — which is also what makes the id stable if it is created later.
    const id = tree.getId(this.#selfId, name);
    tree.epochs.invalidate(id, tree.descendants(id));
    this.#container.trackFacetTeardown(tree.deleteSubtree(id, tree.subtreeOperationBarrier(id)));
  }

  /**
   * ← `DurableObjectFacets::clone`, which has **no body anywhere in workerd** —
   * `Worker::Actor::FacetManager` (`io/worker.h:901-931`) declares four members
   * and none of them is a clone, while `@cloudflare/workers-types` 4.20260702.1
   * declares `clone(src, dst)`. So the semantics come from §1.10's own prose:
   * abort `dst`, delete its storage, recursively copy the `src` subtree onto it.
   *
   * Two things that prose does not settle, assumed here and flagged rather than
   * hidden. It does not say whether `src` must exist — this treats a `src` that
   * was never created as an empty subtree, because `getId` assigns on sight and
   * there is nothing to distinguish "never created" from "created and empty".
   * And it does not say whether `dst`'s own children survive: this deletes
   * `dst`'s whole subtree before copying, because "delete dst storage" followed
   * by a recursive copy leaves no reading in which a child of the old `dst`
   * should still be there.
   */
  cloneFacet(src: string, dst: string): void {
    const tree = this.#tree;
    this.abortFacet(dst, new Error(FACET_DELETED_MESSAGE));

    const srcId = tree.getId(this.#selfId, src);
    const dstId = tree.getId(this.#selfId, dst);
    if (srcId === dstId) throw new TypeError("facets.clone() cannot clone a facet onto itself.");

    tree.epochs.invalidate(dstId, tree.descendants(dstId));
    this.#container.trackFacetTeardown(
      tree
        .deleteSubtree(dstId, tree.subtreeOperationBarrier(dstId))
        .then(() => tree.copySubtree(srcId, dstId)),
    );
  }

  /** ← `monitorOnBroken`'s `for (auto& facet: facets) facet.value->abort(...)` (`server.c++:2777-2780`). */
  abortAll(reason: unknown): void {
    const description = describeReason(reason);
    for (const [name, entry] of this.#facets) {
      this.#facets.delete(name);
      this.#teardown(entry, description);
    }
  }

  /** ← `afterReset`'s `deleteDescendantStorage(dir, selfId)` (`server.c++:2885-2897`). */
  deleteAllDescendants(): void {
    const tree = this.#tree;
    this.abortAll(new Error(FACET_DELETED_MESSAGE));
    for (const child of tree.children(this.#selfId)) {
      tree.epochs.invalidate(child.id, tree.descendants(child.id));
      this.#container.trackFacetTeardown(
        tree.deleteSubtree(child.id, tree.subtreeOperationBarrier(child.id)),
      );
    }
  }

  /**
   * ← `ActorContainer::abort` (`server.c++:2565-2589`) as `abortFacet` reaches it
   * (`:2635-2640`), which is synchronous AND effective the instant it runs.
   *
   * Ours can only be effective once the host has finished placing, so the abort
   * goes to the back of the id's queue when one is in flight and straight
   * through when the id is idle. `abortFacet` stays `void` either way — the
   * queueing is invisible above this line, which is the point: `ctx.facets`'s
   * synchronous shape is upstream's and is not negotiable (`:2635`).
   *
   * Nothing here has to record that this break was the parent's own doing: a
   * facet breaking never reaches its parent, so the parent's own tear-down and a
   * facet dying by itself are the same event as far as the parent is concerned.
   */
  #teardown(entry: FacetEntry, description: string): void {
    this.#tree.runOperation(entry.id, async () => {
      this.#host.abort(entry.id, description);
    });
  }

  #parentId(): string {
    return this.#container.state.id.toString();
  }
}

function describeReason(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** Well-known members a stub proxy must answer as absent rather than as a method. */
const NON_METHOD_PROPERTIES: ReadonlySet<string | symbol> = new Set<string | symbol>([
  "then",
  "catch",
  "finally",
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.asyncIterator,
]);

/**
 * The point where the host's placement stub becomes the `Fetcher` the facet API
 * promises, plus the deferral upstream gets from `ActorChannelImpl` holding a
 * promise.
 *
 * The assertion is `asFacetStub`'s, one layer lower. `FacetHost.start` returns
 * `stub: Promise<object>` because a host mints the handle synchronously and the
 * placement it stands for is not finished yet, so the declared type is the widest
 * thing every host can actually satisfy, and `Promise<Fetcher>` is not it.
 *
 * **This function is the only deferral.** `FacetHandle.stub` carries the
 * placement promise and the proxy below waits for it before forwarding.
 *
 * **The assertion here is a separate one and would survive a narrower
 * `FacetHandle.stub`.** What is not describable is the `Fetcher` *this* function
 * returns: it is a `get`-trap `Proxy` that supplies `fetch`, `connect` and every
 * RPC method name at call time, and TypeScript types a `Proxy` as its target.
 * Typing the target `Fetcher` would only move the assertion to
 * `Object.create(null) as Fetcher`. So this stays where it is, for the reason the
 * two `asFacetStub`-shaped assertions beside it stay: the surface is supplied
 * dynamically, not that the value beneath is unknown.
 */
function asFacetTransport(entry: FacetEntry, owner: ActorContainerImpl): Fetcher {
  const bound = new Map<string | symbol, unknown>();

  const stub = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      // A proxy that answered `then` with a function would make itself a thenable, and
      // `await facets.get(...)` would hang waiting for it to call back.
      if (NON_METHOD_PROPERTIES.has(property)) return undefined;

      const cached = bound.get(property);
      if (cached !== undefined) return cached;

      // ← `awaitIo`, which is what makes an outbound RPC BOTH release the input gate and resume
      // holding one (§1.3). Without it the caller's continuation comes back with an empty
      // invocation stack — divergence 147 — and its next `ctx.storage` or `ctx.facets` call
      // throws. Upstream never faces the question because every promise JS can await originates
      // in an io-context primitive, and a facet stub is one of them.
      const method = (...args: unknown[]): Promise<unknown> => {
        // Capture re-entry now, while the caller's slice (and any surrounding
        // critical section) is current. Waiting for output locks first can move
        // this work onto a later microtask with no current input lock.
        const callArgs = args.map((arg) =>
          arg instanceof RpcTarget ? owner.bindReentryTarget(arg) : arg,
        );
        return owner.awaitIo(
          owner.waitOutputLocks().then(async (): Promise<unknown> => {
            const handle = entry.handle ?? (await entry.started);
            // The placement, which may still be in flight and may have failed. A failure arrives
            // here and nowhere else — it is what upstream's `kj::Promise<ClassAndId>` failing
            // does, and it is what workerd was measured to do (§1.10).
            const target = (await handle.stub) as Record<string | symbol, unknown>;
            const fn = target[property];
            if (typeof fn !== "function") {
              throw new TypeError(`This facet stub has no method ${String(property)}.`);
            }
            // A Cap'n Web method stub is a callable Proxy. Reading its `.apply`
            // would serialize a remote property lookup (`method.apply`) instead
            // of invoking the local call trap, so use the intrinsic directly.
            return await Reflect.apply(fn as (...rest: unknown[]) => unknown, target, callArgs);
          }),
        );
      };
      bound.set(property, method);
      return method;
    },
  });

  return stub as Fetcher;
}

// =======================================================================================
// ActorContainerImpl

class ActorContainerImpl implements ActorContainer {
  readonly #actor: ActorImpl;
  readonly #ctx: IoContext;
  #currentExternalEntry: object | undefined;
  readonly #durableStorage: DurableObjectStorage;
  readonly #cache: ActorSqlite;
  readonly #facets: FacetManagerImpl;
  readonly #tree: ActorTree | undefined;
  readonly #env: unknown;
  readonly #webSockets: HibernatableWebSocketRegistry;
  readonly state: DurableObjectState;
  readonly facetTree: FacetTree;
  readonly globals: ActorGlobalScope;

  /** ← §1.8's "delivery is strictly serialized", measured. One at a time, in order. */
  #alarmTail: Promise<unknown> = Promise.resolve();

  constructor(
    options: ActorContainerOptions,
    db: SqliteDatabase,
    tree: ActorTree | undefined,
    facetTree: FacetTree,
  ) {
    const facet = options.facet;
    this.#actor = new ActorImpl(facet !== undefined, options.gateHooks);
    this.#ctx = new IoContext(this.#actor, options.ports.timer);
    this.#env = options.env;
    this.#tree = tree;

    this.#cache = new ActorSqlite(
      db,
      this.#actor.getOutputGate(),
      // ← `[](SpanParent) -> kj::Promise<void> { return kj::READY_NOW; }` (`server.c++:2900`).
      // Upstream's commit callback exists for a replication layer workerd's local storage has none
      // of; the local commit is already durable when `COMMIT TRANSACTION` returns.
      async () => {},
      // ← `if (parent == kj::none) ... else getDefaultHooks()` (`server.c++:2864-2877`). A facet
      // takes upstream's default hooks, whose `scheduleRun` throws.
      //
      // Nothing can reach them, because `assertCanSetAlarm` refuses first — so giving a facet a
      // live outlet here changes nothing observable and survives the whole suite. It is upstream's
      // own line and it stays: the refusal above it is a divergence, and if the divergence is ever
      // withdrawn this is what workerd's behaviour falls back to.
      facet === undefined ? options.ports.alarms : DEFAULT_ALARM_OUTLET,
    );
    this.#actor.actorStorage = this.#cache;

    this.#durableStorage = new DurableObjectStorage(this.#ctx, this.#cache);
    this.#webSockets = new HibernatableWebSocketRegistry(
      this.#ctx,
      {
        message: (socket, message) => this.#runWebSocketHandler("webSocketMessage", socket, message),
        close: (socket, code, reason, wasClean) =>
          this.#runWebSocketHandler("webSocketClose", socket, code, reason, wasClean),
        error: (socket, error) => this.#runWebSocketHandler("webSocketError", socket, error),
      },
      options.ports.hibernation,
      options.webSockets,
    );
    this.globals = new ActorGlobalScope(this.#ctx, {
      fetch: options.ports.fetch,
      currentExternalEntry: () => this.#currentExternalEntry,
      webSockets: this.#webSockets,
    });
    this.facetTree = facetTree;
    this.#facets = new FacetManagerImpl(
      this,
      options.ports.facets,
      facet?.id ?? 0,
      facet?.depth ?? 0,
      this.facetTree,
    );

    // ← the `afterReset` hook (`server.c++:2885-2897`): "reset() is used when the app called
    // deleteAll(), in which case we also want to delete all child facets." Ours is
    // `beforeSqliteReset`, which is the listener Section 3 ported, and the difference does not
    // matter — the descendants live in other databases entirely.
    db.addResetListener({
      beforeSqliteReset: () => {
        this.#facets.deleteAllDescendants();
      },
    });

    const idFactory = new ActorIdFactoryImpl(options.uniqueKey);
    this.state = new DurableObjectState(this.#ctx, {
      id: new DurableObjectId(idFactory.idFromName(options.id)),
      exports: options.exports,
      props: undefined,
      storage: this.#durableStorage,
      facets: this.#facets,
      // The same object `container.globals` is, so a class that reaches through
      // `ctx` and a dynamically-loaded source that destructured the actor globals
      // are gated by one scope rather than two that could drift.
      globals: actorScopeBindings(() => this.globals),
      webSockets: this.#webSockets,
    });
  }

  get onBroken(): Promise<never> {
    // ← `IoContext`'s two `abortWhen` calls, which are already wired to both gates
    // (`io-context.c++:206-215`). A facet of this actor breaking is NOT one of the ways in: a
    // break travels down, so what reaches here is this container's own failure.
    return this.#ctx.onAbort();
  }

  isCurrentSlice(): boolean {
    return this.#ctx.isCurrentSlice();
  }

  hasCurrent(): boolean {
    return this.#ctx.hasCurrent();
  }

  resolveLoopback<Result>(
    invokeDirect: () => Result,
    invokeEntry: () => Promise<Awaited<Result>>,
    caller?: ActorContainer,
  ): Result | Promise<Awaited<Result>> {
    const context = tryCurrentIoContext();
    if (context === this.#ctx) return invokeDirect();
    if (context !== undefined) {
      return context.awaitIo(context.waitForOutputLocks().then(invokeEntry));
    }
    if (caller === undefined) return invokeEntry();
    if (!caller.hasCurrent()) {
      throw new Error("resolveLoopback() caller has no current input lock");
    }
    if (caller === this) return invokeDirect();
    return caller.awaitIo(caller.waitOutputLocks().then(invokeEntry));
  }

  /**
   * ← `ActorContainer::start` (`server.c++:2854-2957`) as far as the class
   * instance, plus decision 4's boot semantics.
   *
   * Deletion-receipt replay precedes the constructor because a facet the previous
   * session was told to delete must not be reachable from `onStart`. Upstream has
   * no equivalent step for the reason `server/facet-deletion.ts`'s header gives.
   */
  async start<T extends object>(
    construct: (ctx: DurableObjectState, env: unknown) => T,
  ): Promise<T> {
    await this.#tree?.recoverDeletions();

    this.#actor.classInstance = { kind: "initializing" };
    try {
      // The input gate is held for the constructor's synchronous slice and the microtask
      // checkpoint that drains after it, which is upstream's own boundary (§1.2).
      const instance = await this.#ctx.run(() => construct(this.state, this.#env));
      this.#actor.classInstance = { kind: "running", instance };
      return instance;
    } catch (exception) {
      this.#actor.classInstance = { kind: "failed", exception };
      throw exception;
    }
  }

  entry<T extends object>(target: T, signal?: AbortSignal): ActorEntry<T> {
    const bound = new Map<string | symbol, unknown>();

    return new Proxy(target, {
      get: (subject, property): unknown => {
        // The receiver is the target rather than the proxy, so a getter on the class does not
        // re-enter this trap for every field it touches.
        const value: unknown = Reflect.get(subject, property, subject);
        if (typeof value !== "function") return value;

        const cached = bound.get(property);
        if (cached !== undefined) return cached;
        const gated = async (...args: unknown[]): Promise<unknown> => {
          // The dispatch is the one moment that knows both the method name and
          // the caller's frames — the provenance `describeLostLock` reports.
          this.#ctx.noteGateUse(`entry ${String(property)}()`, captureGateStack());
          const result = await this.#ctx.run(
            () =>
              this.#withExternalEntry(() =>
                (value as (...rest: unknown[]) => unknown).apply(subject, args),
              ),
            { signal },
          );
          // ← the reply being piped through `waitForOutputLocks()`. This is §1.1's whole point:
          // a method that returns without awaiting its own write still must not answer before
          // that write is durable.
          await this.#ctx.waitForOutputLocks();
          return result;
        };
        bound.set(property, gated);
        return gated;
      },
    }) as ActorEntry<T>;
  }

  /**
   * Bind an exported Workers RPC callback to the actor slice that created it.
   *
   * A facet call is bidirectional: the caller can pass an `RpcTarget` and the
   * callee can invoke it before returning. That invocation is re-entry into the
   * caller, not an unscoped JavaScript callback. Capturing one generic re-entry
   * function here preserves a surrounding critical section and keeps method
   * discovery lazy for Cap'n Web's property-path dispatch.
   */
  bindReentryTarget<T extends object>(target: T): T {
    const invoke = this.#ctx.makeReentryCallback(
      async (_lock, property: string | symbol, args: unknown[]): Promise<unknown> => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          throw new TypeError(`This RPC callback has no method ${String(property)}.`);
        }
        const result = await Reflect.apply(value as (...rest: unknown[]) => unknown, target, args);
        await this.#ctx.waitForOutputLocks();
        return result;
      },
    );
    const bound = new Map<string | symbol, unknown>();
    return new Proxy(target, {
      get(subject, property): unknown {
        const value: unknown = Reflect.get(subject, property, subject);
        if (typeof value !== "function") return value;
        const cached = bound.get(property);
        if (cached !== undefined) return cached;
        const callback = (...args: unknown[]): Promise<unknown> => invoke(property, args);
        bound.set(property, callback);
        return callback;
      },
    });
  }

  run<T>(event: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    return this.#ctx.run(
      () => this.#withExternalEntry(event),
      { signal },
    );
  }

  #withExternalEntry<T>(body: () => T): T {
    const previous = this.#currentExternalEntry;
    this.#currentExternalEntry = {};
    try {
      return body();
    } finally {
      this.#currentExternalEntry = previous;
    }
  }

  // An arrow property rather than a method, because `asFacetTransport` is handed it as a value
  // and the facet stub's whole job is to be called with `this` bound elsewhere.
  awaitIo = <T>(promise: Promise<T>): Promise<T> => this.#ctx.awaitIo(promise);

  acceptWebSocket(socket: RawWebSocket): AcceptedWebSocket {
    return acceptWebSocket(this.#ctx, socket);
  }

  /**
   * ← the alarm run in `Worker::Actor`: arm, run the handler under a fresh
   * top-level lock, wait for the output locks, then let the deferred deleter
   * drop.
   *
   * "Alarms enter with no lock and no critical section, so an alarm queues behind
   * any held lock and takes a fresh top-level lock" (§1.8) — which is exactly
   * `ctx.run(func)` with no input option. The retry ladder and the watchdog are
   * `server/alarm-scheduler.ts`'s; what is here is one delivery, and the
   * serialization of one delivery against the next, which is the property
   * `_cf_executingScheduleRowId` upstream depends on.
   */
  deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult> {
    const delivery = this.#alarmTail.then(
      () => this.#deliverAlarmImpl(scheduledTime, retryCount),
      () => this.#deliverAlarmImpl(scheduledTime, retryCount),
    );
    this.#alarmTail = delivery.catch(() => undefined);
    return delivery;
  }

  abandonAlarm(scheduledTime: number): Promise<number | null> {
    return this.#cache.abandonAlarm(scheduledTime);
  }

  waitOutputLocks(): Promise<void> {
    return this.#ctx.waitForOutputLocks();
  }

  drainWaitUntil(): Promise<void> {
    return this.#ctx.drainWaitUntil();
  }

  quiescence() {
    return {
      armedTimers: this.#ctx.getTimeoutCount(),
      pendingWaitUntil: this.#ctx.waitUntilTaskCount(),
      inputLockHeld: this.#ctx.hasCurrent(),
      outputGateBroken: this.#ctx.isOutputGateBroken(),
    };
  }

  /** ← `WorkerdApi::compileGlobals`'s `Global::WorkerLoader` arm. */
  workerLoader(channel: IsolateChannelFactory, options: WorkerLoaderOptions): WorkerLoader {
    return new WorkerLoader(this.#ctx, channel, options);
  }

  /**
   * ← `DurableObjectState::abort`, which is what the programmatic path is
   * upstream too. Everything §1.6 asks for is already downstream of it: the cache
   * is shut down synchronously so no scheduled write can still land,
   * `IoContext::abort` refuses re-entry, and `onBroken` is the abort promise.
   * Aborting the facets is this layer's own addition, and it is
   * `monitorOnBroken`'s first act (`server.c++:2777-2780`).
   */
  abort(reason?: unknown): void {
    this.#facets.abortAll(reason ?? new Error("Parent Durable Object was aborted."));
    this.state.abort(reason === undefined ? undefined : describeReason(reason));
  }

  /**
   * A physical deletion or copy outlives the synchronous call that asked for it,
   * so it rides `addWaitUntil`: `drainWaitUntil()` then reports the actor busy
   * until it finishes, and a failure lands in `waitUntilStatus()` instead of
   * becoming an unhandled rejection nobody sees.
   */
  trackFacetTeardown(work: Promise<void>): void {
    this.#ctx.addWaitUntil(work);
  }

  /**
   * ← `ServiceWorkerGlobalScope::runAlarm` (`api/global-scope.c++:518-691`),
   * whose every step is a member of this class: `armAlarmHandler` and its two
   * arms, the handler under a fresh top-level lock, `waitForOutputLocks`, and the
   * deferred deleter dropping last.
   *
   * Two of its steps have nothing to port onto and are absent rather than
   * skipped: the 15-minute walltime `timeoutPromise` (`:558-586`) needs
   * `afterLimitTimeout` and a limit enforcer, neither of which this package has,
   * and every `LOG_NOSENTRY` around the classification is a log with nothing to
   * write to. What survives is the decision those logs describe.
   */
  async #deliverAlarmImpl(scheduledTime: number, retryCount: number): Promise<AlarmResult> {
    const armed = this.#cache.armAlarmHandler(scheduledTime, this.#ctx.now());
    if (armed.kind === "cancel") {
      // ← `CancelAlarmHandler` (`global-scope.c++:684-688`). Not a failure: SQLite has moved past
      // this alarm and has asked the scheduler to re-register the time it does hold.
      await armed.cancel.waitBeforeCancel;
      return { outcome: "canceled", retry: false, retryCountsAgainstLimit: true };
    }

    try {
      const instance = this.#actor.classInstance;
      if (instance.kind === "running" && !hasAlarmHandler(instance.instance)) {
        // ← "Attempted to run a scheduled alarm without a handler, did you remember to export an
        // alarm() function?" (`global-scope.c++:543-549`). Upstream logs the warning once and
        // reports SCRIPT_NOT_FOUND, which does NOT retry — so the deferred deleter still drops and
        // the alarm is cleared rather than redelivered to a class that can never answer it.
        return { outcome: "script-not-found", retry: false, retryCountsAgainstLimit: true };
      }

      let result: AlarmResult;
      try {
        await this.#ctx.run(() => this.#runAlarmHandler(scheduledTime, retryCount));
        result = { outcome: "ok", retry: false, retryCountsAgainstLimit: true };
      } catch (exception) {
        // ← the `.catch_` (`global-scope.c++:593-641`). "We assume that exceptions thrown during
        // commit will propagate to the caller, such that they will ensure
        // cancelDeferredAlarmDeletion() is called": a handler that failed must not have its alarm
        // deleted, or the retry the scheduler is about to make has nothing to run.
        this.#cache.cancelDeferredAlarmDeletion();
        result = {
          outcome: "exception",
          retry: true,
          retryCountsAgainstLimit: true,
          errorDescription: describeReason(exception),
        };
      }

      try {
        // ← `context.waitForOutputLocks()` (`global-scope.c++:645`), which is where a write the
        // handler did not await gets its chance to fail.
        await this.#ctx.waitForOutputLocks();
      } catch (exception) {
        // ← the output-lock error branch (`:647-681`), whose
        // `shouldRetryCountsAgainstLimits` is `isUserGeneratedError` alone: a gate that broke
        // after the handler ran is a reset, and a reset must not spend the alarm's retry budget.
        //
        // Divergence: upstream does NOT cancel the deferred deletion here, because its deleter is
        // owned by the `catch_` lambda and fires at the end of the chain either way. Cancelling is
        // the side that keeps the alarm — a deletion written through a gate that has just broken
        // cannot commit, so the only thing at stake is whether a gate that recovers loses it.
        this.#cache.cancelDeferredAlarmDeletion();
        result = {
          outcome: "exception",
          retry: true,
          retryCountsAgainstLimit: isAlarmFailureUserError(exception),
          errorDescription: describeReason(exception),
        };
      }
      return result;
    } finally {
      armed.run.deferredDelete.drop();
    }
  }

  #runAlarmHandler(scheduledTime: number, retryCount: number): unknown {
    const instance = this.#actor.classInstance;
    if (instance.kind !== "running") {
      throw new Error("An alarm was delivered to a Durable Object that has not been constructed.");
    }
    if (!hasAlarmHandler(instance.instance)) {
      throw new TypeError("Your Durable Object class must have an alarm() handler.");
    }
    // ← `alarm(lock, js.alloc<AlarmInvocationInfo>(scheduledTime, retryCount))` (`:588`).
    return (instance.instance as { alarm: (info: AlarmInvocationInfo) => unknown }).alarm(
      new AlarmInvocationInfo(scheduledTime, retryCount),
    );
  }

  #runWebSocketHandler(
    name: "webSocketMessage" | "webSocketClose" | "webSocketError",
    socket: RawWebSocket,
    ...args: unknown[]
  ): unknown {
    const instance = this.#actor.classInstance;
    if (instance.kind !== "running") return undefined;
    const handler: unknown = Reflect.get(instance.instance, name);
    if (typeof handler !== "function") return undefined;
    return Reflect.apply(handler, instance.instance, [socket, ...args]);
  }
}

// =======================================================================================
// createActorContainer

/**
 * Builds one actor: the two gates, the `IoContext` over them, the storage engine
 * over the actor's database, the facet tree, the id factory, and the `api/`
 * classes on top.
 *
 * Asynchronous because `SqlDatabaseProvider.open` is — see this file's header for
 * why that surfaces here rather than being hidden behind a lazily-opening
 * `state`.
 */
export async function createActorContainer(
  options: ActorContainerOptions,
): Promise<ActorContainer> {
  const actorDb = await options.ports.sql.open(ACTOR_DATABASE_NAME);
  ensureRuntimeStorageVersion(actorDb, ACTOR_DATABASE_NAME);
  const db = new SqliteDatabase(actorDb);

  // ← `ensureFacetTreeIndex()`'s `KJ_REQUIRE(parent == kj::none, "only 'root' may
  // ensureFacetTreeIndex()")` (`server.c++:2704`). A facet is handed the root's rather than
  // opening one, which is also why this is the only `open` a facet container makes.
  if (options.facet !== undefined) {
    return new ActorContainerImpl(options, db, undefined, options.facet.tree);
  }
  const facetDb = await options.ports.sql.open(FACET_DATABASE_NAME);
  ensureRuntimeStorageVersion(facetDb, FACET_DATABASE_NAME);
  const tree = new ActorTree(facetDb, options.ports.facets);
  return new ActorContainerImpl(options, db, tree, tree);
}
