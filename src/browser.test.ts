import { afterAll, describe, expect, test } from "vitest";
import type { RawWebSocket } from "./index";
import {
  installWebSocketUpgradeGlobals,
  upgradeWebSocket,
  withWebSocketUpgrade,
} from "./browser";

const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

afterAll(() => {
  globalThis.Request = NativeRequest;
  globalThis.Response = NativeResponse;
});

describe("browser WebSocket upgrade globals", () => {
  test("carry status 101, its socket, and the upgrade marker through reconstructed requests", () => {
    installWebSocketUpgradeGlobals();
    installWebSocketUpgradeGlobals();
    const request = withWebSocketUpgrade(new Request("https://example.test/socket"));

    expect(request.clone().headers.get("Upgrade")).toBe("websocket");
    expect(new Request(request).headers.get("Upgrade")).toBe("websocket");

    const socket: RawWebSocket & EventTarget & { accept(): void; readonly readyState: number } =
      Object.assign(new EventTarget(), {
        accept() {},
        close() {},
        readyState: WebSocket.OPEN,
        send() {},
      });
    // SAFETY: the browser adapter deliberately accepts the smaller RawWebSocket
    // host seam; the ambient Workers type only spells this field as WebSocket.
    const response = new Response(null, { status: 101, webSocket: socket as WebSocket });

    expect(response.status).toBe(101);
    expect(upgradeWebSocket(response)).toBe(socket);
  });
});
