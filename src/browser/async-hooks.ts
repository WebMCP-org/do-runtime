import { asyncContext, bindAsyncContext, withAsyncContext } from "../util/async-context";

/**
 * Browser ALS for modules compiled by doRuntimeAwaitTransform({ asyncContext: true }).
 * Native await bypasses Promise.then: every async caller needing propagation must
 * be included in that transform. Platform event callbacks must use bind/snapshot.
 */
export class AsyncLocalStorage<T> {
  #key = Symbol();
  readonly #defaultValue: T | undefined;
  readonly name: string;

  constructor(options?: { defaultValue?: T; name?: string }) {
    this.#defaultValue = options?.defaultValue;
    this.name = options?.name ?? "";
  }

  getStore(): T | undefined {
    return asyncContext.current.has(this.#key)
      ? (asyncContext.current.get(this.#key) as T)
      : this.#defaultValue;
  }

  run<Args extends unknown[], Result>(
    store: T,
    callback: (...args: Args) => Result,
    ...args: Args
  ): Result {
    const context = new Map(asyncContext.current);
    context.set(this.#key, store);
    return withAsyncContext(context, () => callback(...args));
  }

  exit<Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args): Result {
    const context = new Map(asyncContext.current);
    context.delete(this.#key);
    return withAsyncContext(context, () => callback(...args));
  }

  enterWith(store: T): void {
    const context = new Map(asyncContext.current);
    context.set(this.#key, store);
    asyncContext.current = context;
  }

  disable(): void {
    // Retire the key so snapshots taken before disable cannot revive this store.
    this.#key = Symbol();
  }

  static bind = bindAsyncContext;

  static snapshot(): <Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
    ...args: Args
  ) => Result {
    const context = asyncContext.current;
    return (callback, ...args) => withAsyncContext(context, () => callback(...args));
  }
}

if (!asyncContext.installed) {
  const then = Promise.prototype.then;
  Promise.prototype.then = function (onfulfilled, onrejected) {
    return Reflect.apply(then, this, [
      typeof onfulfilled === "function" ? bindAsyncContext(onfulfilled) : onfulfilled,
      typeof onrejected === "function" ? bindAsyncContext(onrejected) : onrejected,
    ]);
  };
  asyncContext.installed = true;
}

// unenv's EventEmitter module imports this even when only ordinary EventEmitter
// is used. Refuse async-hook instrumentation rather than inventing resource IDs.
export class AsyncResource {
  constructor() {
    throw new Error(
      "Browser AsyncResource is not supported; use AsyncLocalStorage.bind() or snapshot()",
    );
  }
}

export default { AsyncLocalStorage, AsyncResource };
