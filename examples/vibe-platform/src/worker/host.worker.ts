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
 *   1. use the package's `platformTimer`        (or the runtime's timer recurses)
 *   2. disable the two async-proxy OPFS VFSes   (or a proxy worker starts, with timers)
 *   3. init sqlite, install the SAH pool        (before 4: the installer uses globals)
 *   4. install the actor scope                  (only now: it takes those globals)
 *   5. create the container, start the class
 *
 * Steps 2–4 are all the same rule seen three times: **everything below the
 * runtime in this realm must reach the platform's own primitives**, either by
 * capturing them first or by running before the actor scope is installed.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  createActorContainer,
  DEFAULT_ALARM_OUTLET,
  gateRequestBody,
  installActorScope,
  newRpcSession,
  noFacets,
  platformTimer,
  type ActorContainer,
  type ActorEntry,
} from "@mcp-b/do-runtime";
import {
  installSqliteWasmHost,
  SqliteWasmActorStorage,
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
// 2 + 3. sqlite and the pool, before any actor scope exists

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

  try {
    return await installSqliteWasmHost(sqlite3, {
      name: POOL_NAME,
      // NOT the conformance lane's `true`. That lane wants a pristine profile on
      // every run; this one is a workspace, and clearing on init would delete the
      // user's files on every page load.
      clearOnInit: false,
      // Only the starting size: the backend grows the pool on open.
      initialCapacity: 8,
    });
  } catch (error) {
    // The helper has already waited 10 s for a reloaded or crashed worker to
    // release the pool. A second TAB holds it for as long as it stays open, and
    // no amount of waiting helps, so name that case.
    if (error instanceof DOMException && error.name === "NoModificationAllowedError") {
      throw new Error(WORKSPACE_LOCKED_MESSAGE, { cause: error });
    }
    throw error;
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
  readonly entry: ActorEntry<Workspace>;
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
  const storage = new SqliteWasmActorStorage(host, STORAGE_PREFIX);
  const env: WorkspaceEnv = {};

  const container = await createActorContainer({
    id: ACTOR_ID,
    uniqueKey: UNIQUE_KEY,
    // `ctx.exports` is the registry `ctx.facets.get()` resolves a `$class`
    // against. This host places no facets, so nothing reads it; a host that did
    // would register `asLoopbackDurableObjectClass(...)` values here rather than
    // the bare class.
    exports: { Workspace },
    env,
    ports: {
      sql: storage,
      // Both refuse by name — this example schedules no alarms and places no
      // facets, and scheduling something nothing will deliver would be worse. A
      // real host passes `AlarmScheduler.hooks(id)` backed by a database of its
      // own (in a browser: a second worker with a pool of its own) and a
      // `FacetHost` that constructs a child container per request.
      alarms: DEFAULT_ALARM_OUTLET,
      facets: noFacets,
      timer: platformTimer,
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

  let instance: Workspace;
  try {
    instance = await container.start((ctx): Workspace => new Workspace(ctx, env));
  } catch (error) {
    storage.close();
    throw error;
  }

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

function isWorkspaceBoot(value: unknown): value is WorkspaceBoot {
  return (
    typeof value === "object" &&
    value !== null &&
    "port" in value &&
    value.port instanceof MessagePort
  );
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (peer !== undefined) throw new Error("This worker was booted twice.");
  if (!isWorkspaceBoot(event.data)) throw new TypeError("Invalid workspace worker boot message.");
  // A `MessagePort` cannot be serialised by capnweb, so it arrives once by raw
  // `postMessage` with a transfer list. Everything after this line is capnweb —
  // through the runtime's `newRpcSession`, never capnweb's own, because that
  // export applies the `RpcTarget` identity graft each session needs.
  peer = newRpcSession<PageRpc>(event.data.port, new WorkspaceTarget());
});
