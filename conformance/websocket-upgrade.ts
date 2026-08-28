import { markWebSocketUsed, type RawWebSocket } from "../src/index";

export type UpgradeWebSocket = RawWebSocket & {
  accept(): void;
  readonly readyState: number;
};

type UpgradeResponseInit = ResponseInit & { webSocket?: UpgradeWebSocket };

let installed = false;

/** The Request/Response half of WebSocket upgrades supplied by workerd in the oracle lane. */
export function installWebSocketUpgradeGlobals(): void {
  if (installed) return;
  installed = true;
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
  return (response as Response & { webSocket?: UpgradeWebSocket }).webSocket;
}

/** Preserve workerd's upgrade signal when browser Request.clone() drops forbidden headers. */
export function webSocketUpgradeRequest(url: string, tags: readonly string[]): Request {
  const request = new Request(`${url}?${tags.map((tag) => `tag=${encodeURIComponent(tag)}`).join("&")}`);
  const get = request.headers.get.bind(request.headers);
  Object.defineProperty(request.headers, "get", {
    value: (name: string): string | null =>
      name.toLowerCase() === "upgrade" ? "websocket" : get(name),
  });
  return request;
}
