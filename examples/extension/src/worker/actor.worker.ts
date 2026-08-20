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
  createActorContainer,
  installActorScope,
  newRpcSession,
  noFacets,
  type ActorContainer,
  type ActorGlobalScope,
  type AlarmResult,
  type SqlDatabaseProvider,
  type Timer,
} from "@mcp-b/do-runtime";
import { createSqliteWasmProvider, type SqliteWasmHost } from "@mcp-b/do-runtime/backends/sqlite-wasm";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { RpcTarget } from "cloudflare:workers";
import {
  installMemoryWebSocketPair,
  upgradeWebSocket,
  type UpgradeWebSocket,
} from "../../../platform-shims/memory-websocket-pair";
import { serveMessagePortWebSockets } from "../../../platform-shims/message-port-websocket";
import type { CounterSnapshot, HostRpc, HostStatus, WorkerBoot } from "../protocol";
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
 * further file. That is six before anything unusual happens. Twelve leaves
 * headroom for the journals and for a second actor later.
 *
 * Running out is nameable but not obvious: the pool logs `SAH pool is full.
 * Cannot create file …` on the console and the caller gets
 * `SQLITE_CANTOPEN: sqlite3 result code 14`. This line is the knob.
 */
const POOL_CAPACITY = 12;

// =======================================================================================
// The container this worker hosts

type Live = {
  readonly container: ActorContainer;
  /**
   * `container.entry(instance)` — the door. Every method call through it is one
   * gated event, so this is the only handle anything outside the actor gets.
   */
  readonly entry: Counter;
};

let live: Live | undefined;
/** In flight, so two calls arriving at an unplaced actor do not both place it. */
let placing: Promise<Live> | undefined;
/** The last `onBroken` rejection, surfaced through `status()`. */
let brokenReason: string | null = null;

installMemoryWebSocketPair(() => {
  if (live === undefined) throw new Error("WebSocket upgrade reached an unplaced actor");
  return live.container;
});

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
  /** The provider the root container's storage is opened from. */
  readonly sql: SqlDatabaseProvider;
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
  });

  return { sql: createSqliteWasmProvider(host, { prefix: ACTOR_PREFIX }), scheduler };
}

// =======================================================================================
// Placement

async function place(): Promise<Live> {
  const { sql, scheduler } = await installedSubstrate();

  const container = await createActorContainer({
    id: ACTOR_ID,
    uniqueKey: UNIQUE_KEY,
    // The `ctx.exports` registry. One entry, so a future facet or a loopback
    // stub can name this class; nothing in this example reads it.
    exports: { Counter },
    // No bindings. A real extension puts its `DurableObjectNamespace` loopback,
    // its Worker Loader, and its configuration here.
    env: {},
    ports: {
      sql,
      // ← `ActorSqliteHooks`: one three-line adapter per actor over the
      // namespace's one scheduler, which is how an actor's storage engine
      // reaches it. The host composes the two rather than writing a ladder.
      alarms: scheduler.hooks(ACTOR_ID),
      facets: noFacets,
      timer,
      // `ports.fetch` is deliberately omitted, which is upstream's
      // `globalOutbound: null` posture: `fetch` inside the actor refuses BY NAME
      // rather than reaching an ungated one that would appear to work.
    },
  });

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
  });

  const instance = await container.start((ctx, env) => new Counter(ctx, env as CounterEnv));
  // A break during boot has already run the handler above, and `live` was not
  // this container yet — so nothing dropped it. Refuse to publish a container
  // that is already broken rather than handing callers one that answers nothing.
  if (brokeWhileStarting) {
    throw new Error(`The actor broke while starting: ${brokenReason ?? "unknown"}`);
  }
  live = { container, entry: container.entry(instance) };
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
  async increment(): Promise<number> {
    return await (await placed()).entry.increment();
  }

  async enqueueIncrement(amount: number): Promise<string> {
    return await (await placed()).entry.enqueueIncrement(amount);
  }

  async snapshot(): Promise<CounterSnapshot> {
    return await (await placed()).entry.snapshot();
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
let peer: unknown;

async function connectAgentSocket(url: string): Promise<UpgradeWebSocket> {
  const { entry } = await placed();
  const request = new Request(url.replace(/^ws/, "http"), {
    headers: { Upgrade: "websocket" },
  });
  const nativeGet = request.headers.get.bind(request.headers);
  Object.defineProperty(request.headers, "get", {
    value: (name: string): string | null =>
      name.toLowerCase() === "upgrade" ? "websocket" : nativeGet(name),
  });
  const response = await entry.fetch(request);
  const socket = upgradeWebSocket(response);
  if (response.status !== 101 || socket === undefined) {
    throw new Error(`Agent WebSocket upgrade failed with ${response.status}`);
  }
  return socket;
}

self.addEventListener("message", (event: MessageEvent<WorkerBoot>) => {
  if (peer !== undefined) {
    throw new Error("do-runtime example: this actor worker was booted twice.");
  }
  // `newRpcSession` from the package, never capnweb's `newMessagePortRpcSession`
  // directly: it applies the `RpcTarget` prototype graft that makes the class
  // above recognisable to capnweb, immediately before opening the session.
  peer = newRpcSession(event.data.port, new HostTarget());
  serveMessagePortWebSockets(event.data.sockets, connectAgentSocket);
});
