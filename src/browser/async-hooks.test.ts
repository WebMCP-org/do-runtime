import { expect, test } from "vitest";
import { AsyncLocalStorage } from "./async-hooks";

test("scopes restore immediately, snapshots compose stores, and callbacks retain this", async () => {
  const first = new AsyncLocalStorage<string>();
  const second = new AsyncLocalStorage<number>();
  const snapshot = first.run("owner", () => second.run(42, () => AsyncLocalStorage.snapshot()));
  expect(first.getStore()).toBeUndefined();
  const callback = snapshot(() =>
    AsyncLocalStorage.bind(function (this: { value: number }) {
      return [this.value, first.getStore(), second.getStore()];
    }),
  );
  expect(callback.call({ value: 7 })).toEqual([7, "owner", 42]);
  expect(() =>
    first.run("throw", () => {
      throw new Error("failure");
    }),
  ).toThrow("failure");
  expect(first.getStore()).toBeUndefined();
  const pending = first.run("pending", () => Promise.resolve().then(() => first.getStore()));
  expect(first.getStore()).toBeUndefined();
  expect(await pending).toBe("pending");
  first.disable();
  expect(snapshot(() => first.getStore())).toBeUndefined();
  expect(first.run("new", () => first.exit(() => first.getStore()))).toBeUndefined();
});
