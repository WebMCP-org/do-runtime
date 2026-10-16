import type { FacetStartRequest } from "../server/actor-container";
import type { HibernationAutoResponse } from "../server/hibernation-mirror";
import type { RehydratedWebSocket } from "../api/web-socket";
import { newRpcSession } from "../transport/rpc-session";
import { MessagePortWebSocket } from "./message-port-websocket";

/** Transport identity is independent of application-defined WebSocket tags. */
export type WorkerSocketSnapshot = Omit<RehydratedWebSocket, "socket"> & { readonly id: string };

/** The hibernation state of one actor container: the root or a facet. */
export type WorkerHibernationPlacement = {
  readonly sockets: readonly WorkerSocketSnapshot[];
  readonly autoResponse: HibernationAutoResponse | null;
};

export type WorkerHibernationSnapshot = {
  readonly root: WorkerHibernationPlacement;
  readonly facets: readonly (WorkerHibernationPlacement & {
    readonly request: FacetStartRequest;
  })[];
};

/** A hibernated placement whose sockets carry fresh ports to the replacement worker. */
export type WorkerRehydrationPlacement = {
  readonly autoResponse: HibernationAutoResponse | null;
  readonly sockets: readonly (WorkerSocketSnapshot & {
    readonly url: string;
    readonly port: MessagePort;
  })[];
};

export type WorkerRehydrationSnapshot = {
  readonly root: WorkerRehydrationPlacement;
  readonly facets: readonly (WorkerRehydrationPlacement & {
    readonly request: FacetStartRequest;
  })[];
};

export type WorkerLifecycleState = "active" | "idle";

/** Supervisor to worker: the messages that transfer ports, which Cap'n Web cannot carry. */
export type BrowserWorkerMessage<Configuration> =
  | {
      readonly type: "initialize";
      readonly configuration: Configuration;
      readonly agentPort: MessagePort;
      readonly hostPort: MessagePort;
      readonly rehydration?: WorkerRehydrationSnapshot;
    }
  | {
      readonly type: "connect";
      readonly id: string;
      readonly url: string;
      readonly port: MessagePort;
    };

/** Worker to supervisor, before the agent session exists. */
export type BrowserWorkerEvent =
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly message: string };

type InitializeMessage<Configuration> = Extract<
  BrowserWorkerMessage<Configuration>,
  { type: "initialize" }
>;
type ConnectMessage<Configuration> = Extract<
  BrowserWorkerMessage<Configuration>,
  { type: "connect" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isSocketSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"))) &&
    (value.attachment === undefined || value.attachment instanceof Uint8Array) &&
    isOptionalFiniteNumber(value.autoResponseTimestamp)
  );
}

function isRehydratedSocket(value: unknown): boolean {
  return (
    isSocketSnapshot(value) &&
    isRecord(value) &&
    typeof value.url === "string" &&
    value.port instanceof MessagePort
  );
}

function isAutoResponse(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) && typeof value.request === "string" && typeof value.response === "string")
  );
}

function isPlacement(value: unknown, isSocket: (value: unknown) => boolean): boolean {
  return (
    isRecord(value) &&
    isAutoResponse(value.autoResponse) &&
    Array.isArray(value.sockets) &&
    value.sockets.every(isSocket)
  );
}

function isFacetRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    Number(value.id) >= 0 &&
    typeof value.name === "string" &&
    typeof value.className === "string" &&
    Number.isInteger(value.depth) &&
    Number(value.depth) >= 0 &&
    (value.routedId === undefined || typeof value.routedId === "string")
  );
}

function isSnapshot(value: unknown, isSocket: (value: unknown) => boolean): boolean {
  return (
    isRecord(value) &&
    isPlacement(value.root, isSocket) &&
    Array.isArray(value.facets) &&
    value.facets.every(
      (facet) => isRecord(facet) && isFacetRequest(facet.request) && isPlacement(facet, isSocket),
    )
  );
}

/** A snapshot arrives over RPC from the worker it describes, so it is checked before use. */
export function isWorkerHibernationSnapshot(value: unknown): value is WorkerHibernationSnapshot {
  return isSnapshot(value, isSocketSnapshot);
}

function isWorkerRehydrationSnapshot(value: unknown): value is WorkerRehydrationSnapshot {
  return isSnapshot(value, isRehydratedSocket);
}

