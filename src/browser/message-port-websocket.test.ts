import { describe, expect, it, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { createActorContainer, noFacets } from "../server/actor-container";
import type { UpgradeWebSocket } from "../browser";
import {
  connectMessagePortWebSocket,
  installWebSocketUpgradeGlobals,
  upgradeWebSocket,
} from "../browser";
import {
  MessagePortWebSocket,
  bridgeWebSocket,
  createMessagePortWebSocketConstructor,
  serveMessagePortWebSockets,
  type MessagePortWebSocketData,
  type MessagePortWebSocketWireMessage,
} from "./message-port-websocket";

/** Collect errors reported through `queueMicrotask` instead of failing the run with them. */
function captureReported(): { readonly reported: unknown[]; restore(): void } {
  const reported: unknown[] = [];
  const nativeQueueMicrotask = globalThis.queueMicrotask;
  const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) =>
    nativeQueueMicrotask(() => {
      try {
        callback();
      } catch (error) {
        reported.push(error);
      }
    }),
  );
  return { reported, restore: () => queue.mockRestore() };
}

/** A 101 answer carrying `webSocket`, without installing the upgrade globals. */
function upgradeResponse(webSocket: object): Response {
  return Object.defineProperties(new Response(null), {
    status: { value: 101 },
    webSocket: { value: webSocket },
  });
}

/** What the far end of a bridge's MessagePort receives. */
function recordWire(port: MessagePort): MessagePortWebSocketWireMessage[] {
  const wire: MessagePortWebSocketWireMessage[] = [];
  port.addEventListener("message", (event: MessageEvent<MessagePortWebSocketWireMessage>) => {
    wire.push(event.data);
  });
  port.start();
  return wire;
}

function socketContainer(uniqueKey: string) {
  return createActorContainer({
    id: "socket",
    uniqueKey,
    exports: {},
    env: {},
    ports: {
      sql: createNodeSqlProvider(),
      facets: noFacets,
      alarms: { scheduleRun: async () => {} },
      timer: { now: () => Date.now(), afterDelay: () => new Promise(() => {}) },
    },
  });
}

class MemorySocket extends EventTarget implements UpgradeWebSocket {
  readonly sent: MessagePortWebSocketData[] = [];
  readyState = MessagePortWebSocket.CONNECTING;

