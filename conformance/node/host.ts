/**
 * The Node lane. Runs @mcp-b/do-runtime over backends/node-sqlite with
 * in-process facets, a controllable Timer, and the runtime's own
 * `AlarmScheduler` behind the alarm port.
 *
 * This lane is the one that carries the time-dependent rows, because they are
 * not assertable on wall-clock time: it declares `fake-time` and the browser
 * lane cannot.
 *
 * Facets are in-process here and in the browser lane: a facet is a container in
 * the same realm as its parent, with its own gates and database. `FacetTree.getId`
 * is synchronous all the way down, so a facet across a worker boundary could not
 * share the root's tree index or have facets of its own. The depth-2 conformance
 * row guards that topology against workerd.
 *
 * What the two lanes still fail differently at is the substrate, which is where
 * they were always meant to differ: `node:sqlite` over a directory per facet
 * here, sqlite-wasm over one OPFS pool prefix per facet there.
 *
 * **What a lane is allowed to be.** Everything here is the *platform* around the
 * runtime, which on the workerd lane is supplied by `wrangler.test.jsonc` and by
 * workerd itself: durable storage on disk, the `scheduler` global, the `PROBE`
 * namespace binding, the `LOADER` Worker Loader binding, and something that turns
 * a scheduled alarm into a delivery. None of it is the runtime under test, and
 * none of it may stand in for a behaviour the suite asserts. Where this lane
 * cannot supply a piece of the platform yet, the affected row fails rather than
 * being softened — see the note on the facet class registry below.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import {
  AlarmScheduler,
  createActorContainer,
  installWebSocketGlobals,
  type ActorContainer,
  type ActorEntry,
  type FacetHandle,
  type FacetHost,
  type FacetId,
  type FacetStartRequest,
  type FacetTree,
  type Timer,
} from "../../src/index";
import type {
  ActorClassChannel,
  EntrypointRequest,
  WorkerStubChannel,
} from "../../src/io/io-channels";
import type { WorkerSource } from "../../src/io/worker-source";
import type { IsolateChannelFactory, LoadIsolateRequest } from "../../src/api/worker-loader";
import {
  asLoopbackDurableObjectClass,
  LoopbackDurableObjectClass,
} from "../../src/api/export-loopback";
import type {
  Capability,
  ConformanceHost,
  LaneClientSocket,
  LaneSocketMessage,
  ProbeActor,
} from "../host";
import { Probe } from "../fixtures/probe";
import { HibernationMirror } from "../hibernation-host";
import {
  installWebSocketUpgradeGlobals,
  upgradeWebSocket,
  webSocketUpgradeRequest,
  type UpgradeWebSocket,
} from "../websocket-upgrade";

// =======================================================================================
// The platform globals workerd has natively

/**
 * `scheduler`, `setTimeout`, `setInterval` and their clears are Workers globals
 * the probe uses to mark the awaits that must resume gated. Node has `scheduler`
 * only inside `node:timers/promises` and its `setTimeout` gates nothing, so the
 * lane installs them, exactly as it installs the bindings below.
 *
 * **They are the runtime's, not the lane's.** `container.globals` is the complete
 * bound set: `setTimeout` captures the critical section at the arming call and
 * re-enters through `ctx.run(cb, cs)`, `scheduler.wait` is a timer, and `fetch`
 * is `awaitIo` behind an output-gate wait.
 *
 * Why any of it has to be gated at all: on workerd these are io-context
 * primitives, so the continuation after one re-enters the isolate holding a
 * fresh input lock and can touch storage. A plain `setTimeout` resolves a
 * promise the runtime does not own, the continuation resumes with an empty
 * invocation stack, and the next `ctx.storage` call throws — the runtime's
 * recorded divergence 147, and exactly what the §1.8 alarm row caught: the
 * handler's `exit:1` never happened, because writing it needed a lock the timer
 * had given away.
 *
 * Which container's scope to reach is the question a shared global has to answer,
 * and the answer is the LANE's, in `node:async_hooks`, established by `gated()`
 * below around every entry into an instance. Nothing in `src/` depends on it —
 * `container.globals` holds its context rather than looking one up.
 *
 * **Falling through to Node's own timers is not a fallback in the forbidden
 * sense, and the distinction is exact.** `AsyncLocalStorage` propagates across
 * awaits, so inside an actor the store is set from the entry call through every
 * continuation; an empty store means the caller is not actor code at all, and on
 * this lane that caller is Vitest, which needs a working `setTimeout`. Upstream's
 * global throws there instead (`IoContext::current()` refuses outside a request:
 * "Some functionality... is not allowed within global scope"), which is not
 * available to a lane sharing a realm with its runner. The browser lane's worker
 * shares its realm with nothing and does not need the branch.
 *
 * The browser host needs no ambient at all, and building it is what confirmed
 * that: one worker hosts one actor TREE there, so the global scope has exactly
 * one root container to reach and a module-level reference is the answer rather
 * than an approximation of one. A facet's class arrives as the source of a
 * dynamically-loaded Worker, so it gets its scope bound in its own module scope
 * to its own container, minted per placement — also exact, and also not an
 * ambient. That is not a luxury on that lane: the browser has no
 * `AsyncLocalStorage` and `AsyncContext` is not shipping, so "one actor tree per
 * worker" is load bearing there in a way it is not here.
 */
