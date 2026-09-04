/**
 * The actor worker: one module Worker, one root actor, one OPFS SAH pool, and
 * the namespace's one `AlarmScheduler`.
 *
 * This is the file the runtime's README calls "hosting an actor", written for a
 * Chrome extension. The offscreen document spawns it and is its only peer; the
 * popup and the service worker never reach it directly.
 *
 * **Why the whole actor is in here and not in the offscreen document.** OPFS
 * synchronous access handles — the only way to run SQLite synchronously in a
 * browser — exist only inside a dedicated worker. So a page can never hold an
 * actor's storage, and the offscreen document is a pure supervisor: it creates
 * this worker, holds the RPC session, and owns no storage at all. That is the
 * same division workerd's `Server` makes.
 *
 * **The order of the boot sequence below is load bearing.** Every step in
 * `installSubstrate` is placed where it is because putting it elsewhere was
 * measured to fail, and each one says how. Read it top to bottom before moving
 * anything.
 */

import {
  AlarmScheduler,
  DEFAULT_ALARM_OUTLET,
  LoopbackDurableObjectClass,
  actorScopeBindings,
  asLoopbackDurableObjectClass,
  createActorContainer,
  createDurableObjectNamespace,
  gateRequestBody,
  HibernationMirror,
  installActorScope,
  newRpcSession,
  type ActorContainer,
  type ActorEntry,
  type ActorGlobalScope,
  type ActorScopeBindings,
  type AlarmResult,
  type FacetHandle,
  type FacetHost,
  type FacetId,
  type FacetStartRequest,
  type FacetTree,
  type Timer,
} from "@mcp-b/do-runtime";
import {
  createSqliteWasmProvider,
  SqliteWasmActorStorage,
  type SqliteWasmHost,
} from "@mcp-b/do-runtime/backends/sqlite-wasm";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { getAgentByName, routeAgentEmail, routeAgentRequest } from "agents";
import { RpcTarget } from "cloudflare:workers";
import {
  installWebSocketUpgradeGlobals,
  upgradeWebSocket,
  withWebSocketUpgrade,
  type UpgradeWebSocket,
} from "@mcp-b/do-runtime/browser";
import { serveMessagePortWebSockets } from "@mcp-b/do-runtime/browser/message-port-websocket";
import type {
  CounterSnapshot,
  HostRpc,
  HostStatus,
  NestedSubAgentSnapshot,
  SubAgentSnapshot,
  SupervisorRpc,
  ThinkProbeStatus,
  ThinkProbeSubmission,
  WorkerBoot,
} from "../protocol";
import { Counter, type CounterEnv } from "./counter";

// =======================================================================================
// Raw platform timers, captured before anything else in this module can run
//
// `installActorScope` REPLACES `globalThis.setTimeout` with the container's
// gated one, and the container's gated one is built ON the `Timer` port below.
// So a `Timer` that read the installed global would arm a timeout in order to
// implement a timeout — `#arm` → `afterDelay` → `setTimeout` → `setTimeoutImpl`
// → `#arm` — which the runtime measured as `RangeError: Maximum call stack size
// exceeded` the first time its own primitives were pointed at themselves.
//
// The general rule, and it is the reason these two lines are the first
// statements in the file: everything BELOW the runtime in one realm has to reach
// the platform's timers, either by capturing them here or by running before the
// scope is installed. `installSubstrate` does the second for sqlite.

const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);

/**
 * The clock and the delay the runtime and the scheduler both run on, over the
 * raw timers above.
 *
 * Cancellation leaves the promise unsettled rather than rejecting it, which is
 * what the runtime's own timer does: the waiter is gone, so nothing is owed an
 * answer.
 */
const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = rawSetTimeout(resolve, Math.max(0, ms));
      signal?.addEventListener("abort", () => {
        rawClearTimeout(handle);
      });
    }),
};

// =======================================================================================
// Constants a host owes the runtime, and both of them are forever

/**
 * The namespace's unique key. **Changing this string silently orphans every
 * byte this extension has ever stored.**
 *
 * `ctx.id` is `idFromName(ACTOR_ID)` derived under this key, and the id is what
 * names the actor's storage. Nothing the runtime can observe distinguishes "a
 * new key" from "a new actor", so there is no check and no default — this
 * comment is the whole of the enforcement. Treat it the way you would treat a
 * database name in a shipped migration.
 */
