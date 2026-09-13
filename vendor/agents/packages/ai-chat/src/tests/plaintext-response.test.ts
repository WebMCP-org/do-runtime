import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import { MessageType } from "../types";
import {
  readUIMessageStream,
  type UIMessage as ChatMessage,
  type UIMessageChunk
} from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";
import { restoreContinuationMessage } from "../../../agents/src/chat/message-builder";

describe("Plain text response handling", () => {
  it("produces a single text part for plain text responses", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      messages.push(data);

      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    // Send a chat request - the test worker returns plain text "Hello from chat agent!"
    const userMessage: ChatMessage = {
      id: "msg-plain-1",
      role: "user",
      parts: [{ type: "text", text: "Test" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-plain-1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Verify the persisted message has a single text part (not multiple)
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // The last assistant message should have exactly 1 text part
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const textParts = lastAssistant.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    // The text should be the full response content
    const textPart = textParts[0] as { text: string };
    expect(textPart.text).toBe("Hello from chat agent!");

    // Verify the stream protocol events: text-start, text-delta(s), text-end
    const streamResponses = messages.filter(isUseChatResponseMessage);
    const nonEmptyResponses = streamResponses.filter(
      (m) =>
        "body" in m && typeof m.body === "string" && m.body.trim().length > 0
    );

    // Should have text-start, text-delta(s), text-end events
    const bodies = nonEmptyResponses.map((m) => JSON.parse(m.body as string));
    const types = bodies.map((b) => b.type);

    expect(types[0]).toBe("text-start");
    expect(types[types.length - 1]).toBe("text-end");
    expect(
      types.filter((t: string) => t === "text-delta").length
    ).toBeGreaterThanOrEqual(1);

    ws.close(1000);
  });
  it("replays a plaintext continuation of an interrupted text part through the AI SDK", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const stub = await getAgentByName(env.TestChatAgent, room);
    const prefix: ChatMessage = {
      id: "assistant-continued",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          toolCallId: "search-1",
          state: "input-available",
          input: {}
        },
        { type: "text", text: "Partial ", state: "streaming" }
      ]
    };
    await stub.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "Search" }] },
      prefix
    ]);
    const frames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(event.data as string) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING) {
        ws.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: frame.id
          })
        );
      }
    });
    try {
      ws.send(
        JSON.stringify({
          type: "cf_agent_tool_result",
          toolCallId: "search-1",
          toolName: "search",
          output: "found",
          autoContinue: true
        })
      );
      await vi.waitFor(() =>
        expect(
          frames.some(
            (frame) =>
              frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
              typeof frame.body === "string" &&
              frame.body.includes("text-end")
          )
        ).toBe(true)
      );
      const chunks = frames
        .filter(
          (frame) =>
            frame.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && frame.body
        )
        .map((frame) => JSON.parse(frame.body as string) as UIMessageChunk);
      expect(chunks[0]).toMatchObject({
        type: "start",
        continuationStart: {
          messageId: prefix.id,
          parts: [null, 8]
        }
      });
      const persisted = (await stub.getPersistedMessages()) as ChatMessage[];
      const hydrated = persisted.at(-1)!;
      const start = chunks[0] as UIMessageChunk & {
        continuationStart?: unknown;
      };
      let replayed: ChatMessage | undefined;
      for await (const message of readUIMessageStream({
        message: restoreContinuationMessage(hydrated, start.continuationStart),
        terminateOnError: true,
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          }
        })
      }))
        replayed = message;
      expect(
        replayed?.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toBe("Partial Hello from chat agent!");
      expect(
        persisted.at(-1)?.parts.filter((part) => part.type === "text")
      ).toEqual([
        { type: "text", text: "Partial Hello from chat agent!", state: "done" }
      ]);
    } finally {
      ws.close(1000);
    }
  });
});
