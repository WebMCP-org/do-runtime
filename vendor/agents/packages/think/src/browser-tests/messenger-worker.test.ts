import { expect, it } from "vitest";

it.each(["slack", "discord"] as const)(
  "runs built %s transport, adapter and Chat in a real Worker",
  async (provider) => {
    const worker = new Worker(
      new URL("./messenger.worker.ts", import.meta.url),
      { type: "module" }
    );
    try {
      const result = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          worker.addEventListener(
            "message",
            (event: MessageEvent<Record<string, unknown>>) => {
              if (event.data.error) reject(new Error(String(event.data.error)));
              else resolve(event.data);
            },
            { once: true }
          );
          worker.addEventListener(
            "error",
            (event) => reject(new Error(event.message)),
            { once: true }
          );
          worker.postMessage({ provider, origin: location.origin });
        }
      );
      expect(result.worker).toBe(true);
      expect(result.threadId).toBe(
        provider === "slack" ? "slack:C1:1.1" : "discord:G1:C1:T1"
      );
      expect(result.text).toContain("hello");
      expect(result.sent).toMatchObject({
        id: provider === "slack" ? "2.2" : "M2"
      });
    } finally {
      worker.terminate();
    }
  },
  20_000
);