const UNIQUE_KEY = "do-runtime-example-extension";

/** The one actor this example hosts, and the key the alarm scheduler knows it by. */
const ACTOR_ID = "counter";

/**
 * The OPFS SAH pool's name, which becomes an OPFS **directory** name.
 *
 * It may not contain a "/": `getDirectoryHandle` rejects one with "Name is not
 * allowed", several layers away from whatever chose the name. It is also stable
 * rather than per-session, because the pool is where the durable bytes live —
 * the conformance lane randomises its pool name per spec file precisely so that
 * runs cannot see each other's data, which is the opposite of what a shipped
 * extension wants.
 */
const POOL_NAME = "do-runtime-example-extension";

/** The actor's own databases inside the pool. Absolute, as SAH pool names are. */
const ACTOR_PREFIX = "/actor";

/**
 * The alarm scheduler's `_cf_ALARM` database — upstream's `metadata.sqlite`, one
 * per namespace beside the per-actor files. A separate prefix rather than a
 * table in the actor's database: the scheduler is the namespace's, and the
 * actor's database is reset wholesale by `deleteAll()`.
 */
const ALARM_PREFIX = "/alarms";
const ALARM_DATABASE = "scheduler";

/**
 * The pool's capacity, in files.
 *
 * The default of 6 is not enough. This root opens **two** databases — its own
 * storage and the facet tree index the runtime keeps beside it — the scheduler
 * opens a third, and SQLite puts a rollback journal beside each of those as a
 * further file. That is six before anything unusual happens. Each sub-agent
 * opens another database and journal, so size the pool for a useful actor tree
 * rather than the root alone.
 *
 * Running out is nameable but not obvious: the pool logs `SAH pool is full.
 * Cannot create file …` on the console and the caller gets
 * `SQLITE_CANTOPEN: sqlite3 result code 14`. This line is the knob.
 */
const POOL_CAPACITY = 64;
const EVICTION_POLL_MS = 10;
const EVICTION_TIMEOUT_MS = 5_000;

// =======================================================================================
// Facet placement: bundled Agent classes, one database and gate set per child

type FacetConstructor = new (ctx: DurableObjectState, env: CounterEnv) => object;
type FacetModule = {
  readonly gate: { container: ActorContainer | undefined };
  readonly loaded: Promise<Record<string, unknown>>;
};

