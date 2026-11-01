import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import { describe, expect, it } from "vitest";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

// Stop and cancel own a recovery that was queued before them. The
// interruption budget (#2613) must never count, seal or `onExhausted` such a
// callback, even when the callback is one death short of the budget: the
// fork's Stop epoch and the per-request cancel are checked before the
// engine admits the attempt.

type Incident = {
  incidentId: string;
  status: string;
  reason?: string;
  interruptedAttempts?: number;
  attemptsInFlight?: Array<{ isolate: string; token: string }>;
};

async function freshAgent(name: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    `${name}-${crypto.randomUUID()}`
  );
}

type Agent = Awaited<ReturnType<typeof freshAgent>>;

/** A recovery one death short of the default budget of five. */
async function seedNearBudget(agent: Agent, incidentId: string, root: string) {
  await agent.enableExhaustedCaptureForTest(100);
  await agent.seedIncidentForTest({
    incidentId,
    requestId: root,
    recoveryKind: "continue",
    attempt: 1,
    maxAttempts: 100,
    status: "scheduled",
    firstSeenAt: Date.now(),
    lastAttemptAt: Date.now(),
    interruptedAttempts: 4
  });
  // The previous callback died before it started a turn; only its attempt
  // record is left, so the next admission would count the fifth death.
  await agent.simulateDeadAttemptForTest(incidentId);
}

async function incident(agent: Agent, incidentId: string) {
  const incidents =
    (await agent.getChatRecoveryIncidentsForTest()) as Incident[];
  return incidents.find((entry) => entry.incidentId === incidentId);
}

function runCallback(
  agent: Agent,
  callback: "continue" | "retry",
  data: Record<string, unknown>
) {
  return callback === "continue"
    ? agent.runChatRecoveryContinueForTestWith(data)
    : agent.runChatRecoveryRetryForTestWith(data);
}

describe("recovery after Stop or cancel near the interruption budget", () => {
  it.each(["continue", "retry"] as const)(
    "a Stopped %s callback is never admitted, counted or sealed",
    async (callback) => {
      const agent = await freshAgent(`stop-near-budget-${callback}`);
      const incidentId = `stop-${callback}:`;
      const root = `stop-${callback}`;
      await agent.seedRunningSubmissionForTest(root);
      await seedNearBudget(agent, incidentId, root);
      const before = await incident(agent, incidentId);

      // The callback was queued before Stop, so it carries the old epoch.
      await agent.stopCurrentWork();
      await runCallback(agent, callback, {
        incidentId,
        originalRequestId: root,
        recoveredRequestId: root,
        stopEpoch: 0
      });

      expect(await agent.getExhaustedContextsForTest()).toEqual([]);
      expect(await agent.getTurnBodies()).toHaveLength(0);
      const after = await incident(agent, incidentId);
      expect(after).toMatchObject({ status: "skipped", reason: "cancelled" });
      // No admission ran: the dead attempt is not counted and no new attempt
      // was recorded.
      expect(after?.interruptedAttempts).toBe(4);
      expect(after?.attemptsInFlight).toEqual(before?.attemptsInFlight);
      // Stop owns the submission's terminal state.
      expect(await agent.getSubmissionStatusForTest(root)).toBe("aborted");
    }
  );

  it.each(["continue", "retry"] as const)(
    "a cancelled %s callback still settles its recovered submission as aborted",
    async (callback) => {
      const agent = await freshAgent(`cancel-near-budget-${callback}`);
      const incidentId = `cancel-${callback}:`;
      const root = `cancel-${callback}`;
      await agent.seedRunningSubmissionForTest(root);
      await seedNearBudget(agent, incidentId, root);

      await agent.cancelChat(root);
      await expect
        .poll(async () => (await incident(agent, incidentId))?.status)
        .toBe("skipped");
      await runCallback(agent, callback, {
        incidentId,
        originalRequestId: root,
        recoveredRequestId: root,
        stopEpoch: 0
      });

      expect(await agent.getExhaustedContextsForTest()).toEqual([]);
      expect(await agent.getTurnBodies()).toHaveLength(0);
      const after = await incident(agent, incidentId);
      expect(after).toMatchObject({
        status: "skipped",
        reason: "user_cancelled",
        interruptedAttempts: 4
      });
      expect(await agent.getSubmissionStatusForTest(root)).toBe("aborted");
    }
  );

  it("a callback that is neither Stopped nor cancelled is still sealed at the budget", async () => {
    // Guards the hoist against skipping admission when nothing changed.
    const agent = await freshAgent("live-near-budget");
    const incidentId = "live:";
    await seedNearBudget(agent, incidentId, "live");

    await agent.runChatRecoveryContinueForTestWith({
      incidentId,
      originalRequestId: "live",
      stopEpoch: 0
    });

    const exhausted = (await agent.getExhaustedContextsForTest()) as Array<{
      reason: string;
    }>;
    expect(exhausted.map(({ reason }) => reason)).toEqual([
      "interrupted_attempts_exceeded"
    ]);
    expect(await incident(agent, incidentId)).toMatchObject({
      status: "exhausted",
      interruptedAttempts: 5
    });
  });
});

