/**
 * `useAgentChat` throttles chat updates by default.
 *
 * Merging replayed chunks (#1913) removes one update per chunk, but a replayed
 * turn still costs about one update per part, so a turn with enough tool steps
 * reaches React's 50-render limit anyway. A throttle is independent of the
 * number of chunks, so it covers what merging cannot.
 *
 * The turn below is the shape that still failed after merging landed: 12 tool
 * steps, each with reasoning, a streamed tool input, a result, and a paragraph
 * of text.
 */
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as _render } from "vitest-browser-react";
import { useAgentChat } from "../chat/react";
import type { useAgent } from "../react";

const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RESUMING = "cf_agent_stream_resuming";
const RESUME_REQUEST = "cf_agent_stream_resume_request";
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const CHAT_MESSAGES = "cf_agent_chat_messages";

function createFakeAgent(name: string) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const url = `ws://localhost:3000/agents/chat/${name}?_pk=abc`;
  const agent = {
    _pk: name,
    _pkurl: url,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    dispatchEvent: target.dispatchEvent.bind(target),
    getHttpUrl: () => url.replace("ws://", "http://"),
    id: "fake-agent",
    name,
    path: [{ agent: "Chat", name }],
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data)
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    sentMessages,
    target
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

const countType = (sent: string[], type: string) =>
  sent.filter((m) => {
    try {
      return (JSON.parse(m) as { type?: string }).type === type;
    } catch {
      return false;
    }
  }).length;

const TOOL_STEPS = 12;
const WORDS_PER_STEP = 30;

/** The chunk bodies of an agentic turn: tool call, result, and text per step. */
function toolTurnBodies() {
  const bodies: Record<string, unknown>[] = [
    { messageId: "asst-1", type: "start" }
  ];
  for (let step = 0; step < TOOL_STEPS; step++) {
    bodies.push({ type: "start-step" });
    bodies.push({ id: `r${step}`, type: "reasoning-start" });
    for (let i = 0; i < 20; i++) {
      bodies.push({ delta: "think ", id: `r${step}`, type: "reasoning-delta" });
    }
    bodies.push({ id: `r${step}`, type: "reasoning-end" });
    bodies.push({
      toolCallId: `call-${step}`,
      toolName: "search",
      type: "tool-input-start"
    });
    for (let i = 0; i < 10; i++) {
      bodies.push({
        inputTextDelta: "x",
        toolCallId: `call-${step}`,
        type: "tool-input-delta"
      });
    }
    bodies.push({
      input: { q: "x" },
      toolCallId: `call-${step}`,
      toolName: "search",
      type: "tool-input-available"
    });
    bodies.push({
      output: { result: "ok" },
      toolCallId: `call-${step}`,
      type: "tool-output-available"
    });
    bodies.push({ id: `t${step}`, type: "text-start" });
    for (let i = 0; i < WORDS_PER_STEP; i++) {
      bodies.push({ delta: "word ", id: `t${step}`, type: "text-delta" });
    }
    bodies.push({ id: `t${step}`, type: "text-end" });
    bodies.push({ type: "finish-step" });
  }
  return bodies;
}

const expectedChars = TOOL_STEPS * WORDS_PER_STEP * "word ".length;

async function mount(
  name: string,
  throttle?: number | false,
  renderCostMs = 0
) {
  const { agent, sentMessages, target } = createFakeAgent(name);
  let setChatMessages: ReturnType<typeof useAgentChat>["setMessages"] | null =
    null;

  let chatApi: ReturnType<typeof useAgentChat>;

  const approvalCallbacks = new Set<
    ReturnType<typeof useAgentChat>["addToolApprovalResponse"]
  >();

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      autoContinueAfterToolResult: false,
      getInitialMessages: null,
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" }
      ] as UIMessage[],
      throttle
    });
    // Model a busy transcript while queued socket tasks keep arriving.
    const renderDeadline = performance.now() + renderCostMs;
    while (performance.now() < renderDeadline) {
      /* synchronous render work */
    }
    chatApi = chat;
    setChatMessages = chat.setMessages;
    approvalCallbacks.add(chat.addToolApprovalResponse);
    const assistantText = chat.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    return (
      <div>
        <div data-testid="status">{chat.status}</div>
        <div data-testid="error">{String(chat.error?.message ?? "")}</div>
        <div data-testid="chars">{assistantText.length}</div>
        <div data-testid="message-ids">
          {chat.messages.map((message) => message.id).join(",")}
        </div>
      </div>
    );
  }

  const { container } = await render(<TestComponent />);
  return {
    read: (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    sentMessages,
    approvalCallbacks,
    chat: () => chatApi,
    setMessages: (...args: Parameters<NonNullable<typeof setChatMessages>>) => {
      if (!setChatMessages) {
        throw new Error("Default throttle test chat is not mounted");
      }
      return setChatMessages(...args);
    },
    target
  };
}

/** Replays a whole agentic turn in one task, as a resumed stream does. */
async function replayTurn(h: Awaited<ReturnType<typeof mount>>) {
  await vi.waitFor(() =>
    expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
  );
  dispatch(h.target, { id: "req-1", type: RESUMING });
  await sleep(10);

  for (const body of toolTurnBodies()) {
    dispatch(h.target, {
      body: JSON.stringify(body),
      done: false,
      id: "req-1",
      replay: true,
      type: CHAT_RESPONSE
    });
  }
  dispatch(h.target, {
    body: "",
    done: true,
    id: "req-1",
    type: CHAT_RESPONSE
  });
  await sleep(300);
}

