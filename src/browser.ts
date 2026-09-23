import { AcceptedWebSocket, markWebSocketUsed, type RawWebSocket } from "./api/web-socket";
import { bridgeWebSocket, type MessagePortWebSocket } from "./browser/message-port-websocket";

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
const upgradedSockets = new WeakMap<Response, UpgradeWebSocket>();
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
  const coupled = upgradedSockets.get(response);
  if (coupled !== undefined) return coupled;
  const socket = (response as UpgradeResponse).webSocket;
  if (!(socket instanceof AcceptedWebSocket)) return socket;
  const host = socket.coupleToHost();
  upgradedSockets.set(response, host);
  return host;
}

/**
 * Route one MessagePort socket through a Workers-style `fetch`, such as the
 * Agents SDK's `(request) => routeAgentRequest(request, env, { onBeforeConnect: withWebSocketUpgrade })`,
 * and bridge the socket it upgrades to. Install the upgrade globals first so
 * the handler can answer 101.
 *
 * The bridge closes 1011 when nothing routes the request or routing throws,
 * and 1008 when the upgrade is refused, carrying the response text as the
 * reason when it is printable ASCII of at most 123 bytes. The returned promise
 * rejects in each of those cases.
 *
 * It does not tell the peer that the socket opened. `serveMessagePortWebSockets`
 * sends that signal to clients made by `createMessagePortWebSocketConstructor`;
 * a host running its own port protocol opens its end itself.
 */
export async function connectMessagePortWebSocket(
  bridge: MessagePortWebSocket,
  url: string,
  fetch: (request: Request) => Promise<Response | null | undefined>,
): Promise<void> {
  try {
    const request = withWebSocketUpgrade(new Request(url.replace(/^ws/, "http")));
    const response = await fetch(request);
    if (response == null) {
      bridge.close(1011, "No WebSocket route matched");
      throw new Error(`No WebSocket route matched ${request.url}`);
    }
    const socket = upgradeWebSocket(response);
    if (response.status !== 101 || socket === undefined) {
      const detail = await response.text().catch(() => "");
      const reason = /^[\x20-\x7E]{1,123}$/u.test(detail) ? detail : "WebSocket upgrade rejected";
      bridge.close(1008, reason);
      throw new Error(
        `WebSocket upgrade failed with ${response.status} for ${request.url}${detail ? `: ${detail}` : ""}`,
      );
    }
    bridgeWebSocket(socket, bridge);
  } catch (error) {
    bridge.close(1011, "WebSocket connection failed");
    throw error;
  }
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