function isFacetConstructor(value: unknown): value is FacetConstructor {
  return typeof value === "function" && value.prototype !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadFacetModule(url: URL): Promise<Record<string, unknown>> {
  const module: unknown = await import(/* @vite-ignore */ url.href);
  if (!isRecord(module)) {
    throw new TypeError(`do-runtime example: ${url.pathname} did not export a module record`);
  }
  return module;
}

const FACET_SCOPES_GLOBAL = "__doRuntimeExtensionFacetScopes";
const COUNTER_CHILD_MODULE_URL = "../counter-child.js";
const THINK_PROBE_MODULE_URL = "../think-probe.js";
const facetScopes: Record<string, ActorScopeBindings> = {};
Object.defineProperty(globalThis, FACET_SCOPES_GLOBAL, { value: facetScopes });

type FacetPlacement = {
  readonly container: ActorContainer;
  readonly storage: SqliteWasmActorStorage;
  readonly stub: object;
};

/**
 * The extension equivalent of workerd's in-process facet placement. Classes
 * are bundled and trusted, so MV3 needs neither eval nor a Worker Loader: the
 * `DurableObjectClass` token names an export in that module.
 */
class ExtensionFacetHost implements FacetHost {
  readonly #placements = new Map<FacetId, FacetPlacement>();
  readonly #modules = new Map<FacetId, FacetModule>();
  #host: SqliteWasmHost | undefined;
  #tree: FacetTree | undefined;
  #exports: Record<string, unknown> | undefined;

  attach(
    host: SqliteWasmHost,
    tree: FacetTree,
    workerExports: Record<string, unknown>,
  ): void {
    this.#host = host;
    this.#tree = tree;
    this.#exports = workerExports;
  }

  start(request: FacetStartRequest): FacetHandle {
    const existing = this.#placements.get(request.id);
    if (existing !== undefined) {
      return { stub: Promise.resolve(existing.stub), broken: existing.container.onBroken };
    }

    const tree = this.#tree;
    const workerExports = this.#exports;
    if (tree === undefined || workerExports === undefined) {
      throw new Error("do-runtime example: facet host was reached before the root was attached");
    }

    const started = (async (): Promise<FacetPlacement> => {
      const facetModule = this.#moduleFor(request.id, request.className);
      const exported = (await facetModule.loaded)[request.className];
      if (!isFacetConstructor(exported)) {
        throw new Error(`do-runtime example: no bundled facet class named ${request.className}`);
      }
      const storage = new SqliteWasmActorStorage(this.#requireHost(), `/facet-${request.id}`);
      const env: CounterEnv = { Counter: counterNamespace(facetModule.gate) };
      const exports = { ...workerExports, Counter: env.Counter };
      const container = await createActorContainer({
        id: request.routedId ?? ACTOR_ID,
        uniqueKey: UNIQUE_KEY,
        exports,
        env,
        ports: {
          sql: storage,
          alarms: DEFAULT_ALARM_OUTLET,
          facets: this,
          timer,
        },
        facet: { depth: request.depth, id: request.id, tree },
      });
      facetModule.gate.container = container;
      let instance: object;
      try {
        instance = await container.start((ctx) => new exported(ctx, env));
      } catch (error) {
        facetModule.gate.container = undefined;
        container.abort(error);
        storage.close();
        throw error;
      }
      const placement = { container, storage, stub: container.entry(instance) };
      this.#placements.set(request.id, placement);
      return placement;
    })();

    const { promise: broken, reject } = Promise.withResolvers<never>();
    void broken.catch(() => {});
    void started.then(
      ({ container }) => {
        void container.onBroken.catch(reject);
      },
      () => {},
    );
    return { stub: started.then(({ stub }) => stub), broken };
  }

  abort(id: FacetId, reason?: string): void {
    const placement = this.#placements.get(id);
    if (placement === undefined) return;
    this.#placements.delete(id);
    const module = this.#modules.get(id);
    if (module !== undefined) module.gate.container = undefined;
    placement.container.abort(new Error(reason ?? "Facet placement closed."));
    placement.storage.close();
  }

  async deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void> {
    for (const target of [...subtree, id]) {
      const storage = this.#storageFor(target);
      this.abort(target);
      storage.deleteAll();
    }
  }

  async copyStorage(src: FacetId, dst: FacetId): Promise<void> {
    await this.#storageFor(dst).copyFrom(this.#storageFor(src));
  }

  #storageFor(id: FacetId): SqliteWasmActorStorage {
    return (
      this.#placements.get(id)?.storage ??
      new SqliteWasmActorStorage(this.#requireHost(), `/facet-${id}`)
    );
  }

  #moduleFor(id: FacetId, className: string): FacetModule {
    const existing = this.#modules.get(id);
    if (existing !== undefined) return existing;

    const gate: FacetModule["gate"] = { container: undefined };
    const key = `facet-${id}`;
    facetScopes[key] = actorScopeBindings(() => {
      if (gate.container === undefined) {
        throw new Error(
          `do-runtime example: ${key} reached an async primitive outside its live placement`,
        );
      }
      return gate.container.globals;
    });
    const url = new URL(
      className === "ThinkProbe" ? THINK_PROBE_MODULE_URL : COUNTER_CHILD_MODULE_URL,
      globalThis.location.href,
    );
    url.searchParams.set("scope", key);
    const module = {
      gate,
      loaded: loadFacetModule(url),
    };
    this.#modules.set(id, module);
    return module;
  }

  #requireHost(): SqliteWasmHost {
    if (this.#host === undefined) throw new Error("do-runtime example: facet host has no pool");
    return this.#host;
  }
}

const facets = new ExtensionFacetHost();
// Worker-owned, not placement-owned: accepted raw sockets survive a root replacement.
const hibernation = new HibernationMirror();

// =======================================================================================
// The container this worker hosts

type Live = {
  readonly container: ActorContainer;
  /**
   * `container.entry(instance)` — the door. Every method call through it is one
   * gated event, so this is the only handle anything outside the actor gets.
   */
  readonly entry: ActorEntry<Counter>;
  readonly storage: SqliteWasmActorStorage;
};

let live: Live | undefined;
/** In flight, so two calls arriving at an unplaced actor do not both place it. */
let placing: Promise<Live> | undefined;
/** The last `onBroken` rejection, surfaced through `status()`. */
let brokenReason: string | null = null;

function counterNamespace(gate?: FacetModule["gate"]) {
  return createDurableObjectNamespace<Counter>(UNIQUE_KEY, {
    getGlobalActor: ({ id }) => {
      const name = id.getName();
      if (name !== ACTOR_ID) {
        throw new Error(
          `do-runtime example: this worker does not host the actor named ${String(name)}`,
        );
      }
      if (live === undefined) {
        throw new Error("do-runtime example: root loopback reached before placement");
      }
      const target = live.entry as unknown as Fetcher;
      const caller = gate?.container;
      if (caller === undefined) return target;
      return new Proxy(target, {
        get(subject, property): unknown {
          const value: unknown = Reflect.get(subject, property, subject);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) =>
            caller.awaitIo(
              caller.waitOutputLocks().then(() =>
                Reflect.apply(value as (...values: unknown[]) => unknown, subject, args),
              ),
            );
        },
      });
    },
  });
}