const current = new AsyncLocalStorage<ActorContainer>();

/** Captured before anything is installed, so the fall-through below cannot recurse. */
const nodeSetTimeout = globalThis.setTimeout;
const nodeClearTimeout = globalThis.clearTimeout;
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;
const nodeFetch = globalThis.fetch;

type SchedulerGlobal = {
  wait(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
  yield(): Promise<void>;
};

const scheduler: SchedulerGlobal = {
  wait: (ms, options) => {
    const container = current.getStore();
    if (container === undefined) {
      return new Promise<void>((resolve) => {
        nodeSetTimeout(resolve, ms);
      });
    }
    return container.globals.scheduler.wait(ms, options);
  },
  yield: () => scheduler.wait(0),
};
(globalThis as { scheduler?: SchedulerGlobal }).scheduler ??= scheduler;

globalThis.setTimeout = ((callback: (...args: never[]) => void, ms?: number, ...args: never[]) => {
  const container = current.getStore();
  if (container === undefined) return nodeSetTimeout(callback, ms, ...args);
  return container.globals.setTimeout(callback, ms, ...args);
}) as typeof globalThis.setTimeout;

globalThis.clearTimeout = ((id?: number) => {
  const container = current.getStore();
  if (container === undefined) return nodeClearTimeout(id);
  return container.globals.clearTimeout(id);
}) as typeof globalThis.clearTimeout;

globalThis.setInterval = ((callback: (...args: never[]) => void, ms?: number, ...args: never[]) => {
  const container = current.getStore();
  if (container === undefined) return nodeSetInterval(callback, ms, ...args);
  return container.globals.setInterval(callback, ms, ...args);
}) as typeof globalThis.setInterval;

globalThis.clearInterval = ((id?: number) => {
  const container = current.getStore();
  if (container === undefined) return nodeClearInterval(id);
  return container.globals.clearInterval(id);
}) as typeof globalThis.clearInterval;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const container = current.getStore();
  if (container === undefined) return nodeFetch(input, init);
  return container.globals.fetch(input, init);
}) as typeof globalThis.fetch;

const ActorWebSocketPair: typeof WebSocketPair = new Proxy(
  class WebSocketPair {
    declare readonly 0: WebSocket;
    declare readonly 1: WebSocket;
  },
  {
    construct() {
      const Pair = current.getStore()?.globals.WebSocketPair;
      if (Pair === undefined) {
        throw new Error("Node lane: WebSocketPair was constructed outside an actor event.");
      }
      return new Pair();
    },
  },
);
installWebSocketGlobals(globalThis, ActorWebSocketPair);
installWebSocketUpgradeGlobals();

/**
 * `crypto`, on the same ambient as the timers above.
 *
 * A getter rather than an assigned value, because `crypto.subtle` is read at the
 * call site and the answer depends on which actor is running — the whole point of
 * `current` here. Outside an actor it is the platform's, which is what `nodeCrypto`
 * keeps.
 */
