import { DurableObject } from "cloudflare:workers";
import { RELAY_CLIENT_READY } from "../src/protocol";

type RelayRole = "client" | "host";
type Env = { RELAY: DurableObjectNamespace<AgentRelay> };

const roleTag = (role: RelayRole): string => `role:${role}`;
const otherRole = (role: RelayRole): RelayRole => (role === "host" ? "client" : "host");

function roleFromPath(pathname: string): RelayRole | undefined {
  if (pathname === "/host") return "host";
  if (pathname.startsWith("/agents/")) return "client";
  return undefined;
}

/**
 * An intentionally tiny, authless stand-in for a deployed companion relay.
 * It owns no product protocol: one host socket and one Agents client socket
 * are paired, and their frames pass through untouched.
 */
export class AgentRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const role = roleFromPath(new URL(request.url).pathname);
    if (role === undefined) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (this.#openSockets(role).length !== 0) {
      return new Response(`${role} already connected`, { status: 409 });
    }

    const peer = this.#openSockets(otherRole(role))[0];
    if (role === "client" && peer === undefined) {
      return new Response("host offline", { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [roleTag(role)]);
    server.serializeAttachment(role);
    if (role === "client") peer?.send(RELAY_CLIENT_READY);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role = socket.deserializeAttachment();
    if (role !== "client" && role !== "host") {
      this.#close(socket, 1008, "invalid relay role");
      return;
    }
    const peer = this.#openSockets(otherRole(role))[0];
    if (peer === undefined) {
      this.#close(socket, 1011, "relay peer unavailable");
      return;
    }
    peer.send(message);
  }

  webSocketClose(socket: WebSocket): void {
    this.#closePeer(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.#closePeer(socket);
  }

  #openSockets(role: RelayRole): WebSocket[] {
    return this.ctx
      .getWebSockets(roleTag(role))
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  #closePeer(socket: WebSocket): void {
    const role = socket.deserializeAttachment();
    if (role !== "client" && role !== "host") return;
    const peer = this.#openSockets(otherRole(role))[0];
    if (peer !== undefined) this.#close(peer, 1000, "relay peer closed");
  }

  #close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // The socket is already closing.
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (roleFromPath(url.pathname) === undefined) {
      return new Response("not found", { status: 404 });
    }
    return await env.RELAY.getByName("extension-example").fetch(request);
  },
} satisfies ExportedHandler<Env>;
