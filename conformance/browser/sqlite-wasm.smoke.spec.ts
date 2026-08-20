/**
 * Does the storage floor exist in a real browser?
 *
 * `backends/sqlite-wasm.ts` is the storage floor for the browser runtime. A
 * defect there invalidates every higher-level browser test.
 *
 * Deliberately NOT part of the conformance suite: every suite spec routes through
 * `host.spawn()` and therefore through the whole package, so a failure there
 * could be anywhere. This one drives the backend alone, which makes it the
 * first thing to run when the lane goes red — it answers "is the floor
 * intact?" without the runtime in the way.
 *
 * Through a worker, because the SAH pool needs `createSyncAccessHandle` and
 * browsers expose that only in dedicated workers.
 */

import { beforeAll, expect, test } from "vitest";
import type { SmokeReport } from "./sqlite-wasm-smoke.worker";

let report: SmokeReport;

beforeAll(async () => {
  const worker = new Worker(new URL("./sqlite-wasm-smoke.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    report = await new Promise<SmokeReport>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<SmokeReport>) =>
        resolve(event.data),
      );
      worker.addEventListener("error", (event) => reject(new Error(event.message)));
    });
  } finally {
    worker.terminate();
  }
  // Surface the worker's own failure as the suite's failure rather than letting
  // three tests report a confusing missing-property error each.
  if (!report.ok) throw new Error(report.error);
});

test("the backend round-trips a write through the OPFS SAH pool", () => {
  expect(report).toMatchObject({
    ok: true,
    roundTrip: { rowsWritten: 1, columnNames: ["v"], rawRows: [["1"]] },
  });
});

test("the two members that reach past oo1.DB answer", () => {
  expect(report).toMatchObject({
    ok: true,
    members: { before: false, inside: true, after: false },
  });
  expect(report.ok && report.members.databaseSize).toBeGreaterThan(0);
});

test("reset() drops the file and reopens an empty database", () => {
  expect(report).toMatchObject({ ok: true, reset: { tablesAfterReset: [] } });
});

test("a closed provider snapshot restores storage and seeds a replica", () => {
  expect(report).toMatchObject({
    ok: true,
    snapshot: {
      openRefusal: "Cannot snapshot or restore while database handles are open.",
      restored: [["before"]],
      replica: [["before"]],
    },
  });
});
