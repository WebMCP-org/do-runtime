/**
 * Run:
 *   npx vitest run --config conformance/bench/vitest.browser.config.ts
 *
 * This is the number that counts. Deliberately outside every lane's
 * `test.include` — a timing measurement is a sizing decision, not an invariant,
 * and one wired into the CI fan-in is a flake with no reproduction.
 */

import { expect, test } from "vitest";
import { formatReport } from "./report";
import type { BenchReport } from "./message-store";

test("synchronous sql.exec latency over the real message store, sqlite-wasm on OPFS", async () => {
  const worker = new Worker(new URL("./sql-latency.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const report = await new Promise<BenchReport>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<BenchReport>) => {
        resolve(event.data);
      });
      worker.addEventListener("error", (event) => {
        reject(new Error(event.message));
      });
    });
    console.log(formatReport(report));
    // The only assertion: the run produced numbers. Nothing here asserts a
    // threshold.
    expect(report.ok).toBe(true);
  } finally {
    worker.terminate();
  }
}, 900_000);
