/**
 * Regression test for #1837 — reconnect-driven resume overlap.
 *
 * With `resume: true` (the default), `useAgentChat` re-probes the stream after
 * WebSocket close→open transitions. The AI SDK's
 * `Chat.makeRequest` has NO concurrency guard: every resume shares the single
 * mutable `this.activeResponse`, and its `finally` finalizer reads
 * `this.activeResponse.state.message` with a BARE (unguarded) read before
 * clearing it. If a second resume overwrites + clears `activeResponse` before
 * an earlier resume's `finally` runs, the earlier finalizer reads `undefined`
 * and throws `TypeError: Cannot read properties of undefined (reading 'state')`
 * (caught + logged inside makeRequest's finally try/catch).
 *
 * The old `onAgentOpen` guard (`statusRef.current === "ready"` &&
 * `!isAwaitingResume()`) did not close the window, because:
 *   - `isAwaitingResume()` flips false the instant the resume handshake
 *     resolves (STREAM_RESUMING), but the AI SDK only sets status to
 *     "submitted" in a *later microtask* (behind `await reconnectToStream`), and
 *   - `statusRef.current` is lagging React state that hasn't re-rendered yet.
 *
 * So a socket `open` landing in that window (a reconnect storm: flaky mobile
 * link / DO bounce on redeploy) sailed past both guards and launched an
 * overlapping resume. Resume calls now share one full-lifetime operation; an
 * eligible reconnect is retried only after that operation settles.
 *
 * Detailed resume cases drive the real chat hook through an `EventTarget`
 * agent. The socket-boundary regression additionally runs real `useAgent`
 * and PartySocket, replacing only the browser WebSocket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import type { UIMessage } from "ai";
import { StrictMode } from "react";
import { _bufferAgentChatReplayFrame, useAgent } from "../react";
import { useAgentChat } from "../chat/react";

// Async WebSocket-driven updates legitimately land outside act() here; disable
// the act environment after mount (mirrors the other react-tests in this dir).
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeAgent({ name, url }: { name: string; url: string }) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const agent = {
    _pkurl: url,
    _pk: name,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data),
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () =>
      url.replace("ws://", "http://").replace("wss://", "https://")
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    target,
    sentMessages
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

function open(target: EventTarget) {
  target.dispatchEvent(new Event("open"));
}

function close(target: EventTarget) {
  target.dispatchEvent(new Event("close"));
}

const RESUMING = "cf_agent_stream_resuming";
const RESUME_NONE = "cf_agent_stream_resume_none";
const RESUME_ACK = "cf_agent_stream_resume_ack";
const RESUME_REQUEST = "cf_agent_stream_resume_request";
const STREAM_PENDING = "cf_agent_stream_pending";
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const CHAT_MESSAGES = "cf_agent_chat_messages";

function countType(sentMessages: string[], type: string): number {
  return sentMessages
    .map((m) => {
      try {
        return JSON.parse(m) as { type?: string };
      } catch {
        return {};
      }
    })
    .filter((m) => m.type === type).length;
}

function lastFrameOfType(
  sentMessages: string[],
  type: string
): Record<string, unknown> {
  const frame = sentMessages
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => message.type === type)
    .at(-1);
  if (!frame) throw new Error(`No ${type} frame was sent`);
  return frame;
}

type AgentChatResult = ReturnType<typeof useAgentChat>;

function requireChat(chat: AgentChatResult | null): AgentChatResult {
  if (!chat) throw new Error("Chat hook was not initialized");
  return chat;
}

describe("reconnect-driven stream resume", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    cleanup();
  });

  it("buffers socket messages across chat remounts and clears them on address changes", async () => {
    const sockets: TestWebSocket[] = [];

    // Keep PartySocket, useAgent's onMessage, and useAgentChat real. Only the
    // browser WebSocket is replaced; no replay helper participates in this test.
    class TestWebSocket extends EventTarget {
      readyState = WebSocket.CONNECTING;
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      readonly protocol = "";
      readonly extensions = "";

      constructor(readonly url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== WebSocket.CONNECTING) return;
          this.readyState = WebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }

      send() {}

      close(code = 1000, reason = "") {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
      }
    }

    function Chat({ agent }: { agent: ReturnType<typeof useAgent> }) {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [],
        resume: false
      });
      return (
        <div data-testid="messages">
          {chat.messages.flatMap((message) =>
            message.parts.map((part) => (part.type === "text" ? part.text : ""))
          )}
        </div>
      );
    }

    function TestComponent({
      name,
      showChat,
      explicitHost = false
    }: {
      name: string;
      showChat: boolean;
      explicitHost?: boolean;
    }) {
      const agent = useAgent({
        agent: "Chat",
        name,
        host: explicitHost ? window.location.host : undefined,
        protocol: "ws",
        WebSocket: TestWebSocket
      });
      return showChat ? <Chat agent={agent} /> : null;
    }

    function snapshot(socket: TestWebSocket, text: string) {
      const message: UIMessage = {
        id: text,
        role: "assistant",
        parts: [{ type: "text", text }]
      };
      dispatch(socket, { type: CHAT_MESSAGES, messages: [message] });
    }

    const screen = await render(<TestComponent name="alpha" showChat />);
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
      expect(sockets[0].readyState).toBe(WebSocket.OPEN);
    });
    const visibleMessages = () =>
      screen.container.querySelector('[data-testid="messages"]')?.textContent;

    snapshot(sockets[0], "delivered live");
    await vi.waitFor(() => expect(visibleMessages()).toBe("delivered live"));
    await screen.rerender(<TestComponent name="alpha" showChat={false} />);
    await screen.rerender(<TestComponent name="alpha" showChat />);
    // A frame already delivered to the subscribed chat must not be replayed.
    expect(visibleMessages()).toBe("");

    await screen.rerender(<TestComponent name="alpha" showChat={false} />);
    snapshot(sockets[0], "received while chat was closed");
    await screen.rerender(<TestComponent name="alpha" showChat />);
    await vi.waitFor(() =>
      expect(visibleMessages()).toBe("received while chat was closed")
    );

    await screen.rerender(<TestComponent name="alpha" showChat={false} />);
    snapshot(sockets[0], "queued for the old address");
    await screen.rerender(<TestComponent name="beta" showChat={false} />);
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
      expect(sockets[1].readyState).toBe(WebSocket.OPEN);
    });
    await screen.rerender(<TestComponent name="beta" showChat />);
    expect(visibleMessages()).toBe("");

    snapshot(sockets[1], "new address delivered live");
    await vi.waitFor(() =>
      expect(visibleMessages()).toBe("new address delivered live")
    );
    await screen.rerender(<TestComponent name="beta" showChat={false} />);
    snapshot(sockets[1], "new address buffered");
    await screen.rerender(<TestComponent name="beta" showChat />);
    await vi.waitFor(() =>
      expect(visibleMessages()).toBe("new address buffered")
    );

    // Resolving the default host into an explicit option resets useAgent's
    // address key, but PartySocket normalizes both hosts to the same address
    // and retains its socket. The mounted chat still owns its subscription.
    await screen.rerender(<TestComponent name="beta" showChat explicitHost />);
    expect(sockets).toHaveLength(2);
    snapshot(sockets[1], "delivered after host resolution");
    await vi.waitFor(() =>
      expect(visibleMessages()).toBe("delivered after host resolution")
    );
    await screen.rerender(
      <TestComponent name="beta" showChat={false} explicitHost />
    );
    await screen.rerender(<TestComponent name="beta" showChat explicitHost />);
    expect(visibleMessages()).toBe("");
  });

  it("drains an active-stream offer that arrived before the chat hook subscribed", async () => {
    const { agent, sentMessages } = createFakeAgent({
      name: "early-offer",
      url: "ws://localhost:3000/agents/chat/early-offer?_pk=abc"
    });
    _bufferAgentChatReplayFrame(
      agent,
      JSON.stringify({ type: RESUMING, id: "early-stream" })
    );

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [
          {
            id: "live",
            role: "assistant",
            parts: [{ type: "text", text: "live" }]
          }
        ] as UIMessage[]
      });
      return (
        <div>
          <div data-testid="streaming">{String(chat.isServerStreaming)}</div>
          <div data-testid="messages">
            {chat.messages.map((message) => message.id).join(",")}
          </div>
        </div>
      );
    }

    const { container } = await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_ACK)).toBe(1);
      expect(
        container.querySelector('[data-testid="streaming"]')?.textContent
      ).toBe("true");
      expect(
        container.querySelector('[data-testid="messages"]')?.textContent
      ).toBe("live");
    });
  });

  it("drains chat frames received while the chat hook is temporarily unmounted", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "remounted-chat",
      url: "ws://localhost:3000/agents/chat/remounted-chat?_pk=abc"
    });
    const userMessage: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "delegate work" }]
    };
    const assistantMessage: UIMessage = {
      id: "assistant",
      role: "assistant",
      parts: [{ type: "text", text: "delegation aborted" }]
    };
    _bufferAgentChatReplayFrame(
      agent,
      JSON.stringify({ type: CHAT_MESSAGES, messages: [userMessage] })
    );

    function Chat() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [userMessage]
      });
      return (
        <div data-testid="messages">
          {chat.messages.map((message) => message.id).join(",")}
        </div>
      );
    }

    function TestComponent({ showChat }: { showChat: boolean }) {
      return showChat ? <Chat /> : null;
    }

    const screen = await render(<TestComponent showChat />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
      expect(
        screen.container.querySelector('[data-testid="messages"]')?.textContent
      ).toBe("user");
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });

    screen.rerender(<TestComponent showChat={false} />);
    await sleep(0);
    _bufferAgentChatReplayFrame(
      agent,
      JSON.stringify({
        type: CHAT_MESSAGES,
        messages: [userMessage, assistantMessage]
      })
    );
    screen.rerender(<TestComponent showChat />);

    await vi.waitFor(() => {
      expect(
        screen.container.querySelector('[data-testid="messages"]')?.textContent
      ).toBe("user,assistant");
    });
  });

  it.each(["snapshot", "idle", "stale-snapshot", "active"] as const)(
    "reconciles an overflowing remount buffer when the server is %s",
    async (ending) => {
      const { agent, target, sentMessages } = createFakeAgent({
        name: `overflow-${ending}`,
        url: `ws://localhost:3000/agents/chat/overflow-${ending}`
      });
      const user: UIMessage = {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "work" }]
      };
      const answer = "a".repeat(5000);
      const assistant: UIMessage = {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "text", text: answer }]
      };
      const buffer = (frame: Record<string, unknown>) =>
        _bufferAgentChatReplayFrame(agent, JSON.stringify(frame));
      const chunk = (body: Record<string, unknown>, done = false) => ({
        type: CHAT_RESPONSE,
        id: "stream",
        body: JSON.stringify(body),
        done
      });
      function Chat({ messages }: { messages: UIMessage[] }) {
        const chat = useAgentChat({
          agent,
          getInitialMessages: null,
          messages
        });
        return (
          <div>
            <div data-testid="answer">
              {chat.messages
                .filter((message) => message.role === "assistant")
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")}
            </div>
            <div data-testid="streaming">{String(chat.isStreaming)}</div>
          </div>
        );
      }
      buffer({ type: CHAT_MESSAGES, messages: [user] });
      const screen = await render(<Chat messages={[user]} />);
      await vi.waitFor(() =>
        expect(countType(sentMessages, RESUME_REQUEST)).toBe(1)
      );
      dispatch(target, {
        type: RESUME_NONE,
        reason: "idle",
        probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
      });
      await screen.rerender(<></>);
      buffer({ type: CHAT_MESSAGES, messages: [user] });
      buffer(chunk({ type: "start", messageId: assistant.id }));
      buffer(chunk({ type: "text-start", id: "text" }));
      for (const delta of answer)
        buffer(chunk({ type: "text-delta", id: "text", delta }));
      if (ending === "stale-snapshot")
        buffer({ type: CHAT_MESSAGES, messages: [user] });
      if (ending !== "active") {
        buffer(chunk({ type: "text-end", id: "text" }));
        buffer(chunk({ type: "finish" }, true));
      }
      if (ending === "snapshot")
        buffer({ type: CHAT_MESSAGES, messages: [user, assistant] });

      // Rook hydrates persisted SQL messages before mounting chat again.
      // An active stream may not have persisted an assistant at all yet.
      await screen.rerender(
        <Chat messages={ending === "active" ? [user] : [user, assistant]} />
      );
      await vi.waitFor(() =>
        expect(countType(sentMessages, RESUME_REQUEST)).toBe(2)
      );
      expect(
        screen.container.querySelector('[data-testid="answer"]')?.textContent
      ).toBe(ending === "active" ? "" : answer);
      const probeId = lastFrameOfType(sentMessages, RESUME_REQUEST).probeId;
      if (ending === "active") {
        dispatch(target, { type: RESUMING, id: "stream", probeId });
        await vi.waitFor(() =>
          expect(countType(sentMessages, RESUME_ACK)).toBe(1)
        );
        // The existing resume protocol replays the entire stream, then tails
        // live deltas. No retained suffix can create a second partial answer.
        for (const body of [
          { type: "start", messageId: assistant.id },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: answer },
          { type: "text-end", id: "text" },
          { type: "finish" }
        ])
          dispatch(target, {
            ...chunk(body, body.type === "finish"),
            replay: true
          });
      } else {
        dispatch(target, { type: RESUME_NONE, reason: "idle", probeId });
      }
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector('[data-testid="answer"]')?.textContent
        ).toBe(answer);
        expect(
          screen.container.querySelector('[data-testid="streaming"]')
            ?.textContent
        ).toBe("false");
      });
    }
  );

  it.each([4, 5000])(
    "preserves completed tool state after %i buffered stream deltas",
    async (deltaCount) => {
      const { agent, target, sentMessages } = createFakeAgent({
        name: `tool-update-${deltaCount}`,
        url: `ws://localhost:3000/agents/chat/tool-update-${deltaCount}`
      });
      const pending: UIMessage = {
        id: "assistant",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "search",
            toolCallId: "search-1",
            state: "input-available",
            input: { query: "rook" }
          }
        ]
      };
      const completed: UIMessage = {
        ...pending,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "search",
            toolCallId: "search-1",
            state: "output-available",
            input: { query: "rook" },
            output: "found"
          }
        ]
      };
      function Chat({ messages }: { messages: UIMessage[] }) {
        const chat = useAgentChat({
          agent,
          getInitialMessages: null,
          messages
        });
        return (
          <div data-testid="tool-state">
            {chat.messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "dynamic-tool")
              .map((part) =>
                part.state === "output-available"
                  ? `${part.state}:${String(part.output)}`
                  : part.state
              )
              .join(",")}
          </div>
        );
      }
      const screen = await render(<Chat messages={[]} />);
      await vi.waitFor(() =>
        expect(countType(sentMessages, RESUME_REQUEST)).toBe(1)
      );
      dispatch(target, {
        type: RESUME_NONE,
        reason: "idle",
        probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
      });
      await screen.rerender(<></>);
      const buffer = (frame: Record<string, unknown>) =>
        _bufferAgentChatReplayFrame(agent, JSON.stringify(frame));
      const chunk = (body: Record<string, unknown>, done = false) =>
        buffer({
          type: CHAT_RESPONSE,
          id: "stream",
          body: JSON.stringify(body),
          done
        });
      chunk({ type: "start", messageId: pending.id });
      chunk({ type: "text-start", id: "text" });
      for (let i = 0; i < deltaCount; i++)
        chunk({ type: "text-delta", id: "text", delta: "a" });
      chunk({ type: "text-end", id: "text" });
      chunk({ type: "finish" }, true);
      buffer({ type: CHAT_MESSAGES, messages: [pending] });
      // Think persists a resolved tool result and broadcasts MESSAGE_UPDATED
      // alone; there need not be another full transcript snapshot afterward.
      buffer({ type: "cf_agent_message_updated", message: completed });
      await screen.rerender(<Chat messages={[completed]} />);
      await vi.waitFor(() =>
        expect(countType(sentMessages, RESUME_REQUEST)).toBe(2)
      );
      dispatch(target, {
        type: RESUME_NONE,
        reason: "idle",
        probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
      });
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-testid="tool-state"]')
            ?.textContent
        ).toBe("output-available:found")
      );
    }
  );

  it.each([
    { label: "with done", done: true },
    { label: "without done", done: undefined }
  ])(
    "treats observed error frames as terminal $label (#1898)",
    async ({ done }) => {
      const { agent, target, sentMessages } = createFakeAgent({
        name: "observer-error",
        url: "ws://localhost:3000/agents/chat/observer-error?_pk=abc"
      });

      function TestComponent() {
        const chat = useAgentChat({
          agent,
          getInitialMessages: null,
          messages: [] as UIMessage[]
        });
        return (
          <div>
            <div data-testid="message-count">{chat.messages.length}</div>
            <div data-testid="streaming">{String(chat.isServerStreaming)}</div>
          </div>
        );
      }

      const { container } = await render(<TestComponent />);
      await vi.waitFor(() => {
        expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
      });
      dispatch(target, { type: RESUME_NONE, reason: "idle" });

      // With no transport waiting, this stream is handled by the observer path.
      dispatch(target, { type: RESUMING, id: "errored-stream" });
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="streaming"]')?.textContent
        ).toBe("true");
      });

      dispatch(target, {
        type: CHAT_RESPONSE,
        id: "errored-stream",
        body: "Network connection lost.",
        done,
        error: true,
        replay: true
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="streaming"]')?.textContent
        ).toBe("false");
        expect(
          container.querySelector('[data-testid="message-count"]')?.textContent
        ).toBe("0");
      });
      expect(warnSpy).not.toHaveBeenCalled();
    }
  );

  it("serializes overlapping resumes and never reads a cleared activeResponse (#1837)", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "overlap",
      url: "ws://localhost:3000/agents/chat/overlap?_pk=abc"
    });

    function TestComponent() {
      useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return <div data-testid="ok">ok</div>;
    }

    await render(<TestComponent />);
    await sleep(10);

    // Settle the AI SDK's mount-time resume so the chat is at "ready" and the
    // transport is no longer awaiting a resume (isAwaitingResume() === false).
    dispatch(target, { type: RESUME_NONE });
    await sleep(10);

    // A bare initial open is ignored. An actual close→open then fires resume A.
    open(target);
    close(target);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);
    });

    // Server announces resume A. The handshake resolves SYNCHRONOUSLY here, so
    // isAwaitingResume() flips false immediately — but the AI SDK only sets
    // status to "submitted" in a *later microtask*. A duplicate bare "open"
    // dispatched in the same synchronous turn used to launch an overlapping
    // resume B. Close→open tracking and the full-lifetime gate both reject it.
    const requestsBeforeOverlap = countType(sentMessages, RESUME_REQUEST);
    dispatch(target, { type: RESUMING, id: "s1" });
    open(target); // overlapping reconnect — no await before this
    await sleep(10);
    const requestsAfterOverlap = countType(sentMessages, RESUME_REQUEST);

    // Server announces a second stream id (the would-be overlapping resume B).
    dispatch(target, { type: RESUMING, id: "s2" });
    await sleep(10);

    // B settles first and clears the shared activeResponse...
    dispatch(target, { type: CHAT_RESPONSE, id: "s2", body: "", done: true });
    await sleep(10);

    // ...then A's finalizer runs. Pre-fix it read the now-undefined
    // activeResponse and threw.
    dispatch(target, { type: CHAT_RESPONSE, id: "s1", body: "", done: true });
    await sleep(10);

    const captured = (errorSpy.mock.calls.flat() as unknown[]).map(
      (a: unknown) => (a instanceof Error ? a.message : String(a))
    );
    const sawStateTypeError = captured.some((m: string) =>
      /reading 'state'|Cannot read properties of undefined/.test(m)
    );

    // The overlapping reconnect must not issue a second resume...
    expect(requestsAfterOverlap).toBe(requestsBeforeOverlap);
    // ...and the AI SDK finalizer must never read a cleared activeResponse.
    expect(sawStateTypeError).toBe(false);
  });

  it("re-probes a real client error and clears only an explicitly idle result (#1914)", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "error-reconnect",
      url: "ws://localhost:3000/agents/chat/error-reconnect?_pk=abc"
    });

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        // #1913 is a client-side failure while otherwise-valid replay keeps
        // running on the server. Throwing from the real AI SDK onData seam
        // reproduces that split without inventing a server error frame.
        onData: () => {
          throw new Error("forced client stream failure");
        }
      });
      return (
        <div>
          <div data-testid="status">{chat.status}</div>
          <div data-testid="is-server-streaming">
            {String(chat.isServerStreaming)}
          </div>
        </div>
      );
    }

    const { container } = await render(<TestComponent />);

    const expectHookState = async (status: string, isStreaming: boolean) => {
      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="status"]')?.textContent
        ).toBe(status);
        expect(
          container.querySelector('[data-testid="is-server-streaming"]')
            ?.textContent
        ).toBe(String(isStreaming));
      });
    };

    // Settle the mount-time probe. A bare initial open does not re-probe; with
    // no transport resolver waiting, the offer below enters the fallback.
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await expectHookState("ready", false);
    open(target);

    dispatch(target, { type: RESUMING, id: "s1" });
    await expectHookState("ready", true);

    // A stale/unowned NONE must not tear down the live fallback observer.
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await expectHookState("ready", true);

    // Hand the observed stream to a transport-owned resume. A valid data chunk
    // reaches onData and fails only the client stream; the simulated server
    // remains active and deliberately omits its terminal frame.
    close(target);
    const requestsBeforeHandoff = countType(sentMessages, RESUME_REQUEST);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(
        requestsBeforeHandoff + 1
      );
    });
    dispatch(target, { type: RESUMING, id: "s1" });
    dispatch(target, {
      type: CHAT_RESPONSE,
      id: "s1",
      body: JSON.stringify({
        type: "data-client-failure",
        data: { valid: true },
        transient: true
      }),
      done: false
    });
    await expectHookState("error", true);

    // The server completes while disconnected. Reconnect must probe even though
    // AI SDK status remains error.
    close(target);
    const requestsBeforeErrorReconnect = countType(
      sentMessages,
      RESUME_REQUEST
    );
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(
        requestsBeforeErrorReconnect + 1
      );
    });

    const activeProbeId = lastFrameOfType(sentMessages, RESUME_REQUEST).probeId;

    // A late authoritative reply for an older probe must not settle or clear
    // the current generation.
    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: "stale-probe"
    });
    await expectHookState("error", true);

    // RESUME_NONE also means "an active continuation belongs to another live
    // connection". It resolves this probe but must not clear fallback state.
    dispatch(target, {
      type: RESUME_NONE,
      reason: "continuation-owned",
      probeId: activeProbeId
    });
    dispatch(target, {
      type: CHAT_RESPONSE,
      id: "s1",
      body: JSON.stringify({ type: "text-start", id: "still-live" }),
      continuation: true,
      done: false
    });
    await expectHookState("error", true);

    // A later reconnect receives the distinct globally-idle result. Only this
    // correlated active probe may settle the fallback observer.
    close(target);
    const requestsBeforeIdle = countType(sentMessages, RESUME_REQUEST);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(
        requestsBeforeIdle + 1
      );
    });
    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
    });
    await expectHookState("error", false);

    const captured = (errorSpy.mock.calls.flat() as unknown[]).map(
      (a: unknown) => (a instanceof Error ? a.message : String(a))
    );
    expect(
      captured.some((message: string) =>
        /reading 'state'|Cannot read properties of undefined/.test(message)
      )
    ).toBe(false);
  });

  it("retransmits an in-flight probe on the replacement socket", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "probe-retransmit",
      url: "ws://localhost:3000/agents/chat/probe-retransmit?_pk=abc"
    });

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return (
        <div data-testid="is-server-streaming">
          {String(chat.isServerStreaming)}
        </div>
      );
    }

    const { container } = await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    open(target);

    dispatch(target, { type: RESUMING, id: "lost-probe-stream" });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="is-server-streaming"]')
          ?.textContent
      ).toBe("true");
    });

    close(target);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);
    });

    // The reply to request 2 is lost with its socket. The replacement socket
    // must retransmit that SAME transport handshake instead of starting an
    // overlapping AI SDK resume or waiting five seconds with no queued retry.
    close(target);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(3);
    });

    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="is-server-streaming"]')
          ?.textContent
      ).toBe("false");
    });
  });

  it("recognizes a reconnect after mounting against an already-open agent", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "already-open",
      url: "ws://localhost:3000/agents/chat/already-open?_pk=abc"
    });

    function TestComponent() {
      useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return null;
    }

    await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });

    // No initial `open` event is observed by the hook: the parent agent was
    // already connected when useAgentChat mounted. A close→open is still a real
    // reconnect and must not be mistaken for the initial open.
    close(target);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);
    });
  });

  it("queues an open that arrives while a local stream is still settling", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "status-transition",
      url: "ws://localhost:3000/agents/chat/status-transition?_pk=abc"
    });
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return <div data-testid="status">{chat.status}</div>;
    }

    const { container } = await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });

    void requireChat(chatInstance).sendMessage({ text: "hello" });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="status"]')?.textContent
      ).toMatch(/submitted|streaming/);
    });

    const request = lastFrameOfType(sentMessages, "cf_agent_use_chat_request");
    dispatch(target, {
      type: STREAM_PENDING,
      id: request.id,
      persisted: true
    });

    // close synchronously terminates the transport stream, but React/AI SDK
    // status reaches ready in a later job. The open edge must survive that gap.
    close(target);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);
    });
  });

  it("reports a close before the chat request is acknowledged", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "unacknowledged-send",
      url: "ws://localhost:3000/agents/chat/unacknowledged-send?_pk=abc"
    });
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return (
        <div>
          <div data-testid="status">{chat.status}</div>
          <div data-testid="error">{chat.error?.message}</div>
        </div>
      );
    }

    const { container } = await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });

    void requireChat(chatInstance).sendMessage({ text: "hello" });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="status"]')?.textContent
      ).toMatch(/submitted|streaming/);
    });

    close(target);

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="status"]')?.textContent
      ).toBe("error");
      expect(
        container.querySelector('[data-testid="error"]')?.textContent
      ).toContain("before the chat request was acknowledged");
    });

    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="error"]')?.textContent
      ).toContain("before the chat request was acknowledged");
    });
  });

  it("reconciles an early fallback-observed tool continuation after lost done", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "early-tool-reconnect",
      url: "ws://localhost:3000/agents/chat/early-tool-reconnect?_pk=abc"
    });
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;
    const initialMessages: UIMessage[] = [
      {
        id: "assistant-tool",
        role: "assistant",
        parts: [
          {
            type: "tool-clientTool",
            toolCallId: "tool-1",
            state: "input-available",
            input: {}
          }
        ]
      }
    ];

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: initialMessages
      });
      chatInstance = chat;
      return (
        <div>
          <div data-testid="tool">{String(chat.isToolContinuation)}</div>
          <div data-testid="streaming">{String(chat.isServerStreaming)}</div>
        </div>
      );
    }

    const { container } = await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });

    // The server announces the continuation before the zero-delay launcher can
    // attach a transport stream, so the hook intentionally takes its fallback.
    requireChat(chatInstance).addToolOutput({
      toolCallId: "tool-1",
      toolName: "clientTool",
      output: { ok: true }
    });
    dispatch(target, { type: RESUMING, id: "early-continuation" });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="tool"]')?.textContent).toBe(
        "true"
      );
      expect(
        container.querySelector('[data-testid="streaming"]')?.textContent
      ).toBe("true");
    });

    // The terminal continuation frame is lost. Reconnect after server
    // completion must bypass only the fallback-observed continuation guard.
    close(target);
    const beforeReconnect = countType(sentMessages, RESUME_REQUEST);
    open(target);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(beforeReconnect + 1);
    });
    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: lastFrameOfType(sentMessages, RESUME_REQUEST).probeId
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="tool"]')?.textContent).toBe(
        "false"
      );
      expect(
        container.querySelector('[data-testid="streaming"]')?.textContent
      ).toBe("false");
    });
  });

  it("clears a disconnected fallback observer when resume is disabled", async () => {
    const { agent, target } = createFakeAgent({
      name: "resume-disabled",
      url: "ws://localhost:3000/agents/chat/resume-disabled?_pk=abc"
    });

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[],
        resume: false
      });
      return (
        <div data-testid="streaming">{String(chat.isServerStreaming)}</div>
      );
    }

    const { container } = await render(<TestComponent />);
    dispatch(target, {
      type: CHAT_RESPONSE,
      id: "other-tab",
      body: JSON.stringify({ type: "text-start", id: "text-1" }),
      done: false
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="streaming"]')?.textContent
      ).toBe("true");
    });

    close(target);
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="streaming"]')?.textContent
      ).toBe("false");
    });
  });

  it("cancels an old agent handshake before the new Chat generation probes", async () => {
    const a = createFakeAgent({
      name: "agent-a",
      url: "ws://localhost:3000/agents/chat/agent-a?_pk=abc"
    });
    const b = createFakeAgent({
      name: "agent-b",
      url: "ws://localhost:3000/agents/chat/agent-b?_pk=def"
    });

    function TestComponent({ agent }: { agent: ReturnType<typeof useAgent> }) {
      useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      return null;
    }

    const screen = await render(<TestComponent agent={a.agent} />);
    await vi.waitFor(() => {
      expect(countType(a.sentMessages, RESUME_REQUEST)).toBe(1);
    });

    screen.rerender(<TestComponent agent={b.agent} />);
    await vi.waitFor(() => {
      expect(countType(b.sentMessages, RESUME_REQUEST)).toBe(1);
    });

    // A late offer from A has no listener/resolver ownership and cannot be ACKed
    // through B or mark B's request ID transport-owned.
    dispatch(a.target, { type: RESUMING, id: "stale-a" });
    await sleep(10);
    expect(countType(b.sentMessages, "cf_agent_stream_resume_ack")).toBe(0);

    dispatch(b.target, { type: RESUMING, id: "current-b" });
    await vi.waitFor(() => {
      expect(countType(b.sentMessages, "cf_agent_stream_resume_ack")).toBe(1);
    });
    dispatch(b.target, {
      type: CHAT_RESPONSE,
      id: "current-b",
      body: "",
      done: true
    });
  });

  it("keeps StrictMode mount generations identity-owned", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "strict-resume",
      url: "ws://localhost:3000/agents/chat/strict-resume?_pk=abc"
    });
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return null;
    }

    await render(
      <StrictMode>
        <TestComponent />
      </StrictMode>
    );
    await sleep(20);

    const requests = sentMessages
      .map((message) => JSON.parse(message) as Record<string, unknown>)
      .filter((message) => message.type === RESUME_REQUEST);
    expect(requests).toHaveLength(2);

    // The first setup was cleaned up. Its late correlated response cannot
    // settle the second setup's resolver or make a public call start a third.
    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: requests[0].probeId
    });
    const current = requireChat(chatInstance).resumeStream();
    await sleep(10);
    expect(countType(sentMessages, RESUME_REQUEST)).toBe(2);

    dispatch(target, {
      type: RESUME_NONE,
      reason: "idle",
      probeId: requests[1].probeId
    });
    await current;
  });

  it("single-flights the public resume helper with reconnect-driven resumes", async () => {
    const { agent, target, sentMessages } = createFakeAgent({
      name: "public-resume",
      url: "ws://localhost:3000/agents/chat/public-resume?_pk=abc"
    });
    let chatInstance: ReturnType<typeof useAgentChat> | null = null;

    function TestComponent() {
      const chat = useAgentChat({
        agent,
        getInitialMessages: null,
        messages: [] as UIMessage[]
      });
      chatInstance = chat;
      return null;
    }

    await render(<TestComponent />);
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(1);
    });
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await sleep(10);

    const before = countType(sentMessages, RESUME_REQUEST);
    const first = requireChat(chatInstance).resumeStream();
    const second = requireChat(chatInstance).resumeStream();
    await vi.waitFor(() => {
      expect(countType(sentMessages, RESUME_REQUEST)).toBe(before + 1);
    });
    expect(second).toBe(first);

    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await Promise.all([first, second]);
    expect(countType(sentMessages, RESUME_REQUEST)).toBe(before + 1);
  });
});
