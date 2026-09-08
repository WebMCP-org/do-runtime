import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat, ConsoleLogger } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { SocketModeSlackAdapter } from "@cloudflare/think/messengers/browser/slack";
import { ForwardedDiscordAdapter } from "@cloudflare/think/messengers/browser/discord";
import { SocketModeClient } from "@cloudflare/think/messengers/browser/slack-socket-mode";
import { Client } from "@cloudflare/think/messengers/browser/discord-js";

const shutdowns: Array<() => Promise<void>> = [];
const logger = new ConsoleLogger("silent");

function slack(): SocketModeSlackAdapter {
  return new SocketModeSlackAdapter({
    appToken: "xapp-test",
    botToken: "xoxb-test",
    botUserId: "BOT",
    userName: "think",
    nativeStreaming: true,
    logger,
    webhookVerifier: async () => {
      throw new Error("Forwarded events only");
    }
  });
}

function discord(): ForwardedDiscordAdapter {
  return new ForwardedDiscordAdapter({
    applicationId: "BOT",
    botToken: "discord-token",
    publicKey: "0".repeat(64),
    userName: "think",
    logger
  });
}

function forwarded(header: string, token: string, body: unknown): Request {
  return new Request("https://host.test/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", [header]: token },
    body: JSON.stringify(body)
  });
}

function message(id: string, extra: Record<string, unknown> = {}): Request {
  return forwarded("x-discord-gateway-token", "discord-token", {
    type: "GATEWAY_MESSAGE_CREATE",
    timestamp: Date.now(),
    data: {
      id,
      channel_id: "T1",
      guild_id: "G1",
      content: "hello",
      timestamp: "2026-09-07T00:00:00.000Z",
      author: { id: "U1", username: "user", bot: false },
      mentions: [],
      attachments: [],
      ...extra
    }
  });
}

async function discordChat() {
  const adapter = discord();
  const state = createMemoryState();
  const chat = new Chat({
    adapters: { discord: adapter },
    state,
    userName: "think",
    logger
  });
  shutdowns.push(() => chat.shutdown());
  const received: Array<{ id: string; route: string }> = [];
  chat.onNewMessage(/hello/, async (thread) => {
    received.push({ id: thread.id, route: "new" });
  });
  chat.onSubscribedMessage(async (thread) => {
    received.push({ id: thread.id, route: "subscribed" });
  });
  chat.onDirectMessage(async (thread) => {
    received.push({ id: thread.id, route: "dm" });
  });
  await chat.initialize();
  return { adapter, state, received };
}

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  vi.unstubAllGlobals();
});

