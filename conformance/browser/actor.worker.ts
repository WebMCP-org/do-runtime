/**
 * One worker, one actor TREE. A root probe and every facet under it are
 * containers in this module.
 *
 * **Everything here is the platform, not the runtime.** It supplies what
 * `wrangler.test.jsonc` supplies on the oracle lane and what
 * `conformance/node/host.ts` supplies under Node: durable storage, the
 * `scheduler` global, the `PROBE` and `LOADER` bindings, the `ctx.exports` a
 * dynamically-loaded Worker finds, and placement for facets.
 *
 * **Why one actor tree per worker.** OPFS sync access handles exist only in a
 * dedicated worker, so an actor's storage can never be reached from the page;
 * that much is measured (see the design record's storage-floor entry). The *one*
 * is the part that pays for itself: `scheduler.wait` has to re-enter the
 * container through `container.awaitIo`, or the continuation after it resumes
 * with an empty invocation stack and its next `ctx.storage` call throws. The node
 * lane answers "which container" with `AsyncLocalStorage`, which the browser does
 * not have and `AsyncContext` is years from shipping. With one *root* per worker
 * the question does not arise for the root: there is exactly one container the
 * global `scheduler` can mean.
 *
 * **Facets are in-process with their parent, as they are upstream.** §1.10: a
 * facet is a distinct `Worker::Actor` with its own `InputGate`/`OutputGate`
 * (`worker.c++:3784`) and its own SQLite database, and that is the whole of the
 * separateness — gates, storage, lifecycle, not address space. Placing them in
 * workers of their own was a divergence toward MORE isolation than the oracle
 * has, which conformance cannot assert either way, and it cost the one thing the
 * product's topology needs: `FacetTree.getId` is synchronous all the way down, so
 * a facet across a worker boundary cannot be handed the root's tree index and
 * therefore cannot have facets of its own. The depth-2 row in
 * `conformance/suite/facets.spec.ts` is that fact, asserted.
 *
 * Isolation for untrusted code is a separate mechanism and is not this one.
 * §1.11: Code Mode is two features composed — a dynamic Worker for execution,
 * because "Dynamically-loaded isolates can't directly have storage"
 * (`server.c++:4209`), and a facet for the durable state. The isolate is minted
 * by the Worker Loader (`src/api/worker-loader.ts`), never by where the facet
 * sits.
 *
 * **What a facet class sees as `scheduler`, and why it is per module.** A facet's
 * class arrives as the source of a dynamically-loaded Worker, and upstream a
 * dynamic Worker has its own global scope bound to its own context. There is one
 * realm here, so the module gets a module-scoped `scheduler` instead — bound to
 * that facet's container, minted per placement. That is exact rather than
 * ambient: no guess about which container is running is ever made. Its limit is
 * stated where it is built (`facetModule` below).
 */

import {
  actorScopeBindings,
  createActorContainer,
  installActorScope,
  newRpcSession,
  type ActorContainer,
  type ActorGlobalScope,
  type ActorScopeBindings,
  type AlarmOutlet,
  type AlarmResult,
  type EntrypointRequest,
  type FacetHandle,
  type FacetHost,
  type FacetId,
  type FacetStartRequest,
  type FacetTree,
  type IsolateChannelFactory,
  type LoadIsolateRequest,
  type WorkerSource,
  type WorkerStubChannel,
} from "../../src/index";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import {
  asLoopbackDurableObjectClass,
  LoopbackDurableObjectClass,
} from "../../src/api/export-loopback";
import {
  SqliteWasmActorStorage,
  type SqliteWasmHost,
} from "../../backends/sqlite-wasm";
import { Probe } from "../fixtures/probe";
import type { ActorBoot, ActorRpc, SupervisorRpc } from "./protocol";
import { installPool, timer, UNIQUE_KEY } from "./substrate";

type Session<T> = ReturnType<typeof newRpcSession<T>>;

