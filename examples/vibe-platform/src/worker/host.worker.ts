/**
 * The host: everything the actor needs that is not the actor.
 *
 * On Cloudflare this file does not exist — workerd is the host. In a browser
 * something has to be, and this is the smallest honest version of it: one Web
 * Worker, one OPFS SAH pool, one root actor, and a Cap'n Web session back to the
 * page.
 *
 * The ORDER of the boot below is the part that is easy to get wrong and hard to
 * debug, so each step says what breaks without it.
 *
 *   1. capture the platform's timers            (or the runtime's timer recurses)
 *   2. disable the two async-proxy OPFS VFSes   (or a proxy worker starts, with timers)
 *   3. init sqlite, install the SAH pool        (before 4: the installer uses globals)
 *   4. install the actor scope                  (only now: it takes those globals)
 *   5. create the container, start the class
 *
 * Steps 2–4 are all the same rule seen three times: **everything below the
 * runtime in this realm must reach the platform's own primitives**, either by
 * capturing them first or by running before the actor scope is installed.
 */

// ---------------------------------------------------------------------------
// 1. The platform's timers, captured before anything can replace them.
//
// `installActorScope` (step 4) overwrites `globalThis.setTimeout` with the
// actor's gated one, and the actor's gated one is built ON the `Timer` port
// below. A `Timer` that reached the installed global would arm a timeout in
// order to implement a timeout: measured, in the runtime's own conformance
// lane, as `RangeError: Maximum call stack size exceeded`
// (`conformance/browser/substrate.ts:220`). Module scope is early enough
// because nothing installs a scope at import time — but it must stay at module
// scope, not inside `place()`, which runs after step 4 on a respawn.

const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  createActorContainer,
  DEFAULT_ALARM_OUTLET,
  gateRequestBody,
  installActorScope,
  newRpcSession,
  noFacets,
  type ActorContainer,
  type Timer,
} from "@mcp-b/do-runtime";
import {
  createSqliteWasmProvider,
  type SqliteWasmHost,
} from "@mcp-b/do-runtime/backends/sqlite-wasm";
import { RpcTarget } from "@mcp-b/do-runtime/cloudflare-workers";
import {
  WORKSPACE_LOCKED_MESSAGE,
  type PageRpc,
  type WireRequest,
  type WireResponse,
  type WorkspaceBoot,
  type WorkspaceRpc,
} from "../wire";
import { Workspace, type WorkspaceEnv } from "./workspace";
import type { RetryablePoolOptions } from "./sqlite-storage";

// ---------------------------------------------------------------------------
// Names that must never change

/** The `DurableObjectId` name. One workspace, so one actor. */
const ACTOR_ID = "workspace";

/**
 * The namespace key every id is derived from (`idFromName` under
 * `SHA256(uniqueKey)`), and the id names the actor's storage.
 *
 * **Changing this string orphans every byte already stored.** It is not a
 * version number and there is no migration path: a new key is indistinguishable
 * from a new actor, so the old files simply stop being reachable.
 */
const UNIQUE_KEY = "do-runtime-example-vibe-platform";

/**
 * The SAH pool's name, which the driver also uses as its OPFS directory
 * (`directory` defaults to `"." + name`). It must survive reloads for the same
 * reason `UNIQUE_KEY` must, and it may not contain a path separator —
 * `getDirectoryHandle` rejects one with "Name is not allowed", a long way from
 * the line that chose the name.
 */
const POOL_NAME = "do-runtime-vibe-platform";

/** The prefix every database of this actor takes inside the pool. */
const STORAGE_PREFIX = "/workspace";

// ---------------------------------------------------------------------------
// The ports: what this host supplies the runtime

/** Wall clock, on the timers captured above. */
const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = rawSetTimeout(resolve, Math.max(0, ms));
      // Cancellation leaves the promise unsettled: the waiter is gone.
      signal?.addEventListener("abort", () => {
        rawClearTimeout(handle);
      });
    }),
};

// ---------------------------------------------------------------------------
// 2 + 3. sqlite and the pool, before any actor scope exists

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => rawSetTimeout(resolve, ms));

/**
 * The driver's option bag, plus the one option it implements and does not
 * declare. Without `forceReinitIfPreviouslyFailed` the driver caches the
 * REJECTED promise under this pool name (`installOpfsSAHPoolVfs`, in
 * `dist/index.mjs`), so every retry below would return the first failure
 * forever.
 */