const nodeCrypto = globalThis.crypto;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  get: () => (current.getStore()?.globals.crypto as Crypto | undefined) ?? nodeCrypto,
});

/**
 * Runs every method of an actor instance inside that actor's ambient, so a
 * platform primitive called from anywhere inside it — including from a
 * continuation several awaits deep — knows which container to re-enter.
 *
 * `this` stays the real instance, so field writes land on the object the
 * container holds rather than on the proxy.
 */
function gated<T extends object>(instance: T, container: ActorContainer): T {
  const bound = new Map<string | symbol, unknown>();
  return new Proxy(instance, {
    get(subject, property): unknown {
      const value: unknown = Reflect.get(subject, property, subject);
      if (typeof value !== "function") return value;
      const cached = bound.get(property);
      if (cached !== undefined) return cached;
      const wrapper = (...args: unknown[]): unknown =>
        current.run(container, () =>
          (value as (...rest: unknown[]) => unknown).apply(subject, args),
        );
      bound.set(property, wrapper);
      return wrapper;
    },
  });
}

/**
 * The namespace's configured `uniqueKey`. One constant for the whole lane,
 * because that is the obligation the option documents: an id is derived from it
 * and names the actor's storage, so a lane that minted a fresh one per spawn
 * would lose every actor's data at `respawn` and never say why.
 */
const UNIQUE_KEY = "do-runtime-conformance-node";

/** Every actor in one run shares a directory tree, so `respawn` finds the same files. */
const root = mkdtempSync(join(tmpdir(), "do-runtime-node-"));

// =======================================================================================
// The Worker Loader binding

/**
 * ← the `worker_loaders` binding `wrangler.test.jsonc` declares for the oracle
 * lane. **The binding itself is now the runtime's** — `container.workerLoader()`
 * builds the real `api/worker-loader.ts` `WorkerLoader`, which section 7b
 * implemented; what the lane supplies is the `IsolateChannelFactory` beneath it,
 * which is the substrate half. Before 7b the lane hand-rolled the whole binding,
 * because there was nothing to construct.
 *
 * `NodeIsolateNamespace` is a port of
 * `Server::WorkerLoaderNamespace::loadIsolate` (`server.c++:4243-4281`): a named
 * isolate is found-or-created, an unnamed one is minted per call. That is where
 * upstream's caching lives too — `WorkerLoader::get` does not cache.
 *
 * The module source really is evaluated. The one rewrite is the import specifier:
 * `cloudflare:workers` is a built-in module Node cannot resolve, so it becomes a
 * read of a global the lane has already filled with this package's own
 * `cloudflare:workers`. After that the source has no imports left and imports as a
 * plain `data:` module. What is NOT reproduced is isolation — a loaded module
 * shares this realm — so `globalOutbound` reaches the namespace and is not
 * enforced. That is the substrate's half of decision 15 and no row in the suite
 * asserts it.
 */
const CLOUDFLARE_WORKERS_GLOBAL = "__doRuntimeCloudflareWorkers";

type LoadedModule = Record<string, unknown>;

const loaded = new Map<string, Promise<LoadedModule>>();

/** Every module in the source, evaluated through its main one. */
async function evaluate(source: WorkerSource): Promise<LoadedModule> {
  const { mainModule, modules } = source.variant;
  const main = modules.find((module) => module.name === mainModule);
  if (main === undefined) {
    throw new Error(`Worker Loader: mainModule ${mainModule} is not in modules.`);
  }
  if (main.content.type !== "esModule") {
    throw new Error(
      `Worker Loader: the node lane only evaluates ES modules, got ${main.content.type}.`,
    );
  }

  const workers: unknown = await import("../../src/api/cloudflare-workers");
  (globalThis as Record<string, unknown>)[CLOUDFLARE_WORKERS_GLOBAL] = workers;

  const rewritten = main.content.body.replace(
    /import\s+(\{[^}]*\})\s+from\s+["']cloudflare:workers["'];?/g,
    (_match, clause: string) =>
      `const ${clause.replace(/\bas\b/g, ":")} = globalThis.${CLOUDFLARE_WORKERS_GLOBAL};`,
  );
  if (rewritten.includes("cloudflare:workers")) {
    throw new Error("Worker Loader: an unrewritten cloudflare:workers import remains.");
  }

  const url = `data:text/javascript;base64,${Buffer.from(rewritten, "utf8").toString("base64")}`;
  return (await import(/* @vite-ignore */ url)) as LoadedModule;
}