/** The root container this worker hosts, when it is running. */
type Live = {
  readonly container: ActorContainer;
  readonly entry: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

/**
 * Installed once and outliving every container this worker hosts, which is the
 * whole point: the pool's exclusive handles are acquired at boot and released
 * never, so a respawn is a new container over the same files rather than a race
 * for them. Every facet is a further prefix inside this one pool.
 */
let pool: Promise<SqliteWasmHost> | undefined;
function lanePool(): Promise<SqliteWasmHost> {
  pool ??= installPool(requireBoot().poolName);
  return pool;
}

let boot: ActorBoot | undefined;
let live: Live | undefined;
/** In flight, so two calls arriving at an unplaced actor do not both place it. */
let placing: Promise<Live> | undefined;
/** The page. */
let peer: Session<SupervisorRpc> | undefined;

// =======================================================================================
// The platform globals workerd has natively

/**
 * `scheduler.wait` goes through `container.awaitIo`, and that is not a
 * convenience: on workerd `scheduler.wait` is an io-context primitive, so the
 * continuation after it re-enters holding a fresh input lock and can touch
 * storage. A plain `setTimeout` resolves a promise the runtime does not own and
 * the next `ctx.storage` call throws — the runtime's recorded divergence 147.
 *
 * **This one is the ROOT's**, and it is reached only by classes in this worker's
 * own module graph, which is the root probe and nothing else. A facet's class
 * comes from a Worker Loader source and gets its own, module-scoped — see
 * `facetModule`.
 *
 * **This ASSIGNS where the node lane uses `??=`, and the difference is a real
 * trap.** Chrome ships a `scheduler` global in workers — the Prioritized Task
 * Scheduling API, `postTask` and `yield`, measured present here — and it has no
 * `wait`. A `??=` would silently keep Chrome's and every timer row would fail
 * with "scheduler.wait is not a function" three layers from the cause.
 */
/**
 * ← what `installActorScope` does for a facet below, applied to the root's.
 *
 * The node lane falls through to the platform's own timers when its ambient is
 * empty, because there that can legitimately mean "called from outside any
 * actor" — Vitest shares that realm. Here it cannot mean that: one worker hosts
 * one root and nothing else, so no container can only mean the root went away,
 * and a raw timer would hand the continuation back ungated. That is divergence
 * 147 surfacing three layers from its cause. With
 * `awaitIo` removed from this scheduler, §1.8's alarm row fails as
 * `enter:1, enter:2, exit:2`, the handler's own `exit:1` never written. Refuse
 * instead, which is also what upstream's `IoContext::current()` does outside a
 * request.
 */
function rootScope(op: string): ActorGlobalScope {
  if (live === undefined) {
    throw new Error(
      `Browser lane: ${op} was called with no live root container, so its continuation could ` +
        "not resume gated. One worker hosts one root here, so this means the container was torn " +
        "down while its code was still running.",
    );
  }
  return live.container.globals;
}

/**
 * Installed when the pool is, and not at module scope, which is a lane ordering
 * requirement rather than a preference.
 *
 * `installOpfsSAHPoolVfs` probes the two other OPFS VFSes on its way in, and
 * both of those arm a watchdog through the GLOBAL `setTimeout` — sqlite-wasm is
 * a third-party module in this realm and cannot be made to capture a raw one the
 * way `substrate.ts` does. Installing first therefore hands the actor's gate to a
 * storage library, which is backwards: measured, it produced three `Ignoring
 * inability to install the … sqlite3_vfs` warnings carrying the root scope's own
 * refusal. The rows were green either way, because the probes are optional and
 * the SAH pool is what this lane uses — which is exactly why it needed fixing
 * rather than tolerating.
 *
 * The general rule, and it is the extension's at cutover too: everything BELOW
 * the runtime in one realm must reach the platform's timers, either by capturing
 * them or by running before the scope is installed. See `installActorScope`.
 */
function installRootScope(): void {
  installActorScope(globalThis, () => rootScope("a root global"));
}

// =======================================================================================
// The Worker Loader binding

/**
 * ← `Server::WorkerLoaderNamespace` (`server.c++:4230-4281`), **which is where
 * the caching lives**: `WorkerLoader::get` calls `loadIsolate` unconditionally
 * (`worker-loader.c++:63-83`), so a named isolate is found-or-created here and an
 * unnamed one is minted per call.
 *
 * What is cached is the SOURCE, not an evaluated module. A module is evaluated
 * once per facet PLACEMENT rather than once per isolate, which is what gives each
 * facet its own module-scoped `scheduler` — see `facetModule`. The node lane
 * caches the evaluated module instead, because there the ambient is
 * `AsyncLocalStorage` and one module instance can serve every facet.
 *
 * One namespace per worker rather than per lane. Upstream's is per
 * `worker_loaders` binding, so two actors naming the same isolate share it
 * (`worker-loader-test.js`'s `sharedLoader1`/`sharedLoader2`); here two actors are
 * in separate workers, which is the same thing workerd would do with actors in
 * separate processes. Nothing in the suite observes the difference.
 */
class BrowserIsolateNamespace implements IsolateChannelFactory {
  #anonymous = 0;
  readonly #sources = new Map<string, Promise<WorkerSource>>();

  loadIsolate(request: LoadIsolateRequest): WorkerStubChannel {
    const isolateName =
      request.name === undefined ? `dynamic:${this.#anonymous++}` : `named:${request.name}`;
    // `findOrCreate`: a named isolate fetches its code once, an unnamed one every time.
    if (request.name === undefined || !this.#sources.has(isolateName)) {
      this.#sources.set(
        isolateName,
        request.fetchSource().then((source) => source.source),
      );
    }
    return new BrowserWorkerStubChannel(isolateName);
  }

  /**
   * ← `getSubrequestChannel(IoContext::NULL_CLIENT_CHANNEL)`. The probe never sets
   * `globalOutbound`, so every load takes this path and it has to answer with a
   * value rather than throw. What it answers with is upstream's
   * `NullGlobalOutboundChannel` shape (`server.c++:4306-4331`): a channel that
   * exists and refuses when a request is actually sent through it.
   */
  getNullClientChannel(): Fetcher {
    return {
      fetch: (): Promise<Response> =>
        Promise.reject(new Error("Browser lane: this worker has no global outbound.")),
      connect: (): never => {
        throw new Error("Browser lane: this worker has no global outbound.");
      },
    } as unknown as Fetcher;
  }

  /** The module text a facet placement evaluates in order to construct the class. */
  async mainModule(isolateName: string): Promise<string> {
    const pending = this.#sources.get(isolateName);
    if (pending === undefined) {
      throw new Error(`Browser lane has no loaded isolate named ${isolateName}.`);
    }
    const { mainModule, modules } = (await pending).variant;
    const main = modules.find((module) => module.name === mainModule);
    if (main === undefined) {
      throw new Error(`Worker Loader: mainModule ${mainModule} is not in modules.`);
    }
    if (main.content.type !== "esModule") {
      throw new Error(
        `Worker Loader: the browser lane only evaluates ES modules, got ${main.content.type}.`,
      );
    }
    return main.content.body;
  }
}