/** How long to keep trying for the pool before telling the user it is locked. */
const POOL_ATTEMPTS = 20;
const POOL_RETRY_MS = 150;

async function installPool(): Promise<SqliteWasmHost> {
  // The driver reads this once at bootstrap and then `delete`s it, which is why
  // the property has to be configurable — a plain non-configurable definition
  // makes that delete throw in strict mode.
  //
  // What it turns off is the "opfs" and "opfs-wl" VFSes, which are the
  // asynchronous ones: each spawns a proxy worker and arms a watchdog through
  // the GLOBAL `setTimeout`. Nothing here can use them — the SAH pool is the
  // synchronous VFS and synchronous is the whole requirement — and a storage
  // library holding a timer the actor's scope is about to own is exactly the
  // hazard this boot order exists to prevent.
  //
  // Measured: without these two flags the worker fetches and starts
  // `sqlite3-opfs-async-proxy.js`; with them it does not.
  Object.defineProperty(globalThis, "sqlite3ApiConfig", {
    configurable: true,
    value: { disable: { vfs: { opfs: true, "opfs-wl": true } } },
  });

  const sqlite3 = await sqlite3InitModule();

  const options: RetryablePoolOptions = {
    name: POOL_NAME,
    // NOT the conformance lane's `true`. That lane wants a pristine profile on
    // every run; this one is a workspace, and clearing on init would delete the
    // user's files on every page load.
    clearOnInit: false,
    // Two databases per root actor — its own storage and the facet-tree index —
    // plus a rollback journal beside each, is four files. Eight is that with
    // headroom; the pool cannot grow past its capacity without an explicit
    // `reserveMinimumCapacity`, and running out surfaces as `SQLITE_CANTOPEN`
    // from whichever open happens to be unlucky.
    initialCapacity: 8,
    forceReinitIfPreviouslyFailed: true,
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs(options);
      return { pool, capi: sqlite3.capi };
    } catch (error) {
      // Two situations produce this failure and only one is worth waiting out.
      // A page RELOAD leaves the previous worker's sync access handles held
      // until the browser gets round to releasing them, and there is no signal
      // for that, so retrying is the only strategy available. (Measured on
      // Chromium, 2026-08: a reload never actually needed a retry. This is for
      // when it does, and it costs nothing when it does not.) A second TAB holds
      // the handles for as long as it stays open, and no amount of retrying will
      // help — so the loop ends by naming that case.
      if (attempt === 1) report("the workspace storage is locked; waiting for it", false);
      if (attempt >= POOL_ATTEMPTS) throw new Error(WORKSPACE_LOCKED_MESSAGE, { cause: error });
      await sleep(POOL_RETRY_MS);
    }
  }
}

let pooled: Promise<SqliteWasmHost> | undefined;
/** Installed once and never released: the handles are this worker's for its life. */
function pool(): Promise<SqliteWasmHost> {
  pooled ??= installPool();
  return pooled;
}

// The concrete provider tracks what the container opens, so `storage.close()`
// releases every SAH-pool database handle when a placement is replaced.
// ---------------------------------------------------------------------------
// 4 + 5. The actor scope and the container

type Live = {
  readonly container: ActorContainer;
  /** `container.entry(instance)`: every call through it is one gated event. */
  readonly entry: Workspace;
};

let live: Live | undefined;
let placing: Promise<Live> | undefined;
let scopeInstalled = false;

/**
 * Install the runtime's gated `setTimeout`, `setInterval`, `fetch`, `crypto` and
 * `scheduler` as this worker's globals.
 *
 * One worker hosts one root actor, so "which container does the global
 * `setTimeout` belong to" has exactly one answer and no ambient is needed. When
 * there is no container the resolver throws rather than falling back to a raw
 * timer: a fallback would hand a continuation back UNGATED, and the next
 * `ctx.storage` call would fail three layers from the cause.
 */
function installScope(): void {
  if (scopeInstalled) return;
  scopeInstalled = true;
  installActorScope(globalThis, () => {
    if (live === undefined) {
      throw new Error(
        "A gated global was reached with no live container: the actor was torn down while its " +
          "code was still running, so the continuation could not resume gated.",
      );
    }
    return live.container.globals;
  });
}

