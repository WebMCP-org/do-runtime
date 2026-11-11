import { describe, expect, it, vi } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  WebSocketChatTransport,
  type AgentConnection
} from "../ws-chat-transport";
import { STREAM_RESUME_NONE_REASONS } from "../protocol";
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
  it("settles a resumed connection that closes before its first frame", async () => {
    const agent = new FakeAgent();
    const transport = new WebSocketChatTransport({ agent });
    const resumed = transport.reconnectToStream({
      chatId: "closed-before-replay"
    });
    expect(transport.handleStreamResuming({ id: "pending-replay" })).toBe(true);
    agent.close();
    const stream = await resumed;
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { type: "error", errorText: "WebSocket closed mid-stream" }
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined
    });
  });

  it("keeps waiting for the current probe after an obsolete stream offer", async () => {
    const agent = new FakeAgent();
    const transport = new WebSocketChatTransport({ agent });
    const chatId = "obsolete-resume-offer";
    const previous = transport.reconnectToStream({ chatId });
    const previousProbe = JSON.parse(agent.sent[0]) as { probeId: string };
    transport.cancelPendingResume();
    await expect(previous).resolves.toBeNull();

    const current = transport.reconnectToStream({ chatId });
    const currentProbe = JSON.parse(agent.sent[1]) as { probeId: string };
    try {
      transport.handleStreamResuming({
        id: "obsolete-turn",
        probeId: previousProbe.probeId
      });
      expect(transport.isAwaitingResume()).toBe(true);
      expect(agent.sent).toHaveLength(2);

      transport.handleStreamResuming({
        id: "current-turn",
        probeId: currentProbe.probeId
      });
      expect(JSON.parse(agent.sent[2])).toEqual({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: "current-turn"
      });
      agent.message({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: "current-turn",
        body: "",
        done: true
      });
      const stream = await current;
      await expect(stream?.getReader().read()).resolves.toEqual({
        done: true,
        value: undefined
      });
    } finally {
      transport.cancelPendingResume();
      agent.close();
    }
  });

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
    // so the durable receipt attaches a direct response stream before any
    // STREAM_RESUMING frame exists. Resolution waits for its first frame.
    expect(
      racingTransport.handleStreamPending({
        type: MessageType.CF_AGENT_STREAM_PENDING,
        id: requestId,
        persisted: true
      })
    ).toBe(true);
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
    const resumedStream = await racingReconnect;
    expect(resumedStream).not.toBeNull();
    const reader = resumedStream!.getReader();
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

  it("acknowledges a persisted receipt after the replacement stream starts", async () => {
    const chatId = `late-receipt-${crypto.randomUUID()}`;
    const oldAgent = new FakeAgent();
    const onRequestAcknowledged = vi.fn();
    const oldTransport = new WebSocketChatTransport({
      agent: oldAgent,
      onRequestAcknowledged
    });
    const oldStream = await oldTransport.sendMessages({
      chatId,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message",
      headers: {
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01"
      }
    });
    const originalFrame = requestFrame(oldAgent);
    const requestId = (JSON.parse(originalFrame) as { id: string }).id;
    oldAgent.close();
    await expect(oldStream.getReader().read()).rejects.toThrow(
      "before the chat request was acknowledged"
    );

    const agent = new FakeAgent();
    const transport = new WebSocketChatTransport({ agent });
    const reconnect = transport.reconnectToStream({ chatId });
    expect(requestFrame(agent)).toBe(originalFrame);
    expect(transport.handleStreamResuming({ id: requestId })).toBe(true);

    const receipt = {
      type: MessageType.CF_AGENT_STREAM_PENDING,
      id: requestId,
      persisted: true
    } as const;
    transport.handleStreamPending({ ...receipt, id: "other-request" });
    await Promise.resolve();
    expect(onRequestAcknowledged).not.toHaveBeenCalled();

    transport.handleStreamPending(receipt);
    await Promise.resolve();
    expect(onRequestAcknowledged).toHaveBeenCalledExactlyOnceWith(
      userMessage.id
    );

    transport.handleStreamPending(receipt);
    agent.message({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: "",
      done: true
    });
    const stream = await reconnect;
    expect(stream).not.toBeNull();
    await expect(stream!.getReader().read()).resolves.toEqual({
      done: true,
      value: undefined
    });
    expect(onRequestAcknowledged).toHaveBeenCalledTimes(1);
  });

  it("releases an acknowledged turn when its reconnect probe reports idle", async () => {
    const chatId = `idle-after-close-${crypto.randomUUID()}`;
    const agent = new FakeAgent();
    const transport = new WebSocketChatTransport({ agent });
    const stream = await transport.sendMessages({
      chatId,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });
    const { id: requestId } = JSON.parse(requestFrame(agent)) as {
      id: string;
    };
    agent.message({
      type: MessageType.CF_AGENT_STREAM_PENDING,
      id: requestId,
      persisted: true
    });
    agent.close();
    await expect(stream.getReader().read()).resolves.toEqual({
      done: false,
      value: { type: "error", errorText: "WebSocket closed mid-stream" }
    });
    expect(transport.activeServerTurnId).toBe(requestId);

    const replacement = new FakeAgent();
    transport.setAgent(replacement);
    const resumed = transport.reconnectToStream({ chatId });
    const { probeId } = JSON.parse(replacement.sent[0]) as { probeId: string };
    expect(
      transport.handleStreamResumeNone({
        probeId: "obsolete-probe",
        reason: STREAM_RESUME_NONE_REASONS.IDLE
      })
    ).toBe(false);
    expect(transport.activeServerTurnId).toBe(requestId);
    transport.handleStreamResumeNone({
      probeId,
      reason: STREAM_RESUME_NONE_REASONS.IDLE
    });
    await expect(resumed).resolves.toBeNull();
    expect(transport.activeServerTurnId).toBeNull();
  });

  it("cancels the old handshake without discarding its replay on socket replacement", async () => {
    const chatId = `replace-during-replay-${crypto.randomUUID()}`;
    const original = new FakeAgent();
    const transport = new WebSocketChatTransport({ agent: original });
    const stream = await transport.sendMessages({
      chatId,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });
    const frame = requestFrame(original);
    original.close();
    await expect(stream.getReader().read()).rejects.toThrow(
      "before the chat request was acknowledged"
    );

    const replay = new FakeAgent();
    transport.setAgent(replay);
    const obsoleteHandshake = transport.reconnectToStream({ chatId });
    expect(requestFrame(replay)).toBe(frame);

    const replacement = new FakeAgent();
    try {
      transport.setAgent(replacement);
      expect(transport.isAwaitingResume()).toBe(false);
      await expect(obsoleteHandshake).resolves.toBeNull();
      expect(transport.hasUnacknowledgedRequest(chatId)).toBe(true);

      const currentHandshake = transport.reconnectToStream({ chatId });
      expect(requestFrame(replacement)).toBe(frame);
      transport.cancelPendingResume();
      await expect(currentHandshake).resolves.toBeNull();
    } finally {
      transport.discardPendingRequest(chatId);
    }
  });

  it.each([
    { name: "error", response: { body: "Admission rejected", error: true } },
    { name: "skipped", response: { body: "", outcome: "skipped" } }
  ])(
    "does not acknowledge a pre-admission $name frame",
    async ({ response }) => {
      const chatId = `rejected-${crypto.randomUUID()}`;
      const agent = new FakeAgent();
      const onRequestAcknowledged = vi.fn();
      const transport = new WebSocketChatTransport({
        agent,
        onRequestAcknowledged
      });
      const stream = await transport.sendMessages({
        chatId,
        messages: [userMessage],
        abortSignal: undefined,
        trigger: "submit-message"
      });
      const { id: requestId } = JSON.parse(requestFrame(agent)) as {
        id: string;
      };

      agent.message({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        done: true,
        ...response
      });
      const read = stream.getReader().read();
      if (response.error) {
        await expect(read).rejects.toThrow(response.body);
      } else {
        await expect(read).resolves.toEqual({ done: true, value: undefined });
      }
      expect(onRequestAcknowledged).not.toHaveBeenCalled();
      expect(transport.hasUnacknowledgedRequest(chatId)).toBe(false);
    }
  );
});