const rootNamespace = counterNamespace();

installWebSocketUpgradeGlobals();

/**
 * What the installed globals resolve to, and it REFUSES rather than falling
 * through to the raw timers above.
 *
 * One worker hosts one root here, so "no container" cannot mean "called from
 * outside any actor" — it can only mean the container was torn down while its
 * code was still running. Handing that continuation a raw timer would resume it
 * ungated, and the failure would surface three layers later as `no input lock
 * available in this context`. Refusing here is also what upstream's
 * `IoContext::current()` does outside a request.
 */
function rootScope(): ActorGlobalScope {
  if (live === undefined) {
    throw new Error(
      "do-runtime example: an actor async primitive was reached with no live container, so its " +
        "continuation could not resume gated. This worker hosts one root, so it means the " +
        "container was torn down while its code was still running.",
    );
  }
  return live.container.globals;
}

// =======================================================================================
// The substrate: storage and the alarm scheduler, installed once per worker

type Substrate = {
  /** The installed pool shared by the root and every facet in its tree. */
  readonly host: SqliteWasmHost;
  /** The namespace's one scheduler. It owns `_cf_ALARM`, the retry ladder, and delivery. */
  readonly scheduler: AlarmScheduler;
};

let substrate: Promise<Substrate> | undefined;

function installedSubstrate(): Promise<Substrate> {
  substrate ??= installSubstrate();
  return substrate;
}

async function installSubstrate(): Promise<Substrate> {
  // ---------------------------------------------------------------------------------
  // 1. Turn off the OPFS VFSes this host does not use, BEFORE the driver boots.
  //
  // `sqlite3ApiBootstrap` reads `globalThis.sqlite3ApiConfig` once, when
  // `sqlite3InitModule()` is called. The plain OPFS VFS and `opfs-wl` each need
  // a proxy worker and `Atomics.waitAsync`; this host uses neither, and the SAH
  // pool — which is what `installOpfsSAHPoolVfs` installs and must stay enabled
  // — does not need cross-origin isolation at all.
  //
  // `defineProperty` rather than assignment because the name is not declared
  // anywhere in TypeScript's view of the worker global.
  Object.defineProperty(globalThis, "sqlite3ApiConfig", {
    configurable: true,
    value: { disable: { vfs: { opfs: true, "opfs-wl": true } } },
  });

  // ---------------------------------------------------------------------------------
  // 2. Boot sqlite and install the pool — BEFORE `installActorScope`.
  //
  // `installOpfsSAHPoolVfs` probes the other OPFS VFSes on its way in, and those
  // probes arm watchdogs through the GLOBAL `setTimeout`. sqlite-wasm is a
  // third-party module in this realm and cannot be made to capture a raw timer
  // the way this file does at the top, so installing the actor scope first hands
  // the actor's gate to a storage library. Measured on the runtime's own browser
  // lane, that produced `Ignoring inability to install the … sqlite3_vfs`
  // warnings carrying the actor scope's refusal text.
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: POOL_NAME,
    // NOT the conformance lane's `true`. That lane wipes the pool so a stale
    // browser profile cannot make a run pass or fail; an extension wiping its
    // pool at every worker start is an extension with no storage.
    clearOnInit: false,
    initialCapacity: POOL_CAPACITY,
  });
  const host: SqliteWasmHost = { pool, capi: sqlite3.capi };

  // ---------------------------------------------------------------------------------
  // 3. Now install the actor scope: gated `setTimeout`, `clearTimeout`,
  //    `setInterval`, `clearInterval`, `fetch`, `crypto`, and `scheduler` onto
  //    this worker's globals.
  //
  // Install the whole set through the runtime rather than assigning names by
  // hand: a host that gates five of six leaves one ungated primitive, and an
  // ungated primitive that WORKS is invisible until some continuation after it
  // touches storage. Note it ASSIGNS — Chrome ships its own `scheduler` global
  // in workers (`postTask`/`yield`, no `wait`), so a `??=` here would silently
  // keep Chrome's.
  installActorScope(globalThis, rootScope);

  // ---------------------------------------------------------------------------------
  // 4. The namespace's alarm scheduler, over a database of its own.
  //
  // This is the runtime's own class, not something this host reimplements: it
  // owns `_cf_ALARM`, delivery, the retry counts, exponential backoff with
  // jitter, and abandonment. This host supplies three things — the database, the
  // timer, and a `getActor` that resolves an actor id to something with
  // `deliverAlarm`/`abandonAlarm`.
  //
  // `getActor` goes through `placed()`, which PLACES the container if it is not
  // running. That is upstream's `getActorContainer(id)` contract and it is the
  // whole point of an alarm: a wake is a reason to start a Durable Object, not
  // something that requires one to be started already.
  const scheduler = new AlarmScheduler({
    timer,
    db: await createSqliteWasmProvider(host, { prefix: ALARM_PREFIX }).open(ALARM_DATABASE),
    getActor: () => ({
      deliverAlarm: async (scheduledTime: number, retryCount: number): Promise<AlarmResult> =>
        await (await placed()).container.deliverAlarm(scheduledTime, retryCount),
      abandonAlarm: async (scheduledTime: number): Promise<number | null> =>
        await (await placed()).container.abandonAlarm(scheduledTime),
    }),
    projectWake: async (scheduledTime) => {
      if (peer === undefined) throw new Error("cannot project an alarm before the supervisor connects");
      await peer.projectWake(scheduledTime);
    },
  });

  return { host, scheduler };
}

