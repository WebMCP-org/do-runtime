import { afterEach, expect, test, vi } from "vitest";
import {
  bindChromePortWebSocket,
  createChromePortWebSocketConstructor,
  type ChromeRuntimePort
} from "./chrome-port-websocket";
import type { MessagePortWebSocket } from "./message-port-websocket";

function runtimePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const posted: unknown[] = [];
  const port = {
    posted,
    emit(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    postMessage(message: unknown) {
      posted.push(JSON.parse(JSON.stringify(message)));
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
    onMessage: {
      addListener: (listener: (message: unknown) => void) => {
        messageListeners.add(listener);
      },
      removeListener: (listener: (message: unknown) => void) => {
        messageListeners.delete(listener);
      }
    },
    onDisconnect: {
      addListener: (listener: () => void) => {
        disconnectListeners.add(listener);
      },
      removeListener: (listener: () => void) => {
        disconnectListeners.delete(listener);
      }
    }
  } satisfies ChromeRuntimePort & {
    posted: unknown[];
    emit(message: unknown): void;
  };
  return port;
}

const sockets = new Set<MessagePortWebSocket>();
afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  vi.useRealTimers();
});

async function open(port = runtimePort(), probeLiveness = false) {
  const Socket = createChromePortWebSocketConstructor({
    connect: () => port,
    probeLiveness
  });
  const socket = new Socket("ws://host/agents/test/name");
  sockets.add(socket);
  await vi.waitFor(() => expect(socket.readyState).toBe(Socket.OPEN));
  return { port, socket };
}

test("JSON binary codec preserves sliced views and text, and terminates liveness traffic", async () => {
  const { port, socket } = await open();
  const received: unknown[] = [];
  socket.addEventListener("message", (event) => received.push(event.data));
  socket.send(new Uint8Array([0, 1, 2, 250, 0]).subarray(1, 4));
  await vi.waitFor(() =>
    expect(port.posted).toEqual([
      { type: "message", data: { encoding: "base64", value: "AQL6" } }
    ])
  );
  port.emit(port.posted[0]);
  port.emit({ type: "message", data: "hello" });
  port.emit({ type: "ping" });
  port.emit({ type: "pong" });
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toEqual(new Uint8Array([1, 2, 250]).buffer);
  expect(received[1]).toBe("hello");
  expect(port.posted.at(-1)).toEqual({ type: "pong" });
});

test.each([
  null,
  { type: "message", data: "hello", extra: true },
  { type: "ping", data: "payload" },
  { type: "message", data: { encoding: "base64", value: "YQ" } },
  { type: "message", data: { encoding: "base64", value: "????" } },
  { type: "close", code: Number.NaN, reason: "bad" }
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
});

test("local and remote clean close forward their reason and detach before disconnect", async () => {
  const local = await open();
  local.socket.close(4000, "finished");
  expect(local.port.posted).toEqual([
    { type: "close", code: 4000, reason: "finished" }
  ]);
  const remote = await open();
  const closed: CloseEvent[] = [];
  remote.socket.addEventListener("close", (event) => closed.push(event));
  remote.port.emit({ type: "close", code: 4001, reason: "peer finished" });
  await vi.waitFor(() => expect(closed).toHaveLength(1));
  expect(closed[0]).toMatchObject({
    code: 4001,
    reason: "peer finished",
    wasClean: true
  });
});

test("closing immediately after send preserves frame order", async () => {
  const { port, socket } = await open();
  socket.send("admitted input");
  socket.close(1000, "finished");
  expect(port.posted).toEqual([
    { type: "message", data: "admitted input" },
    { type: "close", code: 1000, reason: "finished" }
  ]);
});

test("a replaced CONNECTING socket shares the readiness deadline without waking the host", async () => {
  vi.useFakeTimers();
  const port = runtimePort();
  const beforeConnect = vi.fn(async () => (Date.now() < 500 ? 500 : undefined));
  vi.setSystemTime(0);
  const connect = vi.fn(() => port);
  const Socket = createChromePortWebSocketConstructor({
    connect,
    beforeConnect,
    probeLiveness: false
  });
  const first = new Socket("ws://host/a");
  sockets.add(first);
  await vi.advanceTimersByTimeAsync(10);
  first.close();
  const next = new Socket("ws://host/a");
  sockets.add(next);
  await vi.advanceTimersByTimeAsync(200);
  expect(beforeConnect).toHaveBeenCalledTimes(1);
  expect(connect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(beforeConnect).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(next.readyState).toBe(Socket.OPEN);
});

test("liveness probes detect a lost disconnect; ordinary replies reset the deadline", async () => {
  vi.useFakeTimers();
  const { port, socket } = await open(undefined, true);
  await vi.advanceTimersByTimeAsync(6_000);
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

test("readiness failures and disconnect errors preserve the native error and close events", async () => {
  const Socket = createChromePortWebSocketConstructor({
    connect: runtimePort,
    beforeConnect: async () => {
      throw new Error("host unavailable");
    }
  });
  const socket = new Socket("ws://host/a");
  sockets.add(socket);
  const errors: Event[] = [];
  const closed: CloseEvent[] = [];
  socket.addEventListener("error", (event) => errors.push(event));
  socket.addEventListener("close", (event) => closed.push(event));
  await vi.waitFor(() => expect(closed).toHaveLength(1));
  expect(errors).toHaveLength(1);
  expect(closed[0]).toMatchObject({
    code: 1011,
    reason: "host unavailable",
    wasClean: false
  });
  const port = runtimePort();
  const onClose = vi.fn();
  const peer = bindChromePortWebSocket(port, {
    onMessage: () => {},
    onClose,
    readLastError: () => "context gone"
  });
  port.disconnect();
  peer.close();
  expect(onClose).toHaveBeenCalledExactlyOnceWith({
    code: 1006,
    reason: "context gone",
    wasClean: false
  });
});
