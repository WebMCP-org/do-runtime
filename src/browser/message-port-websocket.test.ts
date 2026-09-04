import { describe, expect, it, vi } from "vitest";
import type { UpgradeWebSocket } from "../browser";
import {
  MessagePortWebSocket,
  bridgeWebSocket,
  createMessagePortWebSocketConstructor,
  serveMessagePortWebSockets,
  type MessagePortWebSocketData,
  type MessagePortWebSocketWireMessage,
} from "./message-port-websocket";

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
    const connection = Promise.withResolvers<UpgradeWebSocket>();
    const connect = vi.fn(() => connection.promise);
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

  it("closes a brokered client when its runtime connection fails", async () => {
    const broker = new MessageChannel();
    const connect = vi.fn(async () => {
      throw new Error("route failed");
    });
    const stop = serveMessagePortWebSockets(broker.port2, connect);
    const BrokeredWebSocket = createMessagePortWebSocketConstructor(broker.port1);
    broker.port1.postMessage({ type: "connect", url: "ws://invalid.test" });
    const client = new BrokeredWebSocket("ws://actor.test");
    const closed = new Promise<CloseEvent>((resolve) => {
      client.addEventListener("close", resolve, { once: true });
    });

    await expect(closed).resolves.toMatchObject({
      code: 1011,
      reason: "WebSocket connection failed",
      wasClean: true,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith("ws://actor.test");
    stop();
  });

  it("closes a runtime socket that finishes connecting after the server stops", async () => {
    const broker = new MessageChannel();
    const connection = Promise.withResolvers<UpgradeWebSocket>();
    const connect = vi.fn(() => connection.promise);
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
});