async function place(): Promise<Live> {
  const host = await pool();
  installScope();
  const storage = createSqliteWasmProvider(host, { prefix: STORAGE_PREFIX });

  const container = await createActorContainer({
    id: ACTOR_ID,
    uniqueKey: UNIQUE_KEY,
    // `ctx.exports` is the registry `ctx.facets.get()` resolves a `$class`
    // against. This host places no facets, so nothing reads it; a host that did
    // would register `asLoopbackDurableObjectClass(...)` values here rather than
    // the bare class.
    exports: { Workspace },
    env: {},
    ports: {
      sql: storage,
      // Both refuse by name — this example schedules no alarms and places no
      // facets, and scheduling something nothing will deliver would be worse. A
      // real host passes `AlarmScheduler.hooks(id)` backed by a database of its
      // own (in a browser: a second worker with a pool of its own) and a
      // `FacetHost` that constructs a child container per request.
      alarms: DEFAULT_ALARM_OUTLET,
      facets: noFacets,
      timer,
      // `ports.fetch` is deliberately absent. This actor SERVES fetches; it
      // makes none. Absence is upstream's `globalOutbound: null` posture, so a
      // stray `fetch()` inside the actor refuses by name instead of quietly
      // reaching the browser's ungated one.
    },
  });

  // A broken gate is terminal for this placement: the runtime refuses re-entry
  // and the host is expected to drop it. The next request places a fresh
  // container over the same files.
  container.onBroken.catch((error: unknown) => {
    live = undefined;
    storage.close();
    report(`the actor broke: ${describe(error)}`, true);
  });

  const instance = await container.start(
    (ctx, env): Workspace => new Workspace(ctx, env as WorkspaceEnv),
  );

  live = { container, entry: container.entry(instance) };
  return live;
}

/** An event for an actor that is not running is a reason to place it, not an error. */
async function placed(): Promise<Live> {
  if (live !== undefined) return live;
  placing ??= place().finally(() => {
    placing = undefined;
  });
  return await placing;
}

// ---------------------------------------------------------------------------
// The RPC surface

/**
 * capnweb dispatches by looking a method up on the target and refuses an OWN
 * property with "instance properties cannot be accessed over RPC", so every
 * method here is on the prototype — no arrow-function fields.
 */
class WorkspaceTarget extends RpcTarget implements WorkspaceRpc {
  async ready(): Promise<void> {
    await placed();
  }

  async request(wire: WireRequest): Promise<WireResponse> {
    const { container, entry } = await placed();

    // `.slice()` is a copy, and it is not superstition: since TypeScript 5.7
    // typed arrays carry their backing buffer in their type, `BodyInit` wants an
    // `ArrayBuffer`-backed view, and what arrives off the wire is a
    // `Uint8Array<ArrayBufferLike>`. `slice()` allocates, so its result is
    // `Uint8Array<ArrayBuffer>` and the assignment is honest rather than cast.
    const request = new Request(wire.url, {
      method: wire.method,
      headers: wire.headers,
      ...(wire.body === undefined ? {} : { body: wire.body.slice() }),
    });

    // ONE gated event: `entry` is `container.entry(instance)`, so this call
    // queues behind whatever the actor is already doing and its writes commit
    // before the promise resolves.
    const response = await entry.fetch(gateRequestBody(container, request));

    // Read the body out here, not in there: this is host code, outside the
    // actor's slice, and the bytes have to be a `Uint8Array` before they can
    // cross the session.
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }
}

// ---------------------------------------------------------------------------
// Boot

/** The page. Set by the one raw message that carries the port. */
let peer: ReturnType<typeof newRpcSession<PageRpc>> | undefined;

/**
 * A worker's own `console.error` is not reliably visible to whoever is looking
 * at the page, so anything worth seeing goes up the session instead. Failures
 * that are not caught at all still reach the page's `error` listener.
 */
function report(line: string, isError: boolean): void {
  if (peer === undefined) return;
  Promise.resolve(peer.log(line, isError)).catch(() => {
    // The session is gone; there is nowhere left to report to.
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener("message", (event: MessageEvent) => {
  if (peer !== undefined) throw new Error("This worker was booted twice.");
  const boot = event.data as WorkspaceBoot;
  // A `MessagePort` cannot be serialised by capnweb, so it arrives once by raw
  // `postMessage` with a transfer list. Everything after this line is capnweb —
  // through the runtime's `newRpcSession`, never capnweb's own, because that
  // export applies the `RpcTarget` identity graft each session needs.
  peer = newRpcSession<PageRpc>(boot.port, new WorkspaceTarget());
});
