/**
 * The namespace's `AlarmScheduler` in a worker that is terminated while it is
 * delivering an alarm, and the schedulers that replace it over the same pool.
 *
 * `projectWake` is the scheduler's own seam for a browser watchdog, and every
 * projection is reported with the `_cf_ALARM` rows as the scheduler's
 * connection reads them at that moment. The first one comes from the
 * constructor, after recovery has rewritten any interrupted delivery.
 */

import { AlarmScheduler } from "../../src/index";
import { createSqliteWasmProvider } from "../../backends/sqlite-wasm";
import { installPool, timer } from "./substrate";

export type AlarmBoot = { readonly poolName: string; readonly phase: "hang" | "count" };

type Delivery = { readonly scheduledTime: number; readonly retryCount: number };

export type AlarmReport =
  | ({ readonly kind: "delivering" } & Delivery)
  | ({ readonly kind: "delivered" } & Delivery)
  | {
      readonly kind: "projected";
      readonly wake: number | null;
      readonly active: number;
      readonly rows: readonly Record<string, unknown>[];
      /** Read before the scheduler was constructed, and when this projection was reported. */
      readonly before: number;
      readonly at: number;
    }
  | { readonly kind: "error"; readonly error: string };

const report = (value: AlarmReport): void => self.postMessage(value);

self.addEventListener("message", (event: MessageEvent<AlarmBoot>) => {
  void boot(event.data).catch((error: unknown) => report({ kind: "error", error: String(error) }));
});

async function boot({ poolName, phase }: AlarmBoot): Promise<void> {
  const host = await installPool(poolName, { clearOnInit: phase === "hang" });
  const db = await createSqliteWasmProvider(host, { prefix: "/namespace" }).open("alarms");
  const rows = (): Record<string, unknown>[] => {
    const { columnNames, rawRows } = db.exec("SELECT * FROM _cf_ALARM", []);
    return rawRows.map((row) => Object.fromEntries(columnNames.map((name, i) => [name, row[i]])));
  };
  const before = Date.now();
  const scheduler = new AlarmScheduler({
    timer,
    db,
    getActor: () => ({
      deliverAlarm: (scheduledTime, retryCount) => {
        if (phase === "hang") {
          report({ kind: "delivering", scheduledTime, retryCount });
          return new Promise(() => {});
        }
        report({ kind: "delivered", scheduledTime, retryCount });
        return Promise.resolve({ outcome: "ok", retry: false, retryCountsAgainstLimit: true });
      },
      abandonAlarm: () => Promise.resolve(null),
    }),
    projectWake: (wake, active) => {
      report({ kind: "projected", wake, active, rows: rows(), before, at: Date.now() });
    },
  });
  if (phase === "hang") scheduler.setAlarm("actor", Date.now());
}
