import { expect, test } from "vitest";
import type {
  CrashCommand,
  CrashReport,
} from "./sqlite-wasm-crash.worker";

/**
 * Longer than `installSqliteWasmHost` waits for a terminated worker's handles (10 s), so a slow
 * release fails as the helper's refusal rather than as a timeout here.
 */
const WORKER_TIMEOUT_MS = 12_000;

function runWorker(command: CrashCommand): Promise<{ worker: Worker; report: CrashReport }> {
  const worker = new Worker(new URL("./sqlite-wasm-crash.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.postMessage(command);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ worker, report: { kind: "error", error: "worker timed out" } });
    }, WORKER_TIMEOUT_MS);
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

    // One replacement: its install waits for the terminated worker's handles, and killing it
    // mid-wait to try again would only leave another set of handles held.
    const recovered = await runWorker({ mode: "recover", poolName });
    recovered.worker.terminate();
    expect(recovered.report).toEqual({ kind: "recovered", rows: ["committed"] });
  },
  20_000,
);
