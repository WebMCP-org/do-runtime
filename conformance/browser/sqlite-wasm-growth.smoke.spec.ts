/**
 * An OPFS SAH pool that fills up grows instead of bricking its actor.
 *
 * The pool has a fixed number of file slots, and SQLite takes a second slot for
 * a database's rollback journal whenever it writes. A host that never removes
 * finished facets fills its pool, and the database that takes the last slot
 * leaves none for a journal: every later write fails with `SQLITE_CANTOPEN`, the
 * output gate breaks, and every re-placement breaks again. Opening through the
 * backend now grows the pool first, so the size it was installed with is only
 * where it starts.
 */

import { expect, test } from "vitest";
import type { GrowthBoot, GrowthReport } from "./sqlite-wasm-growth.worker";

test(
  "opening grows a full SAH pool until every database and a concurrent journal for each fit",
  async () => {
    const worker = new Worker(new URL("./sqlite-wasm-growth.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const report = await new Promise<GrowthReport>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent<GrowthReport>) =>
          resolve(event.data),
        );
        worker.addEventListener("error", (event) => reject(new Error(event.message)));
        worker.postMessage({
          poolName: `do-runtime-growth-${Math.random().toString(36).slice(2)}`,
        } satisfies GrowthBoot);
      });
      expect(report).toEqual({
        kind: "grown",
        // Six database files and six journals at once.
        capacity: { installed: 3, grown: 12 },
        writes: Array(6).fill("committed"),
        reread: Array.from({ length: 6 }, (_, index) => [[`row-${index + 1}`]]),
      });
    } finally {
      worker.terminate();
    }
  },
  20_000,
);
