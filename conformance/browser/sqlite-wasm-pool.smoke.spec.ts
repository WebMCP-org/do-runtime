import { expect, test } from "vitest";

test("whole-pool snapshots restore real OPFS root/facet files, smaller images and orphans", async () => {
  const worker = new Worker(
    new URL("./sqlite-wasm-pool.worker.ts", import.meta.url),
    { type: "module" }
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.addEventListener("message", (event) => resolve(event.data), {
        once: true
      });
      worker.addEventListener("error", reject, { once: true });
    });
    expect(result).toEqual({
      ok: true,
      result: {
        names: ["/actor.root.sqlite", "/facet-1.root.sqlite"],
        invalidRefused: true,
        preservedOnFailure: true,
        exactRestoration: true
      }
    });
  } finally {
    worker.terminate();
  }
}, 30_000);