describe("a sealed incident stays sealed", () => {
  it.each(["continue", "retry"] as const)(
    "a stale %s callback delivered after Stop leaves an exhausted incident alone",
    async (callback) => {
      const agent = await freshAgent(`sealed-then-stop-${callback}`);
      const incidentId = `sealed-${callback}:`;
      const root = `sealed-${callback}`;
      await seedNearBudget(agent, incidentId, root);
      const data = { incidentId, originalRequestId: root, stopEpoch: 0 };
      // One delivery seals the incident while a duplicate stays queued.
      await runCallback(agent, callback, data);
      expect(await incident(agent, incidentId)).toMatchObject({
        status: "exhausted",
        reason: "interrupted_attempts_exceeded"
      });
      expect(await agent.getExhaustedContextsForTest()).toHaveLength(1);

      const events: string[] = [];
      const unsubscribe = subscribe("chat", (event) => {
        const payload = event.payload as { incidentId?: string };
        if (
          event.type.startsWith("chat:recovery:") &&
          payload.incidentId === incidentId
        )
          events.push(event.type);
      });
      try {
        // The duplicate carries the pre-Stop epoch.
        await agent.stopCurrentWork();
        await runCallback(agent, callback, data);
      } finally {
        unsubscribe();
      }

      expect(await incident(agent, incidentId)).toMatchObject({
        status: "exhausted",
        reason: "interrupted_attempts_exceeded",
        interruptedAttempts: 5
      });
      expect(events).toEqual([]);
      expect(await agent.getExhaustedContextsForTest()).toHaveLength(1);
      expect(await agent.getTurnBodies()).toHaveLength(0);
    }
  );

  it("no later transition reopens an exhausted incident", async () => {
    // A callback admitted at the budget can run past a seal that a duplicate
    // delivery wrote while its sync had the input gate open, if Stop lands in
    // the same window. Its Stop check, and any other transition, must leave
    // the seal in place.
    const agent = await freshAgent("sealed-final");
    const incidentId = "sealed-final:";
    const root = "sealed-final";
    await seedNearBudget(agent, incidentId, root);
    await agent.runChatRecoveryContinueForTestWith({
      incidentId,
      originalRequestId: root,
      stopEpoch: 0
    });
    const sealed = await incident(agent, incidentId);
    expect(sealed).toMatchObject({
      status: "exhausted",
      reason: "interrupted_attempts_exceeded"
    });

    const events: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      const payload = event.payload as { incidentId?: string };
      if (
        event.type.startsWith("chat:recovery:") &&
        payload.incidentId === incidentId
      )
        events.push(event.type);
    });
    try {
      await agent.stopCurrentWork();
      // The write `_cancelRecoveryIfStopped` makes, then every other status.
      await agent.updateIncidentForTest(incidentId, "skipped", "cancelled");
      await agent.updateIncidentForTest(incidentId, "failed", "boom");
      await agent.updateIncidentForTest(incidentId, "scheduled");
      await agent.updateIncidentForTest(incidentId, "completed");
    } finally {
      unsubscribe();
    }

    expect(await incident(agent, incidentId)).toEqual(sealed);
    expect(events).toEqual([]);
    expect(await agent.getExhaustedContextsForTest()).toHaveLength(1);
  });
});

describe("listRecoverableChatRequests and sealed incidents", () => {
  it.each(["retry", "continue"] as const)(
    "does not list a queued %s recovery whose incident was sealed as exhausted",
    async (recoveryKind) => {
      const agent = await freshAgent(`list-exhausted-${recoveryKind}`);
      await agent.persistTestMessage({
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "Finish this request." }]
      });
      const targetMessageId = recoveryKind === "retry" ? "user" : "partial";
      if (recoveryKind === "continue")
        await agent.persistTestMessage({
          id: targetMessageId,
          role: "assistant",
          parts: [{ type: "text", text: "The unfinished answer." }]
        });
      // The queued Task stays pending (its run is an hour out).
      await agent.insertQueuedChatRecoveryForTest({
        requestId: "request",
        recoveryRootRequestId: "root",
        recoveryKind,
        targetMessageId
      });
      expect(await agent.listRecoverableChatRequests()).toEqual([
        { requestId: "request", recoveryRootRequestId: "root" }
      ]);
      const [queued] =
        (await agent.getChatRecoveryIncidentsForTest()) as Incident[];

      // Another delivery of the same callback finds the budget spent and
      // seals the incident while this Task is still queued.
      await agent.enableExhaustedCaptureForTest(100);
      await agent.seedIncidentForTest({
        ...(queued as unknown as Parameters<Agent["seedIncidentForTest"]>[0]),
        interruptedAttempts: 4
      });
      await agent.simulateDeadAttemptForTest(queued.incidentId);
      await runCallback(
        agent,
        recoveryKind,
        recoveryKind === "retry"
          ? {
              incidentId: queued.incidentId,
              originalRequestId: "root",
              targetUserId: targetMessageId,
              stopEpoch: 0
            }
          : {
              incidentId: queued.incidentId,
              originalRequestId: "root",
              targetAssistantId: targetMessageId,
              stopEpoch: 0
            }
      );
      expect(await incident(agent, queued.incidentId)).toMatchObject({
        status: "exhausted",
        reason: "interrupted_attempts_exceeded"
      });
      expect(await agent.getExhaustedContextsForTest()).toHaveLength(1);

      // The engine no-ops the queued callback now, so it is not live work.
      expect(await agent.listRecoverableChatRequests()).toEqual([]);
    }
  );
});
