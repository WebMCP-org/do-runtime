import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSlackSocketClient } from "../messengers/browser/slack-socket";

class BoundaryWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: BoundaryWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = BoundaryWebSocket.OPEN;
  closed?: { code: number; reason: string };

  constructor(readonly url: string) {
    super();
    BoundaryWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  receive(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data)
      })
    );
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

describe("native Slack Socket Mode transport", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    BoundaryWebSocket.instances = [];
    vi.stubGlobal("WebSocket", BoundaryWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ok: true,
          url: `wss://slack.test/${BoundaryWebSocket.instances.length}`
        })
      )
    );
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("authenticates, acks first and forwards bot, interactive and retry envelopes", async () => {
    const onStatus = vi.fn();
    const onEvent = vi.fn(() => {
      expect(BoundaryWebSocket.instances[0].sent).toHaveLength(
        onEvent.mock.calls.length
      );
    });
    stop = startSlackSocketClient({ appToken: "xapp-test", onEvent, onStatus });
    await vi.waitFor(() => expect(BoundaryWebSocket.instances).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: { authorization: "Bearer xapp-test" },
        signal: expect.any(AbortSignal)
      }
    );
    const socket = BoundaryWebSocket.instances[0];
    socket.receive({ type: "hello" });
    expect(onStatus).toHaveBeenLastCalledWith({ phase: "connected" });
    const payload = {
      event: { type: "message", bot_id: "B1", text: "deploy done" }
    };
    socket.receive({
      type: "events_api",
      envelope_id: "E1",
      payload,
      retry_num: 2
    });
    expect(JSON.parse(socket.sent[0])).toEqual({ envelope_id: "E1" });
    expect(onEvent).toHaveBeenCalledWith({
      headers: {
        "content-type": "application/json",
        "x-slack-socket-token": "xapp-test"
      },
      body: JSON.stringify({
        type: "socket_event",
        eventType: "events_api",
        body: payload,
        timestamp: Date.now(),
        retryNum: 2
      })
    });
    socket.receive({
      type: "interactive",
      envelope_id: "E2",
      payload: { type: "block_actions" }
    });
    expect(JSON.parse(socket.sent[1])).toEqual({ envelope_id: "E2" });
    expect(onEvent).toHaveBeenCalledTimes(2);
    socket.receive("not JSON");
    socket.receive({ envelope_id: "invalid" });
    socket.receive({ type: "events_api" });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("mints fresh URLs, backs off and ignores retired sockets", async () => {
    const onStatus = vi.fn();
    const onEvent = vi.fn();
    stop = startSlackSocketClient({ appToken: "xapp-test", onEvent, onStatus });
    await vi.waitFor(() => expect(BoundaryWebSocket.instances).toHaveLength(1));
    const first = BoundaryWebSocket.instances[0];
    first.receive({ type: "hello" });
    first.receive({ type: "disconnect" });
    expect(first.closed?.code).toBe(4000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(BoundaryWebSocket.instances).toHaveLength(2));
    const second = BoundaryWebSocket.instances[1];
    expect(second.url).not.toBe(first.url);
    second.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(BoundaryWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(BoundaryWebSocket.instances).toHaveLength(3));
    const third = BoundaryWebSocket.instances[2];
    onStatus.mockClear();
    first.receive({ type: "hello" });
    first.receive({ type: "disconnect" });
    first.receive({ type: "events_api", envelope_id: "stale" });
    expect(onStatus).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(third.closed).toBeUndefined();
    stop();
    third.receive({ type: "hello" });
    third.receive({ type: "events_api", envelope_id: "stopped" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(BoundaryWebSocket.instances).toHaveLength(3);
  });

  it("retries transient API and constructor failures, then parks on fatal authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ ok: false, error: "ratelimited" }))
        .mockResolvedValueOnce(response({ ok: true, url: "not-a-websocket" }))
        .mockResolvedValueOnce(response({ ok: false, error: "invalid_auth" }))
    );
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("Socket construction rejected");
        }
      }
    );
    const onStatus = vi.fn();
    stop = startSlackSocketClient({
      appToken: "xapp-test",
      onEvent: vi.fn(),
      onStatus
    });
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({
        phase: "reconnecting",
        error: "ratelimited"
      })
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({ phase: "reconnecting" })
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenLastCalledWith({
        phase: "auth_failed",
        error: "invalid_auth"
      })
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["reject", "fatal", "success"])(
    "aborts and ignores a late %s handshake after stop",
    async (outcome) => {
      let resolve!: (value: Response) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<Response>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const request = vi.fn(
        (_input: RequestInfo | URL, _init?: RequestInit) => pending
      );
      vi.stubGlobal("fetch", request);
      const onStatus = vi.fn();
      stop = startSlackSocketClient({
        appToken: "xapp-test",
        onEvent: vi.fn(),
        onStatus
      });
      stop();
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      onStatus.mockClear();
      if (outcome === "reject") reject(new Error("network failed"));
      else
        resolve(
          response(
            outcome === "fatal"
              ? { ok: false, error: "invalid_auth" }
              : { ok: true, url: "wss://slack.test/late" }
          )
        );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onStatus).not.toHaveBeenCalled();
      expect(BoundaryWebSocket.instances).toHaveLength(0);
      expect(request).toHaveBeenCalledTimes(1);
    }
  );
});