/** ← `Server::WorkerLoaderNamespace::WorkerStubImpl` (`server.c++:4332-4380`). */
class BrowserWorkerStubChannel implements WorkerStubChannel {
  constructor(readonly isolateName: string) {}

  getEntrypoint(): Fetcher {
    // No row in the suite reaches a dynamic Worker's entrypoint; the facet bridge is what the
    // probe uses. A named refusal beats a stub that silently answers nothing.
    throw new Error("Browser lane: a dynamic Worker's entrypoint has no transport in this lane.");
  }

  getActorClass(request: EntrypointRequest): { className: string; requireAllowsTransfer(): void } {
    return {
      className: classNameFor(this.isolateName, request.name ?? "default"),
      requireAllowsTransfer: () => {},
    };
  }
}

const isolates = new BrowserIsolateNamespace();

/** `${isolateName}#${exportName}` — what `FacetStartRequest.className` carries on this lane. */
function classNameFor(isolateName: string, exportName: string): string {
  return `${isolateName}#${exportName}`;
}

// =======================================================================================
// Placement

type Placement = {
  readonly container: ActorContainer;
  readonly storage: SqliteWasmActorStorage;
  readonly stub: object;
};

/**
 * One host for the whole actor tree, as `FacetHost`'s contract requires: every id
 * it is handed is an id in the root's index, so it has to be able to place and
 * remove any facet of any depth.
 *
 * Modelled on `conformance/node/host.ts`'s `NodeFacetHost`, which is the worked
 * in-process example. What differs is only the substrate: a prefix inside the
 * root's OPFS pool where Node has a directory.
 */
