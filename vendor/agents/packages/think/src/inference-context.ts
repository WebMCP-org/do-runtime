import { AsyncLocalStorage } from "node:async_hooks";
import type { streamText } from "ai";

type InferenceOptions = Parameters<typeof streamText>[0];

/** Native stream callbacks can enter from outside the turn that created them. */
export function bindInferenceContext(
  options: InferenceOptions
): InferenceOptions {
  const inTurn = AsyncLocalStorage.snapshot();
  const bind = (callback: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const result: unknown = inTurn(() => Reflect.apply(callback, this, args));
      if (!isAsyncIterable(result)) return result;
      // A generator starts at next(), not when execute() returns its iterator.
      const iterator = inTurn(() => result[Symbol.asyncIterator]());
      const bound: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: (...values) => inTurn(() => iterator.next(...values))
      };
      if (iterator.return)
        bound.return = (value) => inTurn(() => iterator.return!(value));
      if (iterator.throw)
        bound.throw = (error) => inTurn(() => iterator.throw!(error));
      return bound;
    };
  const bindValue = (value: unknown): unknown =>
    typeof value === "function"
      ? bind(value as (...args: unknown[]) => unknown)
      : value;
  const bindCallbacks = <T extends object>(value: T): T =>
    Object.assign(
      { ...value },
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          Array.isArray(item) ? item.map(bindValue) : bindValue(item)
        ])
      )
    );
  const bound = bindCallbacks(options);
  if (options.tools) {
    bound.tools = Object.fromEntries(
      Object.entries(options.tools).map(([name, tool]) => [
        name,
        bindCallbacks(tool)
      ])
    );
  }
  return bound;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}
