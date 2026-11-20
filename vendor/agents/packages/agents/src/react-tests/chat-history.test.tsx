import { cleanup, render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type { useAgent } from "../react";
import {
  getAgentMessages,
  useAgentChat,
  useAgentChatHistory
} from "../chat/react";

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

function connection(key: string, identified = true) {
  const target = new EventTarget();
  return {
    target,
    agent: {
      connectionKey: key,
      agent: "Chat",
      name: key,
      identified,
      connectionError: null,
      getHttpUrl: () => `http://localhost/agents/chat/${key}`,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      send: () => true
    } as unknown as ReturnType<typeof useAgent>
  };
}

const message: UIMessage = {
  id: "first",
  role: "user",
  parts: [{ type: "text", text: "hello" }]
};

describe("native chat history lifetime", () => {
  it("loads once through redial and ignores loader and credential refreshes", async () => {
    const { agent } = connection("one");
    const loader = vi.fn(async () => [message]);
    let history: UIMessage[] | undefined;
    function View({ identified }: { identified: boolean }) {
      agent.identified = identified;
      history = useAgentChatHistory(agent, loader);
      return null;
    }
    const screen = await render(<View identified={true} />);
    await vi.waitFor(() => expect(history).toEqual([message]));
    await screen.rerender(<View identified={false} />);
    await screen.rerender(<View identified={true} />);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(history).toEqual([message]);
  });

  it("retries an initial history read that fails during a disconnect", async () => {
    const { agent } = connection("redial");
    let reject!: (error: Error) => void;
    const pending = new Promise<UIMessage[]>((_resolve, fail) => {
      reject = fail;
    });
    const loader = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce([message]);
    let history: UIMessage[] | undefined;
    function View({ identified }: { identified: boolean }) {
      agent.identified = identified;
      history = useAgentChatHistory(agent, loader);
      return null;
    }
    const screen = await render(<View identified={true} />);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await screen.rerender(<View identified={false} />);
    reject(new Error("Connection lost"));
    await pending.catch(() => {});
    await screen.rerender(<View identified={true} />);
    await vi.waitFor(() => expect(history).toEqual([message]));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("retires cached history when briefly visiting an unidentified destination", async () => {
    const a = connection("a").agent;
    const b = connection("b", false).agent;
    const loader = vi.fn(async () => [message]);
    let history: UIMessage[] | undefined;
    function View({ agent }: { agent: ReturnType<typeof useAgent> }) {
      history = useAgentChatHistory(agent, loader);
      return null;
    }
    const screen = await render(<View agent={a} />);
    await vi.waitFor(() => expect(history).toEqual([message]));
    await screen.rerender(<View agent={b} />);
    a.identified = false;
    await screen.rerender(<View agent={a} />);
    expect(history).toBeUndefined();
    a.identified = true;
    await screen.rerender(<View agent={a} />);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(history).toEqual([message]));
  });

  it("retires an old destination's pending load", async () => {
    const a = connection("a").agent;
    const b = connection("b").agent;
    let finish!: (messages: UIMessage[]) => void;
    const slow = new Promise<UIMessage[]>((resolve) => {
      finish = resolve;
    });
    const loader = vi.fn((agent: ReturnType<typeof useAgent>) =>
      agent.connectionKey === "a" ? slow : Promise.resolve([])
    );
    let history: UIMessage[] | undefined;
    function View({ agent }: { agent: ReturnType<typeof useAgent> }) {
      history = useAgentChatHistory(agent, loader);
      return null;
    }
    const screen = await render(<View agent={a} />);
    await screen.rerender(<View agent={b} />);
    await vi.waitFor(() => expect(history).toEqual([]));
    finish([message]);
    await slow;
    expect(history).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("reports server adoption independently of the initial messages array", async () => {
    const { agent, target } = connection("adoption");
    let chat!: ReturnType<typeof useAgentChat>;
    function View() {
      chat = useAgentChat({
        agent,
        messages: [message],
        getInitialMessages: null,
        resume: false
      });
      return null;
    }
    await render(<View />);
    await vi.waitFor(() => expect(chat?.hasReceivedMessages).toBe(false));
    target.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "cf_agent_chat_messages",
          messages: [message]
        })
      })
    );
    await vi.waitFor(() => expect(chat.hasReceivedMessages).toBe(true));
    expect(chat.messages[0].id).toBe(message.id);
  });

  it("does not turn failed or malformed HTTP history into an empty conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 }))
    );
    await expect(
      getAgentMessages({ url: "http://localhost/get-messages" })
    ).rejects.toThrow("403");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ messages: [] }))
    );
    await expect(
      getAgentMessages({ url: "http://localhost/get-messages" })
    ).rejects.toThrow("array");
  });
});