class BrowserFacetHost implements FacetHost {
  readonly #placements = new Map<FacetId, Placement>();
  #pool: SqliteWasmHost | undefined;
  #tree: FacetTree | undefined;
  #env: unknown;

  /** Called by the root placement, which is the only thing that knows the tree. */
  attach(lane: SqliteWasmHost, tree: FacetTree, env: unknown): void {
    this.#pool = lane;
    this.#tree = tree;
    this.#env = env;
  }

  start(request: FacetStartRequest): FacetHandle {
    const existing = this.#placements.get(request.id);
    if (existing !== undefined) {
      return { stub: Promise.resolve(existing.stub), broken: existing.container.onBroken };
    }

    const tree = this.#tree;
    if (tree === undefined) throw new Error("Browser lane: no actor tree attached.");

    const started = (async (): Promise<Placement> => {
      // The gate is filled in below, before anything the class can run: the module's `scheduler`
      // needs this container and this container needs the module's class, so one of the two has
      // to be late-bound and the binding is the one with no work in it.
      const gate: FacetGate = { container: undefined };
      const { ActorClass, exports } = await facetModule(request.className, gate);
      const storage = new SqliteWasmActorStorage(this.#requirePool(), prefixFor(request.id));
      const container = await createActorContainer({
        // Absent `routedId` means the child inherits its parent's id, which in this tree is the
        // root actor's name.
        id: request.routedId ?? requireBoot().actorName,
        uniqueKey: UNIQUE_KEY,
        exports,
        // The root's `env`, as the node lane does: on workerd a facet's env is the env of the
        // Worker its class came from, and nothing in the suite reads a facet's env at all.
        env: this.#env,
        ports: {
          sql: storage,
          alarms: FACET_HAS_NO_ALARM_SLOT,
          facets: this,
          timer,
        },
        // The root's tree, by reference. This is the line cross-worker placement could not
        // write — `getId` is synchronous — and it is what lets this facet have facets of its own.
        facet: { depth: request.depth, id: request.id, tree },
      });
      gate.container = container;
      let instance: object;
      try {
        instance = await container.start((ctx, env) => new ActorClass(ctx as never, env as never));
      } catch (exception) {
        // The container opened this facet's database and took an exclusive sync access handle on
        // its pool file; the instance does not exist, so nothing will ever reach this placement
        // through `#placements` to close it. Leaving it would accumulate a dead writer per failed
        // attempt inside a VFS that expects to own what it opens — see the backend storage's
        // `close()`, which is the same hazard for the same reason.
        container.abort(exception);
        storage.close();
        throw exception;
      }
      const placement: Placement = { container, storage, stub: container.entry(instance) };
      this.#placements.set(request.id, placement);
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

  /** Kills the instance; the storage survives, which is what the §1.10 abort row measures. */
  abort(id: FacetId, reason?: string): void {
    const placement = this.#placements.get(id);
    if (placement === undefined) return;
    this.#placements.delete(id);
    placement.container.abort(new Error(reason ?? "Facet placement closed."));
    // Where the node lane drops a connection the GC will collect, this drops an exclusive sync
    // access handle on a pool file — see `SqliteWasmActorStorage.close()`.
    placement.storage.close();
  }

  async deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void> {
    for (const target of [...subtree, id]) {
      // Read before the abort removes the placement. A facet that was never placed has no
      // placement and no files, and `unlink` on an empty prefix removes nothing — which is not
      // the same as declining to remove it.
      const storage = this.#storageFor(target);
      this.abort(target);
      storage.deleteAll();
    }
  }

  async copyStorage(src: FacetId, dst: FacetId): Promise<void> {
    await this.#storageFor(dst).copyFrom(this.#storageFor(src));
  }

  /** Every placement in this tree, for `respawn`. */
  closeAll(): void {
    for (const id of [...this.#placements.keys()]) this.abort(id);
  }

  #storageFor(id: FacetId): SqliteWasmActorStorage {
    return (
      this.#placements.get(id)?.storage ??
      new SqliteWasmActorStorage(this.#requirePool(), prefixFor(id))
    );
  }

  #requirePool(): SqliteWasmHost {
    if (this.#pool === undefined) throw new Error("Browser lane: no pool attached.");
    return this.#pool;
  }
}

/** One prefix per facet inside the tree's one pool, where the node lane has one directory. */
function prefixFor(id: FacetId): string {
  return `/facet-${id}`;
}

const facets = new BrowserFacetHost();

// =======================================================================================
// The facet class: one evaluation per placement

/** Filled in between evaluating the module and starting the instance. */
type FacetGate = { container: ActorContainer | undefined };

type FacetClass = {
  readonly ActorClass: new (ctx: unknown, env: unknown) => object;
  /**
   * ← the `ctx.exports` a dynamically-loaded Worker finds: its OWN module's
   * entrypoints. It is the only handle a loaded module has on itself, and
   * therefore the only way a facet can name a class for a facet of its own — a
   * facet gets no Worker Loader binding, and a `DurableObjectClass` cannot cross
   * an RPC boundary (`DurableObjectClass.serialize`). Measured on workerd, where
   * the depth-2 row runs on `ctx.exports.Child` inside the probe's dynamic
   * Worker.
   *
   * Every function-valued export becomes a `LoopbackDurableObjectClass`, upstream's
   * type for "you export a class extending `DurableObject` but you don't configure
   * storage for it" (`export-loopback.h:116-148`) — exactly a dynamic Worker's
   * situation, since dynamically-loaded isolates can't directly have storage
   * (§1.11). The non-function exports a real `ctx.exports` would carry as
   * `LoopbackServiceStub` are absent rather than approximated: no row reaches one,
   * and `requireFacetClass` names a missing key loudly.
   */
  readonly exports: Record<string, unknown>;
};

/**
 * ← `Server::WorkerLoaderNamespace::loadIsolate`'s evaluation step, as far as this
 * substrate can take it.
 *
 * Two rewrites, and both are this lane supplying a platform a browser module does
 * not have.
 *
 * `cloudflare:workers` is a module specifier no browser resolves, so it becomes a
 * read of a global this worker has already filled with the package's own
 * `cloudflare:workers` — exactly what the node lane does, by the same route.
 *
 * `scheduler` is bound in the module's own scope to THIS facet's container. On
 * workerd a dynamically-loaded Worker has a global scope of its own and its
 * `scheduler` is that isolate's io-context primitive; there is one realm here, so
 * a module-scoped binding is the closest exact answer — no ambient, no guess
 * about which of the tree's containers is running. Its limit is that it is
 * lexical: a facet source that read `globalThis.scheduler` explicitly would get
 * the root's, and nothing can detect that. The probe's `Child` writes
 * `scheduler.wait`, which is the form every Workers example uses.
 *
 * What is NOT reproduced is isolation: a blob module shares this realm, so
 * `globalOutbound` is not enforced. That is the substrate's half of decision 15
 * and no row asserts it.
 */
const CLOUDFLARE_WORKERS_GLOBAL = "__doRuntimeCloudflareWorkers";
const FACET_SCOPE_GLOBAL = "__doRuntimeFacetScopes";

const facetScopes: Record<string, ActorScopeBindings> = {};
(globalThis as Record<string, unknown>)[FACET_SCOPE_GLOBAL] = facetScopes;
let facetScopeCounter = 0;

/** The seven names `installActorScope` writes, in the order the prologue destructures them. */
const FACET_SCOPE_NAMES = [
  "scheduler",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "crypto",
] as const;

async function facetModule(className: string, gate: FacetGate): Promise<FacetClass> {
  const hash = className.lastIndexOf("#");
  if (hash < 0) throw new Error(`Browser lane cannot resolve facet class ${className}.`);
  const isolateName = className.slice(0, hash);
  const exportName = className.slice(hash + 1);

  const workers: unknown = await import("../../src/api/cloudflare-workers");
  (globalThis as Record<string, unknown>)[CLOUDFLARE_WORKERS_GLOBAL] = workers;

  const key = `s${facetScopeCounter++}`;
  facetScopes[key] = actorScopeBindings(() => {
    const container = gate.container;
    if (container === undefined) {
      throw new Error(
        "Browser lane: a facet reached a platform async primitive before its container existed " +
          "or after it was torn down, so the continuation could not resume gated.",
      );
    }
    return container.globals;
  });

  const rewritten =
    `const { ${FACET_SCOPE_NAMES.join(", ")} } = ` +
    `globalThis.${FACET_SCOPE_GLOBAL}[${JSON.stringify(key)}];\n` +
    (await isolates.mainModule(isolateName)).replace(
      /import\s+(\{[^}]*\})\s+from\s+["']cloudflare:workers["'];?/g,
      (_match, clause: string) =>
        `const ${clause.replace(/\bas\b/g, ":")} = globalThis.${CLOUDFLARE_WORKERS_GLOBAL};`,
    );
  if (rewritten.includes("cloudflare:workers")) {
    throw new Error("Worker Loader: an unrewritten cloudflare:workers import remains.");
  }

  // A blob URL rather than the node lane's base64 `data:` URL: both import here, and a blob needs
  // no answer to what base64 does with a non-Latin-1 source.
  const url = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
  let module: Record<string, unknown>;
  try {
    module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }

  const exported = module[exportName];
  if (typeof exported !== "function") {
    throw new Error(`Browser lane: ${exportName} is not a constructor in the loaded module.`);
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
// The bindings a root actor finds in `env`

/**
 * ← the `PROBE` namespace binding `wrangler.test.jsonc` declares for the oracle
 * lane.
 *
 * A plain object where this was an `RpcTarget` class, and the change is the whole
 * of what in-process facets did to `src/transport/`'s exposure here. §1.10's
 * re-entrancy row hands this value to a facet; while the facet was in another
 * worker that meant capnweb, which passes an `RpcTarget` by reference and refuses
 * anything else carrying functions, so the value had to be a declared `RpcTarget`
 * subclass and decision 18's identity graft had to have run for capnweb to
 * recognise it. A facet in this worker is an ordinary call, so the value is the
 * container's own `entry` proxy — which is also what the node lane hands over.
 */
function probeNamespace(): { idFromName(name: string): unknown; get(id: unknown): object } {
  return {
    idFromName: (target: string) => ({ toString: () => target }),
    get: (id: unknown) => {
      const name = String(id);
      // The same actor, which is what the re-entrancy row asks for: a local, gated call rather
      // than a round trip through the page that would prove nothing extra.
      if (name === requireBoot().actorName) return requireLive().entry;
      return remoteActorStub(name);
    },
  };
}

/** Any other actor in the namespace, routed through the page. Still cross-worker. */
function remoteActorStub(actorName: string): object {
  const supervisor = requirePeer();
  const stub: Record<string, unknown> = {};
  for (const method of methodNames(Probe.prototype)) {
    stub[method] = (...args: unknown[]) => supervisor.callActor(actorName, method, args);
  }
  return stub;
}

function methodNames(prototype: object): string[] {
  const names = new Set<string>();
  for (
    let current: object | null = prototype;
    current !== null && current !== Object.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (typeof descriptor?.value === "function") names.add(name);
    }
  }
  return [...names];
}

/**
 * ← `ActorSqliteHooks` (`server.c++:3199-3219`), one adapter per actor over the
 * namespace's one scheduler — which on this lane is in a worker of its own,
 * because it needs a database and a database needs a worker.
 *
 * Asynchronous where the node lane's is synchronous, and `ActorSqlite` is built
 * for that: `#requestScheduledAlarm` returns the promise unchanged and the
 * pre-commit path awaits it, so "durable before the returned promise resolves"
 * now covers a round trip rather than a function call. What is lost is the
 * synchronous throw, which no path in the suite reaches.
 */
function alarmOutlet(actorName: string): AlarmOutlet {
  return {
    scheduleRun: (scheduledTime: number | null): Promise<void> =>
      Promise.resolve(requirePeer().scheduleRun(actorName, scheduledTime)).then(() => undefined),
  };
}

/**
 * Never reached: a facet container installs `DEFAULT_ALARM_OUTLET` for itself and
 * `assertCanSetAlarm` refuses before anything can call it. Here for the reason
 * the node lane has the same line — a facet with a live outlet would look like a
 * facet with an alarm slot.
 */
const FACET_HAS_NO_ALARM_SLOT: AlarmOutlet = {
  scheduleRun: () => Promise.reject(new Error("facets have no alarm slot")),
};

// =======================================================================================
// The container lifecycle

/** The root's own databases, for the close a respawn owes the pool. */
let rootStorage: SqliteWasmActorStorage | undefined;

async function place(): Promise<Live> {
  const current = requireBoot();
  const lane = await lanePool();
  installRootScope();
  const storage = new SqliteWasmActorStorage(lane, "/actor");

  const env: Record<string, unknown> = { PROBE: probeNamespace() };

  const container = await createActorContainer({
    id: current.actorName,
    uniqueKey: UNIQUE_KEY,
    exports: {},
    env,
    ports: {
      sql: storage,
      alarms: alarmOutlet(current.actorName),
      facets,
      timer,
      fetch: async () => {
        await timer.afterDelay(60);
        return new Response("fetched");
      },
    },
  });

  // ← `WorkerdApi::compileGlobals`'s `Global::WorkerLoader` arm. Filled in after construction
  // because the binding needs the container's IoContext, exactly as upstream's binding
  // compilation runs after the Worker exists; `env` is the same object the container holds.
  env.LOADER = container.workerLoader(isolates, {
    compatDateValidation: "codeVersion",
    allowExperimentalFeatures: true,
  });

  facets.attach(lane, treeOf(container), env);

  const instance = await container.start(
    (ctx, workerEnv): object => new Probe(ctx as never, workerEnv as never),
  );
  const entry = container.entry(instance) as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  live = { container, entry };
  rootStorage = storage;
  return live;
}

/**
 * The root's `FacetTree`, which the host has to hand down to any facet that may
 * have facets of its own — the one thing a nested container cannot build for
 * itself, because ids are sequential across the whole tree.
 */
function treeOf(container: ActorContainer): FacetTree {
  return container.facetTree;
}

/**
 * Drop the containers, keep the files.
 *
 * The node lane's `respawn` does exactly this — it re-places over the same
 * directory — and closing the databases is what this substrate adds, because
 * there is one handle per file rather than one connection per container. See
 * `SqliteWasmActorStorage.close()`.
 */
function teardown(): void {
  facets.closeAll();
  live = undefined;
  placing = undefined;
  rootStorage?.close();
  rootStorage = undefined;
}

// =======================================================================================
// The RPC surface
//
// One RPC surface for the supervised root. Facet get, abort, and delete are
// in-process calls on BrowserFacetHost and never enter this transport.

class RootTarget extends RpcTarget implements ActorRpc {
  ready(): Promise<void> {
    return placed().then(() => undefined);
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    const target = (await placed()).entry[method];
    if (typeof target !== "function") throw new Error(`Probe has no method ${method}`);
    return await target(...args);
  }

  async respawn(): Promise<void> {
    teardown();
    await placed();
  }

  crash(): Promise<void> {
    teardown();
    return Promise.resolve();
  }

  async deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult> {
    return await (await placed()).container.deliverAlarm(scheduledTime, retryCount);
  }

  async abandonAlarm(scheduledTime: number): Promise<number | null> {
    return await (await placed()).container.abandonAlarm(scheduledTime);
  }
}

// =======================================================================================
// Boot

function requireBoot(): ActorBoot {
  if (boot === undefined) throw new Error("Browser lane: this actor worker has not been booted.");
  return boot;
}

function requireLive(): Live {
  if (live === undefined) throw new Error("Browser lane: this actor worker has no live container.");
  return live;
}

/**
 * ← the node lane's `placed()`, and upstream's `getActorContainer(id)`: an event
 * for an actor that is not running is a reason to place it, not an error. That is
 * what makes `crash()` mean "drop it" rather than "drop it forever", and it is
 * the same contract the alarm scheduler's `getActor` relies on.
 *
 * The in-flight promise is the whole of the concurrency control this worker
 * needs now: two calls arriving at an unplaced actor must not both place it, and
 * nothing else in here is a lifecycle operation that can overlap another.
 */
async function placed(): Promise<Live> {
  if (live !== undefined) return live;
  placing ??= place().finally(() => {
    placing = undefined;
  });
  return await placing;
}

function requirePeer(): Session<SupervisorRpc> {
  if (peer === undefined) throw new Error("Browser lane: this actor worker has no session.");
  return peer;
}

self.addEventListener("message", (event: MessageEvent<ActorBoot>) => {
  if (boot !== undefined) throw new Error("Browser lane: an actor worker was booted twice.");
  boot = event.data;
  peer = newRpcSession<SupervisorRpc>(boot.port, new RootTarget());
});
