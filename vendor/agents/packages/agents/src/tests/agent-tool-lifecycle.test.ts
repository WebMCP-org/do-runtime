import { env } from "cloudflare:workers";
import { getAgentByName } from "../index";
import { describe, expect, it } from "vitest";

async function parentForTest(name = `lifecycle-${crypto.randomUUID()}`) {
  return getAgentByName(env.TestAgentToolLifecycleParent, name);
}

describe("awaited agent-tool cancellation at the child boundary", () => {
  it("cancels a reattached child through the new waiter's signal", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original");
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    await parent.startForTest("run", "reattached");
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 2 });
    try {
      await parent.abortForTest("reattached");
      await expect
        .poll(() => parent.resultForTest("reattached"))
        .toMatchObject({ status: "aborted" });
      expect(await parent.childForTest("run")).toMatchObject({
        status: "aborted",
        starts: 1
      });
    } finally {
      await parent.finishChildForTest("run");
    }
  });

  it("does not admit a child when the dispatch signal is already aborted", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "stopped", {}, true);
    await expect
      .poll(() => parent.resultForTest("stopped"))
      .toMatchObject({ status: "aborted" });
    expect(await parent.childForTest("run")).toBeNull();
    expect(await parent.inspectAgentTool("run")).toMatchObject({
      status: "aborted",
      childStillRunning: false
    });
    await parent.startForTest("run", "retry");
    await expect
      .poll(() => parent.resultForTest("retry"))
      .toMatchObject({ status: "aborted" });
    expect(await parent.childForTest("run")).toBeNull();
  });

  it("does not start a child after cancellation during the startup hook", async () => {
    const parent = await parentForTest();
    await parent.holdAdmissionForTest("run");
    await parent.startForTest("run", "original");
    await expect.poll(() => parent.admissionHeldForTest()).toBe(true);
    await parent.cancelAgentTool("run", "stop while starting");
    await parent.releaseAdmissionForTest();
    await expect
      .poll(() => parent.resultForTest("original"))
      .toMatchObject({ status: "aborted" });
    expect(await parent.childForTest("run")).toBeNull();
  });

  it("surfaces cancellation delivery failure and retries the same aborted run", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original", {
      cancellationError: "child cancellation transport failed"
    });
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    try {
      await expect(
        Promise.resolve(parent.cancelAgentTool("run", "stop"))
      ).rejects.toThrow("child cancellation transport failed");
      expect(await parent.observationsForTest("run")).toMatchObject({
        status: "aborted"
      });
      expect(await parent.childForTest("run")).toMatchObject({
        status: "running",
        cancels: 1
      });
      await parent.cancelAgentTool("run", "stop again");
      expect(await parent.childForTest("run")).toMatchObject({
        status: "aborted",
        cancels: 2
      });
      await expect
        .poll(() => parent.resultForTest("original"))
        .toMatchObject({ status: "aborted" });
    } finally {
      await parent.finishChildForTest("run");
    }
  });

  it("counts a still-running interrupted child but lets its original ID reattach", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original");
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    try {
      await parent.startForTest("run", "observation");
      await expect
        .poll(() => parent.resultForTest("observation"))
        .toMatchObject({ status: "interrupted", childStillRunning: true });
      await parent.startForTest("replacement", "replacement", {
        complete: true
      });
      await expect
        .poll(() => parent.resultForTest("replacement"))
        .toMatchObject({
          status: "error",
          error: "maxConcurrentAgentTools (1) exceeded"
        });
      await parent.startForTest("run", "reattached");
      await expect
        .poll(() => parent.childForTest("run"))
        .toMatchObject({ tails: 3 });
      await parent.finishChildForTest("run");
      await expect
        .poll(() => parent.resultForTest("reattached"))
        .toMatchObject({ status: "completed" });
      await parent.startForTest("next", "next", { complete: true });
      await expect
        .poll(() => parent.resultForTest("next"))
        .toMatchObject({ status: "completed" });
    } finally {
      await parent.finishChildForTest("run");
    }
  });

  it("publishes the accepted aborted outcome when a stale completion arrives later", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original", { holdInspection: true });
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    await parent.finishChildForTest("run");
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ inspectionHeld: true });
    await parent.cancelAgentTool("run", "stop before completion is accepted");
    await parent.releaseInspectionForTest("run");
    await expect
      .poll(() => parent.resultForTest("original"))
      .toMatchObject({ status: "aborted" });
    const observations = await parent.observationsForTest("run");
    expect(observations.status).toBe("aborted");
    expect(observations.finishes).toEqual([
      { runId: "run", status: "aborted" }
    ]);
    expect(observations.events.at(-1)?.event).toMatchObject({
      kind: "aborted",
      runId: "run"
    });
  });

  it("preserves a completed outcome when cancellation comes afterward", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original", { complete: true });
    await expect
      .poll(() => parent.resultForTest("original"))
      .toMatchObject({ status: "completed" });
    await parent.cancelAgentTool("run", "too late");
    const observations = await parent.observationsForTest("run");
    expect(observations.status).toBe("completed");
    expect(observations.finishes).toEqual([
      { runId: "run", status: "completed" }
    ]);
    expect(await parent.childForTest("run")).toMatchObject({
      status: "completed",
      cancels: 0
    });
  });

  it("reads retained records without admitting a child for an unknown ID", async () => {
    const parent = await parentForTest();
    expect(await parent.inspectAgentTool("unknown")).toBeNull();
    expect(await parent.listAgentToolRuns()).toEqual([]);
    expect(await parent.childForTest("unknown")).toBeNull();
    await parent.startForTest("complete", "complete", { complete: true });
    await expect
      .poll(() => parent.resultForTest("complete"))
      .toMatchObject({ status: "completed" });
    expect(await parent.listAgentToolRuns()).toEqual([
      await parent.inspectAgentTool("complete")
    ]);
  });

  it.each(["child cancellation transport failed", ""])(
    "reports cancellation failures independently of diagnostic text %j",
    async (error) => {
      const parent = await parentForTest();
      await parent.setLimitForTest(3);
      await parent.startForTest("fails", "fails", { cancellationError: error });
      await parent.startForTest("healthy", "healthy");
      await parent.holdAdmissionForTest("starting");
      await parent.startForTest("starting", "starting");
      await expect.poll(() => parent.admissionHeldForTest()).toBe(true);
      await expect
        .poll(() => parent.childForTest("fails"))
        .toMatchObject({ tails: 1 });
      await expect
        .poll(() => parent.childForTest("healthy"))
        .toMatchObject({ tails: 1 });
      try {
        const results = await parent.cancelAgentTools("stop current work");
        expect(results).toEqual(
          expect.arrayContaining([
            { runId: "fails", status: "rejected", error },
            { runId: "healthy", status: "fulfilled" },
            { runId: "starting", status: "fulfilled" }
          ])
        );
        expect(await parent.childForTest("healthy")).toMatchObject({
          status: "aborted",
          cancels: 1
        });
        expect(await parent.childForTest("starting")).toBeNull();
        expect(await parent.inspectAgentTool("fails")).toMatchObject({
          status: "aborted",
          childStillRunning: true
        });
        await parent.releaseAdmissionForTest();
        await expect
          .poll(() => parent.resultForTest("starting"))
          .toMatchObject({ status: "aborted", childStillRunning: false });
        expect(await parent.childForTest("starting")).toBeNull();
        expect(await parent.cancelAgentTools("retry shutdown")).toEqual([
          { runId: "fails", status: "fulfilled" }
        ]);
        expect(await parent.childForTest("fails")).toMatchObject({
          status: "aborted",
          cancels: 2
        });
      } finally {
        await parent.releaseAdmissionForTest();
        await parent.finishChildForTest("fails");
        await parent.finishChildForTest("healthy");
      }
    }
  );

  it("does not treat a legacy void cancellation acknowledgment as proof of shutdown", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original", {
      unconfirmedCancellation: true
    });
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    await expect(
      Promise.resolve(parent.cancelAgentTool("run", "stop"))
    ).rejects.toThrow("cancellation was not confirmed");
    const retained = await parent.observationsForTest("run");
    expect(retained).toMatchObject({ status: "aborted" });
    expect(retained?.childStillRunning).toBeUndefined();
    await parent.startForTest("blocked", "blocked", { complete: true });
    await expect
      .poll(() => parent.resultForTest("blocked"))
      .toMatchObject({ status: "error" });
    await parent.cancelAgentTool("run", "confirm shutdown");
    expect(await parent.inspectAgentTool("run")).toMatchObject({
      status: "aborted",
      childStillRunning: false
    });
    await parent.startForTest("next", "next", { complete: true });
    await expect
      .poll(() => parent.resultForTest("next"))
      .toMatchObject({ status: "completed" });
  });

  it("bounds stop acknowledgment and later publishes confirmed shutdown to the owner hook", async () => {
    const parent = await parentForTest();
    await parent.startForTest("run", "original", { holdCancellation: true });
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    try {
      await expect(
        Promise.resolve(parent.cancelAgentTool("run", "stop"))
      ).rejects.toThrow();
      expect(await parent.childForTest("run")).toMatchObject({
        cancellationHeld: true
      });
      expect(await parent.inspectAgentTool("run")).toMatchObject({
        status: "aborted",
        childStillRunning: true
      });
      await parent.startForTest("blocked", "blocked", { complete: true });
      await expect
        .poll(() => parent.resultForTest("blocked"))
        .toMatchObject({ status: "error" });
      await parent.releaseCancellationForTest("run");
      await expect
        .poll(() => parent.inspectAgentTool("run"))
        .toMatchObject({ status: "aborted", childStillRunning: false });
      await expect
        .poll(async () =>
          (await parent.observationsForTest("run")).changes.at(-1)
        )
        .toMatchObject({ status: "aborted", childStillRunning: false });
      await parent.startForTest("next", "next", { complete: true });
      await expect
        .poll(() => parent.resultForTest("next"))
        .toMatchObject({ status: "completed" });
    } finally {
      await parent.releaseCancellationForTest("run");
      await parent.finishChildForTest("run");
    }
  });

  it.each(["running", "interrupted"] as const)(
    "retains late shutdown confirmation while a %s run awaits replay",
    async (status) => {
      const parent = await getAgentByName(
        env.TestAgentToolLifecycleWindowParent,
        `lifecycle-replay-${crypto.randomUUID()}`
      );
      await parent.startForTest("run", "original", {
        holdCancellation: true,
        holdInspection: true,
        holdReplayAfterCancellation: true
      });
      await expect
        .poll(() => parent.childForTest("run"))
        .toMatchObject({ tails: 1 });
      try {
        if (status === "interrupted") {
          await parent.failNextTailForTest("run");
          await parent.startForTest("run", "initial-interrupt");
          await expect
            .poll(() => parent.resultForTest("initial-interrupt"))
            .toMatchObject({
              status: "interrupted",
              reason: "no-progress",
              childStillRunning: true
            });
        }
        await parent.startForTest("run", "recovery");
        await expect
          .poll(() => parent.childForTest("run"), { timeout: 6_000 })
          .toMatchObject({
            cancellationHeld: true,
            inspectionHeld: true,
            replayReadHeld: true
          });
        expect(await parent.inspectAgentTool("run")).toMatchObject({ status });
        const changes = (await parent.observationsForTest("run")).changes
          .length;
        await parent.releaseCancellationForTest("run");
        // Wait for the parent's actual acknowledgment handler before letting
        // the older replay observation publish its interruption.
        await expect
          .poll(
            async () => (await parent.observationsForTest("run")).changes.length
          )
          .toBeGreaterThan(changes);
        expect(await parent.resultForTest("recovery")).toBeNull();
        await parent.releaseReplayReadForTest("run");
        await expect
          .poll(() => parent.resultForTest("recovery"))
          .toMatchObject({
            status: "interrupted",
            reason: "window-exceeded",
            childStillRunning: false
          });
        expect(await parent.inspectAgentTool("run")).toMatchObject({
          status: "interrupted",
          childStillRunning: false
        });
        await parent.startForTest("next", "next", { complete: true });
        await expect
          .poll(() => parent.resultForTest("next"))
          .toMatchObject({ status: "completed" });
        await parent.releaseInspectionForTest("run");
        await expect
          .poll(() => parent.resultForTest("original"))
          .toMatchObject({ status: "aborted", childStillRunning: false });
      } finally {
        await parent.releaseCancellationForTest("run");
        await parent.releaseReplayReadForTest("run");
        await parent.releaseInspectionForTest("run");
        await parent.finishChildForTest("run");
      }
    }
  );

  it("retries an unconfirmed durable cancellation after a real parent restart", async () => {
    const name = `lifecycle-evict-${crypto.randomUUID()}`;
    let parent = await parentForTest(name);
    await parent.startForTest("run", "original", {
      cancellationError: "child cancellation transport failed"
    });
    await expect
      .poll(() => parent.childForTest("run"))
      .toMatchObject({ tails: 1 });
    await expect(
      Promise.resolve(parent.cancelAgentTool("run", "stop"))
    ).rejects.toThrow("child cancellation transport failed");
    expect(await parent.inspectAgentTool("run")).toMatchObject({
      status: "aborted",
      childStillRunning: true
    });
    // Crash the one parent actor (and its live facets), preserving SQL. Graceful
    // eviction cannot drain a parent while a child still holds RPC references.
    await expect(Promise.resolve(parent.restartForTest())).rejects.toThrow(
      "forced parent restart"
    );
    parent = await parentForTest(name);
    await expect
      .poll(() => parent.inspectAgentTool("run"))
      .toMatchObject({ status: "aborted", childStillRunning: false });
    expect(await parent.childForTest("run")).toMatchObject({
      status: "aborted",
      starts: 1,
      cancels: 2
    });
  });
});
