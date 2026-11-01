import { describe, expect, it, vi } from "vitest";
import { createNodeSqlProvider } from "../../../../../../backends/node-sqlite";
import type { Timer } from "../../../../../../src/io/io-context";
import { createActorContainer } from "../../../../../../src/server/actor-container";
import { AlarmHandoffObject } from "./lifecycle-alarm-handoff.actor";

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
    id: `alarm-handoff-${crypto.randomUUID()}`,
    uniqueKey: "lifecycle-alarm-handoff",
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
    (ctx, env) => new AlarmHandoffObject(ctx, env)
  );
  return { container, stub: container.entry(instance) };
}

describe("Lifecycle alarm handoff on do-runtime", () => {
  it("records a handed-off memory-limit strike under the dispatching alarm's input lock", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn");
    try {
      const { container, stub } = await startObject();
      const alarm = await stub.queueHandoff();
      expect(alarm).not.toBeNull();

      const delivered = await container.deliverAlarm(alarm!, 0);
      const strike = await stub.strike();

      expect(delivered.outcome).toBe("ok");
      expect(strike).toEqual({
        tracked: true,
        sealed: false,
        executing: "handoff",
        strikes: 1
      });
      // The strike's own report is the only error: a counter read or write
      // without the lock is swallowed as "strike not counted".
      expect(errors.mock.calls).toEqual([
        [
          expect.stringContaining("(strike 1/3, will retry with backoff)"),
          "Durable Object has exceeded its memory limit and was reset"
        ]
      ]);
      // Startup's own ungated await warns too; only the job driver is in scope.
      expect(warnings).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "lifecycle/job-driver.ts ran without an actor input lock"
        )
      );
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });
});
