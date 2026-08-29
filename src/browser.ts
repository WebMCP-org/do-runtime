import { markWebSocketUsed, type RawWebSocket } from "./api/web-socket";

export type UpgradeWebSocket = EventTarget &
  RawWebSocket & {
    accept(): void;
    readonly readyState: number;
  };

type UpgradeResponseInit = Omit<ResponseInit, "webSocket"> & {
  webSocket?: UpgradeWebSocket;
};
type UpgradeResponse = Response & { readonly webSocket?: UpgradeWebSocket };
type CloneableRequest = { readonly headers: Headers; clone(): CloneableRequest };

const upgradeRequests = new WeakSet<CloneableRequest>();
let installed = false;

/** Install the Request/Response half of browser-hosted WebSocket upgrades. */
export function installWebSocketUpgradeGlobals(): void {
  if (installed) return;
  installed = true;

  const NativeRequest = globalThis.Request;
  class WorkersRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const upgrade = input instanceof NativeRequest && isWebSocketUpgrade(input);
      super(input, init);
      if (upgrade) withWebSocketUpgrade(this);
    }
  }
  globalThis.Request = WorkersRequest as typeof Request;

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
  return (response as UpgradeResponse).webSocket;
}

/** Preserve the upgrade signal across browser `Request.clone()` calls. */
export function withWebSocketUpgrade<T extends CloneableRequest>(request: T): T {
  if (upgradeRequests.has(request)) return request;
  upgradeRequests.add(request);
  const get = request.headers.get.bind(request.headers);
  Object.defineProperty(request.headers, "get", {
    value: (name: string): string | null =>
      name.toLowerCase() === "upgrade" ? "websocket" : get(name),
  });
  const clone = request.clone.bind(request);
  Object.defineProperty(request, "clone", {
    value: (): CloneableRequest => withWebSocketUpgrade(clone()),
  });
  return request;
}

function isWebSocketUpgrade(request: Request): boolean {
  return (
    upgradeRequests.has(request) || request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  );
}