/** `${isolateName}#${exportName}` — what `FacetStartRequest.className` carries on this lane. */
function classNameFor(isolateName: string, exportName: string): string {
  return `${isolateName}#${exportName}`;
}

/** ← `Server::WorkerLoaderNamespace::WorkerStubImpl` (`server.c++:4332-4380`). */
class NodeWorkerStubChannel implements WorkerStubChannel {
  constructor(readonly isolateName: string) {}

  getEntrypoint(): Fetcher {
    // No row in the suite reaches a dynamic Worker's entrypoint; the facet bridge is what the
    // probe uses. A named refusal beats a stub that silently answers nothing.
    throw new Error("Node lane: a dynamic Worker's entrypoint has no transport in this lane.");
  }

  getActorClass(request: EntrypointRequest): ActorClassChannel {
    return {
      className: classNameFor(this.isolateName, request.name ?? "default"),
      requireAllowsTransfer: () => {},
    };
  }
}

/** ← `Server::WorkerLoaderNamespace` (`server.c++:4230-4281`), which is where the caching lives. */
class NodeIsolateNamespace implements IsolateChannelFactory {
  #anonymous = 0;

  constructor(readonly namespaceName: string) {}

  loadIsolate(request: LoadIsolateRequest): WorkerStubChannel {
    const isolateName =
      request.name === undefined
        ? `${this.namespaceName}:dynamic:${this.#anonymous++}`
        : `${this.namespaceName}:${request.name}`;
    // `findOrCreate`: a named isolate loads its code once, an unnamed one every time.
    if (request.name === undefined || !loaded.has(isolateName)) {
      loaded.set(
        isolateName,
        request.fetchSource().then((source) => evaluate(source.source)),
      );
    }
    return new NodeWorkerStubChannel(isolateName);
  }

  /**
   * ← `getSubrequestChannel(IoContext::NULL_CLIENT_CHANNEL)`. The probe never sets
   * `globalOutbound`, so every load it makes takes this path — it has to answer
   * with a value rather than throw. What it answers with is upstream's
   * `NullGlobalOutboundChannel` shape (`server.c++:4306-4331`): a channel that
   * exists and refuses when a request is actually sent through it, since this lane
   * has no outbound at all.
   */
  getNullClientChannel(): Fetcher {
    return {
      fetch: (): Promise<Response> =>
        Promise.reject(new Error("Node lane: this worker has no global outbound.")),
      connect: (): never => {
        throw new Error("Node lane: this worker has no global outbound.");
      },
    } as unknown as Fetcher;
  }
}

/**
 * One namespace for the whole run, which is what the `worker_loaders` binding is:
 * two actors naming the same isolate share it, as `worker-loader-test.js`'s
 * `sharedLoader1` / `sharedLoader2` pair does.
 */
const loaderNamespace = new NodeIsolateNamespace("loader");

/** What a facet placement needs out of the isolate its class came from. */
type ResolvedClass = {
  readonly ActorClass: new (ctx: unknown, env: unknown) => object;
  /**
   * ← the `ctx.exports` a dynamically-loaded Worker finds: its OWN module's
   * entrypoints. Supplying it is the lane's job for the same reason supplying
   * `cloudflare:workers` is — the platform, not the runtime — and it is the only
   * handle a loaded module has on itself, which is what lets a facet create a
   * facet of its own. Measured on workerd, where `ctx.exports.Child` inside the
   * probe's dynamic Worker is what the depth-2 row runs on.
   *
   * Every function-valued export becomes a `LoopbackDurableObjectClass`, which is
   * upstream's type for "you export a class extending `DurableObject` but you
   * don't configure storage for it" (`export-loopback.h:116-148`) — exactly a
   * dynamic Worker's situation, since dynamically-loaded isolates can't directly
   * have storage (§1.11). The non-function exports a real `ctx.exports` would
   * carry as `LoopbackServiceStub` are absent rather than approximated: no row
   * reaches one, and `requireFacetClass` names the missing key loudly.
   */
  readonly exports: Record<string, unknown>;
};

