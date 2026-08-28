/**
 * The browser lane. Runs `@mcp-b/do-runtime` over `backends/sqlite-wasm` on the
 * OPFS SAH pool, with facets in the same worker as their parent, as they are in
 * the same isolate upstream (§1.10).
 *
 * **The page is the supervisor and cannot be anything else.** OPFS sync access
 * handles exist only in a dedicated worker, so an actor's storage is
 * unreachable from here — measured, not inferred: the first attempt at the
 * storage smoke spec ran on the page and died with `Missing required OPFS APIs`
 * before reaching an assertion. So this file owns worker creation, the actor
 * registry and the routing between them, which is precisely the offscreen
 * document's job in the extension and `Server`'s job in workerd, and it owns no
 * storage at all.
 *
 * **What a lane is allowed to be.** Everything here and in the three files
 * beside it is the *platform* around the runtime, which on the workerd lane is
 * supplied by `wrangler.test.jsonc` and by workerd itself: durable storage, the
 * `scheduler` global, the `PROBE` and `LOADER` bindings, and something that
 * turns a scheduled alarm into a delivery. None of it is the runtime under test,
 * and none of it may stand in for a behaviour the suite asserts. Where this lane
 * cannot supply a piece of the platform, the affected row fails with a named
 * message rather than being softened. `copyStorage` used to be that example and
 * is no longer one: in-process facets put both databases in this worker's one
 * pool, so it is the pool's own export/import pair (`SqliteWasmActorStorage.copyFrom`).
 *
 * **A placement this lane cannot finish fails its row.** A facet whose storage could not be
 * OPENED timed the row out at 15s with nothing reaching the test or the console,
 * because the throw landed inside `createActorContainer` during placement and a
 * placement failure had no path back to the caller. Let the same pool run out one
 * open later — on the facet's rollback journal rather than its database — and the
 * row failed promptly with the driver's own `SQLITE_CANTOPEN`, which is what said
 * the gap was placement rather than capacity.
 *
 * The fix is the runtime's, not this lane's: `FacetHandle.stub` is a promise, so
 * a placement failure reaches the first call on the facet's stub and nothing
 * else. Nothing travels up from a facet — a break stays in the subtree where it
 * happened — so a placement this lane cannot finish is a
 * rejected call and never a dead actor. What this lane owes it is the two lines
 * in `actor.worker.ts` that drop a half-built
 * container's exclusive pool handles when its class refuses to construct.
 * `conformance/suite/facets.spec.ts` asserts the contract against workerd, which
 * answers it through a constructor that throws.
 *
 * **What this lane proves that the others cannot.** It is the only one that runs
 * the sqlite-wasm backend and the only one in a real browser. It is also the only
 * lane that executes `src/transport/rpc-session.ts` end to end — the page↔actor
 * hop below is a real capnweb session over a `MessagePort` — but that is now the
 * ONLY transport module it reaches. Its `RpcTarget` identity reconciliation is
 * load-bearing for the session's local main — disabling it turns every
 * conformance row red — while facets themselves use the container's in-process
 * entry proxy. The unused remote-facet, stream-pump, and MessagePort WebSocket
 * copies are gone.
 *
 * **A real OPFS crash stays outside the shared oracle.** Worker termination asks
 * whether SQLite's rollback journal survives a process disappearing mid-write on
 * OPFS, which workerd cannot answer because it has no OPFS. The browser-only
 * `sqlite-wasm-crash.smoke.spec.ts` therefore owns that proof: it commits one row,
 * terminates the worker with a second row in an open transaction, retries bounded
 * replacement workers until the browser releases the pool handles, and observes
 * only the committed row. The shared §1.6 crash row keeps the narrower portable
 * contract: volatile instance state disappears while output-gated storage stays.
 *
 * `crash()` below is the same thing the node lane means by it: drop the container
 * without letting it flush, so the files are all that survives. Every lane that
 * declares `real-crash` implements it; `suite/crash.spec.ts` exercises that
 * contract without claiming to simulate a terminated OPFS worker.
 */

import { newRpcSession } from "../../src/index";
import type { AlarmResult } from "../../src/index";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import type { ActorBoot, ActorRpc, AlarmsBoot, AlarmsRpc, SupervisorRpc } from "./protocol";
import { poolName, reportWorkerErrors } from "./protocol";
import type {
  Capability,
  ConformanceHost,
  LaneClientSocket,
  LaneSocketMessage,
  ProbeActor,
} from "../host";

type Session<T> = ReturnType<typeof newRpcSession<T>>;

/**
 * One id per lane instance, and vitest gives every spec file its own.
 *
 * OPFS is shared by every context on the origin, and a pool's sync access
 * handles are exclusive, so two spec files running at once must not name the
 * same pool. Nothing in the suite shares durable state across files — each
 * spawns its own actor names — so per-file isolation costs nothing and removes
 * the whole class of cross-file interference.
 */
const SESSION = Math.random().toString(36).slice(2, 10);

type Placed = {
  readonly worker: Worker;
  readonly rpc: Session<ActorRpc>;
};

class BrowserClientSocket implements LaneClientSocket {
  #readyState: number;

  constructor(
    readonly rpc: Session<ActorRpc>,
    readonly id: string,
    readyState: number,
  ) {
    this.#readyState = readyState;
  }

  get readyState(): number {
    return this.#readyState;
  }

  async send(data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const message = ArrayBuffer.isView(data)
      ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : data;
    await this.rpc.socketSend(this.id, message);
  }

