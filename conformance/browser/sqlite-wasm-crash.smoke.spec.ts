import { expect, test } from "vitest";
import type {
  CrashCommand,
  CrashReport,
} from "./sqlite-wasm-crash.worker";

function runWorker(command: CrashCommand): Promise<{ worker: Worker; report: CrashReport }> {
  const worker = new Worker(new URL("./sqlite-wasm-crash.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.postMessage(command);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ worker, report: { kind: "error", error: "worker timed out" } });
    }, 2_000);
    worker.addEventListener("message", (event: MessageEvent<CrashReport>) => {
      clearTimeout(timeout);
      resolve({ worker, report: event.data });
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ worker, report: { kind: "error", error: event.message } });
    });
  });
}

test(
  "OPFS rolls back an open transaction after its worker is terminated",
  async () => {
    const poolName = `do-runtime-crash-${Math.random().toString(36).slice(2)}`;
    const dirty = await runWorker({ mode: "dirty", poolName });
    dirty.worker.terminate();
    expect(dirty.report).toEqual({ kind: "dirty" });

    const deadline = Date.now() + 10_000;
    let lastError = "replacement worker did not start";
    while (Date.now() < deadline) {
      const recovered = await runWorker({ mode: "recover", poolName });
      recovered.worker.terminate();
      if (recovered.report.kind === "recovered") {
        expect(recovered.report.rows).toEqual(["committed"]);
        return;
      }
      lastError =
        recovered.report.kind === "error"
          ? recovered.report.error
          : `unexpected ${recovered.report.kind} report`;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`replacement worker could not reacquire OPFS: ${lastError}`);
  },
  20_000,
);
