import { afterEach, expect, test, vi } from "vitest";
import { RpcTarget } from "../api/cloudflare-workers";
import { bindChromePortWebSocket, type ChromeRuntimePort } from "./chrome-port-websocket";
import { MessagePortWebSocket, type MessagePortWebSocketWireMessage } from "./message-port-websocket";
import { BrowserWorkerSupervisor, type BrowserWorkerHostContext } from "./worker-supervisor";
import {
  serveBrowserWorker,
  type BrowserWorkerEvent,
  type BrowserWorkerScope,
  type WorkerHibernationSnapshot,
  type WorkerRehydrationSnapshot,
} from "./worker-protocol";

type Configuration = { key: string; fail?: boolean };
class Host extends RpcTarget {
  constructor(readonly ready: Promise<void>) { super(); }
  beforeReady(): Promise<void> { return this.ready; }
}

class Service extends RpcTarget {
  readonly sockets = new Map<string, MessagePortWebSocket>();
  readonly messages: string[] = [];
  invalidSnapshot = false;
  snapshotGate: Promise<void> = Promise.resolve();

  constructor(readonly generation: number) { super(); }
  identity(): number { return this.generation; }
  async prepareHibernation(): Promise<WorkerHibernationSnapshot> {
    await this.snapshotGate;
    return {
      root: {
        autoResponse: null,
        sockets: [...this.sockets.keys()].slice(this.invalidSnapshot ? 1 : 0).map((id) => ({ id, tags: [id] })),
      },
      facets: [],
    };
  }
  attach(id: string, url: string, port: MessagePort): void {
    const socket = new MessagePortWebSocket(url, port);
    this.sockets.set(id, socket);
    socket.addEventListener("message", (event) => {
      this.messages.push(String(event.data));
      socket.send(event.data);
    });
    socket.addEventListener("close", () => this.sockets.delete(id));
  }
}

class WorkerScope extends EventTarget implements BrowserWorkerScope {
  constructor(private readonly publish: (message: BrowserWorkerEvent) => void) { super(); }
  postMessage(message: BrowserWorkerEvent): void { this.publish(message); }
}
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}

/** Worker is the platform boundary: bootstrap, RPC sessions and socket endpoints are real. */
class TestWorker extends EventTarget implements Worker {
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  onerror: Worker["onerror"] = null;
  readonly scope: WorkerScope;
  readonly service: Service;
  readonly errors: unknown[] = [];
  readonly ports = new Set<MessagePort>();
  readonly server: Disposable;
  terminated = false;

  constructor(generation: number, parseConfiguration = (value: unknown): Configuration => {
    if (value === null || typeof value !== "object" || !("key" in value) || typeof value.key !== "string") {
      throw new TypeError("Invalid worker configuration");
    }
    const fail = "fail" in value ? value.fail : undefined;
    if (fail !== undefined && typeof fail !== "boolean") throw new TypeError("Invalid failure fixture flag");
    return { key: value.key, ...(fail === undefined ? {} : { fail }) };
  }) {
    super();
    this.service = new Service(generation);
    this.scope = new WorkerScope((message) => queueMicrotask(() => this.deliver(message)));
    this.server = serveBrowserWorker<Configuration, Host>({
      scope: this.scope,
      parseConfiguration,
      initialize: async (configuration, host, snapshot) => {
        if (configuration.fail) throw new Error("actor construction failed");
        await host.beforeReady();
        for (const placement of snapshot ? [snapshot.root, ...snapshot.facets] : []) {
          for (const socket of placement.sockets) this.service.attach(socket.id, socket.url, socket.port);
        }
        return this.service;
      },
      connect: async ({ id, url, port }) => this.service.attach(id, url, port),
      onError: (error) => this.errors.push(error),
    });
  }

  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    if (this.terminated) throw new Error("Worker already terminated");
    const transfer = Array.isArray(options) ? options : options?.transfer;
    const data: unknown = structuredClone(message, transfer ? { transfer } : {});
    // Track the physical endpoints only to emulate worker termination without JS close frames.
    if (typeof data === "object" && data !== null) {
      for (const value of Object.values(data)) if (value instanceof MessagePort) this.ports.add(value);
      if ("rehydration" in data && data.rehydration) {
        const snapshot = data.rehydration as WorkerRehydrationSnapshot;
        for (const part of [snapshot.root, ...snapshot.facets]) {
          for (const socket of part.sockets) this.ports.add(socket.port);
        }
      }
    }
    queueMicrotask(() => {
      if (!this.terminated) this.scope.dispatchEvent(new MessageEvent("message", { data }));
    });
  }
  deliver(message: BrowserWorkerEvent): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.server[Symbol.dispose]();
    for (const port of this.ports) port.close();
  }
}
interface TestWorker {
  addEventListener<K extends keyof WorkerEventMap>(type: K, listener: (event: WorkerEventMap[K]) => void): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}

