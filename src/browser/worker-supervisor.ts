import { RpcTarget } from "../api/cloudflare-workers";
import { newRpcSession } from "../transport/rpc-session";
import type {
  MessagePortWebSocketPeer,
  MessagePortWebSocketWireMessage,
} from "./message-port-websocket";
import {
  isWorkerHibernationSnapshot,
  parseBrowserWorkerEvent,
  type BrowserWorkerMessage,
  type WorkerHibernationPlacement,
  type WorkerHibernationSnapshot,
  type WorkerLifecycleState,
  type WorkerRehydrationPlacement,
  type WorkerRehydrationSnapshot,
} from "./worker-protocol";

export * from "./worker-protocol";

export interface HibernatableWorkerService {
  /** `null` while busy, or always for a worker that must stay resident. */
  prepareHibernation(): Promise<WorkerHibernationSnapshot | null>;
}

/** The current physical worker for one key. */
export interface SupervisedWorker<Configuration, Service> {
  readonly configuration: Configuration;
  readonly key: string;
  readonly service: ReturnType<typeof newRpcSession<Service>>;
  readonly ready: Promise<void>;
  readonly readyNow: boolean;
}

export interface SupervisedWorkerSocket {
  receive(message: MessagePortWebSocketWireMessage): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserWorkerHostContext {
  /** Reports are bound to this physical worker, never a replacement for the same key. */
  reportLifecycle(state: WorkerLifecycleState): void;
}

export type BrowserWorkerSupervisorOptions<Configuration> = {
  key(configuration: Configuration): string;
  createWorker(configuration: Configuration): Worker;
  hostExports(configuration: Configuration, context: BrowserWorkerHostContext): object;
  removeStorage(configuration: Configuration): Promise<void>;
  /** Release resources a terminated worker's finalizers can no longer release. */
  discarded?(configuration: Configuration, reason: string): void;
  readonly idleGraceMs: number;
};

type Placement<Configuration, Service> = SupervisedWorker<Configuration, Service> & {
  readyNow: boolean;
  readonly readiness: PromiseWithResolvers<void>;
  readonly worker: Worker;
  readonly hostSession: ReturnType<typeof newRpcSession>;
  hibernation?: { canceled: boolean };
  /** The worker's last lifecycle report was idle. */
  idle: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type Socket<Configuration> = {
  readonly configuration: Configuration;
  readonly id: string;
  readonly key: string;
  readonly peer: MessagePortWebSocketPeer;
  /** Frames held while the worker starts or hibernates. */
  readonly pending: MessagePortWebSocketWireMessage[];
  readonly url: string;
  closed: boolean;
  closing: boolean;
  /** This socket's port into the key's current worker; absent until one is attached. */
  port?: MessagePort;
};

type Identity<Configuration> = { readonly configuration: Configuration; epoch: number };

type Deletion<Configuration> = {
  includes(configuration: Configuration): boolean;
  readonly promise: Promise<void>;
};

type Close = Extract<MessagePortWebSocketWireMessage, { type: "close" }>;

/** A logical capability survives worker eviction, but never deletion of its configuration. */
export class BrowserWorkerReference<Service> extends RpcTarget {
  constructor(
    private readonly resolveCurrent: () => Promise<ReturnType<typeof newRpcSession<Service>>>,
  ) {
    super();
  }
  resolve(): Promise<ReturnType<typeof newRpcSession<Service>>> {
    return this.resolveCurrent();
  }
}

/**
 * Owns physical workers, their Cap'n Web sessions and the client transports
 * which outlast an idle worker. A configuration names an actor; application
 * policy decides which configurations may be requested or deleted.
 */
export class BrowserWorkerSupervisor<
  Configuration,
  Service extends HibernatableWorkerService,
> implements Disposable {
  readonly #options: BrowserWorkerSupervisorOptions<Configuration>;
  readonly #workers = new Map<string, Placement<Configuration, Service>>();
  readonly #hibernated = new Map<string, WorkerHibernationSnapshot>();
  readonly #sockets = new Set<Socket<Configuration>>();
  /** Every configuration seen, so deletion can reach storage whose worker is not running. */
  readonly #identities = new Map<string, Identity<Configuration>>();
  readonly #deletions = new Set<Deletion<Configuration>>();
  #deletionTail = Promise.resolve();
  #disposed = false;

  constructor(options: BrowserWorkerSupervisorOptions<Configuration>) {
    this.#options = options;
  }

  get size(): number {
    return this.#workers.size;
  }
  placements(): readonly SupervisedWorker<Configuration, Service>[] {
    return [...this.#workers.values()];
  }
  get(key: string): SupervisedWorker<Configuration, Service> | undefined {
    return this.#workers.get(key);
  }

  ensure(configuration: Configuration): SupervisedWorker<Configuration, Service> {
    return this.#ensure(configuration);
  }

  /** Each caller receives its own capability; disposal cannot tear down the registry's session. */
  resolve(configuration: Configuration): Promise<ReturnType<typeof newRpcSession<Service>>> {
    return this.#resolve(configuration, () => {});
  }

  reference(configuration: Configuration): BrowserWorkerReference<Service> {
    const identity = this.#identity(configuration);
    const epoch = identity.epoch;
    return new BrowserWorkerReference(() =>
      this.#resolve(configuration, () => {
        if (identity.epoch !== epoch) throw new Error("Worker reference is stale after deletion");
      }),
    );
  }

  connect(
    configuration: Configuration,
    connection: { readonly id: string; readonly url: string; readonly peer: MessagePortWebSocketPeer },
  ): SupervisedWorkerSocket {
    const key = this.#options.key(configuration);
    const socket: Socket<Configuration> = {
      configuration,
      key,
      ...connection,
      pending: [],
      closed: false,
      closing: false,
    };
    const control: SupervisedWorkerSocket = {
      receive: (message) => this.#receive(socket, message),
      close: (code = 1000, reason = "") => this.#close(socket, code, reason, false),
    };
    const previous = this.#socketsFor(key).find((candidate) => candidate.id === socket.id);
    if (previous) {
      this.#close(previous, 1008, "Connection superseded", true);
      socket.peer.send({ type: "close", code: 1012, reason: "Previous connection is closing" });
      this.#finish(socket);
      return control;
    }
    try {
      // Wake before registering: a hibernation snapshot describes only the existing transports.
      const placement = this.#ensure(configuration);
      this.#sockets.add(socket);
      this.#connect(socket, placement);
    } catch (error) {
      this.#finish(socket);
      throw error;
    }
    return control;
  }

  /** A native MessagePort endpoint, using the same socket lifetime as other peers. */
  connectPort(
    configuration: Configuration,
    connection: { readonly id: string; readonly url: string },
  ): MessagePort {
    const channel = new MessageChannel();
    const socket = this.connect(configuration, {
      ...connection,
      peer: {
        send: (message) => channel.port2.postMessage(message),
        close: () => channel.port2.close(),
      },
    });
    channel.port2.addEventListener(
      "message",
      (event: MessageEvent<MessagePortWebSocketWireMessage>) => socket.receive(event.data),
    );
    channel.port2.start();
    return channel.port1;
  }

  /** End live sockets without waking a hibernated worker (for host admission/maintenance policy). */
  closeSockets(configuration: Configuration, code: number, reason: string): void {
    const key = this.#options.key(configuration);
    this.#hibernated.delete(key);
    this.#endSockets(key, code, reason);
  }

  /** Probe now; lifecycle reports normally arrange this after the configured idle grace. */
  async hibernate(configuration: Configuration): Promise<boolean> {
    const placement = this.#workers.get(this.#options.key(configuration));
    return placement ? this.#hibernate(placement) : false;
  }

  stop(configuration: Configuration, reason = "Worker stopped"): void {
    const key = this.#options.key(configuration);
    const placement = this.#workers.get(key);
    if (placement) this.#discard(placement, reason, false);
    else {
      this.#hibernated.delete(key);
      this.#endSockets(key, 1011, reason);
    }
  }

  async waitForDeletion(configuration: Configuration): Promise<void> {
    for (;;) {
      const pending = [...this.#deletions].filter((deletion) => deletion.includes(configuration));
      if (!pending.length) return;
      await Promise.all(pending.map((deletion) => deletion.promise));
    }
  }

  /**
   * Invalidates captured references synchronously. `includes` is the
   * application's actual ancestry rule; keys are never prefix-matched. All
   * physical deletions serialize because terminated OPFS pools release
   * asynchronously.
   */
  delete(
    configuration: Configuration,
    includes?: (candidate: Configuration) => boolean,
  ): Promise<void> {
    const key = this.#options.key(configuration);
    const within = (candidate: Configuration): boolean =>
      this.#options.key(candidate) === key || (includes?.(candidate) ?? false);
    this.#identity(configuration);
    const targets = [...this.#identities.values()].filter((identity) =>
      within(identity.configuration),
    );
    const failures: unknown[] = [];
    // This callback runs after the synchronous teardown below, so it reports those failures too.
    const promise = this.#deletionTail.then(async () => {
      for (const identity of targets) {
        try {
          await this.#options.removeStorage(identity.configuration);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Worker deletion failed");
    });
    this.#deletionTail = promise.catch(() => undefined);
    // Install the barrier before discard callbacks can re-enter the supervisor.
    const deletion: Deletion<Configuration> = { includes: within, promise };
    this.#deletions.add(deletion);
    const clear = (): void => {
      this.#deletions.delete(deletion);
    };
    void promise.then(clear, clear);
    for (const identity of targets) identity.epoch++;
    for (const identity of targets) {
      try {
        this.closeSockets(identity.configuration, 1001, "Worker deleted");
        this.stop(identity.configuration, "Worker deleted");
      } catch (error) {
        failures.push(error);
      }
    }
    return promise;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: unknown[] = [];
    for (const placement of [...this.#workers.values()]) {
      try {
        this.#discard(placement, "Supervisor disposed", false);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const key of this.#hibernated.keys()) this.#endSockets(key, 1001, "Supervisor disposed");
    this.#hibernated.clear();
    if (failures.length) throw new AggregateError(failures, "Supervisor cleanup failed");
  }

  #ensure(configuration: Configuration): Placement<Configuration, Service> {
    if (this.#disposed) throw new Error("Browser worker supervisor is disposed");
    if ([...this.#deletions].some((deletion) => deletion.includes(configuration)))
      throw new Error("Worker storage is being deleted");
    const key = this.#options.key(configuration);
    this.#identity(configuration);
    const existing = this.#workers.get(key);
    if (!existing) return this.#spawn(configuration, key);
    // New work cancels a hibernation probe and restarts a pending idle grace.
    if (existing.hibernation) existing.hibernation.canceled = true;
    if (existing.idleTimer !== undefined) this.#scheduleIdle(existing);
    return existing;
  }

  #spawn(configuration: Configuration, key: string): Placement<Configuration, Service> {
    const worker = this.#options.createWorker(configuration);
    const host = new MessageChannel();
    const agent = new MessageChannel();
    const readiness = Promise.withResolvers<void>();
    void readiness.promise.catch(() => undefined);
    let placement: Placement<Configuration, Service>;
    try {
      placement = {
        configuration,
        key,
        worker,
        readiness,
        ready: readiness.promise,
        readyNow: false,
        idle: false,
        hostSession: newRpcSession(
          host.port1,
          this.#options.hostExports(configuration, {
            reportLifecycle: (state) => {
              if (placement) this.#reportLifecycle(placement, state);
            },
          }),
        ),
        service: newRpcSession<Service>(agent.port1),
      };
    } catch (error) {
      host.port1.close();
      host.port2.close();
      agent.port1.close();
      agent.port2.close();
      worker.terminate();
      throw error;
    }
    this.#workers.set(key, placement);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!this.#isCurrent(placement)) return;
      const message = parseBrowserWorkerEvent(event.data);
      if (!message) {
        console.warn(`Worker ${key} sent an invalid event`, describeWorkerEvent(event.data));
        return;
      }
      if (message.type === "failed") this.#discard(placement, message.message, false);
      else {
        placement.readyNow = true;
        readiness.resolve();
        this.#flush(placement);
      }
    });
    worker.addEventListener("error", (event) =>
      this.#discard(placement, event.message || `Worker ${key} failed`, false),
    );
    worker.addEventListener("messageerror", () =>
      this.#discard(placement, `Worker ${key} could not deserialize a message`, false),
    );
    const snapshot = this.#hibernated.get(key);
    this.#hibernated.delete(key);
    try {
      let restored: { snapshot: WorkerRehydrationSnapshot; ports: MessagePort[] } | undefined;
      if (snapshot) {
        if (this.#describesLiveSockets(key, snapshot)) restored = this.#rehydrate(key, snapshot);
        else this.#endSockets(key, 1011, "Worker snapshot no longer matches its transports");
      }
      worker.postMessage(
        {
          type: "initialize",
          configuration,
          agentPort: agent.port2,
          hostPort: host.port2,
          ...(restored ? { rehydration: restored.snapshot } : {}),
        } satisfies BrowserWorkerMessage<Configuration>,
        [agent.port2, host.port2, ...(restored?.ports ?? [])],
      );
    } catch (error) {
      agent.port2.close();
      host.port2.close();
      this.#discard(placement, String(error), false);
      throw error;
    }
    return placement;
  }

  async #resolve(
    configuration: Configuration,
    assertCurrent: () => void,
  ): Promise<ReturnType<typeof newRpcSession<Service>>> {
    assertCurrent();
    await this.waitForDeletion(configuration);
    assertCurrent();
    const placement = this.#ensure(configuration);
    await placement.ready;
    assertCurrent();
    return placement.service.dup();
  }

  #isCurrent(placement: Placement<Configuration, Service>): boolean {
    return this.#workers.get(placement.key) === placement;
  }

  #identity(configuration: Configuration): Identity<Configuration> {
    const key = this.#options.key(configuration);
    let identity = this.#identities.get(key);
    if (!identity) {
      identity = { configuration, epoch: 0 };
      this.#identities.set(key, identity);
    }
    return identity;
  }

