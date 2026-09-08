import "./setup";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  startDiscordGatewayClient,
  startSlackSocketClient,
  type ForwardedMessengerEvent
} from "@cloudflare/think/messengers/browser";
import { SocketModeSlackAdapter } from "@cloudflare/think/messengers/browser/slack";
import { ForwardedDiscordAdapter } from "@cloudflare/think/messengers/browser/discord";

globalThis.addEventListener(
  "message",
  (event: MessageEvent<{ provider: "slack" | "discord"; origin: string }>) => {
    void run(event.data).catch((error: unknown) => {
      postMessage({ error: String(error) });
    });
  },
  { once: true }
);

async function run({
  provider,
  origin
}: {
  provider: "slack" | "discord";
  origin: string;
}): Promise<void> {
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    return rawFetch(
      url === "https://slack.com/api/apps.connections.open"
        ? `${origin}/__messenger/slack/open`
        : url,
      init
    );
  };
  // Redirect the network boundary only. The client runs a native Worker WebSocket.
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(
        String(url).startsWith("wss://gateway.discord.gg")
          ? `${origin.replace(/^http/, "ws")}/__messenger/socket/discord`
          : url,
        protocols
      );
    }
  };
  const adapter =
    provider === "slack"
      ? new SocketModeSlackAdapter({
          botToken: "test-bot",
          appToken: "test-app",
          userName: "think",
          apiUrl: `${origin}/__messenger/slack/api/`,
          webhookVerifier: async () => {
            throw new Error("forwarded events only");
          }
        })
      : new ForwardedDiscordAdapter({
          botToken: "test-bot",
          applicationId: "BOT",
          publicKey: "0".repeat(64),
          userName: "think",
          apiUrl: `${origin}/__messenger/discord/api`
        });
  const bot = new Chat({
    userName: "think",
    adapters: { [provider]: adapter },
    state: createMemoryState(),
    logger: "silent"
  });
  let stop: () => void = () => {};
  bot.onNewMention(async (thread, message) => {
    try {
      if (provider === "slack") await thread.startTyping();
      const sent = await thread.post({
        markdown: "Reply from the browser worker"
      });
      postMessage({
        worker: typeof document === "undefined",
        threadId: thread.id,
        text: message.text,
        sent: { id: sent.id }
      });
    } catch (error) {
      postMessage({ error: String(error) });
    } finally {
      stop();
    }
  });
  await bot.initialize();
  const onEvent = (forwarded: ForwardedMessengerEvent) => {
    void bot.webhooks[provider]!(
      new Request(`${origin}/messengers/${provider}`, {
        method: "POST",
        ...forwarded
      }),
      {
        waitUntil: (work) => {
          void work.catch((error: unknown) =>
            postMessage({ error: String(error) })
          );
        }
      }
    )
      .then((response) => {
        if (!response.ok)
          postMessage({ error: `Webhook returned ${response.status}` });
      })
      .catch((error: unknown) => postMessage({ error: String(error) }));
  };
  stop =
    provider === "slack"
      ? startSlackSocketClient({ appToken: "test-app", onEvent })
      : startDiscordGatewayClient({ botToken: "test-bot", onEvent });
}
