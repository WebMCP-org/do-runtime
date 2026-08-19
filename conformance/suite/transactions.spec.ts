/**
 * §1.7.1 — the implicit-transaction boundary IS the gate boundary.
 *
 * The most important rows in the suite. Get decision 1 right and atomicity is
 * free; release at every await and every multi-statement write silently loses
 * it, with nothing failing until a crash lands mid-sequence.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

const expectAbort = async (
  probe: Awaited<ReturnType<typeof host.spawn>>,
  method: string,
  reason: string,
): Promise<void> => {
  // workerd terminates the JavaScript slice at abort(); this runtime has no
  // isolate to terminate, so the fixture reaches its explicit sentinel throw.
  // Both are named expected outcomes; any earlier storage/runtime failure now
  // fails here instead of being mistaken for a successful rollback.
  const expected = host.lane === "workerd" ? reason : `unreachable after ${reason}`;
  const outcome = await probe.call(method).then(
    (value) => ({ status: "fulfilled", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
  expect(outcome.status, `${method} must reject after abort()`).toBe("rejected");
  if (outcome.status === "rejected") expect(String(outcome.error)).toContain(expected);
};

it("§1.7.1 a storage await does not end the implicit transaction", async () => {
  const probe = await host.spawn("tx-storage");
  await expectAbort(probe, "txAcrossStorageAwait", "conformance: kill before commit");
  const after = await host.respawn(probe);
  const state = (await after.call("readTx")) as Record<string, unknown>;
  // One transaction spanned the await: both writes died together.
  expect(state.p1).toBeNull();
  expect(state.p2).toBeNull();
});

it("§1.7.1 a timer await commits, and opens a new transaction", async () => {
  const probe = await host.spawn("tx-timer");
  await expectAbort(probe, "txAcrossTimerAwait", "conformance: kill before commit");
  const after = await host.respawn(probe);
  const state = (await after.call("readTx")) as Record<string, unknown>;
  expect(state.t1).toBe(1);
  expect(state.t2).toBeNull();
});

it("§2.6 a schedule row and its follow-up setAlarm are one atomic write", async () => {
  // This is what justifies the browser host's boot sweep comment. An earlier
  // draft of the design record doubted it by reading the source; measuring it
  // reversed the conclusion.
  const probe = await host.spawn("tx-alarm");
  await expectAbort(probe, "txInsertThenAlarm", "conformance: kill between row and alarm");
  const after = await host.respawn(probe);
  const state = (await after.call("readTx")) as Record<string, unknown>;
  expect(state.row).toBeNull();
});

it("§2.4 a throwing transactionSync callback rolls back, DDL included", async () => {
  const probe = await host.spawn("tx-sync");
  const result = (await probe.call("transactionSyncRollback")) as {
    threw: string;
    count: number;
  };
  expect(result.threw).toContain("rollback me");
  expect(result.count).toBe(1); // the pre-existing row only
});
