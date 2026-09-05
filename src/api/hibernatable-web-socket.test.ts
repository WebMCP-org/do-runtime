import { describe, expect, test, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import type { Timer } from "../io/io-context";
import type { InputGateHooks, OutputGateHooks } from "../io/io-gate";
import {
  createActorContainer,
  noFacets,
  type ActorContainer,
  type ActorContainerOptions,
  type HibernationHost,
} from "../server/actor-container";
import { HibernationMirror } from "../server/hibernation-mirror";
import type { RawWebSocket } from "./web-socket";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(handle);
        reject(signal.reason);
      });
    }),
};

const alarms = { scheduleRun: (): Promise<void> => Promise.resolve() };

function options(overrides: Partial<ActorContainerOptions> = {}): ActorContainerOptions {
  return {
    id: "socket-actor",
    uniqueKey: "hibernatable-web-socket-test",
    exports: {},
    env: {},
    ports: {
      sql: createNodeSqlProvider(),
      alarms,
      facets: noFacets,
      timer,
    },
    ...overrides,
  };
}

async function quiesce(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

type SocketLike = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

class RawEndpoint extends EventTarget implements RawWebSocket, WebSocket {
  readonly READY_STATE_CONNECTING = 0;
  readonly READY_STATE_OPEN = 1;
  readonly READY_STATE_CLOSING = 2;
  readonly READY_STATE_CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";
  readonly readyState = 1;
  readonly url = "";
  binaryType: "blob" | "arraybuffer" = "blob";
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  peer!: RawEndpoint;

  accept(): void {}

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.peer.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    this.peer.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  serializeAttachment(): void {}

  deserializeAttachment(): null {
    return null;
  }
}

function rawPair(): [client: RawEndpoint, server: RawEndpoint] {
  const client = new RawEndpoint();
  const server = new RawEndpoint();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

class SocketActor {
  readonly messages: Record<string, unknown>[] = [];
  readonly constructorSockets: Record<string, unknown>[];

  constructor(readonly ctx: DurableObjectState) {
    this.constructorSockets = ctx.getWebSockets().map((socket) => ({
      tags: ctx.getTags(socket),
      attachment: (socket as SocketLike).deserializeAttachment(),
    }));
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.messages.push({
      message,
      tags: this.ctx.getTags(socket),
      attachment: (socket as SocketLike).deserializeAttachment(),
      listed: this.ctx.getWebSockets().includes(socket),
    });
    socket.send("ack");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}

class RawSocketActor {
  readonly messages: (string | ArrayBuffer)[] = [];

  constructor(readonly ctx: DurableObjectState) {}

  webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): void {
    this.messages.push(message);
  }
}

type MirrorEntry = {
  socket: RawWebSocket;
  tags: readonly string[];
  attachment?: Uint8Array;
  autoResponseTimestamp?: number;
};

function recorder(): {
  host: HibernationHost;
  entries: Map<RawWebSocket, MirrorEntry>;
  accepted: ReturnType<typeof vi.fn>;
  attached: ReturnType<typeof vi.fn>;
  autoResponse: ReturnType<typeof vi.fn>;
  closed: ReturnType<typeof vi.fn>;
} {
  const entries = new Map<RawWebSocket, MirrorEntry>();
  const accepted = vi.fn((socket: RawWebSocket, tags: readonly string[]) => {
    entries.set(socket, { socket, tags: [...tags] });
  });
  const attached = vi.fn((socket: RawWebSocket, bytes: Uint8Array | null) => {
    const entry = entries.get(socket);
    if (entry === undefined) throw new Error("attachment mirrored before acceptance");
    if (bytes === null) delete entry.attachment;
    else entry.attachment = bytes.slice();
  });
  const autoResponse = vi.fn();
  const closed = vi.fn((socket: RawWebSocket) => {
    entries.delete(socket);
  });
  return {
    entries,
    accepted,
    attached,
    autoResponse,
    closed,
    host: { accepted, attachment: attached, autoResponse, closed },
  };
}

async function started(
  overrides: Partial<ActorContainerOptions> = {},
): Promise<{ container: ActorContainer; actor: SocketActor }> {
  const container = await createActorContainer(options(overrides));
  const actor = await container.start((ctx) => new SocketActor(ctx));
  return { container, actor };
}

describe("hibernation embedder contract", () => {
  test("preserves auto-response configuration and timestamps across container replacement", async () => {
    let now = 10;
    const mirror = new HibernationMirror();
    const ports = {
      ...options().ports,
      timer: { ...timer, now: () => now },
      hibernation: mirror,
    };
    const first = await started({ ports });
    const [client, server] = rawPair();
    const replies: unknown[] = [];
    client.addEventListener("message", (event) => replies.push((event as MessageEvent).data));
    await first.container.run(() => {
      first.container.state.acceptWebSocket(server, ["id"]);
      first.container.state.setWebSocketAutoResponse(
        new first.container.globals.WebSocketRequestResponsePair("ping", "pong"),
      );
    });
    client.send("ping");
    expect(mirror.snapshot()[0]?.autoResponseTimestamp).toBe(10);

    first.container.abort(new Error("evicted"));
    // An idle transport can answer and update the mirror before the next placement.
    mirror.autoResponseTimestamp(server, 15);
    const replacement = new HibernationMirror(mirror.snapshot(), mirror.autoResponsePair);
    const secondContainer = await createActorContainer(
      options({
        ports: { ...ports, hibernation: replacement },
        webSockets: replacement.snapshot(),
      }),
    );
    const secondActor = await secondContainer.start((ctx) => {
      expect(ctx.getWebSocketAutoResponse()?.request).toBe("ping");
      expect(ctx.getWebSocketAutoResponseTimestamp(server)?.getTime()).toBe(15);
      return new SocketActor(ctx);
    });
    now = 20;
    client.send("ping");
    await quiesce();
    expect(replies).toEqual(["pong", "pong"]);
    expect(first.actor.messages).toEqual([]);
    expect(secondActor.messages).toEqual([]);
    expect(replacement.snapshot()[0]?.autoResponseTimestamp).toBe(20);
  });

  test("mirrors acceptance and attachment bytes, then rebuilds before the constructor", async () => {
    const mirror = recorder();
    const first = await started({
      ports: { ...options().ports, hibernation: mirror.host },
    });

    let client!: SocketLike;
    let server!: SocketLike;
    await first.container.run(() => {
      const pair = new first.container.globals.WebSocketPair();
      client = pair[0] as SocketLike;
      server = pair[1] as SocketLike;
      first.container.state.acceptWebSocket(server, ["connection-id", "room"]);
      server.serializeAttachment({ id: "connection-id", state: { count: 1 } });
      client.accept();
    });

    expect(mirror.accepted).toHaveBeenCalledWith(server, ["connection-id", "room"]);
    expect(mirror.attached.mock.calls[0]?.[0]).toBe(server);
    const persisted = mirror.entries.get(server);
    expect(persisted?.attachment).toBeInstanceOf(Uint8Array);
    if (persisted === undefined) throw new Error("accepted socket was not mirrored");

    const secondMirror = recorder();
    const second = await started({
      ports: { ...options().ports, hibernation: secondMirror.host },
      webSockets: [persisted],
    });
    expect(second.actor.constructorSockets).toEqual([
      {
        tags: ["connection-id", "room"],
        attachment: { id: "connection-id", state: { count: 1 } },
      },
    ]);
    expect(secondMirror.accepted).not.toHaveBeenCalled();

    client.send("after-rebuild");
    await quiesce();
    expect(second.actor.messages).toEqual([
      {
        message: "after-rebuild",
        tags: ["connection-id", "room"],
        attachment: { id: "connection-id", state: { count: 1 } },
        listed: true,
      },
    ]);
  });

  test("mirrors auto-response and close lifecycle with the original socket reference", async () => {
    const mirror = recorder();
    const { container, actor } = await started({
      ports: { ...options().ports, hibernation: mirror.host },
    });
    let client!: SocketLike;
    let server!: SocketLike;
    const replies: string[] = [];
    await container.run(() => {
      const pair = new container.globals.WebSocketPair();
      client = pair[0] as SocketLike;
      server = pair[1] as SocketLike;
      container.state.acceptWebSocket(server, ["id"]);
      client.accept();
      client.addEventListener("message", (event) => replies.push(String(event.data)));
      container.state.setWebSocketAutoResponse(
        new container.globals.WebSocketRequestResponsePair("ping", "pong") as WebSocketRequestResponsePair,
      );
    });

    expect(mirror.autoResponse).toHaveBeenLastCalledWith({ request: "ping", response: "pong" });
    client.send("ping");
    await quiesce();
    expect(replies).toEqual(["pong"]);
    expect(actor.messages).toEqual([]);
    expect(container.state.getWebSocketAutoResponseTimestamp(server)).toBeInstanceOf(Date);

    client.close(4001, "bye");
    await quiesce();
    expect(mirror.closed).toHaveBeenCalledWith(server);

    expect(() => server.serializeAttachment({ after: "close" })).not.toThrow();
    expect(server.deserializeAttachment()).toEqual({ after: "close" });
    expect(mirror.entries.has(server)).toBe(false);
  });

  test("moves a rehydrated raw socket's listener to the replacement registry", async () => {
    const mirror = recorder();
    const firstContainer = await createActorContainer(
      options({ ports: { ...options().ports, hibernation: mirror.host } }),
    );
    const firstActor = await firstContainer.start((ctx) => new RawSocketActor(ctx));
    const [client, server] = rawPair();

    await firstContainer.run(() => {
      firstContainer.state.acceptWebSocket(server, ["raw"]);
    });
    const persisted = mirror.entries.get(server);
    if (persisted === undefined) throw new Error("accepted raw socket was not mirrored");

    const secondContainer = await createActorContainer(
      options({
        ports: { ...options().ports, hibernation: mirror.host },
        webSockets: [persisted],
      }),
    );
    const secondActor = await secondContainer.start((ctx) => new RawSocketActor(ctx));

    client.send("after-rebuild");
    await quiesce();
    expect(firstActor.messages).toEqual([]);
    expect(secondActor.messages).toEqual(["after-rebuild"]);
  });

  test("pins cross-accept, attachment, and synchronous close errors", async () => {
    const { container } = await started();
    await container.run(() => {
      const hibernatable = new container.globals.WebSocketPair();
      container.state.acceptWebSocket(hibernatable[1]);
      expect(() => container.state.acceptWebSocket(hibernatable[1])).toThrowError(
        new Error("Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`"),
      );
      expect(() => hibernatable[1].accept()).toThrowError(
        new TypeError("Can't accept() WebSocket after enabling hibernation."),
      );

      const classic = new container.globals.WebSocketPair();
      classic[1].accept();
      expect(() => container.state.acceptWebSocket(classic[1])).toThrowError(
        new Error("Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`"),
      );

      const attachment = { nested: { value: 1 } };
      (hibernatable[1] as SocketLike).serializeAttachment(attachment);
      attachment.nested.value = 2;
      expect((hibernatable[1] as SocketLike).deserializeAttachment()).toEqual({
        nested: { value: 1 },
      });
      expect(() =>
        (hibernatable[1] as SocketLike).serializeAttachment("x".repeat(16_380)),
      ).toThrowError(
        new Error(
          "A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16385 bytes.",
        ),
      );

      hibernatable[1].close(4000, "done");
      expect(() => hibernatable[1].send("late")).toThrowError(
        new TypeError("Can't call WebSocket send() after close()."),
      );
    });
  });
});

test("quiescence reports eviction state and gateHooks reach both gates", async () => {
  const inputTrace: string[] = [];
  const outputTrace: string[] = [];
  const input: InputGateHooks = {
    inputGateLocked: () => inputTrace.push("locked"),
    inputGateReleased: () => inputTrace.push("released"),
    inputGateWaiterAdded: () => inputTrace.push("waiter-added"),
    inputGateWaiterRemoved: () => inputTrace.push("waiter-removed"),
  };
  const output: OutputGateHooks = {
    makeTimeoutPromise: () => new Promise<never>(() => {}),
    outputGateLocked: () => outputTrace.push("locked"),
    outputGateReleased: () => outputTrace.push("released"),
    outputGateWaiterAdded: () => outputTrace.push("waiter-added"),
    outputGateWaiterRemoved: () => outputTrace.push("waiter-removed"),
  };
  const { container } = await started({ gateHooks: { input, output } });
  const pending = Promise.withResolvers<void>();
  let interval = 0;

  const inside = await container.run(() => {
    container.state.waitUntil(pending.promise);
    interval = container.globals.setInterval(() => {}, 60_000);
    void container.state.storage.put("output-hook", 1);
    return container.quiescence();
  });
  expect(inside).toEqual({
    armedTimers: 1,
    pendingWaitUntil: 2,
    inputLockHeld: true,
    outputGateBroken: false,
  });
  await quiesce(2);
  expect(container.quiescence()).toEqual({
    armedTimers: 1,
    pendingWaitUntil: 2,
    inputLockHeld: false,
    outputGateBroken: false,
  });

  pending.resolve();
  await container.run(() => container.globals.clearInterval(interval));
  await container.drainWaitUntil();
  await quiesce(2);
  expect(container.quiescence()).toEqual({
    armedTimers: 0,
    pendingWaitUntil: 0,
    inputLockHeld: false,
    outputGateBroken: false,
  });
  expect(inputTrace).toContain("locked");
  expect(inputTrace).toContain("released");
  expect(outputTrace).toContain("locked");
  expect(outputTrace).toContain("released");
});
