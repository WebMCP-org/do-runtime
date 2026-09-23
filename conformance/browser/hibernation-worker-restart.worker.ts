/**
 * An actor worker that accepts a hibernatable socket over a transferred
 * `MessagePort`, and the replacement worker that rehydrates it after
 * `terminate()`. The two halves follow the Chrome-extension host this runtime
 * serves: the first connect is the actor's own `fetch`, bridged to the port;
 * the rehydration wraps the replacement's port directly and hands it to the
 * container with the state the first worker mirrored.
 *
 * The boot order is the README's: the pool, then the actor scope, then the
 * container.
 */

import {
  createActorContainer,
  DEFAULT_ALARM_OUTLET,
  HibernationMirror,
  installActorScope,
  noFacets,
  WebSocketRequestResponsePair,
  type ActorContainer,
  type HibernationAutoResponse,
} from "../../src/index";
import { installWebSocketUpgradeGlobals, upgradeWebSocket } from "../../src/browser";
import { bridgeWebSocket, MessagePortWebSocket } from "../../src/browser/message-port-websocket";
import { SqliteWasmActorStorage } from "../../backends/sqlite-wasm";
import { installPool, timer, UNIQUE_KEY } from "./substrate";

/** A mirrored socket without its transport, which is what outlives the worker. */
export type HibernatedSocket = {
  readonly tags?: readonly string[];
  readonly attachment?: Uint8Array;
  readonly autoResponseTimestamp?: number;
};

export type Hibernated = {
  readonly socket: HibernatedSocket;
  readonly autoResponse: HibernationAutoResponse | null;
};

export type SocketBoot = {
  readonly poolName: string;
  readonly url: string;
  /** This worker's end of the socket's port. */
  readonly port: MessagePort;
  /** Absent for the worker that accepts the socket; the mirror for its replacement. */
  readonly hibernated?: Hibernated;
};

export type SocketReport =
  | { readonly kind: "accepted" }
  | { readonly kind: "ready" }
  | ({ readonly kind: "hibernated" } & Hibernated)
  | {
      readonly kind: "message";
      readonly message: string;
      readonly tags: readonly string[];
      readonly attachment: unknown;
      readonly autoResponseTimestamp: number | null;
      readonly stored: unknown;
    }
  | {
      readonly kind: "close";
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    }
  | { readonly kind: "error"; readonly error: string };

const report = (value: SocketReport): void => self.postMessage(value);

class Room {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["room:lobby", "user:ada"]);
    pair[1].serializeAttachment({ user: "ada", since: new Date(0), roles: new Set(["admin"]) });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    await this.ctx.storage.put("user", "ada");
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    report({
      kind: "message",
      message: String(message),
      tags: this.ctx.getTags(ws),
      attachment: WebSocket.prototype.deserializeAttachment.call(ws),
      autoResponseTimestamp: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      stored: await this.ctx.storage.get("user"),
    });
    ws.send(`echo:${String(message)}`);
  }

  webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    report({ kind: "close", code, reason, wasClean });
  }
}

let container: ActorContainer | undefined;
let mirror: HibernationMirror | undefined;

self.addEventListener("message", (event: MessageEvent<SocketBoot | "hibernate">) => {
  void (event.data === "hibernate" ? hibernate() : boot(event.data)).catch((error: unknown) => {
    report({ kind: "error", error: String(error) });
  });
});

async function boot({ poolName, url, port, hibernated }: SocketBoot): Promise<void> {
  const host = await installPool(poolName, { clearOnInit: hibernated === undefined });
  installActorScope(globalThis, () => {
    if (container === undefined) throw new Error("no live room container");
    return container.globals;
  });
  installWebSocketUpgradeGlobals();

  if (hibernated === undefined) {
    mirror = new HibernationMirror();
  } else {
    const socket = new MessagePortWebSocket(url, port, false);
    socket.open();
    mirror = new HibernationMirror([{ socket, ...hibernated.socket }], hibernated.autoResponse);
  }
  container = await createActorContainer({
    id: "room",
    uniqueKey: UNIQUE_KEY,
    exports: {},
    env: {},
    ports: {
      sql: new SqliteWasmActorStorage(host, "/actor"),
      alarms: DEFAULT_ALARM_OUTLET,
      facets: noFacets,
      timer,
      hibernation: mirror,
    },
    webSockets: mirror.snapshot(),
  });
  const room = container.entry(await container.start((ctx) => new Room(ctx)));
  if (hibernated !== undefined) {
    report({ kind: "ready" });
    return;
  }

  const server = upgradeWebSocket(await room.fetch());
  if (server === undefined) throw new Error("the room did not upgrade");
  bridgeWebSocket(server, new MessagePortWebSocket(url, port, false));
  report({ kind: "accepted" });
}

/** What a host keeps before it discards the worker: the mirror, minus the transport. */
async function hibernate(): Promise<void> {
  const [mirrored, ...others] = mirror?.snapshot() ?? [];
  if (mirrored === undefined || others.length > 0) throw new Error("expected one mirrored socket");
  const { socket: _transport, ...socket } = mirrored;
  report({ kind: "hibernated", socket, autoResponse: mirror?.autoResponsePair ?? null });
}
