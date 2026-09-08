import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDiscordGatewayClient } from "../messengers/browser/discord-gateway";

// Network boundary only: native browser events exercise the production client.
// close() deliberately leaves queued frames and the eventual close event to
// the test, exposing callbacks from sockets retired during reconnection.
class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  closed?: { code: number; reason: string };

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSING;
  }

  receive(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) })
    );
  }

  disconnect(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

function frames(socket: FakeWebSocket): Array<{ op: number; d: unknown }> {
  return socket.sent.map((value) => JSON.parse(value));
}

function ready(socket: FakeWebSocket): void {
  socket.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
  socket.receive({
    op: 0,
    s: 41,
    t: "READY",
    d: {
      session_id: "session-1",
      resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
      user: { username: "bot" }
    }
  });
}

const message = {
  id: "message-1",
  channel_id: "channel-1",
  guild_id: "guild-1",
  content: "hello",
  timestamp: "2026-07-12T12:00:00.000Z",
  author: { id: "user-1", username: "alex", bot: false },
  mentions: [],
  attachments: []
};

describe("Discord Gateway browser transport", () => {
  const cleanups: Array<() => void> = [];

  function start() {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const stop = startDiscordGatewayClient({
      botToken: "token-1",
      onEvent,
      onStatus
    });
    cleanups.push(stop);
    return { onEvent, onStatus, stop, socket: FakeWebSocket.instances.at(-1)! };
  }

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    for (const stop of cleanups.splice(0)) stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("identifies once, jitters heartbeats, acknowledges requests, and forwards human guild messages and DMs", () => {
    const { socket, onStatus, onEvent } = start();
    expect(socket.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(onStatus).toHaveBeenLastCalledWith({ phase: "connecting" });
    ready(socket);
    socket.receive({ op: 10, d: { heartbeat_interval: 2_000 } });
    expect(frames(socket)).toEqual([
      {
        op: 2,
        d: {
          token: "token-1",
          intents: 37_377,
          properties: {
            os: "browser",
            browser: "@cloudflare/think",
            device: "@cloudflare/think"
          }
        }
      }
    ]);
    expect(onStatus).toHaveBeenLastCalledWith({
      phase: "connected",
      userName: "bot"
    });
    socket.receive({ op: 0, s: 42, t: "MESSAGE_CREATE", d: message });
    socket.receive({
      op: 0,
      s: 43,
      t: "MESSAGE_CREATE",
      d: { ...message, author: { ...message.author, bot: true } }
    });
    const dm = {
      ...message,
      id: "dm-1",
      guild_id: null,
      extra_field: "retained"
    };
    socket.receive({ op: 0, s: 44, t: "MESSAGE_CREATE", d: dm });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0]).toEqual({
      body: JSON.stringify({
        type: "GATEWAY_MESSAGE_CREATE",
        timestamp: Date.now(),
        data: message
      }),
      headers: {
        "content-type": "application/json",
        "x-discord-gateway-token": "token-1"
      }
    });
    expect(JSON.parse(onEvent.mock.calls[1][0].body).data).toEqual(dm);

    vi.advanceTimersByTime(499);
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames(socket).at(-1)).toEqual({ op: 1, d: 44 });
    socket.receive({ op: 11 });
    socket.receive({ op: 1 });
    expect(socket.sent).toHaveLength(3);
    socket.receive({ op: 11 });
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toHaveLength(4);
    expect(socket.closed).toBeUndefined();
  });

  it("rejects malformed payloads while tracking the sequence of received dispatches", () => {
    const { socket, onEvent, onStatus } = start();
    socket.receive({ op: 10, d: { heartbeat_interval: -1 } });
    socket.receive({ op: 0, s: 50, t: "READY", d: { user: null } });
    socket.receive({
      op: 0,
      s: 51,
      t: "MESSAGE_CREATE",
      d: { ...message, mentions: null }
    });
    socket.receive({
      op: 0,
      s: 52,
      t: "MESSAGE_CREATE",
      d: { ...message, attachments: [{}] }
    });
    socket.receive({
      op: 0,
      s: 53,
      t: "MESSAGE_CREATE",
      d: { ...message, author: { ...message.author, bot: "yes" } }
    });
    socket.receive({ op: 9, d: "false" });
    socket.receive({ op: 0, s: -1, t: "MESSAGE_CREATE", d: message });
    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }));
    socket.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([1, 2]) })
    );
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    socket.receive({ op: 1 });
    expect(frames(socket)).toEqual([{ op: 1, d: 53 }]);
  });

  it("resumes on the supplied Gateway URL with the last sequence and ignores retired socket frames", () => {
    const { socket, onEvent, onStatus } = start();
    ready(socket);
    socket.receive({ op: 0, s: 42, t: "MESSAGE_CREATE", d: message });
    socket.disconnect(1006);
    expect(onStatus).toHaveBeenLastCalledWith({
      phase: "reconnecting",
      userName: "bot"
    });
    socket.receive({ op: 0, s: 99, t: "MESSAGE_CREATE", d: message });
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const replacement = FakeWebSocket.instances[1];
    expect(replacement.url).toBe(
      "wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json"
    );
    replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(frames(replacement)).toEqual([
      { op: 6, d: { token: "token-1", session_id: "session-1", seq: 42 } }
    ]);
    socket.receive({ op: 7 });
    socket.disconnect(4004);
    replacement.receive({
      op: 0,
      s: 43,
      t: "MESSAGE_CREATE",
      d: { ...message, id: "replayed" }
    });
    replacement.receive({ op: 0, s: 44, t: "RESUMED", d: {} });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith({
      phase: "connected",
      userName: "bot"
    });
    replacement.disconnect(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("retires a zombie immediately and resumes without waiting for the old close event", () => {
    const { socket, onEvent } = start();
    ready(socket);
    vi.advanceTimersByTime(500);
    expect(frames(socket).at(-1)).toEqual({ op: 1, d: 41 });
    vi.advanceTimersByTime(1_000);
    expect(socket.closed).toEqual({
      code: 4000,
      reason: "heartbeat ack missed"
    });
    expect(vi.getTimerCount()).toBe(1);
    socket.receive({ op: 11 });
    socket.receive({ op: 0, s: 99, t: "MESSAGE_CREATE", d: message });
    vi.advanceTimersByTime(1_000);
    const replacement = FakeWebSocket.instances[1];
    replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(frames(replacement)[0]).toEqual({
      op: 6,
      d: { token: "token-1", session_id: "session-1", seq: 41 }
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(2);
    socket.disconnect(1006);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("resumes immediately when Discord requests a reconnect", () => {
    const { socket } = start();
    ready(socket);
    socket.receive({ op: 7 });
    expect(socket.closed?.code).toBe(4000);
    vi.advanceTimersByTime(0);
    const replacement = FakeWebSocket.instances[1];
    replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(frames(replacement)[0].op).toBe(6);
  });

  it.each([true, false])(
    "handles Invalid Session resumable=%s",
    (resumable) => {
      const { socket } = start();
      ready(socket);
      socket.receive({ op: 9, d: resumable });
      vi.advanceTimersByTime(1_000);
      const replacement = FakeWebSocket.instances[1];
      replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
      expect(frames(replacement)[0].op).toBe(resumable ? 6 : 2);
      if (!resumable) {
        expect(replacement.url).toBe(
          "wss://gateway.discord.gg/?v=10&encoding=json"
        );
        replacement.receive({ op: 1 });
        expect(frames(replacement).at(-1)).toEqual({ op: 1, d: null });
      }
    }
  );

  it.each([1000, 1001, 4007, 4009])(
    "starts a new session after close %s",
    (code) => {
      const { socket } = start();
      ready(socket);
      socket.disconnect(code);
      vi.advanceTimersByTime(1_000);
      const replacement = FakeWebSocket.instances[1];
      replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
      expect(replacement.url).toBe(
        "wss://gateway.discord.gg/?v=10&encoding=json"
      );
      expect(frames(replacement)[0].op).toBe(2);
    }
  );

  it.each([4004, 4010, 4011, 4012, 4013, 4014])(
    "stops permanently after fatal close %s",
    (code) => {
      const { socket, onStatus, onEvent } = start();
      ready(socket);
      socket.disconnect(code);
      expect(onStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phase: "auth_failed",
          error: expect.stringContaining(`close ${code}`)
        })
      );
      socket.receive({ op: 0, s: 42, t: "MESSAGE_CREATE", d: message });
      vi.advanceTimersByTime(600_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(onEvent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("cancels heartbeat and reconnect work on cleanup, including queued frames", () => {
    const { socket, stop, onEvent, onStatus } = start();
    ready(socket);
    stop();
    stop();
    expect(socket.closed).toEqual({ code: 1000, reason: "messenger disabled" });
    socket.receive({ op: 0, s: 42, t: "MESSAGE_CREATE", d: message });
    socket.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
    socket.disconnect(4004);
    socket.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(600_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(socket.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    const pending = start();
    pending.socket.disconnect(1006);
    pending.stop();
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated network failures and keeps error-driven reconnects resumable", () => {
    const { socket } = start();
    ready(socket);
    socket.dispatchEvent(new Event("error"));
    expect(socket.closed?.code).toBe(4000);
    let delay = 1_000;
    for (let index = 1; index <= 8; index++) {
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(index);
      vi.advanceTimersByTime(1);
      const replacement = FakeWebSocket.instances[index];
      replacement.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
      expect(frames(replacement)[0].op).toBe(6);
      replacement.disconnect(1006);
      delay = Math.min(delay * 2, 60_000);
    }
  });
});
