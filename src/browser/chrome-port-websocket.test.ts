import { afterEach, expect, test, vi } from "vitest";
import {
  bindChromePortWebSocket,
  createChromePortWebSocketConstructor,
  type ChromeRuntimePort,
} from "./chrome-port-websocket";
import type { MessagePortWebSocket } from "./message-port-websocket";

/** A runtime.Port that JSON-serializes like Chrome's; `peerDisconnects()` is the far end going. */
function runtimePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const posted: unknown[] = [];
  return {
    posted,
    disconnected: false,
    emit(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    peerDisconnects() {
      for (const listener of disconnectListeners) listener();
    },
    postMessage(message: unknown) {
      posted.push(JSON.parse(JSON.stringify(message)));
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => messageListeners.add(listener),
      removeListener: (listener: (message: unknown) => void) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) => disconnectListeners.add(listener),
      removeListener: (listener: () => void) => disconnectListeners.delete(listener),
    },
  } satisfies ChromeRuntimePort & Record<string, unknown>;
}

const sockets = new Set<MessagePortWebSocket>();
afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  vi.useRealTimers();
});

function nextOpen(socket: MessagePortWebSocket): Promise<Event> {
  return new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
}

function nextClose(socket: MessagePortWebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

async function open(port = runtimePort(), probeLiveness = false) {
  const Socket = createChromePortWebSocketConstructor({ connect: () => port, probeLiveness });
  const socket = new Socket("ws://host/agents/test/name");
  sockets.add(socket);
  await nextOpen(socket);
  return { port, socket };
}

test("JSON binary codec preserves sliced views and text, and terminates liveness traffic", async () => {
  const { port, socket } = await open();
  const received: unknown[] = [];
  socket.addEventListener("message", (event) => received.push(event.data));
  socket.send(new Uint8Array([0, 1, 2, 250, 0]).subarray(1, 4));
  expect(port.posted).toEqual([{ type: "message", data: { encoding: "base64", value: "AQL6" } }]);
  port.emit(port.posted[0]);
  port.emit({ type: "message", data: "hello" });
  port.emit({ type: "ping" });
  port.emit({ type: "pong" });
  expect(received).toEqual([new Uint8Array([1, 2, 250]).buffer, "hello"]);
  expect(port.posted.at(-1)).toEqual({ type: "pong" });
});

test.each([
  null,
  { type: "message", data: "hello", extra: true },
  { type: "ping", data: "payload" },
  { type: "message", data: { encoding: "base64", value: "YQ" } },
  { type: "message", data: { encoding: "base64", value: "????" } },
  { type: "close", code: Number.NaN, reason: "bad" },
  { type: "close", code: 1000.5, reason: "bad" },
  { type: "close", code: 70_000, reason: "bad" },
  { type: "close", code: -1, reason: "bad" },
])("malformed frame closes once with an error: %j", async (frame) => {
  const { socket, port } = await open();
  const errors: Event[] = [];
  const closed: CloseEvent[] = [];
  socket.onerror = (event) => errors.push(event);
  socket.addEventListener("error", (event) => errors.push(event));
  socket.addEventListener("close", (event) => closed.push(event));
  port.emit(frame);
  port.emit({ type: "message", data: "late" });
  expect(errors).toHaveLength(2);
  expect(closed).toHaveLength(1);
  expect(closed[0]).toMatchObject({ code: 1002, wasClean: false });
  expect(port.posted).toEqual([
    { type: "close", code: 1002, reason: "invalid runtime port message" },
  ]);
});

test("a local close follows the frames sent before it and disconnects the port", async () => {
  const { port, socket } = await open();
  socket.send("admitted input");
  socket.close(4000, "finished");
  expect(port.posted).toEqual([
    { type: "message", data: "admitted input" },
    { type: "close", code: 4000, reason: "finished" },
  ]);
  expect(port.disconnected).toBe(true);
});

test("a remote close frame closes the socket cleanly with its reason", async () => {
  const { port, socket } = await open();
  const closed: CloseEvent[] = [];
  socket.addEventListener("close", (event) => closed.push(event));
  port.emit({ type: "close", code: 4001, reason: "peer finished" });
  expect(closed).toHaveLength(1);
  expect(closed[0]).toMatchObject({ code: 4001, reason: "peer finished", wasClean: true });
});

test("a send on a dead port returns before the socket reports its close", async () => {
  const { port, socket } = await open();
  const events: string[] = [];
  const closed = nextClose(socket);
  socket.addEventListener("close", (event) => events.push(`close ${event.code}`));
  port.postMessage = () => {
    throw new Error("Attempting to use a disconnected port object");
  };
  socket.send("first");
  socket.send("second");
  events.push("sent");
  expect(socket.readyState).toBe(socket.OPEN);
  await closed;
  expect(events).toEqual(["sent", "close 1006"]);
  expect(socket.readyState).toBe(socket.CLOSED);
});

test("a replaced CONNECTING socket shares the readiness deadline without waking the host", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const port = runtimePort();
  const beforeConnect = vi.fn(async () => (Date.now() < 500 ? 500 : undefined));
  const connect = vi.fn(() => port);
  const Socket = createChromePortWebSocketConstructor({
    connect,
    beforeConnect,
    probeLiveness: false,
  });
  const first = new Socket("ws://host/a");
  sockets.add(first);
  await vi.advanceTimersByTimeAsync(10);
  first.close();
  const replacement = new Socket("ws://host/a");
  sockets.add(replacement);
  await vi.advanceTimersByTimeAsync(200);
  expect(beforeConnect).toHaveBeenCalledTimes(1);
  expect(connect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(beforeConnect).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(replacement.readyState).toBe(Socket.OPEN);
});

test("liveness probes detect a lost disconnect; ordinary replies reset the deadline", async () => {
  vi.useFakeTimers();
  const { port, socket } = await open(undefined, true);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(port.posted).toEqual([{ type: "ping" }, { type: "ping" }, { type: "ping" }]);
  expect(socket.readyState).toBe(socket.OPEN);
  port.emit({ type: "message", data: "still alive" });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(socket.readyState).toBe(socket.OPEN);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(vi.getTimerCount()).toBe(0);
});

test("a service-worker connection sends no probes, and closing in onopen leaves no timers", async () => {
  vi.useFakeTimers();
  const { port } = await open();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(port.posted).toEqual([]);
  const Socket = createChromePortWebSocketConstructor({ connect: runtimePort });
  const socket = new Socket("ws://host/a");
  sockets.add(socket);
  socket.onopen = () => socket.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.readyState).toBe(Socket.CLOSED);
  expect(vi.getTimerCount()).toBe(0);
});