describe("published browser messenger adapters", () => {
  it("rejects invalid forwarding tokens before parsing or provider requests", async () => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchBoundary);
    const slackResponse = await slack().handleWebhook(
      forwarded("x-slack-socket-token", "wrong", {})
    );
    const discordResponse = await discord().handleWebhook(
      forwarded("x-discord-gateway-token", "wrong", {})
    );
    expect(slackResponse.status).toBe(401);
    expect(discordResponse.status).toBe(401);
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it("disables Assistant typing and native streaming even when requested", async () => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchBoundary);
    const adapter = slack();
    await adapter.startTyping("slack:D1:1.1", "Searching");
    async function* chunks() {
      yield "hello";
    }
    // A DM with a thread timestamp would otherwise use Slack's Assistant API.
    await expect(adapter.stream("slack:D1:1.1", chunks())).resolves.toBeNull();
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it.each([
    { type: 10, channelType: undefined },
    { type: 11, channelType: undefined },
    { type: 12, channelType: undefined },
    { type: 10, channelType: 10 },
    { type: 11, channelType: 11 },
    { type: 12, channelType: 12 }
  ])(
    "resolves and caches thread type $type with forwarded type $channelType",
    async ({ type, channelType }) => {
      const fetchBoundary = vi.fn<typeof fetch>(async () =>
        Response.json({ type, parent_id: "P1" })
      );
      vi.stubGlobal("fetch", fetchBoundary);
      const { adapter, state, received } = await discordChat();
      const threadId = adapter.encodeThreadId({
        guildId: "G1",
        channelId: "P1",
        threadId: "T1"
      });
      await state.subscribe(threadId);
      for (const id of ["M1", "M2"]) {
        expect(
          (
            await adapter.handleWebhook(
              message(id, { channel_type: channelType })
            )
          ).status
        ).toBe(200);
      }
      expect(received).toEqual([
        { id: threadId, route: "subscribed" },
        { id: threadId, route: "subscribed" }
      ]);
      expect(fetchBoundary).toHaveBeenCalledTimes(1);
      const [input, init] = fetchBoundary.mock.calls[0];
      const request = new Request(input, init);
      expect(request.url).toBe("https://discord.com/api/v10/channels/T1");
      expect(request.headers.get("authorization")).toBe("Bot discord-token");
    }
  );

  it("uses supplied thread metadata and routes DMs without a channel lookup", async () => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchBoundary);
    const { adapter, received } = await discordChat();
    await adapter.handleWebhook(
      message("thread", { thread: { id: "T1", parent_id: "P1" } })
    );
    await adapter.handleWebhook(
      message("dm", { guild_id: null, channel_id: "D1" })
    );
    expect(received).toEqual([
      { id: "discord:G1:P1:T1", route: "new" },
      { id: "discord:@me:D1", route: "dm" }
    ]);
    expect(fetchBoundary).not.toHaveBeenCalled();
  });

  it("caches a valid non-thread channel without requiring a parent", async () => {
    const fetchBoundary = vi.fn<typeof fetch>(async () =>
      Response.json({ type: 0 })
    );
    vi.stubGlobal("fetch", fetchBoundary);
    const { adapter, received } = await discordChat();
    await adapter.handleWebhook(message("M1"));
    await adapter.handleWebhook(message("M2"));
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      { id: "discord:G1:T1", route: "new" },
      { id: "discord:G1:T1", route: "new" }
    ]);
  });

  it.each([undefined, 11])(
    "rejects a failed lookup and accepts the same event on retry (type %s)",
    async (channelType) => {
      const fetchBoundary = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(Response.json({ type: 11, parent_id: "P1" }));
      vi.stubGlobal("fetch", fetchBoundary);
      const { adapter, received } = await discordChat();
      const event = () => message("M1", { channel_type: channelType });
      await expect(adapter.handleWebhook(event())).rejects.toThrow(
        "network unavailable"
      );
      expect(received).toEqual([]);
      expect((await adapter.handleWebhook(event())).status).toBe(200);
      expect(fetchBoundary).toHaveBeenCalledTimes(2);
      expect(received).toEqual([{ id: "discord:G1:P1:T1", route: "new" }]);
    }
  );

  it.each([
    { type: 10 },
    { type: 11, parent_id: null },
    { type: 12, parent_id: "" },
    { parent_id: "P1" }
  ])(
    "rejects malformed channel metadata and retries the same event: %j",
    async (channel) => {
      const fetchBoundary = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(channel))
        .mockResolvedValueOnce(Response.json({ type: 11, parent_id: "P1" }));
      vi.stubGlobal("fetch", fetchBoundary);
      const { adapter, received } = await discordChat();
      const event = () => message("M1");
      await expect(adapter.handleWebhook(event())).rejects.toThrow();
      expect(received).toEqual([]);
      expect((await adapter.handleWebhook(event())).status).toBe(200);
      expect(fetchBoundary).toHaveBeenCalledTimes(2);
      expect(received).toEqual([{ id: "discord:G1:P1:T1", route: "new" }]);
    }
  );

  it("sends actual attachment bytes through Slack's external-upload API", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("files.getUploadURLExternal")) {
          return Response.json({
            ok: true,
            file_id: "F1",
            upload_url: "https://files.slack.test/upload"
          });
        }
        return Response.json({ ok: true });
      })
    );
    await slack().postMessage("slack:C1:", {
      markdown: "",
      files: [
        { data: new Blob([new Uint8Array([1, 2, 3])]), filename: "repro.bin" }
      ]
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.test/upload",
      "https://slack.com/api/files.completeUploadExternal"
    ]);
    expect(await requests[1].arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer
    );
    const ticket = new URLSearchParams(await requests[0].text());
    expect(ticket.get("length")).toBe("3");
    const completed = new URLSearchParams(await requests[2].text());
    expect(completed.get("channel_id")).toBe("C1");
    expect(completed.get("thread_ts")).toBeNull();
    expect(JSON.parse(completed.get("files") ?? "[]")).toEqual([
      { id: "F1", title: "repro.bin" }
    ]);
  });

  it("sends Discord attachments as multipart files with names and MIME types", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "M1" });
      })
    );
    await discord().postMessage("discord:G1:C1", {
      markdown: "",
      files: [
        {
          data: new Blob([new Uint8Array([4, 5])]),
          filename: "shot.png",
          mimeType: "image/png"
        }
      ]
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://discord.com/api/v10/channels/C1/messages"
    );
    expect(requests[0].headers.get("authorization")).toBe("Bot discord-token");
    const form = await requests[0].formData();
    const file = form.get("files[0]");
    if (!(file instanceof File)) throw new Error("Expected multipart file");
    expect(file.name).toBe("shot.png");
    expect(file.type).toBe("image/png");
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([4, 5]).buffer);
  });

  it("refuses the unused Node socket clients with actionable errors", () => {
    expect(() => new SocketModeClient()).toThrow("startSlackSocketClient");
    expect(() => new Client()).toThrow("startDiscordGatewayClient");
  });
});