const supervisors = new Set<BrowserWorkerSupervisor<Configuration, Service>>();
afterEach(() => {
  for (const supervisor of supervisors) supervisor[Symbol.dispose]();
  supervisors.clear();
  vi.useRealTimers();
});

function fixture(options: {
  ready?: Promise<void>;
  removeStorage?: (configuration: Configuration) => Promise<void>;
  discarded?: (configuration: Configuration, reason: string) => void;
  parseConfiguration?: (value: unknown) => Configuration;
} = {}) {
  const workers: TestWorker[] = [];
  const contexts: BrowserWorkerHostContext[] = [];
  const supervisor = new BrowserWorkerSupervisor<Configuration, Service>({
    key: (configuration) => configuration.key,
    createWorker: () => {
      const worker = new TestWorker(workers.length + 1, options.parseConfiguration);
      workers.push(worker);
      return worker;
    },
    hostExports: (_configuration, context) => {
      contexts.push(context);
      return new Host(options.ready ?? Promise.resolve());
    },
    removeStorage: options.removeStorage ?? (async () => {}),
    ...(options.discarded && { discarded: options.discarded }),
    idleGraceMs: 60_000,
  });
  supervisors.add(supervisor);
  return { supervisor, workers, contexts };
}

function peer() {
  const messages: MessagePortWebSocketWireMessage[] = [];
  const closed = vi.fn();
  return { messages, send: (message: MessagePortWebSocketWireMessage) => messages.push(message), close: closed };
}
const configuration: Configuration = { key: "employee/thread" };
const url = "ws://host/agents/test/thread";

test("readiness failure and stop reject callers, and stale ready cannot revive a replaced placement", async () => {
  const { supervisor, workers } = fixture();
  await expect(supervisor.resolve({ key: "failed", fail: true })).rejects.toThrow("actor construction failed");
  expect(supervisor.size).toBe(0);
  const ready = Promise.withResolvers<void>();
  const next = fixture({ ready: ready.promise });
  const pending = next.supervisor.ensure(configuration);
  next.supervisor.stop(configuration, "explicit stop");
  await expect(pending.ready).rejects.toThrow("explicit stop");
  next.workers[0]!.deliver({ type: "ready" });
  expect(next.supervisor.size).toBe(0);
  expect(workers[0]!.terminated).toBe(true);
});

test("socket frames queue until ready and the same transport resumes on a new generation", async () => {
  const ready = Promise.withResolvers<void>();
  const { supervisor, workers } = fixture({ ready: ready.promise });
  const client = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  socket.receive({ type: "message", data: "queued" });
  expect(client.messages).toEqual([]);
  ready.resolve();
  await vi.waitFor(() => expect(client.messages).toEqual([{ type: "message", data: "queued" }]));
  const reference = supervisor.reference(configuration);
  const first = await reference.resolve();
  expect(await first.identity()).toBe(1);
  first[Symbol.dispose]();
  expect(await supervisor.hibernate(configuration)).toBe(true);
  expect(workers[0]!.terminated).toBe(true);
  expect(client.close).not.toHaveBeenCalled();
  socket.receive({ type: "message", data: "restored" });
  await vi.waitFor(() => expect(client.messages.at(-1)).toEqual({ type: "message", data: "restored" }));
  const second = await reference.resolve();
  expect(await second.identity()).toBe(2);
  second[Symbol.dispose]();
  expect(workers[1]!.service.sockets.size).toBe(1);
  socket.close(4000, "finished");
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
});

