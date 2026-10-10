/**
 * A model stream cut inside a tool call must end the turn with a visible
 * error, not a silent `completed`.
 *
 * The provider's response can stop mid tool input two ways: the body errors
 * (a network failure), or it ends cleanly with no finish chunk (a relay or
 * proxy closing the response early). In the second case the AI SDK keeps the
 * partial step and reports `finish` with reason `other`, so the turn looked
 * complete: no error frame, no `onChatError`, and a tool call left
 * `input-streaming` until the next turn's transcript repair.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import type { ThinkTestAgent } from "./agents/think-session";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

type ResponseFrame = {
  id: string;
  body?: string;
  done?: boolean;
  error?: boolean;
  outcome?: string;
};

async function freshAgent() {
  const room = crypto.randomUUID();
  const agent = await getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    room
  );
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { agent, ws };
}

/** Sends one chat request and collects its error and terminal frames. */
function sendAndWaitForDone(
  ws: WebSocket,
  requestId: string,
  text: string
): Promise<ResponseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ResponseFrame[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      10_000
    );
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as ResponseFrame & {
        type?: string;
      };
      if (msg.type !== MSG_CHAT_RESPONSE || msg.id !== requestId) return;
      if (msg.done || msg.error) frames.push(msg);
      if (msg.done) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(frames);
      }
    };
    ws.addEventListener("message", handler);
    const message: UIMessage = {
      id: `u-${requestId}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [message] })
        }
      })
    );
  });
}

function cutToolPart(messages: UIMessage[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .find(
      (part) => (part as { toolCallId?: string }).toolCallId === "tc-cut"
    ) as { type: string; state?: string } | undefined;
}

describe("Think — model stream cut inside a tool call", () => {
  it.each(["close", "error"] as const)(
    "reports an error to WebSocket clients when the stream %ss mid tool input",
    async (ending) => {
      const { agent, ws } = await freshAgent();
      await agent.setCutToolInputResponseForTest(ending);
      try {
        const frames = await sendAndWaitForDone(ws, "req-cut", "write it");

        const errorFrame = frames.find((frame) => frame.error === true);
        expect(errorFrame?.body).toBeTruthy();
        expect(frames.at(-1)?.done).toBe(true);
        expect(frames.at(-1)?.outcome).not.toBe("completed");
      } finally {
        ws.close();
      }
    }
  );

  it("keeps the cut tool call for the next turn's transcript repair", async () => {
    const { agent, ws } = await freshAgent();
    await agent.setCutToolInputResponseForTest("close");
    try {
      await sendAndWaitForDone(ws, "req-cut", "write it");
      expect(cutToolPart(await agent.getStoredMessages())).toMatchObject({
        type: "tool-write",
        state: "input-streaming"
      });

      await agent.setCutToolInputResponseForTest(null);
      await sendAndWaitForDone(ws, "req-next", "try again");
      expect(cutToolPart(await agent.getStoredMessages())).toMatchObject({
        type: "tool-write",
        state: "output-error"
      });
    } finally {
      ws.close();
    }
  });

  it.each(["close", "error"] as const)(
    "reports an error to chat() callbacks when the stream %ss mid tool input",
    async (ending) => {
      const room = crypto.randomUUID();
      const agent = await getAgentByName(
        env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
        room
      );
      await agent.setCutToolInputResponseForTest(ending);

      const result = await agent.testChat("write it");

      expect(result.done).toBe(false);
      expect(result.error).toBeTruthy();
    }
  );

  it("hands the error to classifyChatError, so a transient class recovers", async () => {
    const agent = await getAgentByName(
      env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
      crypto.randomUUID()
    );

    const result = await agent.testCutToolInputRecoveryForTest();

    expect(result.first.error).toBeUndefined();
    expect(result.first.interruptedCalls).toBe(1);
    expect(result.scheduledContinues).toBe(1);
    expect(result.cutToolState).toBe("output-error");
    expect(result.finalAssistantText.length).toBeGreaterThan(0);
  });
});