  async close(code?: number, reason?: string): Promise<void> {
    this.#readyState = WebSocket.CLOSING;
    await this.rpc.socketClose(this.id, code, reason);
  }

  nextMessage(): Promise<LaneSocketMessage> {
    return this.rpc.nextSocketMessage(this.id);
  }

  async nextClose(): Promise<{ code: number; reason: string; wasClean: boolean }> {
    const close = await this.rpc.nextSocketClose(this.id);
    this.#readyState = WebSocket.CLOSED;
    return close;
  }
}

const live = new Map<string, Placed>();

/**
 * ← what upstream's supervisor exposes to the actors it hosts. One instance
 * serves every session, because it holds no per-peer state: the registry is the
 * page's and the actor name is an argument.
 */
class SupervisorTarget extends RpcTarget implements SupervisorRpc {
  /** ← the `PROBE` namespace binding, reaching an actor other than the caller. */
  async callActor(actorName: string, method: string, args: unknown[]): Promise<unknown> {
    return await place(actorName).rpc.call(method, args);
  }

  async scheduleRun(actorName: string, scheduledTime: number | null): Promise<void> {
    await alarms().scheduleRun(actorName, scheduledTime);
  }

  /** ← `AlarmScheduler::GetActorFn`, which PLACES the actor if it is not running. */
  async deliverAlarm(
    actorName: string,
    scheduledTime: number,
    retryCount: number,
  ): Promise<AlarmResult> {
    return (await place(actorName).rpc.deliverAlarm(scheduledTime, retryCount)) as AlarmResult;
  }

  async abandonAlarm(actorName: string, scheduledTime: number): Promise<number | null> {
    return await place(actorName).rpc.abandonAlarm(scheduledTime);
  }

  /**
   * A worker's own `console.error` is not reliably forwarded to the runner; the
   * page's is, which is why `reportWorkerErrors` listens here rather than there.
   * This is the same channel for a failure that was caught rather than thrown, so
   * the `error` event cannot carry it.
   */
  report(description: string): void {
    console.error(`[do-runtime browser lane] ${description}`);
  }
}

const supervisor = new SupervisorTarget();

/** Lazy, so a spec file that never sets an alarm never pays for a pool it will not use. */
let alarmsSession: Session<AlarmsRpc> | undefined;

function alarms(): Session<AlarmsRpc> {
  if (alarmsSession !== undefined) return alarmsSession;
  const worker = new Worker(new URL("./alarms.worker.ts", import.meta.url), { type: "module" });
  reportWorkerErrors(worker, "alarm scheduler");
  const channel = new MessageChannel();
  worker.postMessage(
    {
      port: channel.port2,
      poolName: poolName("do-runtime", SESSION, "alarms"),
    } satisfies AlarmsBoot,
    [channel.port2],
  );
  alarmsSession = newRpcSession<AlarmsRpc>(channel.port1, supervisor);
  return alarmsSession;
}

/**
 * One worker per actor, created on first sight and never terminated.
 *
 * The container inside it comes and goes — `respawn` and `crash` drop it, the
 * next call rebuilds it — but the worker stays, because it holds the actor's
 * OPFS pool and re-acquiring one is the only operation in this lane with
 * unbounded timing.
 */
function place(actorName: string): Placed {
  const existing = live.get(actorName);
  if (existing !== undefined) return existing;

  const worker = new Worker(new URL("./actor.worker.ts", import.meta.url), { type: "module" });
  reportWorkerErrors(worker, `actor ${actorName}`);
  const channel = new MessageChannel();
  worker.postMessage(
    {
      port: channel.port2,
      actorName,
      poolName: poolName("do-runtime", SESSION, actorName),
    } satisfies ActorBoot,
    [channel.port2],
  );
  const placed: Placed = { worker, rpc: newRpcSession<ActorRpc>(channel.port1, supervisor) };
  live.set(actorName, placed);
  return placed;
}

function actor(name: string): ProbeActor {
  const invoke = async (method: string, args: unknown[]): Promise<unknown> =>
    await place(name).rpc.call(method, args);
  return {
    name,
    call: <T,>(method: string, ...args: readonly unknown[]) =>
      invoke(method, [...args]) as Promise<T>,
    post: (method: string, ...args: readonly unknown[]) => ({
      settled: invoke(method, [...args]),
    }),
  };
}

let probeCounter = 0;

export const host: ConformanceHost = {
  lane: "browser",
  capabilities: new Set<Capability>(["real-crash"]),

  spawn: async (name = `probe-${probeCounter++}`) => {
    // `ready()` is awaited so a placement failure reaches the test as itself rather than as
    // whatever the first probe call happens to say.
    await place(name).rpc.ready();
    return actor(name);
  },

  /** Same identity, fresh instance. The pool is the durable half and it stays. */
  respawn: async (previous) => {
    await place(previous.name).rpc.respawn();
    return actor(previous.name);
  },

  connect: async (target, tags = []) => {
    const rpc = place(target.name).rpc;
    const socket = await rpc.connect([...tags]);
    return new BrowserClientSocket(rpc, socket.id, socket.readyState);
  },

  evict: async (target) => {
    await place(target.name).rpc.evict();
  },

  /**
   * Drop the container without letting it flush: the files are all that
   * survives, which is the same thing the node lane's `crash` means. The worker
   * is left standing — see this file's header for why terminating it is a
   * different row than this one.
   */
  crash: async (target) => {
    await place(target.name).rpc.crash();
  },
};