// =======================================================================================
// Placement

async function place(): Promise<Live> {
  const { host, scheduler } = await installedSubstrate();
  const storage = new SqliteWasmActorStorage(host, ACTOR_PREFIX);
  const rootGate: FacetModule["gate"] = { container: undefined };
  const actorNamespace = counterNamespace(rootGate);

  const facetClass = (className: string): unknown =>
    asLoopbackDurableObjectClass(
      new LoopbackDurableObjectClass({
        getActorClass: () => ({
          className,
          requireAllowsTransfer: () => {},
        }),
      }),
    );
  const workerExports: Record<string, unknown> = {
    Counter: actorNamespace,
    CounterChild: facetClass("CounterChild"),
    CounterLeaf: facetClass("CounterLeaf"),
    ThinkProbe: facetClass("ThinkProbe"),
  };
  const env: CounterEnv = { Counter: actorNamespace };

  const container = await createActorContainer({
    id: ACTOR_ID,
    uniqueKey: UNIQUE_KEY,
    // A configured root namespace plus an unconfigured exported child class:
    // the same two `ctx.exports` shapes workerd gives the Agents SDK.
    exports: workerExports,
    env,
    ports: {
      sql: storage,
      // ← `ActorSqliteHooks`: one three-line adapter per actor over the
      // namespace's one scheduler, which is how an actor's storage engine
      // reaches it. The host composes the two rather than writing a ladder.
      alarms: scheduler.hooks(ACTOR_ID),
      facets,
      timer,
      hibernation,
      // `ports.fetch` is deliberately omitted, which is upstream's
      // `globalOutbound: null` posture: `fetch` inside the actor refuses BY NAME
      // rather than reaching an ungated one that would appear to work.
    },
    webSockets: hibernation.snapshot(),
  });
  rootGate.container = container;

  facets.attach(host, container.facetTree, workerExports);

  // **Consume `onBroken` at the moment the container exists.** It rejects when a
  // gate breaks, and a host that ignores it gets an actor that answers nothing
  // and logs nothing — a hung-looking agent with no report anywhere. Dropping
  // `live` here is the rest of the contract: the next call re-places a fresh
  // container over the same files, which is how a broken actor recovers.
  let brokeWhileStarting = false;
  void container.onBroken.catch((reason: unknown) => {
    brokeWhileStarting = true;
    brokenReason = String(reason);
    console.error("[do-runtime example] the actor container broke:", reason);
    if (live?.container === container) live = undefined;
    storage.close();
  });

  let instance: Counter;
  try {
    instance = await container.start((ctx) => new Counter(ctx, env));
    // A break during boot has already run the handler above, and `live` was not
    // this container yet — so nothing dropped it. Refuse to publish a container
    // that is already broken rather than handing callers one that answers nothing.
    if (brokeWhileStarting) {
      throw new Error(`The actor broke while starting: ${brokenReason ?? "unknown"}`);
    }
  } catch (error) {
    storage.close();
    throw error;
  }
  live = { container, entry: container.entry(instance), storage };
  return live;
}

