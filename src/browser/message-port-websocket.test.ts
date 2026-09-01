import { describe, expect, it, vi } from "vitest";
import {
  MessagePortWebSocket,
  bridgeWebSocket,
  createMessagePortWebSocket,
  serveMessagePortWebSockets,
  type AcceptingWebSocket,
  type MessagePortWebSocketData,
  type MessagePortWebSocketWireMessage,
} from "./message-port-websocket";

class MemorySocket extends EventTarget implements AcceptingWebSocket {
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
    expect([...new Uint8Array(messages[0] as ArrayBuffer)]).toEqual([7, 8, 9]);

    socket.close();
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

  it("refuses a runtime socket after its MessagePort transport closed", () => {
    const channel = new MessageChannel();
    const bridge = new MessagePortWebSocket("ws://actor.test", channel.port1, false);
    const runtime = new MemorySocket();
    bridge.close();

    bridgeWebSocket(runtime, bridge);

    expect(runtime.readyState).toBe(MessagePortWebSocket.CLOSED);
    channel.port2.close();
  });

  it("serves WebSocket constructors over a broker MessagePort", async () => {
    const broker = new MessageChannel();
    const runtime = new MemorySocket();
    const connection = Promise.withResolvers<AcceptingWebSocket>();
    const stop = serveMessagePortWebSockets(broker.port2, () => connection.promise);
    const BrokeredWebSocket = createMessagePortWebSocket(broker.port1);
    const client = new BrokeredWebSocket("ws://actor.test");
    const received: MessagePortWebSocketData[] = [];
    client.addEventListener("message", (event) => received.push(event.data));

    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("closes a brokered client when its runtime connection fails", async () => {
    const broker = new MessageChannel();
    const stop = serveMessagePortWebSockets(broker.port2, async () => {
      throw new Error("route failed");
    });
    const BrokeredWebSocket = createMessagePortWebSocket(broker.port1);
    const client = new BrokeredWebSocket("ws://actor.test");
    const closed = new Promise<CloseEvent>((resolve) => {
      client.addEventListener("close", resolve, { once: true });
    });

    await expect(closed).resolves.toMatchObject({
      code: 1011,
      reason: "WebSocket connection failed",
      wasClean: true,
    });
    stop();
  });

  it("closes a runtime socket that finishes connecting after the server stops", async () => {
    const broker = new MessageChannel();
    const connection = Promise.withResolvers<AcceptingWebSocket>();
    const stop = serveMessagePortWebSockets(broker.port2, () => connection.promise);
    const BrokeredWebSocket = createMessagePortWebSocket(broker.port1);
    const client = new BrokeredWebSocket("ws://actor.test");
    const runtime = new MemorySocket();

    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    connection.resolve(runtime);

    await vi.waitFor(() => expect(runtime.readyState).toBe(MessagePortWebSocket.CLOSED));
    await vi.waitFor(() => expect(client.readyState).toBe(MessagePortWebSocket.CLOSED));
  });
});
