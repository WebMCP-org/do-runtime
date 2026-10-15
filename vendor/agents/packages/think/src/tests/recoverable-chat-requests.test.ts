import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { createChatFiberSnapshot, wrapChatFiberSnapshot } from "agents/chat";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshAgent() {
  const agent = await getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    `recoverable-inspection-${crypto.randomUUID()}`
  );
  await agent.persistTestMessage({
    id: "user",
    role: "user",
    parts: [{ type: "text", text: "Finish this request." }]
  });
  return agent;
}

function snapshot(requestId: string, recoveryRootRequestId = requestId) {
  return wrapChatFiberSnapshot(
    "__cfThinkChatFiberSnapshot",
    createChatFiberSnapshot({
      kind: "think-chat-turn",
      requestId,
      recoveryRootRequestId,
      stopEpoch: 0,
      continuation: false,
      messages: [{ id: "user", role: "user" }]
    }),
    null
  );
}

describe("recoverable chat request inspection", () => {
  it("tracks a real native model turn until its response hook settles", async () => {
    const agent = await freshAgent();
    await agent.holdRecoveryModelForTest();
    const chat = agent.testChat("Keep this native request live.");
    void chat.catch(() => {});
    try {
      await expect
        .poll(() => agent.getHeldRecoveryModelForTest())
        .toMatchObject({ calls: 1 });
      const pending = await agent.listRecoverableChatRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestId).toBeTruthy();
      expect(pending[0]?.recoveryRootRequestId).toBe(pending[0]?.requestId);

      await agent.releaseRecoveryModelForTest();
      const result = await chat;

      expect(result.requestId).toBe(pending[0]?.requestId);
      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    } finally {
      await agent.releaseRecoveryModelForTest();
      await chat.catch(() => {});
    }
  });

  it.each(["absent", "running"] as const)(
    "includes an interrupted native Task whose model journal is %s",
    async (journal) => {
      const agent = await freshAgent();
      const runId = await agent.insertInterruptedChatTurnTaskForTest(
        "request",
        snapshot("request")
      );
      if (journal === "running")
        await agent.insertChatTaskJournalForTest(runId, journal);

      expect(await agent.listRecoverableChatRequests()).toEqual([
        { requestId: "request", recoveryRootRequestId: "request" }
      ]);
    }
  );

  it.each(["completed", "failed"] as const)(
    "excludes a %s model step even before its native Task cleanup",
    async (journal) => {
      const agent = await freshAgent();
      const runId = await agent.insertInterruptedChatTurnTaskForTest(
        "request",
        snapshot("request")
      );
      await agent.insertChatTaskJournalForTest(runId, journal);

      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    }
  );

  it.each(["completed", "error"] as const)(
    "excludes a native Task whose stream already recorded %s",
    async (status) => {
      const agent = await freshAgent();
      await agent.insertInterruptedChatTurnTaskForTest(
        "request",
        snapshot("request")
      );
      await agent.insertAgedStreamForTest(
        "terminal-stream",
        "request",
        status,
        0
      );

      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    }
  );

  it("keeps a persisted terminal hook owed after Task and stream cutover", async () => {
    const agent = await freshAgent();
    const runId = await agent.insertInterruptedChatTurnTaskForTest(
      "successor",
      snapshot("successor", "root")
    );
    await agent.insertChatTaskJournalForTest(runId, "completed");
    await agent.insertAgedStreamForTest(
      "terminal-stream",
      "successor",
      "completed",
      0
    );
    await agent.persistTestMessage({
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "The persisted answer." }]
    });
    await agent.insertPendingResponseHookForTest({
      requestId: "successor",
      recoveryRootRequestId: "root",
      messageId: "answer",
      status: "completed"
    });
    expect(await agent.listRecoverableChatRequests()).toEqual([
      { requestId: "successor", recoveryRootRequestId: "root" }
    ]);

    await agent.replayPendingResponseHooksForTest();

    expect(await agent.getChatResponsesForTest()).toMatchObject([
      { requestId: "successor", messageId: "answer", recovered: true }
    ]);
    expect(await agent.listRecoverableChatRequests()).toEqual([]);
  });

  it("requires the terminal hook's message to have persisted", async () => {
    const agent = await freshAgent();
    await agent.insertPendingResponseHookForTest({
      requestId: "request",
      messageId: "uncommitted-answer",
      status: "completed"
    });

    expect(await agent.listRecoverableChatRequests()).toEqual([]);
  });

  it("defaults a released terminal hook without a root to its own request", async () => {
    const agent = await freshAgent();
    await agent.persistTestMessage({
      id: "answer",
      role: "assistant",
      parts: [{ type: "text", text: "The persisted answer." }]
    });
    await agent.insertPendingResponseHookForTest({
      requestId: "request",
      messageId: "answer",
      status: "error"
    });

    expect(await agent.listRecoverableChatRequests()).toEqual([
      { requestId: "request", recoveryRootRequestId: "request" }
    ]);
  });

  it("excludes a native Task invalidated by Stop", async () => {
    const agent = await freshAgent();
    await agent.insertInterruptedChatTurnTaskForTest(
      "request",
      snapshot("request")
    );
    expect(await agent.listRecoverableChatRequests()).toHaveLength(1);

    await agent.stopCurrentWork();

    expect(await agent.listRecoverableChatRequests()).toEqual([]);
  });

  it("excludes a native Task cancelled through its owning capability", async () => {
    const agent = await freshAgent();
    const runId = await agent.insertInterruptedChatTurnTaskForTest(
      "request",
      snapshot("request")
    );
    expect(await agent.listRecoverableChatRequests()).toHaveLength(1);

    expect(await agent.cancelChatTaskForTest(runId)).toBe(true);

    expect(await agent.listRecoverableChatRequests()).toEqual([]);
  });

  it("includes a released interrupted fiber through the same request contract", async () => {
    const agent = await freshAgent();
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:successor",
      snapshot("successor", "root")
    );

    expect(await agent.listRecoverableChatRequests()).toEqual([
      { requestId: "successor", recoveryRootRequestId: "root" }
    ]);
  });

  it.each([
    ["retry", "cancel"],
    ["continue", "cancel"],
    ["retry", "Stop"],
    ["continue", "Stop"]
  ] as const)(
    "reports pending %s recovery until %s",
    async (recoveryKind, settlement) => {
      const agent = await freshAgent();
      const targetMessageId = recoveryKind === "retry" ? "user" : "partial";
      if (recoveryKind === "continue")
        await agent.persistTestMessage({
          id: targetMessageId,
          role: "assistant",
          parts: [{ type: "text", text: "The unfinished answer." }]
        });
      await agent.insertQueuedChatRecoveryForTest({
        requestId: "request",
        recoveryRootRequestId: "root",
        recoveryKind,
        targetMessageId
      });
      expect(await agent.listRecoverableChatRequests()).toEqual([
        { requestId: "request", recoveryRootRequestId: "root" }
      ]);

      if (settlement === "Stop") await agent.stopCurrentWork();
      else await agent.cancelChat("root");

      await expect.poll(() => agent.listRecoverableChatRequests()).toEqual([]);
    }
  );

  it.each(["completed", "failed"] as const)(
    "excludes a %s recovery continuation even before Task cleanup",
    async (state) => {
      const agent = await freshAgent();
      const runId = await agent.insertQueuedChatRecoveryForTest({
        requestId: "request",
        recoveryRootRequestId: "root",
        recoveryKind: "retry",
        targetMessageId: "user"
      });
      await agent.insertChatTaskJournalForTest(runId, state, "continuation");

      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    }
  );

  it("excludes a queued recovery whose durable submission no longer runs", async () => {
    const agent = await freshAgent();
    await agent.insertQueuedChatRecoveryForTest({
      requestId: "request",
      recoveryRootRequestId: "root",
      recoveryKind: "retry",
      targetMessageId: "user",
      recoveredRequestId: "absent-submission"
    });

    expect(await agent.listRecoverableChatRequests()).toEqual([]);
  });

  it.each(["retry", "continue"] as const)(
    "excludes %s recovery superseded by a newer user message",
    async (recoveryKind) => {
      const agent = await freshAgent();
      const targetMessageId = recoveryKind === "retry" ? "user" : "partial";
      if (recoveryKind === "continue")
        await agent.persistTestMessage({
          id: targetMessageId,
          role: "assistant",
          parts: [{ type: "text", text: "The unfinished answer." }]
        });
      await agent.insertQueuedChatRecoveryForTest({
        requestId: "request",
        recoveryRootRequestId: "root",
        recoveryKind,
        targetMessageId
      });
      await agent.persistTestMessage({
        id: "newer-user",
        role: "user",
        parts: [{ type: "text", text: "A newer request." }]
      });

      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    }
  );

  it("gives an admitted successor precedence over its root's pending retry", async () => {
    const agent = await freshAgent();
    await agent.insertQueuedChatRecoveryForTest({
      requestId: "root",
      recoveryRootRequestId: "root",
      recoveryKind: "retry",
      targetMessageId: "user"
    });
    await agent.insertInterruptedChatTurnTaskForTest(
      "successor",
      snapshot("successor", "root")
    );

    expect(await agent.listRecoverableChatRequests()).toEqual([
      { requestId: "successor", recoveryRootRequestId: "root" }
    ]);
  });
});
