/** A real actor worker using the same bootstrap and supervisor contract as an MV3 host. */
import {
  createActorContainer,
  DEFAULT_ALARM_OUTLET,
  HibernationMirror,
  installActorScope,
  noFacets,
  WebSocketRequestResponsePair,
  type ActorContainer,
  type ActorEntry,
} from "../../src/index";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import { connectMessagePortWebSocket, installWebSocketUpgradeGlobals } from "../../src/browser";
import { MessagePortWebSocket } from "../../src/browser/message-port-websocket";
import {
  serveBrowserWorker,
  rehydrateWorkerSockets,
  type WorkerHibernationSnapshot,
} from "../../src/browser/worker-supervisor";
import { isActorQuiescent } from "../../src/browser/actor-tree";
import { SqliteWasmActorStorage } from "../../backends/sqlite-wasm";
import { installPool, timer, UNIQUE_KEY } from "./substrate";

export type RoomConfiguration = { poolName: string };
export type RoomInspection = {
  readonly messages: readonly {
    message: string;
    tags: readonly string[];
    attachment: { user: string; since: string; roles: string[] };
    autoResponseTimestamp: number | null;
    stored: unknown;
  }[];
  readonly closes: readonly { code: number; reason: string; wasClean: boolean }[];
};
export interface RoomService {
  prepareHibernation(): Promise<WorkerHibernationSnapshot | null>;
  inspect(): Promise<RoomInspection>;
}
const messages: RoomInspection["messages"][number][] = [];
const closes: RoomInspection["closes"][number][] = [];
let container: ActorContainer;
let entry: ActorEntry<Room>;
let mirror: HibernationMirror;
let transportId: string | undefined;

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
    const attachment = WebSocket.prototype.deserializeAttachment.call(ws) as {
      user: string;
      since: Date;
      roles: Set<string>;
    };
    messages.push({
      message: String(message),
      tags: this.ctx.getTags(ws),
      attachment: {
        user: attachment.user,
        since: attachment.since.toISOString(),
        roles: [...attachment.roles],
      },
      autoResponseTimestamp: this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      stored: await this.ctx.storage.get("user"),
    });
    ws.send(`echo:${String(message)}`);
  }
  webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    closes.push({ code, reason, wasClean });
  }
}
class Service extends RpcTarget implements RoomService {
  async inspect(): Promise<RoomInspection> {
    return { messages, closes };
  }
  async prepareHibernation(): Promise<WorkerHibernationSnapshot | null> {
    if (!isActorQuiescent(container)) return null;
    const sockets = mirror.snapshot().map(({ socket: _socket, ...state }) => {
      if (!transportId) throw new Error("A mirrored socket has no transport identity");
      return { id: transportId, ...state };
    });
    return { root: { sockets, autoResponse: mirror.autoResponsePair }, facets: [] };
  }
}
serveBrowserWorker<RoomConfiguration, object>({
  scope: self,
  parseConfiguration(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("poolName" in value) ||
      typeof value.poolName !== "string"
    )
      throw new TypeError("Invalid room configuration");
    return { poolName: value.poolName };
  },
  async initialize({ poolName }, _host, rehydration) {
    const host = await installPool(poolName, { clearOnInit: rehydration === undefined });
    installActorScope(globalThis, () => container.globals);
    installWebSocketUpgradeGlobals();
    mirror = new HibernationMirror(
      rehydrateWorkerSockets(rehydration?.root),
      rehydration?.root.autoResponse,
    );
    transportId = rehydration?.root.sockets[0]?.id;
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
    entry = container.entry(await container.start((ctx) => new Room(ctx)));
    return new Service();
  },
  async connect({ id, url, port }) {
    transportId = id;
    await connectMessagePortWebSocket(new MessagePortWebSocket(url, port, false), url, () => entry.fetch(),
    );
  },
});
