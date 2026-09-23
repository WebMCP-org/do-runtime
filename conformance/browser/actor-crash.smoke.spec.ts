/**
 * A real `Worker.terminate()` in the middle of an actor's synchronous slice.
 *
 * The suite's crash rows drop a container with `abort()` and `close()`, which
 * never leaves SQLite inside a transaction. A browser host's workers die for
 * real, so this commits and acknowledges one call, lets a second call rewrite
 * every row inside its implicit transaction until SQLite has had to spill
 * journaled pages into the database file, and terminates the worker there.
 * What a fresh worker then finds is the whole claim.
 */

import { expect, test } from "vitest";
import type { CrashBoot, CrashReport } from "./actor-crash.worker";

type Kind = CrashReport["kind"];

/** Every worker the test started, terminated however it ends. */
const workers: Worker[] = [];

function start(boot: CrashBoot): { worker: Worker; reports: CrashReport[] } {
  const worker = new Worker(new URL("./actor-crash.worker.ts", import.meta.url), {
    type: "module",
  });
  workers.push(worker);
  const reports: CrashReport[] = [];
  worker.addEventListener("message", (event: MessageEvent<CrashReport>) => reports.push(event.data));
  worker.addEventListener("error", (event) => reports.push({ kind: "error", error: event.message }));
  worker.postMessage(boot);
  return { worker, reports };
}

/** The first report of a kind, polled until a deadline; a worker error fails at once. */
async function next<K extends Kind>(
  reports: CrashReport[],
  kind: K,
): Promise<Extract<CrashReport, { kind: K }>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const failure = reports.find((report) => report.kind === "error");
    if (failure?.kind === "error") throw new Error(failure.error);
    const found = reports.find((report): report is Extract<CrashReport, { kind: K }> => report.kind === kind);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "worker termination mid-slice rolls back the open implicit transaction, the first reopen removes the hot journal, and acknowledged writes survive",
  async () => {
    const poolName = `do-runtime-actor-crash-${Math.random().toString(36).slice(2)}`;
    try {
      const crashed = start({ poolName, phase: "crash" });
      await next(crashed.reports, "acknowledged");
      await next(crashed.reports, "started");
      crashed.worker.terminate();

      const reopened = start({ poolName, phase: "reopen" });
      expect(await next(reopened.reports, "reopened")).toEqual({
        kind: "reopened",
        beforeReopen: {
          files: ["/actor.facets.sqlite", "/actor.root.sqlite", "/actor.root.sqlite-journal"],
          hotJournal: true,
          exported:
            "Cannot export a snapshot with a SQLite recovery sidecar: /actor.root.sqlite-journal",
        },
        // One open and close of the actor database, which is the first read after the crash.
        afterReopen: {
          files: ["/actor.facets.sqlite", "/actor.root.sqlite"],
          rows: [["call-1", 2_304]],
          exported: "facets,root",
        },
      });
    } finally {
      for (const worker of workers.splice(0)) worker.terminate();
    }
  },
  30_000,
);
