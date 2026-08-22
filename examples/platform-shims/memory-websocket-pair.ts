import type { ActorContainer } from "@mcp-b/do-runtime";
import type { RawWebSocket } from "@mcp-b/do-runtime";

export type UpgradeWebSocket = EventTarget & RawWebSocket & {
  accept(): void;
  readonly readyState: number;
};

class MemoryWebSocket extends EventTarget implements UpgradeWebSocket {
  #accepted = false;
  #peer!: MemoryWebSocket;
  #pending: Event[] = [];
  readyState: number = WebSocket.CONNECTING;

  link(peer: MemoryWebSocket): void {
    this.#peer = peer;
  }

  accept(): void {
    if (this.#accepted) return;
    this.#accepted = true;
    this.readyState = WebSocket.OPEN;
    this.#peer.readyState = WebSocket.OPEN;
    this.#deliver(new Event("open"));
    for (const event of this.#pending.splice(0)) this.#deliver(event);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== WebSocket.OPEN) throw new DOMException("WebSocket is not open.");
    this.#peer.receive(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    this.#peer.readyState = WebSocket.CLOSED;
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.receive(event);
    this.#peer.receive(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  receive(event: Event): void {
    if (this.#accepted) this.#deliver(event);
    else this.#pending.push(event);
  }

  #deliver(event: Event): void {
    queueMicrotask(() => this.dispatchEvent(event));
  }
}

type UpgradeResponseInit = Omit<ResponseInit, "webSocket"> & { webSocket?: UpgradeWebSocket };

/** Install the two workerd upgrade primitives PartyServer uses in non-hibernating mode. */
export function installMemoryWebSocketPair(resolve: () => ActorContainer): void {
  const WebSocketWithWorkersConstants = WebSocket as typeof WebSocket & {
    READY_STATE_OPEN?: number;
  };
  WebSocketWithWorkersConstants.READY_STATE_OPEN ??= WebSocket.OPEN;

  const Pair = function (): Record<0 | 1, UpgradeWebSocket> {
    const client = new MemoryWebSocket();
    const rawServer = new MemoryWebSocket();
    client.link(rawServer);
    rawServer.link(client);
    const server = resolve().acceptWebSocket(rawServer) as unknown as UpgradeWebSocket;
    Object.defineProperties(server, {
      accept: { value: () => rawServer.accept() },
      readyState: { get: () => rawServer.readyState },
    });
    return { 0: client, 1: server };
  };
  (globalThis as unknown as { WebSocketPair: typeof WebSocketPair }).WebSocketPair =
    Pair as unknown as typeof WebSocketPair;

  const NativeResponse = globalThis.Response;
  class WorkersResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init: UpgradeResponseInit = {}) {
      const upgrade = init.status === 101;
      const { webSocket, ...nativeInit } = init;
      super(body, upgrade ? { ...nativeInit, status: 200 } : nativeInit);
      if (upgrade) Object.defineProperty(this, "status", { value: 101 });
      if (webSocket !== undefined) {
        Object.defineProperty(this, "webSocket", { value: webSocket });
      }
    }
  }
  globalThis.Response = WorkersResponse as typeof Response;
}

export function upgradeWebSocket(response: Response): UpgradeWebSocket | undefined {
  return (response as unknown as { webSocket?: UpgradeWebSocket }).webSocket;
}

/** Preserve workerd's WebSocket upgrade signal across browser `Request.clone()` calls. */
export function withWebSocketUpgrade<T extends { headers: Headers; clone(): T }>(request: T): T {
  const get = request.headers.get.bind(request.headers);
  Object.defineProperty(request.headers, "get", {
    value: (name: string): string | null =>
      name.toLowerCase() === "upgrade" ? "websocket" : get(name),
  });
  const clone = request.clone.bind(request);
  Object.defineProperty(request, "clone", {
    value: (): T => withWebSocketUpgrade(clone()),
  });
  return request;
}
