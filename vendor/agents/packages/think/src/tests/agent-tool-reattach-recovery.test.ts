import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

async function freshRecoveryAgent(name: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

/**
 * Re-attach budget regression (deterministic counterpart to the slow
 * `reattach-budget` e2e): when a facet running as an agent-tool child is
 * interrupted mid-run and recovers, its recovery turn mints a NEW request id.
 * If the `cf_agent_tool_child_runs.request_id` binding is not updated, the
 * parent's re-attach tail can no longer attribute the recovered turn's frames,
 * so a healthy, still-advancing child is abandoned as `interrupted` once the
 * no-progress budget elapses. The fix re-binds the row (and the in-memory
 * attribution map) on both recovery paths.
 */
describe("agent-tool child re-attach: request_id rebinding across recovery", () => {
  it("does not start a tool whose decision hook was still running when Stop arrived", async () => {
    const agent = await freshRecoveryAgent(
      `stop-tool-admission-${crypto.randomUUID()}`
    );
    const result = await agent.stopWithHeldToolForTest("decision");
    expect(result.toolCalls).toBe(0);
  });

  it.each(["scalar", "streaming", "action"] as const)(
    "does not acknowledge Stop before the active %s tool finishes cleanup",
    async (kind) => {
      const agent = await freshRecoveryAgent(
        `stop-tool-cleanup-${crypto.randomUUID()}`
      );
      const result = await agent.stopWithHeldToolForTest("cleanup", kind);
      expect(result.toolCalls).toBe(1);
      expect(result.finishedWhenStopAcknowledged).toBe(true);
    }
  );

  it("does not start a native request that was still being admitted when Stop arrived", async () => {
    const agent = await freshRecoveryAgent(
      `stop-admission-${crypto.randomUUID()}`
    );
    const frames = await agent.stopDuringChatAdmissionForTest();
    expect(await agent.getTurnCallCount()).toBe(0);
    expect(frames.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({
        type: "cf_agent_use_chat_response",
        id: "stop-during-admission",
        done: true
      })
    );
  });

  it("stops current work, preserves partial history, and allows a later user turn", async () => {
    const agent = await freshRecoveryAgent(
      `stop-current-${crypto.randomUUID()}`
    );
    await agent.holdRecoveryModelForTest();
    const turn = agent.testChat("original user input").then((result) => result);
    try {
      await expect
        .poll(async () => (await agent.getHeldRecoveryModelForTest()).calls)
        .toBe(1);
      const submissionId = await agent.submitMessagesForTest([
        {
          id: "queued",
          role: "user",
          parts: [{ type: "text", text: "keep this queued input" }]
        }
      ]);
      await agent.stopCurrentWork();
      expect((await agent.getHeldRecoveryModelForTest()).aborted).toBe(true);
      await turn;
      expect(await agent.getStoredTextForTest()).toContain("Partial answer");
      expect(await agent.getSubmissionStatusForTest(submissionId)).toBe(
        "skipped"
      );
      expect(await agent.getSubmissionMessagesForTest(submissionId)).toContain(
        "keep this queued input"
      );
    } finally {
      await agent.releaseRecoveryModelForTest();
      await turn;
    }
    await agent.testChat("new user input");
    expect(await agent.getTurnCallCount()).toBe(2);
  });

  it("keeps Stop durable when an old non-submission fiber is recovered after later input", async () => {
    const name = `stop-durable-${crypto.randomUUID()}`;
    let agent = await freshRecoveryAgent(name);
    await agent.persistTestMessage({
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "old input" }]
    });
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:old-request", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "old-request",
        continuation: false,
        latestMessageId: "user",
        latestMessageRole: "user",
        latestUserMessageId: "user",
        startedAt: Date.now()
      },
      user: null
    });
    await agent.stopCurrentWork();
    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await freshRecoveryAgent(name);
    await agent.triggerFiberRecovery();
    await agent.runScheduledRecoveryRetryForTest();
    expect(await agent.getTurnCallCount()).toBe(0);
    await agent.testChat("new input");
    await agent.runScheduledRecoveryRetryForTest();
    expect(await agent.getTurnCallCount()).toBe(1);
  });

  it("remembers cancellation delivered before child start", async () => {
    const name = `cancel-before-start-${crypto.randomUUID()}`;
    let agent = await freshRecoveryAgent(name);
    await agent.cancelAgentToolRun("cancelled", "Stopped by user");
    await evictDurableObject(agent as unknown as DurableObjectStub);
    agent = await freshRecoveryAgent(name);
    const status = await agent.startAgentToolRunStatusForTest(
      "must not execute",
      "cancelled"
    );
    expect(status).toBe("aborted");
    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it.each(["retry", "continue"] as const)(
    "does not admit a cancelled child through %s recovery",
    async (kind) => {
      const agent = await freshRecoveryAgent(
        `cancel-recovery-${kind}-${crypto.randomUUID()}`
      );
      await agent.seedAgentToolChildRunForTest("cancelled", "old-request");
      await agent.persistTestMessage({
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "do work" }]
      });
      if (kind === "continue") {
        await agent.persistTestMessage({
          id: "assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Partial" }]
        });
      }
      await agent.cancelAgentToolRun("cancelled", "Stopped by user");
      if (kind === "retry") await agent.runRecoveryRetryForTest();
      else await agent.testContinueLastTurn();
      expect(await agent.getTurnCallCount()).toBe(0);
      expect(
        await agent.getAgentToolChildRunRequestIdForTest("cancelled")
      ).toBe("old-request");
      expect(await agent.getChildRunStatusForTest("cancelled")).toBe("aborted");
    }
  );

  it("cancels the real model signal of a recovered child without a submission controller", async () => {
    const agent = await freshRecoveryAgent(
      `cancel-live-recovery-${crypto.randomUUID()}`
    );
    await agent.seedAgentToolChildRunForTest("cancelled", "old-request");
    await agent.persistTestMessage({
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "do work" }]
    });
    await agent.holdRecoveryModelForTest();
    const recovery = agent.runRecoveryRetryForTest().then(() => undefined);
    try {
      await expect
        .poll(async () => (await agent.getHeldRecoveryModelForTest()).calls)
        .toBe(1);
      await agent.cancelAgentToolRun("cancelled", "Stopped by user");
      expect((await agent.getHeldRecoveryModelForTest()).aborted).toBe(true);
      expect(await agent.getChildRunStatusForTest("cancelled")).toBe("aborted");
    } finally {
      await agent.releaseRecoveryModelForTest();
      await recovery;
    }
  });

  it("re-binds the child-run request_id on a CONTINUE recovery so frames stay attributable", async () => {
    const agent = await freshRecoveryAgent(
      `reattach-continue-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest(
      "run-continue",
      "old-req-continue"
    );

    await agent.persistTestMessage({
      id: "u-reattach-continue",
      role: "user",
      parts: [{ type: "text", text: "do the long job" }]
    });
    await agent.persistTestMessage({
      id: "a-reattach-continue",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream(
      "stream-reattach-continue",
      "req-reattach-continue",
      [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "a-reattach-continue"
          }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
          index: 2
        }
      ]
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-continue",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-reattach-continue",
          continuation: false,
          latestMessageId: "a-reattach-continue",
          latestMessageRole: "assistant",
          latestUserMessageId: "u-reattach-continue",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);
    await agent.runScheduledRecoveryContinueForTest();

    // The row's request_id moved off the pre-eviction turn to the recovery
    // turn's fresh id, and that id now attributes back to the run.
    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-continue");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-continue");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-continue");
  });

  it("re-binds the child-run request_id on a RETRY recovery so frames stay attributable", async () => {
    const agent = await freshRecoveryAgent(
      `reattach-retry-${crypto.randomUUID()}`
    );

    await agent.seedAgentToolChildRunForTest("run-retry", "old-req-retry");

    await agent.persistTestMessage({
      id: "u-reattach-retry",
      role: "user",
      parts: [{ type: "text", text: "do the long job" }]
    });

    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-reattach-retry",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-reattach-retry",
          continuation: false,
          latestMessageId: "u-reattach-retry",
          latestMessageRole: "user",
          latestUserMessageId: "u-reattach-retry",
          startedAt: Date.now()
        },
        user: null
      }
    );

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    const reboundReqId =
      await agent.getAgentToolChildRunRequestIdForTest("run-retry");
    expect(reboundReqId).toBeTruthy();
    expect(reboundReqId).not.toBe("old-req-retry");
    expect(
      await agent.resolveAgentToolRunForRequestForTest(reboundReqId as string)
    ).toBe("run-retry");
  });
});
