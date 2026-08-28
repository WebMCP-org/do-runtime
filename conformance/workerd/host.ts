/**
 * The workerd lane: the oracle. This package is deliberately not loaded here —
 * every assertion is measuring Cloudflare's runtime.
 */

import { env, evictDurableObject } from "cloudflare:test";
import type {
  Capability,
  ConformanceHost,
  LaneClientSocket,
  LaneSocketMessage,
  ProbeActor,
} from "../host";

type ProbeNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub & Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const probes = () => (env as unknown as { PROBE: ProbeNamespace }).PROBE;

let probeCounter = 0;

/**
 * A fresh stub each time. Re-getting by the same name is what `respawn` needs:
 * same durable identity, new instance — which is exactly how the transaction
 * rows read state back after `ctx.abort` destroyed the actor.
 */
function actor(name: string): ProbeActor {
  const namespace = probes();
  const stub = namespace.get(namespace.idFromName(name));
  const invoke = (method: string, args: readonly unknown[]) => {
    const fn = stub[method];
    if (!fn) throw new Error(`Probe has no method ${method}`);
    return fn(...args);
  };
  return {
    name,
    call: <T,>(method: string, ...args: readonly unknown[]) => invoke(method, args) as Promise<T>,
    post: (method: string, ...args: readonly unknown[]) => ({
      settled: invoke(method, args),
    }),
  };
}

function stubFor(actor: ProbeActor): DurableObjectStub {
  const namespace = probes();
  return namespace.get(namespace.idFromName(actor.name));
}

function clientSocket(socket: WebSocket): LaneClientSocket {
  const messages: LaneSocketMessage[] = [];
  const messageWaiters: ((message: LaneSocketMessage) => void)[] = [];
  const closes: { code: number; reason: string; wasClean: boolean }[] = [];
  const closeWaiters: ((event: { code: number; reason: string; wasClean: boolean }) => void)[] = [];

  socket.accept();
  socket.addEventListener("message", (event) => {
    const message = event.data as LaneSocketMessage;
    const waiter = messageWaiters.shift();
    if (waiter === undefined) messages.push(message);
    else waiter(message);
  });
  socket.addEventListener("close", (event) => {
    const closed = { code: event.code, reason: event.reason, wasClean: event.wasClean };
    const waiter = closeWaiters.shift();
    if (waiter === undefined) closes.push(closed);
    else waiter(closed);
  });

  return {
    get readyState() {
      return socket.readyState;
    },
    send: async (data) => {
      socket.send(data);
    },
    close: async (code, reason) => {
      socket.close(code, reason);
    },
    nextMessage: async () =>
      messages.shift() ??
      (await new Promise<LaneSocketMessage>((resolve) => {
        messageWaiters.push(resolve);
      })),
    nextClose: async () =>
      closes.shift() ??
      (await new Promise<{ code: number; reason: string; wasClean: boolean }>((resolve) => {
        closeWaiters.push(resolve);
      })),
  };
}

export const host: ConformanceHost = {
  lane: "workerd",
  capabilities: new Set<Capability>(["bookmarks"]),
  spawn: async (name = `probe-${probeCounter++}`) => actor(name),
  respawn: async (a) => actor(a.name),
  connect: async (target, tags = []) => {
    const url = new URL("http://probe/hibernation");
    for (const tag of tags) url.searchParams.append("tag", tag);
    const response = await stubFor(target).fetch(url, { headers: { Upgrade: "websocket" } });
    if (response.status !== 101 || response.webSocket === null) {
      throw new Error(`Probe upgrade failed with status ${response.status}.`);
    }
    return clientSocket(response.webSocket);
  },
  evict: async (target) => {
    await evictDurableObject(stubFor(target), { webSockets: "hibernate" });
  },
};
