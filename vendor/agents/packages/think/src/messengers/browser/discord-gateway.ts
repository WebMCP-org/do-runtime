import { z } from "zod";
import type { ForwardedMessengerEvent, MessengerSocketStatus } from "./types";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const FATAL_CLOSE_CODES = new Map<number, string>([
  [4004, "authentication failed"],
  [4010, "invalid shard"],
  [4011, "sharding required"],
  [4012, "invalid API version"],
  [4013, "invalid intents"],
  [4014, "disallowed intents"]
]);

const gatewayFrameSchema = z.object({
  op: z.number().int(),
  d: z.unknown().optional(),
  s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().nullable().optional()
});
const gatewayHelloSchema = z.object({
  heartbeat_interval: z.number().finite().positive()
});
const gatewayReadySchema = z.object({
  session_id: z.string().min(1),
  resume_gateway_url: z.url().refine((url) => new URL(url).protocol === "wss:"),
  user: z.object({ username: z.string().min(1) })
});

// Validate the fields consumed by the Chat SDK's forwarded Gateway handler,
// retaining extra Discord fields for downstream adapters.
const gatewayMessageCreateSchema = z
  .object({
    id: z.string().min(1),
    channel_id: z.string().min(1),
    guild_id: z.string().min(1).nullable().optional(),
    content: z.string(),
    timestamp: z.string().min(1),
    author: z
      .object({
        id: z.string().min(1),
        username: z.string().min(1),
        global_name: z.string().nullable().optional(),
        bot: z.boolean().optional()
      })
      .loose(),
    mentions: z.array(z.object({ id: z.string().min(1) }).loose()),
    mention_roles: z.array(z.string().min(1)).optional(),
    attachments: z.array(
      z
        .object({
          url: z.string().min(1),
          filename: z.string().min(1),
          size: z.number().int().nonnegative(),
          content_type: z.string().nullable().optional()
        })
        .loose()
    ),
    channel_type: z.number().int().optional(),
    is_mention: z.boolean().optional(),
    thread: z
      .object({
        id: z.string().min(1),
        parent_id: z.string().min(1)
      })
      .loose()
      .optional()
  })
  .loose();

export type DiscordGatewayClientOptions = {
  botToken: string;
  onEvent: (event: ForwardedMessengerEvent) => void;
  onStatus?: (status: MessengerSocketStatus) => void;
};

/**
 * Receive Discord messages using the browser's native WebSocket. The host
 * routes each forwarded envelope to its configured Chat SDK webhook handler.
 * Call the returned cleanup function before replacing credentials or stopping.
 */
export function startDiscordGatewayClient(
  options: DiscordGatewayClientOptions
): () => void {
  const botToken = z.string().min(1).parse(options.botToken);
  let socket: WebSocket | undefined;
  let stopped = false;
  let sequence: number | null = null;
  let session: z.infer<typeof gatewayReadySchema> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelayMs = RECONNECT_MIN_MS;
  let heartbeatAcked = true;

  function publish(
    phase: MessengerSocketStatus["phase"],
    error?: string
  ): void {
    options.onStatus?.({
      phase,
      ...(session ? { userName: session.user.username } : {}),
      ...(error ? { error } : {})
    });
  }

  function retireSocket(code: number, reason: string): void {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    const retired = socket;
    // Retire before closing: queued frames and close events must not mutate
    // the replacement session, including during the reconnect delay.
    socket = undefined;
    if (retired && retired.readyState < WebSocket.CLOSING) {
      retired.close(code, reason);
    }
  }

  function stop(): void {
    stopped = true;
    clearTimeout(reconnectTimer);
    retireSocket(1000, "messenger disabled");
  }

  function reconnect(reason: string, delay = reconnectDelayMs): void {
    if (stopped) return;
    retireSocket(4000, reason);
    publish("reconnecting");
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  function send(op: number, d: unknown): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op, d }));
    }
  }

  function heartbeat(): void {
    heartbeatAcked = false;
    send(1, sequence);
  }

  function connect(): void {
    if (stopped) return;
    publish("connecting");
    if (stopped) return;
    const url = new URL(session?.resume_gateway_url ?? GATEWAY_URL);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      reconnect("gateway connection failed");
      return;
    }
    socket = current;
    const active = () => !stopped && socket === current;

    current.addEventListener("message", (event: MessageEvent) => {
      if (!active() || typeof event.data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = gatewayFrameSchema.safeParse(value);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.op === 0 && frame.s != null) sequence = frame.s;

      switch (frame.op) {
        case 10: {
          const hello = gatewayHelloSchema.safeParse(frame.d);
          if (!hello.success || heartbeatTimer !== undefined) return;
          const interval = hello.data.heartbeat_interval;
          heartbeatAcked = true;
          const beat = () => {
            if (!active()) return;
            if (!heartbeatAcked) {
              reconnect("heartbeat ack missed");
              return;
            }
            heartbeat();
            heartbeatTimer = setTimeout(beat, interval);
          };
          // Discord requires jitter on the first heartbeat, then fixed intervals.
          // https://docs.discord.com/developers/events/gateway#sending-heartbeats
          heartbeatTimer = setTimeout(beat, interval * Math.random());
          if (session && sequence !== null) {
            send(6, {
              token: botToken,
              session_id: session.session_id,
              seq: sequence
            });
          } else {
            send(2, {
              token: botToken,
              intents: GATEWAY_INTENTS,
              properties: {
                os: "browser",
                browser: "@cloudflare/think",
                device: "@cloudflare/think"
              }
            });
          }
          return;
        }
        case 1:
          heartbeat();
          return;
        case 11:
          heartbeatAcked = true;
          return;
        case 7:
          reconnect("gateway asked to reconnect", 0);
          return;
        case 9:
          if (typeof frame.d !== "boolean") return;
          if (!frame.d) {
            session = undefined;
            sequence = null;
          }
          reconnect("gateway session invalidated");
          return;
        case 0:
          if (frame.t === "READY") {
            const ready = gatewayReadySchema.safeParse(frame.d);
            if (!ready.success) return;
            session = ready.data;
            reconnectDelayMs = RECONNECT_MIN_MS;
            publish("connected");
          } else if (frame.t === "RESUMED") {
            reconnectDelayMs = RECONNECT_MIN_MS;
            publish("connected");
          } else if (frame.t === "MESSAGE_CREATE") {
            const message = gatewayMessageCreateSchema.safeParse(frame.d);
            if (!message.success || message.data.author.bot === true) return;
            options.onEvent({
              body: JSON.stringify({
                type: "GATEWAY_MESSAGE_CREATE",
                timestamp: Date.now(),
                data: message.data
              }),
              headers: {
                "content-type": "application/json",
                "x-discord-gateway-token": botToken
              }
            });
          }
      }
    });
    current.addEventListener("close", (event: CloseEvent) => {
      if (!active()) return;
      const fatal = FATAL_CLOSE_CODES.get(event.code);
      if (fatal) {
        stop();
        publish("auth_failed", `${fatal} (close ${event.code})`);
        return;
      }
      // These codes invalidate the session; other disconnects retain the
      // sequence and resume URL so Discord can replay messages missed offline.
      if ([1000, 1001, 4007, 4009].includes(event.code)) {
        session = undefined;
        sequence = null;
      }
      reconnect("gateway closed");
    });
    current.addEventListener("error", () => {
      if (active()) reconnect("gateway connection failed");
    });
  }

  connect();
  return stop;
}