  accept(): void {
    this.readyState = MessagePortWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: MessagePortWebSocketData): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MessagePortWebSocket.CLOSED) return;
    this.readyState = MessagePortWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  receive(data: MessagePortWebSocketData): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("MessagePortWebSocket", () => {
  it("queues structured-clone frames until the accepting endpoint opens", async () => {
    const channel = new MessageChannel();
    const socket = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const messages: MessagePortWebSocketData[] = [];
    socket.addEventListener("message", (event) => messages.push(event.data));

    channel.port2.postMessage({
      type: "message",
      data: new Uint8Array([7, 8, 9]).buffer,
    } satisfies MessagePortWebSocketWireMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.readyState).toBe(MessagePortWebSocket.CONNECTING);
    expect(messages).toEqual([]);

    socket.accept();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    const [message] = messages;
    expect(message).toBeInstanceOf(ArrayBuffer);
    if (!(message instanceof ArrayBuffer)) throw new TypeError("expected an ArrayBuffer frame");
    expect([...new Uint8Array(message)]).toEqual([7, 8, 9]);

    socket.close();
    channel.port2.close();
  });

  it("closes on a malformed wire message", async () => {
    const channel = new MessageChannel();
    const socket = new MessagePortWebSocket("ws://actor.test", channel.port1);
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });

    channel.port2.postMessage({ type: "message", data: { unsupported: true } });

    await expect(closed).resolves.toMatchObject({
      code: 1002,
      reason: "Invalid MessagePort WebSocket message",
      wasClean: true,
    });
    channel.port2.close();
  });

  it("reports a throwing onmessage without skipping listeners or later frames", async () => {
    const { reported, restore } = captureReported();
    const channel = new MessageChannel();
    const socket = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const arrived: unknown[] = [];
    channel.port1.addEventListener("message", (event) => arrived.push(event.data));
    const failure = new Error("onmessage failed");
    const handled: MessagePortWebSocketData[] = [];
    const listened: MessagePortWebSocketData[] = [];
    socket.onmessage = (event) => {
      handled.push(event.data);
      if (event.data === "first") throw failure;
    };
    socket.addEventListener("message", (event) => listened.push(event.data));
    try {
      for (const data of ["first", "second"]) {
        channel.port2.postMessage({ type: "message", data } satisfies MessagePortWebSocketWireMessage);
      }
      await vi.waitFor(() => expect(arrived).toHaveLength(2));
      socket.open();
      for (const data of ["third", "fourth"]) {
        channel.port2.postMessage({ type: "message", data } satisfies MessagePortWebSocketWireMessage);
      }

      const frames = ["first", "second", "third", "fourth"];
      await vi.waitFor(() => expect(listened).toEqual(frames));
      expect(handled).toEqual(frames);
      expect(reported).toEqual([failure]);
      expect(socket.readyState).toBe(MessagePortWebSocket.OPEN);
    } finally {
      restore();
      socket.close();
      channel.port2.close();
    }
  });

  it("dispatches a close that arrives while connecting and discards queued frames", async () => {
    const channel = new MessageChannel();
    const socket = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const events: string[] = [];
    socket.addEventListener("message", (event) => events.push(`message ${String(event.data)}`));
    socket.addEventListener("close", (event) => events.push(`close ${event.code} ${event.reason}`));

    channel.port2.postMessage({ type: "message", data: "queued" } satisfies MessagePortWebSocketWireMessage);
    channel.port2.postMessage({
      type: "close",
      code: 4409,
      reason: "worker stopped",
    } satisfies MessagePortWebSocketWireMessage);
    await vi.waitFor(() => expect(socket.readyState).toBe(MessagePortWebSocket.CLOSED));
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["close 4409 worker stopped"]);
    channel.port2.close();
  });

  it("carries frames and close state in both directions", async () => {
    const channel = new MessageChannel();
    const left = new MessagePortWebSocket("ws://actor.test", channel.port1);
    const right = new MessagePortWebSocket("ws://actor.test", channel.port2);
    const received: MessagePortWebSocketData[] = [];
    const closed: CloseEvent[] = [];
    right.addEventListener("message", (event) => received.push(event.data));
    right.addEventListener("close", (event) => closed.push(event));
    await vi.waitFor(() => expect(left.readyState).toBe(MessagePortWebSocket.OPEN));

    left.send("hello");
    await vi.waitFor(() => expect(received).toEqual(["hello"]));

    left.close(1000, "finished");
    await vi.waitFor(() => expect(right.readyState).toBe(MessagePortWebSocket.CLOSED));
    expect(closed[0]).toMatchObject({ code: 1000, reason: "finished", wasClean: true });
  });

  it("bridges a runtime socket without exposing transport choreography", async () => {
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const client = new MessagePortWebSocket("ws://actor.test", channel.port2);
    const runtime = new MemorySocket();
    const received: MessagePortWebSocketData[] = [];
    client.addEventListener("message", (event) => received.push(event.data));

    bridgeWebSocket(runtime, bridge);
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.OPEN));
    client.send("to actor");
    await vi.waitFor(() => expect(runtime.sent).toEqual(["to actor"]));

    runtime.receive("to client");
    await vi.waitFor(() => expect(received).toEqual(["to client"]));

    runtime.close(1000, "done");
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.CLOSED));
  });

  it("delivers state queued before the actor returns its WebSocket upgrade", async () => {
    const NativeRequest = globalThis.Request;
    const NativeResponse = globalThis.Response;
    installWebSocketUpgradeGlobals();
    const container = await socketContainer("message-port-websocket-test");
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const client = new MessagePortWebSocket("ws://actor.test", channel.port2);
    try {
      const response = await container.run(() => {
        const pair = new container.globals.WebSocketPair();
        container.state.acceptWebSocket(pair[1]);
        pair[1].send("initial state");
        return new Response(null, { status: 101, webSocket: pair[0] });
      });
      await container.waitOutputLocks();
      const runtime = upgradeWebSocket(response)!;
      const received: MessagePortWebSocketData[] = [];
      client.addEventListener("message", (event) => received.push(event.data));

      bridgeWebSocket(runtime, bridge);
      await vi.waitFor(() => expect(received).toEqual(["initial state"]));
    } finally {
      bridge.close();
      client.close();
      container.abort();
      globalThis.Request = NativeRequest;
      globalThis.Response = NativeResponse;
    }
  });

  it("refuses a runtime socket after its MessagePort transport closed", () => {
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const runtime = new MemorySocket();
    bridge.close();

    bridgeWebSocket(runtime, bridge);

    expect(runtime.readyState).toBe(MessagePortWebSocket.CLOSED);
    channel.port2.close();
  });

  it("closes the runtime peer with the client's code and drops frames queued behind it", async () => {
    const container = await socketContainer("message-port-websocket-close");
    const pair = await container.run(() => {
      const sockets = new container.globals.WebSocketPair();
      sockets[1].accept();
      return sockets;
    });
    const peerCloses: number[] = [];
    pair[1].addEventListener("close", (event) => peerCloses.push(event.code));
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const wire = recordWire(channel.port2);
    try {
      bridgeWebSocket(upgradeWebSocket(upgradeResponse(pair[0]))!, bridge);
      await container.run(() => pair[1].send("before close"));
      await vi.waitFor(() => expect(wire).toHaveLength(1));
      await container.run(() => {
        pair[1].send("queued behind the close");
        bridge.close(1008, "client left");
      });
      await container.drainWaitUntil();

      await vi.waitFor(() => expect(peerCloses).toEqual([1008]));
      expect(wire).toEqual([
        { type: "message", data: "before close" },
        { type: "close", code: 1008, reason: "client left" },
      ]);
    } finally {
      container.abort();
      channel.port2.close();
    }
  });

  it("serves WebSocket constructors over a broker MessagePort", async () => {
    const broker = new MessageChannel();
    const runtime = new MemorySocket();
    const connection = Promise.withResolvers<UpgradeWebSocket>();
    const connect = vi.fn(async (bridge: MessagePortWebSocket) => {
      bridgeWebSocket(await connection.promise, bridge);
    });
    const stop = serveMessagePortWebSockets(broker.port2, connect);
    const BrokeredWebSocket = createMessagePortWebSocketConstructor(broker.port1);
    const client = new BrokeredWebSocket("ws://actor.test");
    const received: MessagePortWebSocketData[] = [];
    client.addEventListener("message", (event) => received.push(event.data));

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(client.readyState).toBe(MessagePortWebSocket.CONNECTING);
    connection.resolve(runtime);
    await vi.waitFor(() => expect(runtime.readyState).toBe(MessagePortWebSocket.OPEN));
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.OPEN));
    client.send("request");
    await vi.waitFor(() => expect(runtime.sent).toEqual(["request"]));

    runtime.receive("answer");
    await vi.waitFor(() => expect(received).toEqual(["answer"]));

    stop();
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.CLOSED));
  });

  it("closes a brokered client and reports the failure when connecting throws", async () => {
    const { reported, restore } = captureReported();
    const failure = new Error("WebSocket already accepted");
    const runtime = new MemorySocket();
    runtime.accept = () => {
      throw failure;
    };
    const broker = new MessageChannel();
    const connect = vi.fn(async (bridge: MessagePortWebSocket) => bridgeWebSocket(runtime, bridge));
    const stop = serveMessagePortWebSockets(broker.port2, connect);
    const BrokeredWebSocket = createMessagePortWebSocketConstructor(broker.port1);
    broker.port1.postMessage({ type: "connect", url: "ws://invalid.test" });
    const client = new BrokeredWebSocket("ws://actor.test");
    const closed = new Promise<CloseEvent>((resolve) => {
      client.addEventListener("close", resolve, { once: true });
    });
    try {
      await expect(closed).resolves.toMatchObject({
        code: 1011,
        reason: "WebSocket connection failed",
        wasClean: true,
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledWith(expect.any(MessagePortWebSocket), "ws://actor.test");
      expect(runtime.readyState).toBe(MessagePortWebSocket.CLOSED);
      await vi.waitFor(() => expect(reported).toEqual([failure]));
    } finally {
      restore();
      stop();
    }
  });

  it("closes a runtime socket that finishes connecting after the server stops", async () => {
    const broker = new MessageChannel();
    const connection = Promise.withResolvers<UpgradeWebSocket>();
    const connect = vi.fn(async (bridge: MessagePortWebSocket) => {
      bridgeWebSocket(await connection.promise, bridge);
    });
    const stop = serveMessagePortWebSockets(broker.port2, connect);
    const BrokeredWebSocket = createMessagePortWebSocketConstructor(broker.port1);
    const client = new BrokeredWebSocket("ws://actor.test");
    const runtime = new MemorySocket();

    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    stop();
    connection.resolve(runtime);

    await vi.waitFor(() => expect(runtime.readyState).toBe(MessagePortWebSocket.CLOSED));
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.CLOSED));
  });

  it("closes 1011 and rejects when no route matches", async () => {
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test/missing", channel.port1, false);
    const wire = recordWire(channel.port2);

    await expect(
      connectMessagePortWebSocket(bridge, "ws://actor.test/missing", async () => null),
    ).rejects.toThrow("No WebSocket route matched http://actor.test/missing");
    await vi.waitFor(() =>
      expect(wire).toEqual([{ type: "close", code: 1011, reason: "No WebSocket route matched" }]),
    );
    channel.port2.close();
  });

  it.each([
    { name: "keeps a 123-byte refusal", refusal: "x".repeat(123), reason: "x".repeat(123) },
    { name: "drops a 124-byte refusal", refusal: "x".repeat(124), reason: "WebSocket upgrade rejected" },
    { name: "drops a non-ASCII refusal", refusal: "Non autorisé", reason: "WebSocket upgrade rejected" },
  ])(
    "closes 1008 and $name as the reason",
    async ({ refusal, reason }) => {
      const channel = new MessageChannel();
      const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
      const wire = recordWire(channel.port2);

      await expect(
        connectMessagePortWebSocket(
          bridge,
          "ws://actor.test",
          async () => new Response(refusal, { status: 403 }),
        ),
      ).rejects.toThrow("WebSocket upgrade failed with 403 for http://actor.test/");
      await vi.waitFor(() => expect(wire).toEqual([{ type: "close", code: 1008, reason }]));
      channel.port2.close();
    },
  );

  it("closes 1011 and rethrows when routing throws", async () => {
    const failure = new Error("route failed");
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const wire = recordWire(channel.port2);

    await expect(
      connectMessagePortWebSocket(bridge, "ws://actor.test", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(wire).toEqual([{ type: "close", code: 1011, reason: "WebSocket connection failed" }]),
    );
    channel.port2.close();
  });

  it("serves fetch-routed sockets and forwards a refusal reason to the client", async () => {
    const { reported, restore } = captureReported();
    const broker = new MessageChannel();
    const runtime = new MemorySocket();
    const requests: (readonly [string, string | null])[] = [];
    const route = async (request: Request): Promise<Response> => {
      requests.push([request.url, request.headers.get("Upgrade")]);
      return new URL(request.url).pathname === "/refused"
        ? new Response("Unauthorized", { status: 401 })
        : upgradeResponse(runtime);
    };
    const stop = serveMessagePortWebSockets(broker.port2, (bridge, url) =>
      connectMessagePortWebSocket(bridge, url, route),
    );
    const BrokeredWebSocket = createMessagePortWebSocketConstructor(broker.port1);
    const refused = new BrokeredWebSocket("ws://actor.test/refused");
    const refusal = new Promise<CloseEvent>((resolve) => {
      refused.addEventListener("close", resolve, { once: true });
    });
    const client = new BrokeredWebSocket("wss://actor.test/agents/counter");
    try {
      await expect(refusal).resolves.toMatchObject({ code: 1008, reason: "Unauthorized" });
      await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.OPEN));
      client.send("request");
      await vi.waitFor(() => expect(runtime.sent).toEqual(["request"]));
      expect(requests).toEqual([
        ["http://actor.test/refused", "websocket"],
        ["https://actor.test/agents/counter", "websocket"],
      ]);
      await vi.waitFor(() => expect(reported).toHaveLength(1));
      expect(String(reported[0])).toContain("WebSocket upgrade failed with 401");
    } finally {
      restore();
      stop();
    }
  });
});
