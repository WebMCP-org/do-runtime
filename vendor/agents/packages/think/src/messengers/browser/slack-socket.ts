import { z } from "zod";
import type { ForwardedMessengerEvent, MessengerSocketStatus } from "./types";

const fatalErrors = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "invalid_app",
  "invalid_app_id",
  "forbidden_team",
  "missing_scope"
]);
const connectionsOpenSchema = z.union([
  z.object({ ok: z.literal(true), url: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: z.string() })
]);
const socketFrameSchema = z.object({
  type: z.string().min(1),
  envelope_id: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  retry_num: z.number().int().nonnegative().optional()
});

export interface SlackSocketClientOptions {
  appToken: string;
  onEvent: (event: ForwardedMessengerEvent) => void;
  onStatus?: (status: MessengerSocketStatus) => void;
}

/**
 * Native Socket Mode transport for the Slack adapter's forwarded-event seam.
 * Call the returned cleanup function before restarting with a changed token.
 * The host owns forwarding and handling asynchronous delivery failures.
 */
export function startSlackSocketClient({
  appToken,
  onEvent,
  onStatus
}: SlackSocketClientOptions): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = 1_000;
  const abort = new AbortController();

  function stop(): void {
    stopped = true;
    abort.abort();
    clearTimeout(reconnectTimer);
    const closing = socket;
    socket = undefined;
    closing?.close(1000, "messenger disabled");
  }

  function reconnect(error?: string): void {
    if (stopped) return;
    onStatus?.({ phase: "reconnecting", ...(error ? { error } : {}) });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    onStatus?.({ phase: "connecting" });
    try {
      // Each connection needs a fresh URL. Socket Mode does not replay gaps.
      // ponytail: no history catch-up; add it if disconnected delivery must recover.
      const response = await fetch(
        "https://slack.com/api/apps.connections.open",
        {
          method: "POST",
          headers: { authorization: `Bearer ${appToken}` },
          signal: abort.signal
        }
      );
      const opened = connectionsOpenSchema.parse(await response.json());
      if (stopped) return;
      if (!opened.ok) {
        if (fatalErrors.has(opened.error)) {
          onStatus?.({ phase: "auth_failed", error: opened.error });
          stop();
        } else {
          reconnect(opened.error);
        }
        return;
      }

      const current = new WebSocket(opened.url);
      socket = current;
      current.addEventListener("message", (event: MessageEvent) => {
        if (stopped || socket !== current || typeof event.data !== "string") {
          return;
        }
        let frame: z.infer<typeof socketFrameSchema>;
        try {
          frame = socketFrameSchema.parse(JSON.parse(event.data));
        } catch {
          return;
        }
        if (frame.type === "hello") {
          reconnectDelay = 1_000;
          onStatus?.({ phase: "connected" });
          return;
        }
        if (frame.type === "disconnect") {
          current.close(4000, "slack asked to reconnect");
          return;
        }
        if (!frame.envelope_id || current.readyState !== WebSocket.OPEN) return;
        // Acknowledge before crossing the host boundary (Slack allows 3 seconds).
        current.send(JSON.stringify({ envelope_id: frame.envelope_id }));
        onEvent({
          body: JSON.stringify({
            type: "socket_event",
            eventType: frame.type,
            body: frame.payload ?? {},
            timestamp: Date.now(),
            ...(frame.retry_num === undefined
              ? {}
              : { retryNum: frame.retry_num })
          }),
          headers: {
            "content-type": "application/json",
            "x-slack-socket-token": appToken
          }
        });
      });
      current.addEventListener("close", () => {
        if (stopped || socket !== current) return;
        socket = undefined;
        reconnect();
      });
      current.addEventListener("error", () => {
        if (!stopped && socket === current) current.close();
      });
    } catch {
      reconnect();
    }
  }

  void connect();
  return stop;
}
