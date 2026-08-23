import { expect, test } from "vitest";
import { InputGate, OutputGate } from "../../src/io/io-gate";
import { IoContext, type Actor, type Timer } from "../../src/io/io-context";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

class TestActor implements Actor {
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

function importGateCopy(name: string): Promise<typeof import("../../src/gate")> {
  return import(/* @vite-ignore */ `../../src/gate.ts?${name}`) as Promise<
    typeof import("../../src/gate")
  >;
}

function portHop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

test("only one actor publishes into the await-to-resume gap", async () => {
  const [firstGate, secondGate] = await Promise.all([
    importGateCopy("first-publication"),
    importGateCopy("second-publication"),
  ]);
  const first = new IoContext(new TestActor(), timer);
  const second = new IoContext(new TestActor(), timer);
  const firstSource = Promise.withResolvers<void>();
  const secondSource = Promise.withResolvers<void>();
  let firstPublication!: Promise<unknown>;
  let secondPublication!: Promise<unknown>;

  await first.run(() => {
    firstPublication = Promise.resolve(firstGate.__gateAwait(firstSource.promise));
  });
  await second.run(() => {
    secondPublication = Promise.resolve(secondGate.__gateAwait(secondSource.promise));
  });

  let secondPublished = false;
  void secondPublication.then(() => {
    secondPublished = true;
  });
  firstSource.resolve();
  secondSource.resolve();
  await Promise.resolve();
  const beforeCheckpointFallback = portHop();

  const firstResult = await firstPublication;
  await beforeCheckpointFallback;
  expect(secondPublished).toBe(false);

  firstGate.__resumeAwait(firstResult);
  const secondResult = await secondPublication;
  secondGate.__resumeAwait(secondResult);
});