/** Validate the native bootstrap envelope, delegating only the application's configuration. */
export function parseBrowserWorkerMessage<Configuration>(
  value: unknown,
  parseConfiguration: (value: unknown) => Configuration,
): BrowserWorkerMessage<Configuration> {
  if (!isRecord(value)) throw new TypeError("Invalid browser worker message");
  if (
    value.type === "connect" &&
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    value.port instanceof MessagePort
  )
    return { type: "connect", id: value.id, url: value.url, port: value.port };
  const rehydration = value.rehydration;
  if (
    value.type === "initialize" &&
    value.agentPort instanceof MessagePort &&
    value.hostPort instanceof MessagePort &&
    (rehydration === undefined || isWorkerRehydrationSnapshot(rehydration))
  ) {
    return {
      type: "initialize",
      configuration: parseConfiguration(value.configuration),
      agentPort: value.agentPort,
      hostPort: value.hostPort,
      ...(rehydration === undefined ? {} : { rehydration }),
    };
  }
  throw new TypeError("Invalid browser worker message");
}

export function parseBrowserWorkerEvent(value: unknown): BrowserWorkerEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === "ready") return { type: "ready" };
  return value.type === "failed" && typeof value.message === "string"
    ? { type: "failed", message: value.message }
    : null;
}

/** Restore the native socket endpoints before constructing the owning actor container. */
export function rehydrateWorkerSockets(
  placement?: WorkerRehydrationPlacement,
): RehydratedWebSocket[] {
  return (placement?.sockets ?? []).map(({ id: _id, port, url, ...state }) => {
    const socket = new MessagePortWebSocket(url, port, false);
    socket.open();
    return { socket, ...state };
  });
}

export interface BrowserWorkerScope {
  postMessage(message: BrowserWorkerEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

export type BrowserWorkerOptions<Configuration, Host> = {
  readonly scope: BrowserWorkerScope;
  readonly parseConfiguration: (value: unknown) => Configuration;
  /** Construct the service the supervisor resolves; `host` reaches the supervisor's `hostExports`. */
  readonly initialize: (
    configuration: Configuration,
    host: ReturnType<typeof newRpcSession<Host>>,
    rehydration?: WorkerRehydrationSnapshot,
  ) => Promise<object>;
  /** Route a new client socket. Runs only once `initialize` has succeeded. */
  readonly connect: (connection: ConnectMessage<Configuration>) => Promise<void>;
  /** Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Own the transferable bootstrap and the two existing Cap'n Web sessions in a dedicated worker. */
export function serveBrowserWorker<Configuration, Host>(
  options: BrowserWorkerOptions<Configuration, Host>,
): Disposable {
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);
  const sessions = new DisposableStack();
  let initialized = false;
  let disposed = false;

  const fail = (error: unknown, message: string): void => {
    ready.reject(error);
    options.scope.postMessage({ type: "failed", message });
    sessions.dispose();
  };
  const initialize = async (message: InitializeMessage<Configuration>): Promise<void> => {
    if (initialized) throw new Error("Browser worker is already initialized");
    initialized = true;
    try {
      const host = sessions.use(newRpcSession<Host>(message.hostPort));
      const target = await options.initialize(message.configuration, host, message.rehydration);
      if (disposed) throw new Error("Browser worker bootstrap was disposed");
      sessions.use(newRpcSession(message.agentPort, target));
      ready.resolve();
      options.scope.postMessage({ type: "ready" });
    } catch (error) {
      fail(error, error instanceof Error ? (error.stack ?? error.message) : String(error));
      throw error;
    }
  };
  const connect = async (message: ConnectMessage<Configuration>): Promise<void> => {
    try {
      await ready.promise;
      if (disposed) {
        message.port.close();
        return;
      }
      await options.connect(message);
    } catch (error) {
      message.port.postMessage({ type: "close", code: 1011, reason: errorMessage(error) });
      message.port.close();
      throw error;
    }
  };
  const receive = async (data: unknown): Promise<void> => {
    let message: BrowserWorkerMessage<Configuration>;
    try {
      message = parseBrowserWorkerMessage(data, options.parseConfiguration);
    } catch (error) {
      if (!initialized) fail(error, errorMessage(error));
      throw error;
    }
    await (message.type === "initialize" ? initialize(message) : connect(message));
  };
  const listener = (event: MessageEvent<unknown>): void => {
    void receive(event.data).catch((error: unknown) =>
      options.onError ? options.onError(error) : console.error("Browser worker failed", error),
    );
  };

  options.scope.addEventListener("message", listener);
  return {
    [Symbol.dispose]() {
      disposed = true;
      ready.reject(new Error("Browser worker bootstrap was disposed"));
      options.scope.removeEventListener("message", listener);
      sessions.dispose();
    },
  };
}