/**
 * The container, placing it if it is not running.
 *
 * The in-flight promise is the whole of the concurrency control this worker
 * needs: two calls arriving at an unplaced actor must not both place it, because
 * two containers over one pool prefix would be two writers on files a VFS
 * expects to own alone.
 */
async function placed(): Promise<Live> {
  if (live !== undefined) return live;
  placing ??= place().finally(() => {
    placing = undefined;
  });
  return await placing;
}

/** Poll on the raw host timer; an actor-scoped delay would itself keep the actor busy. */
async function waitUntilEvictable(container: ActorContainer): Promise<void> {
  const deadline = Date.now() + EVICTION_TIMEOUT_MS;
  for (;;) {
    const state = container.quiescence();
    if (state.outputGateBroken) {
      throw new Error(`The actor output gate is broken: ${JSON.stringify(state)}`);
    }
    if (
      state.armedTimers === 0 &&
      state.pendingWaitUntil === 0 &&
      !state.inputLockHeld
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`The actor did not become idle: ${JSON.stringify(state)}`);
    }
    await timer.afterDelay(EVICTION_POLL_MS);
  }
}

// =======================================================================================
// The RPC surface
//
// Prototype methods on an `RpcTarget` subclass, because capnweb dispatches by
// looking the method up on the target and refuses an OWN property with
// "instance properties cannot be accessed over RPC". An arrow-function field
// here would fail at the first call, not at build time.

/**
 * **The one trap this example does not have to spring, stated so you know where
 * it lives.**
 *
 * Nothing in `Counter` awaits a promise the runtime does not own, so no call
 * below needs wrapping. The moment an actor awaits something host-provided — a
 * `chrome.storage` read forwarded from the supervisor, an RPC to another actor,
 * anything that resolves on a raw platform callback — that promise must go
 * through `container.awaitIo(hostPromise)` exactly once, at the point the actor
 * awaits it.
 *
 * Without it the continuation resumes with an empty invocation stack and the
 * next `ctx.storage` call throws `no input lock available in this context`. The
 * gated `setTimeout`, `fetch`, `crypto` and `scheduler` that `installActorScope`
 * put on this worker's globals are already wrapped; a promise from anywhere else
 * is not.
 */
class HostTarget extends RpcTarget implements HostRpc {
  async directStubIncrement(): Promise<number> {
    await placed();
    const stub = await getAgentByName<CounterEnv, Counter>(rootNamespace, ACTOR_ID);
    return await stub.increment();
  }

  async email(subject: string, body: string): Promise<void> {
    await placed();
    const bytes = new TextEncoder().encode(
      `From: sender@example.com\r\nTo: counter@example.com\r\nSubject: ${subject}\r\n\r\n${body}`,
    );
    const message: ForwardableEmailMessage = {
      from: "sender@example.com",
      to: "counter@example.com",
      headers: new Headers({ Subject: subject }),
      rawSize: bytes.byteLength,
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      setReject: () => {},
      forward: async () => {
        throw new Error("Outbound email is not available in this browser host");
      },
      reply: async () => {
        throw new Error("Outbound email is not available in this browser host");
      },
    };
    await routeAgentEmail(message, { Counter: rootNamespace }, {
      resolver: async () => ({ agentName: "Counter", agentId: ACTOR_ID }),
    });
  }

  async evict(): Promise<void> {
    const current = await placed();
    await waitUntilEvictable(current.container);
    live = undefined;
    current.storage.close();
    await placed();
  }

  async increment(): Promise<number> {
    return await (await placed()).entry.increment();
  }

  async enqueueIncrement(amount: number): Promise<string> {
    return await (await placed()).entry.enqueueIncrement(amount);
  }

