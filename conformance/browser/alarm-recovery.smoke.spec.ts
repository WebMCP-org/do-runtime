/**
 * An alarm whose scheduler worker is terminated mid-delivery, recovered by a
 * real restart over the same OPFS pool.
 *
 * `alarm-scheduler.test.ts` proves the recovery against a fake timer and a
 * handler that never returns. This is the same interruption produced the way
 * Chrome produces it — `Worker.terminate()` while `deliverAlarm` is pending —
 * with the row read back through the scheduler's own connection each time.
 */

import { expect, test } from "vitest";
import type { AlarmBoot, AlarmReport } from "./alarm-recovery.worker";

type Kind = AlarmReport["kind"];

/** Every worker the test started, terminated however it ends. */
const workers: Worker[] = [];

function start(boot: AlarmBoot): { worker: Worker; reports: AlarmReport[] } {
  const worker = new Worker(new URL("./alarm-recovery.worker.ts", import.meta.url), {
    type: "module",
  });
  workers.push(worker);
  const reports: AlarmReport[] = [];
  worker.addEventListener("message", (event: MessageEvent<AlarmReport>) => reports.push(event.data));
  worker.addEventListener("error", (event) => reports.push({ kind: "error", error: event.message }));
  worker.postMessage(boot);
  return { worker, reports };
}

/**
 * The first report that matches, polled until a deadline; a worker error fails at once. Longer
 * than the 10 s a replacement's pool install may wait, so a slow release reports as itself.
 */
async function next<K extends Kind>(
  reports: AlarmReport[],
  kind: K,
  matches: (report: Extract<AlarmReport, { kind: K }>) => boolean = () => true,
): Promise<Extract<AlarmReport, { kind: K }>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const failure = reports.find((report) => report.kind === "error");
    if (failure?.kind === "error") throw new Error(failure.error);
    const found = reports.find(
      (report): report is Extract<AlarmReport, { kind: K }> =>
        report.kind === kind && matches(report as Extract<AlarmReport, { kind: K }>),
    );
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "an alarm interrupted by scheduler-worker termination is redelivered exactly once after restart",
  async () => {
    const poolName = `do-runtime-alarm-recovery-${Math.random().toString(36).slice(2)}`;
    try {
      const hung = start({ poolName, phase: "hang" });
      const interrupted = await next(hung.reports, "delivering");
      hung.worker.terminate();
      expect(interrupted.retryCount).toBe(0);

      const restarted = start({ poolName, phase: "count" });
      // The constructor's projection: recovery has already turned the running mark into a
      // retry that moved the backoff and not the counted retries.
      const recovered = await next(restarted.reports, "projected");
      expect(recovered.rows).toEqual([
        {
          actor_id: "actor",
          scheduled_time: interrupted.scheduledTime,
          retry_time: expect.any(Number),
          backoff: 1,
          counted_retry: 0,
          previous_retry_counted: 0,
          running: 0,
        },
      ]);
      // The first rung, two seconds, plus at most a quarter of it in jitter.
      const retryTime = recovered.rows[0]?.retry_time as number;
      expect(retryTime).toBeGreaterThanOrEqual(recovered.before + 2_000);
      expect(retryTime).toBeLessThanOrEqual(recovered.at + 2_500);

      // Uncounted, so the handler is told retryCount 0, exactly as for a first delivery.
      expect(await next(restarted.reports, "delivered")).toEqual({
        kind: "delivered",
        scheduledTime: interrupted.scheduledTime,
        retryCount: 0,
      });
      const settled = await next(
        restarted.reports,
        "projected",
        (report) => report.wake === null && report.active === 0,
      );
      expect(settled.rows).toEqual([]);
      expect(restarted.reports.filter((report) => report.kind === "delivered")).toHaveLength(1);
      restarted.worker.terminate();

      const third = start({ poolName, phase: "count" });
      expect(await next(third.reports, "projected")).toMatchObject({ wake: null, rows: [] });
      // As long as the recovered rung could take: a delivery still owed would have arrived by now.
      for (const deadline = Date.now() + 2_500; Date.now() < deadline; ) {
        expect(third.reports.filter((report) => report.kind !== "projected")).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      for (const worker of workers.splice(0)) worker.terminate();
    }
  },
  30_000,
);