async function resolveClass(className: string): Promise<ResolvedClass> {
  const hash = className.lastIndexOf("#");
  if (hash < 0) throw new Error(`Node lane cannot resolve facet class ${className}.`);
  const isolateName = className.slice(0, hash);
  const module = await loaded.get(isolateName);
  if (module === undefined) throw new Error(`Node lane has no loaded worker for ${className}.`);
  const exported = module[className.slice(hash + 1)];
  if (typeof exported !== "function") {
    throw new Error(`Node lane: ${className} is not a constructor.`);
  }

  const exports: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function") continue;
    exports[name] = asLoopbackDurableObjectClass(
      new LoopbackDurableObjectClass({
        getActorClass: () => ({
          className: classNameFor(isolateName, name),
          requireAllowsTransfer: () => {},
        }),
      }),
    );
  }

  return { ActorClass: exported as new (ctx: unknown, env: unknown) => object, exports };
}

// =======================================================================================
// The clock

/**
 * `now()` is the real clock — `setAlarm`'s past-time clamp and
 * `armAlarmHandler`'s comparison both read it, so a fake one would make every
 * alarm look overdue.
 *
 * `afterDelay` fires on real elapsed time AND can be jumped forward, which is
 * the whole of what the `fake-time` capability claims. Both halves are needed
 * now that `AlarmScheduler` takes this timer: an alarm armed for 20ms from now
 * has to arrive by itself, because a lane supplies the platform and a wake that
 * only happens when a test pokes it is not one. `advance()` is the extra power,
 * for the 30-second `blockConcurrencyWhile` deadline and the retry ladder —
 * neither of which is assertable on wall time.
 */
type PendingDelay = { readonly at: number; settle(): void };

class ControllableTimer implements Timer {
  #offset = 0;
  readonly #pending = new Set<PendingDelay>();

  now(): number {
    return Date.now() + this.#offset;
  }

  /**
   * `nodeSetTimeout` and not the installed global, and this one is not a style
   * preference. `container.globals.setTimeout` is built ON this timer, so a
   * `Timer` that reached the gated global would arm a timeout to implement a
   * timeout — `#arm` → `afterDelay` → `setTimeout` → `setTimeoutImpl` → `#arm`,
   * measured as `RangeError: Maximum call stack size exceeded` the first time
   * this lane was pointed at the runtime's own primitives. Every substrate piece
   * BELOW the runtime has to hold the raw ones.
   */
  afterDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: ReturnType<typeof nodeSetTimeout> | undefined;
      const entry: PendingDelay = {
        at: this.now() + ms,
        settle: () => {
          if (handle !== undefined) nodeClearTimeout(handle);
          this.#pending.delete(entry);
          resolve();
        },
      };
      this.#pending.add(entry);
      handle = nodeSetTimeout(
        () => {
          entry.settle();
        },
        Math.max(0, ms),
      );
      // Node keeps the process alive for a pending timer; a test runner should not wait on one.
      handle.unref?.();
      signal?.addEventListener("abort", () => {
        if (handle !== undefined) nodeClearTimeout(handle);
        this.#pending.delete(entry);
      });
    });
  }

  async advance(ms: number): Promise<void> {
    this.#offset += ms;
    const now = this.now();
    for (const entry of [...this.#pending]) {
      if (entry.at <= now) entry.settle();
    }
    // Let every continuation the resolutions unblocked run before the caller looks at the result.
    await new Promise<void>((resolve) => nodeSetTimeout(resolve, 0));
  }
}

const timer = new ControllableTimer();

// =======================================================================================
// Placement

type Placement = {
  readonly container: ActorContainer;
  readonly stub: object;
};

class NodeClientSocket implements LaneClientSocket {
  readonly #messages: LaneSocketMessage[] = [];
  readonly #messageWaiters: ((message: LaneSocketMessage) => void)[] = [];
  readonly #closes: { code: number; reason: string; wasClean: boolean }[] = [];
  readonly #closeWaiters: ((close: { code: number; reason: string; wasClean: boolean }) => void)[] = [];

