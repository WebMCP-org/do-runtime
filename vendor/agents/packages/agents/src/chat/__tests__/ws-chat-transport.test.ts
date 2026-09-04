import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  WebSocketChatTransport,
  type AgentConnection
} from "../ws-chat-transport";
import { MessageType } from "../wire-types";

class FakeAgent implements AgentConnection {
  readonly sent: string[] = [];
  private readonly target = new EventTarget();

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ): void {
    this.target.addEventListener(type, listener as EventListener, options);
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void
  ): void {
    this.target.removeEventListener(type, listener as EventListener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  message(frame: Record<string, unknown>): void {
    this.target.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) })
    );
  }

  close(): void {
    this.target.dispatchEvent(new Event("close"));
  }
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "hello" }]
};

function requestFrame(agent: FakeAgent): string {
  const frame = agent.sent.find(
    (value) =>
      (JSON.parse(value) as { type?: string }).type ===
      MessageType.CF_AGENT_USE_CHAT_REQUEST
  );
  if (!frame) throw new Error("chat request was not sent");
  return frame;
}

describe("WebSocketChatTransport unacknowledged request replay", () => {
  it("survives transport replacement, replays byte-identically, and waits for durable ACK", async () => {
    const chatId = `cross-instance-${crypto.randomUUID()}`;
    const oldAgent = new FakeAgent();
    const oldTransport = new WebSocketChatTransport({ agent: oldAgent });
    const oldStream = await oldTransport.sendMessages({
      chatId,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });
    const originalFrame = requestFrame(oldAgent);
    const requestId = (JSON.parse(originalFrame) as { id: string }).id;
    const oldReader = oldStream.getReader();

    // An ordinary pre-stream frame is advisory. It must neither acknowledge
    // nor remove the request from the cross-instance outbox.
    oldAgent.message({
      type: MessageType.CF_AGENT_STREAM_PENDING,
      id: requestId
    });
    oldAgent.close();
    await expect(oldReader.read()).rejects.toThrow(
      "before the chat request was acknowledged"
    );

    // Model a route-away/remount: this is a new transport and a new socket.
    const racingAgent = new FakeAgent();
    const racingTransport = new WebSocketChatTransport({ agent: racingAgent });
    const racingReconnect = racingTransport.reconnectToStream({ chatId });

    expect(requestFrame(racingAgent)).toBe(originalFrame);

    // A resume probe may race ahead of the request handler. NONE must neither
    // resolve this operation nor mark the replay locally active (which would
    // make the fallback skip its raw chunks).
    const racingProbe = racingAgent.sent
      .map((value) => JSON.parse(value) as { type: string; probeId?: string })
      .find(
        (frame) => frame.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      );
    racingTransport.handleStreamResumeNone({
      probeId: racingProbe?.probeId
    });
    let settled = false;
    void racingReconnect.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // This is the true never-reached-server path: the replay is newly accepted,
    // so the durable receipt resolves a direct response stream before any
    // STREAM_RESUMING frame exists.
    expect(
      racingTransport.handleStreamPending({
        type: MessageType.CF_AGENT_STREAM_PENDING,
        id: requestId,
        persisted: true
      })
    ).toBe(true);
    const resumedStream = await racingReconnect;
    expect(resumedStream).not.toBeNull();
    const reader = resumedStream!.getReader();
    racingAgent.message({
      type: MessageType.CF_AGENT_STREAM_RESUMING,
      id: requestId
    });
    racingAgent.message({
      type: MessageType.CF_AGENT_STREAM_RESUMING,
      id: requestId
    });
    expect(
      racingAgent.sent.filter(
        (value) =>
          (JSON.parse(value) as { type: string }).type ===
          MessageType.CF_AGENT_STREAM_RESUME_ACK
      )
    ).toHaveLength(1);
    const chunk = { type: "text-delta", id: "text-1", delta: "hello" };
    racingAgent.message({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(chunk),
      done: false
    });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: chunk as UIMessageChunk
    });
    racingAgent.message({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: "",
      done: true
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined
    });

    // The correlated persisted receipt consumed the outbox entry. A later
    // remount sends only the ordinary resume probe, not the chat request again.
    const finalAgent = new FakeAgent();
    const finalTransport = new WebSocketChatTransport({ agent: finalAgent });
    const finalReconnect = finalTransport.reconnectToStream({ chatId });
    expect(
      finalAgent.sent.some(
        (value) =>
          (JSON.parse(value) as { type?: string }).type ===
          MessageType.CF_AGENT_USE_CHAT_REQUEST
      )
    ).toBe(false);
    const probe = JSON.parse(finalAgent.sent[0]) as { probeId: string };
    finalTransport.handleStreamResumeNone({ probeId: probe.probeId });
    await expect(finalReconnect).resolves.toBeNull();
  });

  it("discards the chat outbox on explicit history clear", async () => {
    const chatId = `cleared-${crypto.randomUUID()}`;
    const oldAgent = new FakeAgent();
    const oldTransport = new WebSocketChatTransport({ agent: oldAgent });
    const stream = await oldTransport.sendMessages({
      chatId,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });
    const reader = stream.getReader();

    const replacementAgent = new FakeAgent();
    const replacement = new WebSocketChatTransport({
      agent: replacementAgent
    });
    const reconnect = replacement.reconnectToStream({ chatId });
    const replayedRequest = requestFrame(replacementAgent);

    // Clear while this replacement transport still owns a live handshake. It
    // must settle that handshake and prevent later socket-open retries.
    expect(replacement.discardPendingRequest(chatId)).toBe(true);
    expect(replacement.retryPendingResume()).toBe(false);
    expect(
      replacementAgent.sent.filter(
        (value) =>
          (JSON.parse(value) as { type: string }).type ===
          MessageType.CF_AGENT_USE_CHAT_REQUEST
      )
    ).toEqual([replayedRequest]);

    const requestId = (JSON.parse(replayedRequest) as { id: string }).id;
    expect(
      replacement.handleStreamPending({
        type: MessageType.CF_AGENT_STREAM_PENDING,
        id: requestId,
        persisted: true
      })
    ).toBe(false);
    expect(replacement.handleStreamResuming({ id: requestId })).toBe(false);
    await expect(reconnect).resolves.toBeNull();

    oldAgent.close();
    await expect(reader.read()).rejects.toThrow(
      "before the chat request was acknowledged"
    );

    // A subsequent remount also sees no request to replay: the stale persisted
    // receipt above did not resurrect the deleted outbox entry.
    const finalAgent = new FakeAgent();
    const finalTransport = new WebSocketChatTransport({ agent: finalAgent });
    const finalReconnect = finalTransport.reconnectToStream({ chatId });
    expect(
      finalAgent.sent.some(
        (value) =>
          (JSON.parse(value) as { type: string }).type ===
          MessageType.CF_AGENT_USE_CHAT_REQUEST
      )
    ).toBe(false);
    const finalProbe = JSON.parse(finalAgent.sent[0]) as { probeId: string };
    finalTransport.handleStreamResumeNone({ probeId: finalProbe.probeId });
    await expect(finalReconnect).resolves.toBeNull();
  });
});
