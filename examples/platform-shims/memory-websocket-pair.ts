import { markWebSocketUsed, type RawWebSocket } from "@mcp-b/do-runtime";

export type UpgradeWebSocket = EventTarget & RawWebSocket & {
  accept(): void;
  readonly readyState: number;
};

type UpgradeResponseInit = Omit<ResponseInit, "webSocket"> & { webSocket?: UpgradeWebSocket };

/** Install the Response-101 half; `installActorScope` supplies the runtime's WebSocketPair. */
export function installWebSocketUpgradeResponse(): void {
  const NativeResponse = globalThis.Response;
  class WorkersResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init: UpgradeResponseInit = {}) {
      const upgrade = init.status === 101;
      const { webSocket, ...nativeInit } = init;
      super(body, upgrade ? { ...nativeInit, status: 200 } : nativeInit);
      if (upgrade) Object.defineProperty(this, "status", { value: 101 });
      if (webSocket !== undefined) {
        markWebSocketUsed(webSocket);
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
