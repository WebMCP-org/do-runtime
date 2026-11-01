import { describe, expect, it, vi } from "vitest";
import { createNodeSqlProvider } from "../../../../../../backends/node-sqlite";
import type { Timer } from "../../../../../../src/io/io-context";
import { createActorContainer } from "../../../../../../src/server/actor-container";
import { AlarmContextObject } from "./lifecycle-alarm-context.actor";

const DEADMAN_ALARM_DELAY_MS = 30_000;

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle));
    })
};

const noFacets = () => {
  throw new Error("this test places no facets");
};

async function startObject() {
  const container = await createActorContainer({
    id: `alarm-context-${crypto.randomUUID()}`,
    uniqueKey: "lifecycle-alarm-context",
    exports: {},
    env: {},
    ports: {
      sql: createNodeSqlProvider(),
      alarms: { scheduleRun: () => Promise.resolve() },
      facets: {
        start: noFacets,
        abort: noFacets,
        deleteStorage: noFacets,
        copyStorage: noFacets
      },
      timer
    }
  });
  const instance = await container.start(
    (ctx, env) => new AlarmContextObject(ctx, env)
  );
  return container.entry(instance);
}

describe("Lifecycle alarm writes on do-runtime", () => {
  it("re-arms jobs queued with no await between them under the caller's input lock", async () => {
    const stub = await startObject();
    await stub.startLifecycle();

    const result = await stub.queueTwoWithoutAwait();

    expect(result.errors).toEqual([]);
    expect(result.alarm).toBe(result.time);
  });

  it("arms the failed-startup fallback behind an in-flight re-arm", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = await startObject();

      const result = await stub.failStartupBehindPendingRearm();

      expect(result.startError).toBe("intentional startup failure");
      // The due job pushed during startup clamps the fallback to the deadman
      // delay. A null alarm means the fallback write failed and was dropped.
      expect(result.alarm).not.toBeNull();
      expect(result.alarm!).toBeGreaterThanOrEqual(
        result.before + DEADMAN_ALARM_DELAY_MS
      );
      expect(result.pushErrors).toEqual([]);
      expect(errors).not.toHaveBeenCalledWith(
        expect.stringContaining("startup fallback alarm"),
        expect.anything()
      );
    } finally {
      errors.mockRestore();
    }
  });
});