  #reportLifecycle(
    placement: Placement<Configuration, Service>,
    state: WorkerLifecycleState,
  ): void {
    if (!this.#isCurrent(placement)) return;
    placement.idle = state === "idle";
    if (state === "active") {
      if (placement.hibernation) placement.hibernation.canceled = true;
      this.#clearIdle(placement);
    } else this.#scheduleIdle(placement);
  }

  #socketsFor(key: string): Socket<Configuration>[] {
    return [...this.#sockets].filter((socket) => socket.key === key);
  }

  #connect(socket: Socket<Configuration>, placement: Placement<Configuration, Service>): void {
    const channel = new MessageChannel();
    this.#attach(socket, channel.port1);
    placement.worker.postMessage(
      {
        type: "connect",
        id: socket.id,
        url: socket.url,
        port: channel.port2,
      } satisfies BrowserWorkerMessage<Configuration>,
      [channel.port2],
    );
  }

  #attach(socket: Socket<Configuration>, port: MessagePort): void {
    socket.port?.close();
    socket.port = port;
    port.addEventListener("message", (event: MessageEvent<MessagePortWebSocketWireMessage>) => {
      if (socket.port !== port) return;
      socket.peer.send(event.data);
      if (event.data.type === "close") this.#finish(socket);
    });
    port.start();
  }

  #receive(socket: Socket<Configuration>, message: MessagePortWebSocketWireMessage): void {
    if (socket.closed || (socket.closing && message.type !== "close")) return;
    const placement = this.#ensure(socket.configuration);
    // Waking a worker whose snapshot no longer matches its transports ends this socket.
    if (socket.closed) return;
    if (!socket.port) this.#connect(socket, placement);
    if (!placement.readyNow || placement.hibernation) socket.pending.push(message);
    else this.#post(socket, message);
  }

  /** Route a close through the worker, waking it if needed, so the actor observes it. */
  #close(socket: Socket<Configuration>, code: number, reason: string, notifyPeer: boolean): void {
    if (socket.closed || socket.closing) return;
    socket.closing = true;
    const close: Close = { type: "close", code, reason };
    if (notifyPeer) socket.peer.send(close);
    this.#receive(socket, close);
  }

  #post(socket: Socket<Configuration>, message: MessagePortWebSocketWireMessage): void {
    if (!socket.port) {
      socket.pending.push(message);
      return;
    }
    socket.port.postMessage(message);
    if (message.type === "close") this.#finish(socket);
  }

  #flush(placement: Placement<Configuration, Service>): void {
    if (!placement.readyNow || placement.hibernation) return;
    for (const socket of this.#socketsFor(placement.key)) {
      if (!socket.port) continue;
      for (const message of socket.pending.splice(0)) {
        this.#post(socket, message);
        if (socket.closed) break;
      }
    }
  }

  #finish(socket: Socket<Configuration>): void {
    if (socket.closed) return;
    socket.closed = true;
    this.#sockets.delete(socket);
    socket.port?.close();
    delete socket.port;
    socket.peer.close();
  }

  /** Close one socket at both ends without waiting for the worker. */
  #end(socket: Socket<Configuration>, close: Close): void {
    socket.closing = true;
    socket.port?.postMessage(close);
    socket.peer.send(close);
    this.#finish(socket);
  }

  #endSockets(key: string, code: number, reason: string): void {
    for (const socket of this.#socketsFor(key)) this.#end(socket, { type: "close", code, reason });
  }

  #rehydrate(
    key: string,
    snapshot: WorkerHibernationSnapshot,
  ): { ports: MessagePort[]; snapshot: WorkerRehydrationSnapshot } {
    const sockets = new Map(this.#socketsFor(key).map((socket) => [socket.id, socket]));
    const ports: MessagePort[] = [];
    const restore = (part: WorkerHibernationPlacement): WorkerRehydrationPlacement => ({
      autoResponse: part.autoResponse,
      sockets: part.sockets.map((state) => {
        const socket = sockets.get(state.id);
        if (!socket) throw new Error(`Missing host transport ${state.id}`);
        const channel = new MessageChannel();
        this.#attach(socket, channel.port1);
        ports.push(channel.port2);
        return { ...state, url: socket.url, port: channel.port2 };
      }),
    });
    return {
      ports,
      snapshot: {
        root: restore(snapshot.root),
        facets: snapshot.facets.map(({ request, ...part }) => ({ request, ...restore(part) })),
      },
    };
  }

  /** The snapshot names exactly the key's live transport IDs, each once. */
  #describesLiveSockets(key: string, snapshot: WorkerHibernationSnapshot): boolean {
    if (!isWorkerHibernationSnapshot(snapshot)) return false;
    const live = new Set(this.#socketsFor(key).map((socket) => socket.id));
    const ids = [snapshot.root, ...snapshot.facets].flatMap((part) =>
      part.sockets.map((socket) => socket.id),
    );
    return (
      ids.length === new Set(ids).size &&
      ids.length === live.size &&
      ids.every((id) => live.has(id))
    );
  }

  #clearIdle(placement: Placement<Configuration, Service>): void {
    if (placement.idleTimer !== undefined) clearTimeout(placement.idleTimer);
    delete placement.idleTimer;
  }

  #scheduleIdle(placement: Placement<Configuration, Service>): void {
    this.#clearIdle(placement);
    placement.idleTimer = setTimeout(() => {
      delete placement.idleTimer;
      void this.#hibernate(placement).catch((error: unknown) => {
        console.error(`Worker ${placement.key} hibernation failed`, error);
        if (this.#isCurrent(placement) && placement.idle) this.#scheduleIdle(placement);
      });
    }, this.#options.idleGraceMs);
  }

  async #hibernate(placement: Placement<Configuration, Service>): Promise<boolean> {
    if (!this.#isCurrent(placement) || placement.hibernation) return false;
    const attempt = { canceled: false };
    placement.hibernation = attempt;
    let snapshot: WorkerHibernationSnapshot | null;
    try {
      snapshot = await placement.service.prepareHibernation();
    } catch (error) {
      if (this.#isCurrent(placement)) this.#resume(placement);
      throw error;
    }
    if (!this.#isCurrent(placement)) return false;
    if (
      attempt.canceled ||
      snapshot === null ||
      !this.#describesLiveSockets(placement.key, snapshot)
    ) {
      this.#resume(placement);
      if (placement.idle) this.#scheduleIdle(placement);
      return false;
    }
    this.#hibernated.set(placement.key, snapshot);
    this.#discard(placement, "Idle grace elapsed", true);
    return true;
  }

  /** End a hibernation attempt and deliver the frames it held. */
  #resume(placement: Placement<Configuration, Service>): void {
    delete placement.hibernation;
    this.#flush(placement);
  }

  #discard(
    placement: Placement<Configuration, Service>,
    reason: string,
    keepSockets: boolean,
  ): void {
    if (!this.#isCurrent(placement)) return;
    this.#clearIdle(placement);
    delete placement.hibernation;
    this.#workers.delete(placement.key);
    if (!keepSockets) this.#hibernated.delete(placement.key);
    placement.readiness.reject(new Error(reason));
    for (const socket of this.#socketsFor(placement.key)) {
      socket.port?.close();
      delete socket.port;
      if (!keepSockets) this.#end(socket, { type: "close", code: 1011, reason: "Worker stopped" });
    }
    // The placement left #workers above, so `discarded` runs once per worker even when teardown
    // throws. The stack disposes in reverse: sessions, then the worker, then the callback.
    const teardown = new DisposableStack();
    teardown.defer(() => this.#options.discarded?.(placement.configuration, reason));
    teardown.defer(() => placement.worker.terminate());
    teardown.defer(() => placement.hostSession[Symbol.dispose]());
    teardown.defer(() => placement.service[Symbol.dispose]());
    teardown.dispose();
  }
}

/** Name what was rejected without echoing a payload of arbitrary size. */
function describeWorkerEvent(value: unknown): string {
  if (value === null || typeof value !== "object") return value === null ? "null" : typeof value;
  const keys = Object.keys(value);
  const type = "type" in value && typeof value.type === "string" ? value.type : undefined;
  return [
    type === undefined ? "no string type" : `type ${JSON.stringify(type.slice(0, 64))}`,
    `keys ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", ..." : ""}`,
  ].join("; ");
}
