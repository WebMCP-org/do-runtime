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

type Started = {
  readonly worker: Worker;
  /** The first report of a kind, whether it has arrived yet or not; a worker error fails at once. */
  next<K extends Kind>(kind: K): Promise<Extract<CrashReport, { kind: K }>>;
};

function start(boot: CrashBoot): Started {
  const worker = new Worker(new URL("./actor-crash.worker.ts", import.meta.url), {
    type: "module",
  });
  workers.push(worker);
  const reports: CrashReport[] = [];
  let arrived = Promise.withResolvers<void>();
  const receive = (report: CrashReport): void => {
    reports.push(report);
    arrived.resolve();
    arrived = Promise.withResolvers<void>();
  };
  worker.addEventListener("message", (event: MessageEvent<CrashReport>) => receive(event.data));
  worker.addEventListener("error", (event) => receive({ kind: "error", error: event.message }));
  worker.postMessage(boot);
  return {
    worker,
    async next<K extends Kind>(kind: K): Promise<Extract<CrashReport, { kind: K }>> {
      for (;;) {
        const failure = reports.find((report) => report.kind === "error");
        if (failure?.kind === "error") throw new Error(failure.error);
        const found = reports.find(
          (report): report is Extract<CrashReport, { kind: K }> => report.kind === kind,
        );
        if (found !== undefined) return found;
        await arrived.promise;
      }
    },
  };
}

test(
  "worker termination mid-slice rolls back the open implicit transaction, the first reopen removes the hot journal, and acknowledged writes survive",
  async () => {
    const poolName = `do-runtime-actor-crash-${Math.random().toString(36).slice(2)}`;
    try {
      const crashed = start({ poolName, phase: "crash" });
      await crashed.next("acknowledged");
      await crashed.next("started");
      crashed.worker.terminate();

      const reopened = start({ poolName, phase: "reopen" });
      expect(await reopened.next("reopened")).toEqual({
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

test(
  "whole-pool backup and restore roll back a terminated worker's hot journal instead of refusing it",
  async () => {
    const poolName = `do-runtime-actor-backup-${Math.random().toString(36).slice(2)}`;
    const dirty = ["/actor.facets.sqlite", "/actor.root.sqlite", "/actor.root.sqlite-journal"];
    const clean = ["/actor.facets.sqlite", "/actor.root.sqlite"];
    const crash = async (acknowledged: string): Promise<void> => {
      const crashed = start({ poolName, phase: "crash", acknowledged });
      await crashed.next("acknowledged");
      await crashed.next("started");
      crashed.worker.terminate();
    };
    try {
      await crash("call-1");
      const backup = start({ poolName, phase: "backup" });
      const { snapshot, ...backedUp } = await backup.next("backedUp");
      backup.worker.terminate();
      expect(backedUp).toEqual({ kind: "backedUp", before: dirty, after: clean });
      expect(snapshot.files.map(({ name }) => name)).toEqual(clean);

      // A later acknowledged write, then a crash that leaves the destination another hot journal.
      await crash("call-3");
      const restore = start({ poolName, phase: "restore", snapshot });
      expect(await restore.next("restored")).toEqual({
        kind: "restored",
        before: dirty,
        // The backup's committed rows: neither the rolled-back call-2 nor the replaced call-3.
        after: { files: clean, rows: [["call-1", 2_304]] },
      });
    } finally {
      for (const worker of workers.splice(0)) worker.terminate();
    }
  },
  60_000,
);
