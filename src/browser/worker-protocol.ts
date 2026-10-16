import type { FacetStartRequest } from "../server/actor-container";
import type { HibernationAutoResponse } from "../server/hibernation-mirror";
import type { RehydratedWebSocket } from "../api/web-socket";
import { newRpcSession } from "../transport/rpc-session";
import { MessagePortWebSocket } from "./message-port-websocket";

/** Transport identity is independent of application-defined WebSocket tags. */
export type WorkerSocketSnapshot = Omit<RehydratedWebSocket, "socket"> & { readonly id: string };
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
export type BrowserWorkerEvent =
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}
function isSocket(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"))) &&
    (value.attachment === undefined || value.attachment instanceof Uint8Array) &&
    optionalNumber(value.autoResponseTimestamp)
  );
}
function isPlacement(value: unknown, rehydrated: boolean): boolean {
  if (!record(value) || !Array.isArray(value.sockets)) return false;
  const response = value.autoResponse;
  if (
    response !== null &&
    !(
      record(response) &&
      typeof response.request === "string" &&
      typeof response.response === "string"
    )
  )
    return false;
  return value.sockets.every(
    (socket) =>
      isSocket(socket) &&
      (!rehydrated ||
        (record(socket) && typeof socket.url === "string" && socket.port instanceof MessagePort)),
  );
}
function isFacetRequest(value: unknown): boolean {
  return (
    record(value) &&
    Number.isInteger(value.id) &&
    Number(value.id) >= 0 &&
    typeof value.name === "string" &&
    typeof value.className === "string" &&
    Number.isInteger(value.depth) &&
    Number(value.depth) >= 0 &&
    (value.routedId === undefined || typeof value.routedId === "string")
  );
}
function isSnapshot(value: unknown, rehydrated: boolean): boolean {
  return (
    record(value) &&
    isPlacement(value.root, rehydrated) &&
    Array.isArray(value.facets) &&
    value.facets.every(
      (facet) => record(facet) && isFacetRequest(facet.request) && isPlacement(facet, rehydrated),
    )
  );
}
/** Validate the native bootstrap envelope, delegating only the application's configuration. */
export function parseBrowserWorkerMessage<Configuration>(
  value: unknown,
  parseConfiguration: (value: unknown) => Configuration,
): BrowserWorkerMessage<Configuration> {
  if (!record(value)) throw new TypeError("Invalid browser worker message");
  if (
    value.type === "connect" &&
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    value.port instanceof MessagePort
  )
    return { type: "connect", id: value.id, url: value.url, port: value.port };
  if (
    value.type === "initialize" &&
    value.agentPort instanceof MessagePort &&
    value.hostPort instanceof MessagePort &&
    (value.rehydration === undefined || isSnapshot(value.rehydration, true))
  ) {
    return {
      type: "initialize",
      configuration: parseConfiguration(value.configuration),
      agentPort: value.agentPort,
      hostPort: value.hostPort,
      ...(value.rehydration === undefined
        ? {}
        : { rehydration: value.rehydration as WorkerRehydrationSnapshot }),
    };
  }
  throw new TypeError("Invalid browser worker message");
}
export function parseBrowserWorkerEvent(value: unknown): BrowserWorkerEvent | null {
  if (!record(value)) return null;
  if (value.type === "ready") return { type: "ready" };
  return value.type === "failed" && typeof value.message === "string"
    ? { type: "failed", message: value.message }
    : null;
}
/** RPC snapshots are checked before replacing a live worker and again before transferring ports. */
export function isWorkerHibernationSnapshot(value: unknown): value is WorkerHibernationSnapshot {
  return isSnapshot(value, false);
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
/** Own the transferable bootstrap and the two existing Cap'n Web sessions in a dedicated worker. */
export function serveBrowserWorker<Configuration, Host>(options: {
  readonly scope: BrowserWorkerScope;
  readonly parseConfiguration: (value: unknown) => Configuration;
  readonly initialize: (
    configuration: Configuration,
    host: ReturnType<typeof newRpcSession<Host>>,
    rehydration?: WorkerRehydrationSnapshot,
  ) => Promise<object>;
  readonly connect: (
    connection: Extract<BrowserWorkerMessage<Configuration>, { type: "connect" }>,
  ) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}): Disposable {
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => undefined);
  const sessions = new DisposableStack();
  let initialized = false;
  let disposed = false;
  const receive = (event: MessageEvent<unknown>): void => {
    void (async () => {
      let message: BrowserWorkerMessage<Configuration>;
      try {
        message = parseBrowserWorkerMessage(event.data, options.parseConfiguration);
      } catch (error) {
        if (!initialized) {
          ready.reject(error);
          options.scope.postMessage({
            type: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
          sessions.dispose();
        }
        throw error;
      }
      if (message.type === "initialize") {
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
          ready.reject(error);
          options.scope.postMessage({
            type: "failed",
            message: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
          sessions.dispose();
          throw error;
        }
      } else {
        try {
          await ready.promise;
          if (disposed) {
            message.port.close();
            return;
          }
          await options.connect(message);
        } catch (error) {
          message.port.postMessage({
            type: "close",
            code: 1011,
            reason: error instanceof Error ? error.message : String(error),
          });
          message.port.close();
          throw error;
        }
      }
    })().catch((error: unknown) =>
      options.onError ? options.onError(error) : console.error("Browser worker failed", error),
    );
  };
  options.scope.addEventListener("message", receive);
  return {
    [Symbol.dispose]() {
      disposed = true;
      ready.reject(new Error("Browser worker bootstrap was disposed"));
      options.scope.removeEventListener("message", receive);
      sessions.dispose();
    },
  };
}
