// Shared by separately bundled facet modules. Only the browser async_hooks leaf
// installs propagation; importing the runtime alone never patches Promise.
const KEY = Symbol.for("@mcp-b/do-runtime/async-context");
type ContextState = { current: ReadonlyMap<symbol, unknown>; installed: boolean };
const globals = globalThis as typeof globalThis & { [KEY]?: ContextState };
export const asyncContext = (globals[KEY] ??= { current: new Map(), installed: false });

export function withAsyncContext<T>(context: ReadonlyMap<symbol, unknown>, callback: () => T): T {
  const previous = asyncContext.current;
  asyncContext.current = context;
  try {
    return callback();
  } finally {
    asyncContext.current = previous;
  }
}

export function bindAsyncContext<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  if (!asyncContext.installed) return callback;
  const context = asyncContext.current;
  return function (this: unknown, ...args: Args): Result {
    return withAsyncContext(context, () => Reflect.apply(callback, this, args));
  };
}