  constructor(readonly socket: UpgradeWebSocket) {
    socket.addEventListener("message", (event) => {
      const message = (event as MessageEvent).data as LaneSocketMessage;
      const waiter = this.#messageWaiters.shift();
      if (waiter === undefined) this.#messages.push(message);
      else waiter(message);
    });
    socket.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      const close = {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      };
      const waiter = this.#closeWaiters.shift();
      if (waiter === undefined) this.#closes.push(close);
      else waiter(close);
    });
    socket.accept();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    this.socket.send(data);
    return Promise.resolve();
  }

  close(code?: number, reason?: string): Promise<void> {
    this.socket.close(code, reason);
    return Promise.resolve();
  }

  nextMessage(): Promise<LaneSocketMessage> {
    const message = this.#messages.shift();
    return message === undefined
      ? new Promise((resolve) => this.#messageWaiters.push(resolve))
      : Promise.resolve(message);
  }

  nextClose(): Promise<{ code: number; reason: string; wasClean: boolean }> {
    const close = this.#closes.shift();
    return close === undefined
      ? new Promise((resolve) => this.#closeWaiters.push(resolve))
      : Promise.resolve(close);
  }
}

/**
 * One host for the whole run, as `FacetHost`'s contract requires: every id it is
 * handed is an id in some root's tree index, so it has to be able to place and
 * remove any facet of any actor. Ids are unique per actor tree, so the map is
 * keyed by the root's directory as well.
 */
class NodeFacetHost implements FacetHost {
  readonly #placements = new Map<string, Placement>();
  #tree: FacetTree | undefined;
  #actorRoot = "";
  #env: unknown;

  /** Called by the root placement, which is the only thing that knows the tree. */
  attach(actorRoot: string, tree: FacetTree, env: unknown): void {
    this.#actorRoot = actorRoot;
    this.#tree = tree;
    this.#env = env;
  }

  start(request: FacetStartRequest): FacetHandle {
    const key = this.#key(request.id);
    const existing = this.#placements.get(key);
    if (existing !== undefined) {
      return { stub: Promise.resolve(existing.stub), broken: existing.container.onBroken };
    }

    const directory = this.#directory(request.id);
    mkdirSync(directory, { recursive: true });

    const tree = this.#tree;
    if (tree === undefined) throw new Error("Node lane: no actor tree attached.");

    const started = (async (): Promise<Placement> => {
      const { ActorClass, exports } = await resolveClass(request.className);
      const container = await createActorContainer({
        id: request.routedId ?? request.name,
        uniqueKey: UNIQUE_KEY,
        exports,
        env: this.#env,
        ports: {
          sql: createNodeSqlProvider({ directory }),
          // Never reached: a facet container installs `DEFAULT_ALARM_OUTLET` and
          // `assertCanSetAlarm` refuses before anything can call it.
          alarms: { scheduleRun: () => Promise.reject(new Error("facets have no alarm slot")) },
          facets: this,
          timer,
        },
        facet: { depth: request.depth, id: request.id, tree },
      });
      let instance: object;
      try {
        instance = await container.start((ctx, env) => gated(new ActorClass(ctx, env), container));
      } catch (exception) {
        // The container exists and holds a database connection; the instance does not, so nothing
        // will ever tear it down through `#placements`. Drop it here or a failed start leaks a
        // connection on the actor's directory for every attempt.
        container.abort(exception);
        throw exception;
      }
      const placement: Placement = { container, stub: container.entry(instance) };
      this.#placements.set(key, placement);
      return placement;
    })();

    // `broken` carries a RUNNING facet breaking and nothing else. A placement that never completed
    // is a start that failed, and it reaches the caller through `stub` — which is what workerd
    // does, measured: a facet whose constructor throws does not break its parent.
    const { promise: broken, reject } = Promise.withResolvers<never>();
    void broken.catch(() => {});
    void started.then(
      ({ container }) => {
        void container.onBroken.catch(reject);
      },
      () => {
        // Deliberately nothing: `stub` below is the rejection's route home.
      },
    );

    return { stub: started.then((placement) => placement.stub), broken };
  }

  abort(id: FacetId): void {
    const key = this.#key(id);
    const placement = this.#placements.get(key);
    if (placement === undefined) return;
    this.#placements.delete(key);
    placement.container.abort(new Error("Facet placement closed."));
  }

  async deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void> {
    for (const descendant of subtree) {
      this.abort(descendant);
      rmSync(this.#directory(descendant), { recursive: true, force: true });
    }
    this.abort(id);
    rmSync(this.#directory(id), { recursive: true, force: true });
  }

  async copyStorage(src: FacetId, dst: FacetId): Promise<void> {
    rmSync(this.#directory(dst), { recursive: true, force: true });
    cpSync(this.#directory(src), this.#directory(dst), { recursive: true, force: true });
  }

  /** Every placement in this tree, for `respawn`. */
  closeAll(): void {
    for (const [key, placement] of this.#placements) {
      this.#placements.delete(key);
      placement.container.abort(new Error("Facet placement closed."));
    }
  }

  #key(id: FacetId): string {
    return `${this.#actorRoot}:${id}`;
  }

  #directory(id: FacetId): string {
    return join(this.#actorRoot, `facet-${id}`);
  }
}

// =======================================================================================
// The actor registry

type Record_ = {
  readonly name: string;
  readonly container: ActorContainer;
  readonly instance: Probe;
  readonly stub: ActorEntry<Probe>;
  readonly host: NodeFacetHost;
};

/**
 * ← the per-namespace `AlarmScheduler` (`server.c++:2325-2350`), which is the
 * runtime's own and not the lane's: what a lane supplies is the database it
 * keeps `_cf_ALARM` in and the function that resolves an actor id to a
 * container. One for the whole run, because ids are namespace-wide.
 *
 * `getActor` PLACES the actor if it is not running, which is what upstream's
 * `getActorContainer(id)` does — an alarm is a reason to wake a Durable Object,
 * not something that requires one to be awake already.
 */
let schedulerPromise: Promise<AlarmScheduler> | undefined;

function alarmScheduler(): Promise<AlarmScheduler> {
  schedulerPromise ??= (async (): Promise<AlarmScheduler> => {
    const db = await createNodeSqlProvider({ directory: root }).open("alarms");
    return new AlarmScheduler({
      timer,
      db,
      getActor: (actorId) => ({
        deliverAlarm: async (scheduledTime, retryCount) =>
          await (await placed(actorId)).container.deliverAlarm(scheduledTime, retryCount),
        abandonAlarm: async (scheduledTime) =>
          await (await placed(actorId)).container.abandonAlarm(scheduledTime),
      }),
    });
  })();
  return schedulerPromise;
}

const live = new Map<string, Record_>();
const socketHosts = new Map<string, HibernationMirror>();

function socketHost(name: string): HibernationMirror {
  const existing = socketHosts.get(name);
  if (existing !== undefined) return existing;
  const host = new HibernationMirror();
  socketHosts.set(name, host);
  return host;
}

async function placed(name: string): Promise<Record_> {
  return live.get(name) ?? (await place(name));
}

function directoryFor(name: string): string {
  return join(root, encodeURIComponent(name).replace(/[^A-Za-z0-9_-]/g, "_"));
}

async function place(name: string): Promise<Record_> {
  const directory = directoryFor(name);
  mkdirSync(directory, { recursive: true });

  const host = new NodeFacetHost();
  const hibernation = socketHost(name);
  const scheduler = await alarmScheduler();
  // `LOADER` is filled in below: the binding needs the container's IoContext, exactly as
  // upstream's binding compilation runs after the Worker exists. `env` is the same object the
  // container holds, which is what makes the later assignment visible to the probe.
  const env: Record<string, unknown> = {
    PROBE: {
      idFromName: (target: string) => ({ toString: () => target }),
      get: (id: { toString(): string }) => stubFor(String(id)),
    },
  };

  const container = await createActorContainer({
    id: name,
    uniqueKey: UNIQUE_KEY,
    exports: {},
    env,
    ports: {
      sql: createNodeSqlProvider({ directory }),
      // ← `ActorSqliteHooks` (`server.c++:3199-3219`): one adapter per actor over the namespace's
      // scheduler, which is the whole of how an actor's storage engine reaches it.
      alarms: scheduler.hooks(name),
      facets: host,
      timer,
      hibernation,
      fetch: async () => {
        await timer.afterDelay(60);
        return new Response("fetched");
      },
    },
    webSockets: hibernation.snapshot(),
  });
  // ← `WorkerdApi::compileGlobals`'s `Global::WorkerLoader` arm — the real binding over the
  // lane's own namespace. `CODE_VERSION` is what workerd itself passes
  // (`server/workerd-api.c++:751`); the calling worker is experimental, as
  // `worker-loader-test.wd-test`'s is.
  env.LOADER = container.workerLoader(loaderNamespace, {
    compatDateValidation: "codeVersion",
    allowExperimentalFeatures: true,
  });
  host.attach(directory, treeOf(container), env);

  const instance = await container.start((ctx, workerEnv) =>
    gated(new Probe(ctx as never, workerEnv as never), container),
  );
  const record: Record_ = {
    name,
    container,
    instance,
    stub: container.entry(instance),
    host,
  };
  live.set(name, record);
  return record;
}

/**
 * The root's `FacetTree`, which the host has to hand back down to any facet that
 * may have facets of its own — the one thing a nested container cannot build for
 * itself, because ids are sequential across the whole tree.
 */
function treeOf(container: ActorContainer): FacetTree {
  return container.facetTree;
}

function stubFor(name: string): ActorEntry<Probe> {
  return new Proxy({} as ActorEntry<Probe>, {
    get: (_target, property): unknown => {
      if (property === "then") return undefined;
      return (...args: unknown[]): Promise<unknown> => {
        const caller = current.getStore();
        const invocation = placed(name).then((record) => {
          const method = (record.stub as unknown as Record<PropertyKey, unknown>)[property];
          if (typeof method !== "function") {
            throw new Error(`Probe has no method ${String(property)}`);
          }
          return (method as (...rest: unknown[]) => Promise<unknown>)(...args);
        });
        return caller === undefined ? invocation : caller.awaitIo(invocation);
      };
    },
  });
}

function actor(name: string): ProbeActor {
  const invoke = async (method: string, args: readonly unknown[]): Promise<unknown> => {
    const record = await placed(name);
    const fn = (record.stub as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Probe has no method ${method}`);
    return await (fn as (...rest: unknown[]) => Promise<unknown>)(...args);
  };
  return {
    name,
    call: <T>(method: string, ...args: readonly unknown[]) => invoke(method, args) as Promise<T>,
    post: (method: string, ...args: readonly unknown[]) => ({
      settled: invoke(method, args),
    }),
  };
}

function teardown(name: string): void {
  const record = live.get(name);
  if (record === undefined) return;
  live.delete(name);
  record.host.closeAll();
}

let probeCounter = 0;

export const host: ConformanceHost = {
  lane: "node",
  capabilities: new Set<Capability>(["fake-time", "real-crash"]),

  spawn: async (name = `probe-${probeCounter++}`) => {
    if (!live.has(name)) await place(name);
    return actor(name);
  },

  /** Same identity, fresh instance. The directory is the durable half and it stays. */
  respawn: async (previous) => {
    teardown(previous.name);
    await place(previous.name);
    return actor(previous.name);
  },

  connect: async (target, tags = []) => {
    const record = await placed(target.name);
    const response = await record.stub.fetch(
      webSocketUpgradeRequest("https://probe.invalid/socket", tags),
    );
    const socket = upgradeWebSocket(response);
    if (socket === undefined) throw new Error("Node lane: probe fetch did not upgrade.");
    return new NodeClientSocket(socket);
  },

  evict: async (target) => {
    teardown(target.name);
    await place(target.name);
  },

  /** Drop the container without letting it flush: the files are all that survives. */
  crash: async (target) => {
    teardown(target.name);
  },

  time: { advance: (ms) => timer.advance(ms) },
};