  async mcp(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { container, entry } = await placed();
    const response = await entry.fetch(
      gateRequestBody(
        container,
        new Request("http://actor.invalid/mcp", {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      ),
    );
    const body = await response.text();
    const data = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : body;
    const result: unknown = JSON.parse(data ?? "null");
    if (!response.ok) throw new Error(`MCP request failed with ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }

  async snapshot(): Promise<CounterSnapshot> {
    return await (await placed()).entry.snapshot();
  }

  async subAgents(): Promise<readonly SubAgentSnapshot[]> {
    return await (await placed()).entry.subAgents();
  }

  async overlapSubAgents(): Promise<readonly SubAgentSnapshot[]> {
    return await (await placed()).entry.overlapSubAgents();
  }

  async subAgentLifecycle(): Promise<readonly number[]> {
    return await (await placed()).entry.subAgentLifecycle();
  }

  async nestedSubAgent(): Promise<NestedSubAgentSnapshot> {
    return await (await placed()).entry.nestedSubAgent();
  }

  async armSubAgentWake(delayMs: number): Promise<number> {
    return await (await placed()).entry.armSubAgentWake(delayMs);
  }

  async scheduledSubAgentValue(): Promise<number> {
    return await (await placed()).entry.scheduledSubAgentValue();
  }

  async startThink(name: string, text: string): Promise<void> {
    await (await placed()).entry.startThink(name, text);
  }

  async submitThink(
    name: string,
    text: string,
    idempotencyKey: string,
  ): Promise<ThinkProbeSubmission> {
    return await (await placed()).entry.submitThink(name, text, idempotencyKey);
  }

  async thinkStatus(name: string): Promise<ThinkProbeStatus> {
    return await (await placed()).entry.thinkStatus(name);
  }

  async stopThink(name: string): Promise<void> {
    await (await placed()).entry.stopThink(name);
  }

  async armWake(delayMs: number): Promise<number> {
    return await (await placed()).entry.armWake(delayMs);
  }

  /**
   * Host state rather than actor state, so it deliberately does NOT place the
   * container: asking whether the actor is running must not be the thing that
   * starts it.
   */
  async status(): Promise<HostStatus> {
    const { scheduler } = await installedSubstrate();
    const failure = scheduler.taskFailure();
    return {
      actorId: ACTOR_ID,
      placed: live !== undefined,
      broken: brokenReason,
      alarmTaskFailure: failure === undefined ? null : String(failure),
      nextAlarm: scheduler.getAlarm(ACTOR_ID),
    };
  }
}

// =======================================================================================
// Boot
//
// One raw `postMessage` carrying a `MessagePort` in the transfer list, because a
// port is not a value capnweb can serialise. Everything after this message is
// capnweb over that port.

/** Held so the session is not collected while the worker lives. */
let peer: ReturnType<typeof newRpcSession<SupervisorRpc>> | undefined;

async function connectAgentSocket(url: string): Promise<UpgradeWebSocket> {
  await placed();
  const request = withWebSocketUpgrade(new Request(url.replace(/^ws/, "http")));
  const response = await routeAgentRequest(
    request,
    { Counter: rootNamespace },
    { onBeforeConnect: withWebSocketUpgrade },
  );
  if (response == null) throw new Error(`No Agent route matched ${request.url}`);
  const socket = upgradeWebSocket(response);
  if (response.status !== 101 || socket === undefined) {
    throw new Error(`Agent WebSocket upgrade failed with ${response.status}`);
  }
  return socket;
}

function isWorkerBoot(value: unknown): value is WorkerBoot {
  return (
    typeof value === "object" &&
    value !== null &&
    "port" in value &&
    value.port instanceof MessagePort &&
    "sockets" in value &&
    value.sockets instanceof MessagePort
  );
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (peer !== undefined) {
    throw new Error("do-runtime example: this actor worker was booted twice.");
  }
  if (!isWorkerBoot(event.data)) throw new TypeError("invalid actor worker boot message");
  // `newRpcSession` from the package, never capnweb's `newMessagePortRpcSession`
  // directly: it applies the `RpcTarget` prototype graft that makes the class
  // above recognisable to capnweb, immediately before opening the session.
  peer = newRpcSession<SupervisorRpc>(event.data.port, new HostTarget());
  serveMessagePortWebSockets(event.data.sockets, connectAgentSocket);
});