test("a readiness failure reports an error, then an unclean 1011 close", async () => {
  const Socket = createChromePortWebSocketConstructor({
    connect: runtimePort,
    beforeConnect: async () => {
      throw new Error("host unavailable");
    },
  });
  const socket = new Socket("ws://host/a");
  sockets.add(socket);
  const events: string[] = [];
  socket.addEventListener("error", () => events.push("error"));
  const closed = await nextClose(socket);
  expect(events).toEqual(["error"]);
  expect(closed).toMatchObject({ code: 1011, reason: "host unavailable", wasClean: false });
});

test("a readiness failure after the app closed a CONNECTING socket reports nothing", async () => {
  const readiness = Promise.withResolvers<number | void>();
  const Socket = createChromePortWebSocketConstructor({
    connect: runtimePort,
    beforeConnect: () => readiness.promise,
  });
  const socket = new Socket("ws://host/a");
  sockets.add(socket);
  const events: string[] = [];
  socket.onerror = () => events.push("onerror");
  socket.addEventListener("error", () => events.push("error"));
  socket.addEventListener("close", (event) => events.push(`close ${event.code}`));
  socket.close();
  readiness.reject(new Error("host unavailable"));
  // Nothing should fire, so there is no event to await: let the rejection settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["close 1000"]);
});

test("a peer disconnect closes once with runtime.lastError as the reason", () => {
  const port = runtimePort();
  const onClose = vi.fn();
  const peer = bindChromePortWebSocket(port, {
    onMessage: () => {},
    onClose,
    readLastError: () => "context gone",
  });
  port.peerDisconnects();
  peer.close();
  expect(onClose).toHaveBeenCalledExactlyOnceWith({
    code: 1006,
    reason: "context gone",
    wasClean: false,
  });
});
