import type { Plugin } from "vite";
import { WebSocketServer } from "ws";

/** Local provider boundary: real HTTP and WebSockets, no SaaS credentials. */
export function messengerServer(): Plugin {
  return {
    name: "messenger-test-server",
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer?.on("close", () => sockets.close());
      server.httpServer?.on("upgrade", (request, socket, head) => {
        if (!request.url?.startsWith("/__messenger/socket/")) return;
        sockets.handleUpgrade(request, socket, head, (ws) => {
          const send = (value: unknown) => ws.send(JSON.stringify(value));
          if (request.url?.endsWith("slack")) {
            send({ type: "hello" });
            send({
              type: "events_api",
              envelope_id: "envelope-1",
              payload: {
                type: "event_callback",
                event_id: "event-1",
                event: {
                  type: "app_mention",
                  user: "U1",
                  channel: "C1",
                  ts: "1.1",
                  text: "<@BOT> hello &amp; goodbye"
                }
              }
            });
          } else {
            send({ op: 10, d: { heartbeat_interval: 30_000 } });
            ws.on("message", (bytes) => {
              const frame = JSON.parse(bytes.toString());
              if (frame.op === 1) send({ op: 11 });
              if (frame.op !== 2) return;
              send({
                op: 0,
                t: "READY",
                s: 1,
                d: {
                  user: { id: "BOT", username: "think" },
                  session_id: "session-1",
                  resume_gateway_url: "wss://gateway.discord.gg"
                }
              });
              send({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 2,
                d: {
                  id: "M1",
                  channel_id: "T1",
                  guild_id: "G1",
                  content: "<@BOT> hello &amp; goodbye",
                  timestamp: "2026-09-07T00:00:00.000Z",
                  author: { id: "U1", username: "user", bot: false },
                  mentions: [{ id: "BOT", username: "think" }],
                  attachments: []
                }
              });
            });
          }
        });
      });
      server.middlewares.use("/__messenger", async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        response.setHeader("content-type", "application/json");
        const url = request.url ?? "";
        if (url === "/slack/open") {
          response.end(
            JSON.stringify({
              ok: true,
              url: `ws://${request.headers.host}/__messenger/socket/slack`
            })
          );
        } else if (url === "/slack/api/auth.test") {
          response.end(
            JSON.stringify({ ok: true, user_id: "BOT", user: "think" })
          );
        } else if (url === "/slack/api/users.info") {
          response.end(
            JSON.stringify({
              ok: true,
              user: { id: "U1", name: "user", profile: { real_name: "User" } }
            })
          );
        } else if (url === "/slack/api/chat.postMessage") {
          const message = new URLSearchParams(body);
          if (
            request.method !== "POST" ||
            request.headers.authorization !== "Bearer test-bot" ||
            message.get("channel") !== "C1" ||
            message.get("thread_ts") !== "1.1" ||
            message.get("markdown_text") !== "Reply from the browser worker"
          ) {
            response.statusCode = 400;
            response.end(JSON.stringify({ ok: false, error: "invalid_reply" }));
            return;
          }
          response.end(
            JSON.stringify({
              ok: true,
              ts: "2.2",
              channel: "C1"
            })
          );
        } else if (url === "/discord/api/channels/T1") {
          response.end(JSON.stringify({ id: "T1", type: 11, parent_id: "C1" }));
        } else if (url === "/discord/api/channels/T1/messages") {
          const message = JSON.parse(body);
          if (
            request.method !== "POST" ||
            request.headers.authorization !== "Bot test-bot" ||
            message.content !== "Reply from the browser worker"
          ) {
            response.statusCode = 400;
            response.end(
              JSON.stringify({ message: "invalid reply", code: 50035 })
            );
            return;
          }
          response.end(
            JSON.stringify({
              id: "M2"
            })
          );
        } else {
          response.statusCode = 404;
          response.end(
            JSON.stringify({ error: `Unexpected provider request: ${url}` })
          );
        }
      });
    }
  };
}
