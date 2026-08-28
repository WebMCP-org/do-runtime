/**
 * What the page and the lane's workers say to each other. Only the page and the
 * workers: a facet is a container in its parent's worker, so it says nothing to
 * anyone and has no surface here.
 *
 * **Ports move by `postMessage` with a transfer list**, because a `MessagePort`
 * is not a value capnweb can serialise — so every worker is booted with one raw
 * message carrying the port it will speak capnweb over, and everything after
 * that is capnweb. That is the shape the Chrome-extension host
 * this was extracted from uses, for the same reason.
 *
 * The RPC surfaces are declared as interfaces here and implemented as
 * `RpcTarget` subclasses on each side. capnweb dispatches by looking the method
 * up on the target, and refuses an OWN property with "instance properties cannot
 * be accessed over RPC" (`capnweb/dist/index.js:681`), so every implementation
 * puts its methods on a prototype.
 */

import type { AlarmResult } from "../../src/index";

/**
 * A SAH pool name is an OPFS directory name, so it may not contain a separator —
 * `getDirectoryHandle` rejects one with "Name is not allowed", which is a long
 * way from the call that chose the name. Here rather than in `substrate.ts`
 * because the page picks the names and must not import the sqlite driver to do
 * it.
 */
export function poolName(...parts: readonly string[]): string {
  return parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join("-");
}

/**
 * An uncaught exception inside a dedicated worker goes nowhere a test runner can
 * see it: the failure it eventually causes is a call that never answers, several
 * layers away. This is the whole of this lane's fail-loudly wiring, and it is
 * attached to every worker the lane creates.
 */
export function reportWorkerErrors(worker: Worker, description: string): void {
  worker.addEventListener("error", (event: ErrorEvent) => {
    console.error(`[do-runtime browser lane] ${description} worker failed:`, event.message, event);
  });
  worker.addEventListener("messageerror", () => {
    console.error(`[do-runtime browser lane] ${description} worker could not deserialise a message`);
  });
}

/**
 * One actor TREE per worker: a root and every facet under it. That is what lets
 * the worker's `scheduler` global reach the root's container without an ambient —
 * the design record's claim, and the reason this lane does not need
 * `node:async_hooks`. A facet's class is a dynamically-loaded Worker source and
 * gets a `scheduler` bound in its own module scope, so it needs no ambient
 * either.
 */
export type ActorBoot = {
  readonly port: MessagePort;
  /** The `DurableObjectId` name, and the key the alarm scheduler knows this actor by. */
  readonly actorName: string;
  /** This tree's OPFS SAH pool. Exclusive per worker — see `substrate.ts`. */
  readonly poolName: string;
};

export type AlarmsBoot = {
  readonly port: MessagePort;
  readonly poolName: string;
};

/**
 * What the page exposes to every worker it boots. The page is the supervisor:
 * it owns worker creation, the actor registry, and the routing between them —
 * which is exactly the offscreen document's role in the extension, and the role
 * `Server` plays in workerd.
 */
export interface SupervisorRpc {
  /** ← the `PROBE` namespace binding, for an actor other than the caller. */
  callActor(actorName: string, method: string, args: unknown[]): Promise<unknown>;
  /** ← `ActorSqliteHooks::scheduleRun`, forwarded to the namespace's one scheduler. */
  scheduleRun(actorName: string, scheduledTime: number | null): Promise<void>;
  /**
   * ← `AlarmScheduler::GetActorFn`, whose contract is that it PLACES the actor
   * if it is not running: an alarm is a reason to wake a Durable Object, not
   * something that requires one to be awake already.
   */
  deliverAlarm(actorName: string, scheduledTime: number, retryCount: number): Promise<AlarmResult>;
  abandonAlarm(actorName: string, scheduledTime: number): Promise<number | null>;
  /**
   * The lane's diagnostic channel, for a failure that belongs to no call.
   *
   * A worker's own `console.error` is not reliably forwarded to the test runner —
   * only the page's is, which is why `reportWorkerErrors` listens on the page
   * side. This is the same idea for something the `error` event cannot carry,
   * because it was caught rather than thrown.
   */
  report(description: string): void;
}

/** What the alarm scheduler's worker exposes to the page. */
export interface AlarmsRpc {
  scheduleRun(actorName: string, scheduledTime: number | null): Promise<void>;
}

/** What a root actor's worker exposes to the page. */
export interface ActorRpc {
  /** Place the container. `spawn` awaits it so a boot failure reaches the test. */
  ready(): Promise<void>;
  /** One gated event, through `container.entry()`. */
  call(method: string, args: unknown[]): Promise<unknown>;
  /** Same identity, fresh instance: drop the container, reopen the same files. */
  respawn(): Promise<void>;
  /** Same identity and transport: rebuild with the mirrored hibernation state. */
  evict(): Promise<void>;
  connect(tags: string[]): Promise<{ id: string; readyState: number }>;
  socketSend(id: string, data: string | ArrayBuffer): Promise<void>;
  socketClose(id: string, code?: number, reason?: string): Promise<void>;
  nextSocketMessage(id: string): Promise<string | ArrayBuffer>;
  nextSocketClose(
    id: string,
  ): Promise<{ code: number; reason: string; wasClean: boolean }>;
  /** ← `ConformanceHost.crash`: drop the container and do NOT replace it. */
  crash(): Promise<void>;
  deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult>;
  abandonAlarm(scheduledTime: number): Promise<number | null>;
}
