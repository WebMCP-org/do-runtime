/**
 * §1.8 — alarms are ordinary events, and they never overlap.
 *
 * Load bearing beyond alarms themselves: upstream's
 * `_cf_executingScheduleRowId` is a per-invocation instance field that is safe
 * ONLY because delivery is serialised. Any runtime that overlaps alarm
 * delivery turns that field into a corruption bug.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

it("§1.8 an alarm re-armed from inside its own handler does not re-enter", async () => {
  const probe = await host.spawn("alarm-overlap");
  await probe.call("armAlarm");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(await probe.call("readAlarmLog")).toEqual([
    "enter:1",
    "exit:1",
    "enter:2",
    "exit:2",
  ]);
});

/**
 * The retry ladder, which section 6c makes reachable. Two things at once, and
 * both are workerd's rather than ours: a handler that throws leaves its alarm
 * set and is redelivered, and the redelivery is told how many counted retries
 * preceded it.
 *
 * `ALARM_RETRY_START_SECONDS` is 2 with up to 25% jitter, so the first retry
 * lands between 2.0s and 2.5s. The poll is generous rather than exact because
 * the jitter is deliberately not a function of anything a test can see.
 */
it("§1.8 a failed alarm is retried, and the handler is told its retry count", async () => {
  const probe = await host.spawn("alarm-retry");
  await probe.call("armFailingAlarm", 1);

  const deadline = Date.now() + 8_000;
  let observed: { retryCount: number; isRetry: boolean } | null = null;
  while (observed === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    observed = await probe.call("readAlarmRetry");
  }

  expect(observed).toEqual({ retryCount: 1, isRetry: true });
});

/**
 * §1.8 — what `getAlarm()` answers BETWEEN failed attempts, which is a plain
 * Durable Object API and therefore something the oracle can settle.
 *
 * The row exists because the browser host changed its answer here. Its storage
 * shim used to report `null` for as long as a retry was outstanding, on the
 * reasoning that the alarm had been consumed; the cutover changed it to report
 * the alarm, on the claim that `ActorSqlite` restores it when the handler
 * throws. That is a claim about upstream, so it is not something to settle by
 * reading either implementation.
 *
 * Two facts in one row, and the second is what makes the first meaningful: the
 * alarm is visible while a retry is pending, and it is `null` once the handler
 * finally succeeds — so a runtime that simply never consumed anything cannot
 * pass by accident.
 */
it("§1.8 a failed alarm stays visible to getAlarm until a delivery succeeds", async () => {
  const probe = await host.spawn("alarm-retry-visibility");
  await probe.call("armFailingAlarm", 1);

  // Poll rather than sleep to a fixed point: the first retry lands between 2.0s
  // and 2.5s (25% jitter on a 2s start), and this has to observe the window
  // before it, not a particular instant inside it.
  const deadline = Date.now() + 8_000;
  let seenWhilePending: number | null = null;
  let settled: { retryCount: number; isRetry: boolean } | null = null;
  while (settled === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seenWhilePending ??= await probe.call("readAlarm");
    settled = await probe.call("readAlarmRetry");
  }

  expect(settled).toEqual({ retryCount: 1, isRetry: true });
  expect(seenWhilePending).not.toBeNull();
  expect(await probe.call("readAlarm")).toBeNull();
});
