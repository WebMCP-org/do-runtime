import { expect, test } from "vitest";
import { IoContext, tryCurrentIoContext, type Actor, type Timer } from "../io/io-context";
import { InputGate, OutputGate } from "../io/io-gate";
import { AsyncLocalStorage } from "./async-hooks";

// Keep this caller untransformed: only synchronous runtime callback boundaries
// should restore the browser store, never the test's native-await continuations.
function fixture() {
  const inputGate = new InputGate();
  const outputGate = new OutputGate();
  const wakes: (() => void)[] = [];
  const timer: Timer = {
    now: () => 0,
    afterDelay: () => new Promise((resolve) => wakes.push(resolve)),
  };
  const actor: Actor = {
    getInputGate: () => inputGate,
    getOutputGate: () => outputGate,
    shutdownActorCache() {},
    assertCanSetAlarm() {},
  };
  const context = new IoContext(actor, timer);
  const store = new AsyncLocalStorage<string>();
  return {
    context,
    store,
    inputGate,
    observe: () => ({ store: store.getStore(), input: tryCurrentIoContext() === context }),
    fire() {
      const wake = wakes.shift();
      if (!wake) throw new Error("No timer armed");
      wake();
    },
  };
}

test("run captures its caller before waiting for an occupied input gate", async () => {
  const { context, store, inputGate, observe } = fixture();
  const held = await inputGate.wait();
  let entered = false;
  const pending = store.run("owner", () =>
    context.run(() => {
      entered = true;
      return observe();
    }),
  );
  await Promise.resolve();
  expect(entered).toBe(false);
  expect(store.getStore()).toBeUndefined();
  store.run("unrelated", () => held.release());
  expect(await pending).toEqual({ store: "owner", input: true });
  expect(store.getStore()).toBeUndefined();
});

test.each([false, true])(
  "reentry uses registration scope when transformed=%s",
  async (transformed) => {
    const { context, store, observe } = fixture();
    const reenter = await context.run(() =>
      store.run("owner", () =>
        transformed
          ? context.makeTransformReentryCallback(observe)
          : context.makeReentryCallback(observe),
      ),
    );
    const pending = store.run("unrelated", () => reenter());
    expect(store.getStore()).toBeUndefined();
    expect(await pending).toEqual({ store: "owner", input: true });
    expect(store.getStore()).toBeUndefined();
  },
);

test("critical-section admission restores the callback's scope", async () => {
  const { context, store, observe } = fixture();
  const result = await context.run(() =>
    store.run("section", () => context.blockConcurrencyWhile(observe)),
  );
  expect(result).toEqual({ store: "section", input: true });
  expect(store.getStore()).toBeUndefined();
});

test("an interval keeps its registration scope on its second firing", async () => {
  const { context, store, observe, fire } = fixture();
  const seen: ReturnType<typeof observe>[] = [];
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const id = await context.run(() =>
    store.run("interval", () =>
      context.setTimeoutImpl(
        true,
        () => {
          seen.push(observe());
          if (seen.length === 1) first.resolve();
          else {
            context.clearTimeoutImpl(id);
            second.resolve();
          }
        },
        1,
      ),
    ),
  );
  store.run("first wake", fire);
  await first.promise;
  expect(store.getStore()).toBeUndefined();
  store.run("second wake", fire);
  await second.promise;
  await context.drainWaitUntil();
  expect(seen).toEqual([
    { store: "interval", input: true },
    { store: "interval", input: true },
  ]);
  expect(store.getStore()).toBeUndefined();
});