test("a frame arriving during snapshot prevents eviction and flushes in order", async () => {
  const { supervisor, workers } = fixture();
  const client = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  const snapshot = Promise.withResolvers<void>();
  workers[0]!.service.snapshotGate = snapshot.promise;
  const hibernation = supervisor.hibernate(configuration);
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.receive({ type: "message", data: "first" });
  socket.receive({ type: "message", data: "second" });
  snapshot.resolve();
  expect(await hibernation).toBe(false);
  await vi.waitFor(() => expect(client.messages).toEqual([
    { type: "message", data: "first" }, { type: "message", data: "second" },
  ]));
  expect(supervisor.size).toBe(1);
});

test("snapshot identity mismatch leaves the current worker and transport usable", async () => {
  const { supervisor, workers } = fixture();
  const client = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  workers[0]!.service.invalidSnapshot = true;
  expect(await supervisor.hibernate(configuration)).toBe(false);
  socket.receive({ type: "message", data: "still here" });
  await vi.waitFor(() => expect(client.messages.at(-1)).toEqual({ type: "message", data: "still here" }));
});

test("deletion invalidates old logical references and blocks new descendants until physical removal", async () => {
  const removing = Promise.withResolvers<void>();
  const removed: string[] = [];
  const { supervisor, workers } = fixture({ removeStorage: async ({ key }) => { removed.push(key); await removing.promise; } });
  const reference = supervisor.reference(configuration);
  const first = await reference.resolve();
  first[Symbol.dispose]();
  const deletion = supervisor.delete({ key: "employee" }, ({ key }) => key === "employee" || key.startsWith("employee/"));
  await expect(reference.resolve()).rejects.toThrow("stale");
  expect(() => supervisor.ensure({ key: "employee/new-thread" })).toThrow("being deleted");
  let resolved = false;
  const newReference = supervisor.reference({ key: "employee/new-thread" });
  const afterDeletion = newReference.resolve().then((value) => { resolved = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toBe(false);
  expect(workers[0]!.terminated).toBe(true);
  removing.resolve();
  await deletion;
  const next = await afterDeletion;
  expect(await next.identity()).toBe(2);
  next[Symbol.dispose]();
  expect(removed.sort()).toEqual(["employee", "employee/thread"]);
});

test("deletion is fenced before discarded callbacks can reenter placement", async () => {
  let reentry: unknown;
  const { supervisor } = fixture({ discarded: (configuration) => {
    try { supervisor.ensure(configuration); } catch (error) { reentry = error; }
  } });
  const service = await supervisor.resolve(configuration);
  service[Symbol.dispose]();
  await supervisor.delete(configuration);
  expect(reentry).toBeInstanceOf(Error);
  expect(supervisor.size).toBe(0);
});

test("configuration rejection fails readiness instead of leaving a caller pending", async () => {
  const { supervisor, workers } = fixture({ parseConfiguration: () => { throw new Error("configuration rejected"); } });
  let failure: unknown;
  void supervisor.resolve(configuration).catch((error: unknown) => { failure = error; });
  await vi.waitFor(() => expect(workers[0]!.errors).toHaveLength(1));
  await vi.waitFor(() => expect(failure).toBeInstanceOf(Error), { timeout: 200 });
  expect(String(failure)).toContain("configuration rejected");
});


test("a closed peer wakes hibernated state once to deliver its terminal frame", async () => {
  const { supervisor, workers } = fixture();
  const client = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  expect(await supervisor.hibernate(configuration)).toBe(true);
  socket.close(4000, "peer closed while asleep");
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(workers[1]!.service.sockets.size).toBe(0));
  expect(await supervisor.hibernate(configuration)).toBe(true);
});

test("duplicate transport ids retire the previous connection and allow a normal retry", async () => {
  const { supervisor, workers } = fixture();
  const first = peer();
  supervisor.connect(configuration, { id: "socket", url, peer: first });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  const duplicate = peer();
  supervisor.connect(configuration, { id: "socket", url, peer: duplicate });
  expect(first.messages.at(-1)).toMatchObject({ type: "close", code: 1008 });
  expect(duplicate.messages.at(-1)).toMatchObject({ type: "close", code: 1012 });
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(0));
  const replacement = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: replacement });
  socket.receive({ type: "message", data: "retry" });
  await vi.waitFor(() => expect(replacement.messages).toContainEqual({ type: "message", data: "retry" }));
});

