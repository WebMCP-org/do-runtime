import { afterAll, describe, expect, test } from "vitest";
import type { RawWebSocket } from "./index";
import { HibernatableWebSocketRegistry } from "./api/web-socket";
import { IoContext } from "./io/io-context";
import { InputGate, OutputGate } from "./io/io-gate";
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
  test("a host upgrade releases the actor's socket reference without exposing ungated sends", async () => {
    installWebSocketUpgradeGlobals();
    const input = new InputGate();
    const output = new OutputGate();
    const ctx = new IoContext(
      {
        getInputGate: () => input,
        getOutputGate: () => output,
        shutdownActorCache() {},
        assertCanSetAlarm() {},
      },
      { now: () => 0, afterDelay: () => new Promise<void>(() => {}) },
    );
    const messages: unknown[] = [];
    const closes: number[] = [];
    const registry = new HibernatableWebSocketRegistry(ctx, {
      message: (_socket, message) => messages.push(message),
      close: (_socket, code) => closes.push(code),
      error: () => {},
    });
    const pair = new registry.WebSocketPair();
    const retained = pair[0];
    const server = pair[1];
    registry.acceptWebSocket(server);
    const response = new Response(null, { status: 101, webSocket: retained });
    const host = upgradeWebSocket(response)!;
    host.accept();
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);

    await ctx.run(() => {
      retained.send("must not escape");
      retained.close(4000, "must not close the host");
    });
    for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([]);
    expect(closes).toEqual([]);
    expect(host).not.toBe(retained);
    expect(response.webSocket).toBe(retained);
    expect(upgradeWebSocket(response)).toBe(host);
    expect(() => retained.accept()).toThrow("already used in a response");

    host.send("host frame");
    for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual(["host frame"]);
    write.resolve();
    await ctx.waitForOutputLocks();
  });

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
