import { expect, test } from "vitest";
import { __gate } from "../../src/gate";
import { InputGate, OutputGate } from "../../src/io/io-gate";
import { IoContext, type Actor, type Timer } from "../../src/io/io-context";

const ITERATIONS = 1_000;

const timer: Timer = {
  now: () => performance.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle), { once: true });
    }),
};

class BenchActor implements Actor {
  readonly inputGate = new InputGate();
  readonly outputGate = new OutputGate();

  getInputGate(): InputGate {
    return this.inputGate;
  }

  getOutputGate(): OutputGate {
    return this.outputGate;
  }

  shutdownActorCache(): void {}
  assertCanSetAlarm(): void {}
}

async function measure(kind: "plain" | "awaitIo" | "transformed"): Promise<number> {
  const context = new IoContext(new BenchActor(), timer);
  const started = performance.now();
  const result = await context.run(async () => {
    let value = 0;
    for (let index = 0; index < ITERATIONS; index++) {
      if (kind === "plain") value = await value + 1;
      else if (kind === "awaitIo") value = await context.awaitIo(Promise.resolve(value + 1));
      else value = await __gate(Promise.resolve(value + 1));
    }
    return value;
  });
  expect(result).toBe(ITERATIONS);
  return (performance.now() - started) / ITERATIONS;
}

test("await transform per-await cost", async () => {
  const plainMs = await measure("plain");
  const awaitIoMs = await measure("awaitIo");
  const transformedMs = await measure("transformed");

  console.log(
    JSON.stringify({
      iterations: ITERATIONS,
      millisecondsPerAwait: { plain: plainMs, awaitIo: awaitIoMs, transformed: transformedMs },
    }),
  );
  expect(transformedMs).toBeGreaterThanOrEqual(0);
});