test("old generation lifecycle reports cannot evict its replacement", async () => {
  const { supervisor, contexts } = fixture();
  const first = await supervisor.resolve(configuration);
  first[Symbol.dispose]();
  supervisor.stop(configuration);
  const second = await supervisor.resolve(configuration);
  second[Symbol.dispose]();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  contexts[0]!.reportLifecycle("idle");
  expect(vi.getTimerCount()).toBe(0);
  contexts[1]!.reportLifecycle("idle");
  expect(vi.getTimerCount()).toBe(1);
});

test("a throwing cleanup callback cannot strand a deletion barrier", async () => {
  let throwCleanup = true;
  const removeStorage = vi.fn(async (_configuration: Configuration) => {});
  const { supervisor, workers } = fixture({ removeStorage, discarded: () => {
    if (throwCleanup) { throwCleanup = false; throw new Error("cleanup failed"); }
  } });
  const client = peer();
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  let deletion: Promise<void> | undefined;
  expect(() => { deletion = supervisor.delete(configuration); }).not.toThrow();
  await expect(deletion).rejects.toThrow("cleanup failed");
  expect(client.messages).toEqual([{ type: "close", code: 1001, reason: "Worker deleted" }]);
  expect(client.close).toHaveBeenCalledOnce();
  expect(workers[0]!.terminated).toBe(true);
  expect(removeStorage).toHaveBeenCalledExactlyOnceWith(configuration);
  socket.receive({ type: "message", data: "retired" });
  expect(workers).toHaveLength(1);
  expect(() => supervisor.ensure(configuration)).not.toThrow();
});

test.each(["live", "hibernated"])("deleting %s state sends going-away and retires a broken Chrome transport before storage removal", async (state) => {
  const removeStorage = vi.fn(async (_configuration: Configuration) => {});
  const { supervisor, workers } = fixture({ removeStorage });
  const port = {
    postMessage: vi.fn((_message: unknown) => { throw new Error("Chrome port disconnected"); }),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
  } satisfies ChromeRuntimePort;
  const client = bindChromePortWebSocket(port, {
    onMessage: (message) => socket.receive(message),
    onClose: ({ code, reason }) => socket.close(code, reason),
  });
  const socket = supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  if (state === "hibernated") {
    expect(await supervisor.hibernate(configuration)).toBe(true);
    expect(workers[0]!.terminated).toBe(true);
  }
  await supervisor.delete(configuration);
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "close", code: 1001, reason: "Worker deleted" });
  expect(port.disconnect).toHaveBeenCalledOnce();
  expect(removeStorage).toHaveBeenCalledExactlyOnceWith(configuration);
  expect(workers[0]!.terminated).toBe(true);
  socket.receive({ type: "message", data: "retired" });
  socket.close();
  expect(supervisor.size).toBe(0);
  expect(workers).toHaveLength(1);
});

test("ordinary stop keeps its failure close code", async () => {
  const { supervisor, workers } = fixture();
  const client = peer();
  supervisor.connect(configuration, { id: "socket", url, peer: client });
  await supervisor.ensure(configuration).ready;
  await vi.waitFor(() => expect(workers[0]!.service.sockets.size).toBe(1));
  supervisor.stop(configuration);
  expect(client.messages).toEqual([{ type: "close", code: 1011, reason: "Worker stopped" }]);
  expect(client.close).toHaveBeenCalledOnce();
  expect(workers[0]!.terminated).toBe(true);
});