describe("default chat throttle", () => {
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

  it("replays a tool-heavy turn without exceeding React's update depth", async () => {
    const h = await mount("throttle-default");
    await replayTurn(h);

    expect({
      chars: h.read("chars"),
      error: h.read("error"),
      status: h.read("status")
    }).toEqual({
      chars: String(expectedChars),
      error: "",
      status: "ready"
    });
  });

  it("streams a long turn without exhausting React's update depth", async () => {
    const h = await mount("live-tool-result-prune", false, 3);
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );
    dispatch(h.target, { id: "req-live", type: RESUMING });
    const frames = [
      { messageId: "asst-1", type: "start" },
      { type: "start-step" },
      { id: "t1", type: "text-start" },
      ...Array.from({ length: 120 }, () => ({
        delta: "word ",
        id: "t1",
        type: "text-delta"
      })),
      { id: "t1", type: "text-end" },
      { type: "finish-step" }
    ];
    // Each frame is its own queued socket task. Awaiting between frames
    // would drain React's pending work and hide the cleanup dispatch bug.
    await new Promise<void>((resolve) => {
      for (const [index, frame] of frames.entries()) {
        setTimeout(() => {
          dispatch(h.target, {
            body: JSON.stringify(frame),
            done: false,
            id: "req-live",
            type: CHAT_RESPONSE
          });
          if (index === frames.length - 1) resolve();
        }, 0);
      }
    });
    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-live",
      type: CHAT_RESPONSE
    });
    await vi.waitFor(() =>
      expect({
        chars: h.read("chars"),
        error: h.read("error"),
        status: h.read("status")
      }).toEqual({ chars: "600", error: "", status: "ready" })
    );
  });

  it("retains visible tool results and prunes them after history removes the call", async () => {
    const h = await mount("tool-result-lifetime");
    const pending: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "call-1",
          state: "input-available",
          input: { query: "hi" }
        }
      ]
    };
    h.setMessages([pending]);
    await vi.waitFor(() => expect(h.chat().messages).toEqual([pending]));
    h.chat().addToolOutput({
      toolName: "search",
      toolCallId: "call-1",
      output: "found"
    });
    await vi.waitFor(() =>
      expect(h.chat().messages[0].parts[0]).toMatchObject({
        state: "output-available",
        output: "found"
      })
    );
    // An older snapshot must keep the client's result while its call exists.
    h.setMessages([pending]);
    await vi.waitFor(() =>
      expect(h.chat().messages[0].parts[0]).toMatchObject({
        state: "output-available",
        output: "found"
      })
    );
    h.setMessages([]);
    await vi.waitFor(() => expect(h.chat().messages).toEqual([]));
    h.setMessages([pending]);
    await vi.waitFor(() => expect(h.chat().messages).toEqual([pending]));
  });

  it("keeps approval controls stable while streamed messages change", async () => {
    const h = await mount("stable-approval-controls");
    await replayTurn(h);
    expect(h.read("chars")).toBe(String(expectedChars));
    expect(h.approvalCallbacks.size).toBe(1);
  });

  it("resolves functional updates against the current Chat store", async () => {
    const h = await mount("current-store-updater");

    h.setMessages((messages) => [
      ...messages,
      {
        id: "a1",
        parts: [{ text: "streamed", type: "text" }],
        role: "assistant"
      }
    ]);
    h.setMessages((messages) => [
      ...messages,
      { id: "u2", parts: [{ text: "next", type: "text" }], role: "user" }
    ]);

    await vi.waitFor(() => expect(h.read("message-ids")).toBe("u1,a1,u2"));
    expect(h.sentMessages[h.sentMessages.length - 1]).toContain('"id":"a1"');
  });

  it("preserves Chat store parts newer than the rendered snapshot", async () => {
    const h = await mount("current-store-snapshot", 200);
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );
    dispatch(h.target, { id: "req-snapshot", type: RESUMING });
    await sleep(10);

    for (const body of [
      { messageId: "asst-1", type: "start" },
      { id: "text-1", type: "text-start" },
      { delta: "first", id: "text-1", type: "text-delta" }
    ]) {
      dispatch(h.target, {
        body: JSON.stringify(body),
        done: false,
        id: "req-snapshot",
        type: CHAT_RESPONSE
      });
    }
    await vi.waitFor(() => expect(h.read("chars")).toBe("5"));

    dispatch(h.target, {
      body: JSON.stringify({
        delta: " second",
        id: "text-1",
        type: "text-delta"
      }),
      done: false,
      id: "req-snapshot",
      type: CHAT_RESPONSE
    });
    await sleep(10);
    dispatch(h.target, {
      messages: [
        { id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
        {
          id: "asst-1",
          parts: [{ text: "first", type: "text" }],
          role: "assistant"
        }
      ],
      type: CHAT_MESSAGES
    });

    await vi.waitFor(() => expect(h.read("chars")).toBe("12"));
  });
});
