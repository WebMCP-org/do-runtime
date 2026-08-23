/* @do-runtime-gated */

import {
  tryCurrentContinuation,
  tryCurrentIoContext,
  type IoContext,
} from "./io/io-context";

type Publication = {
  readonly publish: () => Promise<void>;
  readonly reject: (exception: unknown) => void;
};

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly exception: unknown };

const TRANSFORMED_AWAIT = Symbol("@mcp-b/do-runtime/transformed-await");
const warnedUngatedAwaits = new Set<string>();

type TransformedAwait<T> = {
  readonly [TRANSFORMED_AWAIT]: true;
  readonly context: IoContext;
  readonly outcome: Outcome<T>;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof Reflect.get(value, "then") === "function";
}

/** Re-enter the actor that owns this transformed await; fail open outside actors. */
export function __gate<T>(value: T): T | Promise<Awaited<T>> {
  const context = tryCurrentIoContext();
  if (!isThenable(value) && context === undefined) return value;
  if (context === undefined) return value;
  return resumeWithContext(context, Promise.resolve(value));
}

/** Capture an actor await without publishing its context before the continuation runs. */
export function __gateAwait<T>(
  value: T,
  developmentSource?: string,
): T | Promise<TransformedAwait<Awaited<T>>> {
  const context = tryCurrentIoContext();
  if (context === undefined) {
    if (developmentSource !== undefined && !warnedUngatedAwaits.has(developmentSource)) {
      warnedUngatedAwaits.add(developmentSource);
      console.warn(
        `do-runtime: transformed await in ${developmentSource} ran without an actor input lock; ` +
          "an earlier await or entry path is not gated",
      );
    }
    return value;
  }
  return resumeAwaitWithContext(context, Promise.resolve(value));
}

/** Restore the captured actor at the first instruction after a transformed await. */
export function __resumeAwait<T>(value: T | TransformedAwait<T>): T {
  if (!isTransformedAwait(value)) return value as T;

  value.context.restoreContinuation();
  if (value.outcome.ok) return value.outcome.value;
  throw value.outcome.exception;
}

function isTransformedAwait<T>(value: T | TransformedAwait<T>): value is TransformedAwait<T> {
  return Reflect.get(Object(value), TRANSFORMED_AWAIT) === true;
}

function publishOutcome<T, Result>(
  context: IoContext,
  promise: Promise<T>,
  finish: (outcome: Outcome<T>) => Result,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const publish = context.makeTransformReentryCallback((outcome: Outcome<T>) => {
      if (tryCurrentContinuation() !== undefined) {
        schedulePublication({ publish: () => publish(outcome), reject });
        return;
      }
      resolve(finish(outcome));
    });
    void promise.then(
      (value) => {
        schedulePublication({ publish: () => publish({ ok: true, value }), reject });
      },
      (exception: unknown) => {
        schedulePublication({ publish: () => publish({ ok: false, exception }), reject });
      },
    );
  });
}

function resumeAwaitWithContext<T>(
  context: IoContext,
  promise: Promise<T>,
): Promise<TransformedAwait<T>> {
  return publishOutcome(context, promise, (outcome) => ({
    [TRANSFORMED_AWAIT]: true,
    context,
    outcome,
  }));
}

function resumeWithContext<T>(context: IoContext, promise: Promise<T>): Promise<T> {
  return publishOutcome(context, promise, (outcome) => {
    context.restoreContinuation();
    if (outcome.ok) return outcome.value;
    throw outcome.exception;
  });
}

/**
 * Resolve one transformed await per task, inside a fresh actor slice. Admission
 * attempts are independent so a blocked actor cannot stall the actor that will
 * unblock it. The task boundary keeps each continuation ambient isolated.
 */
function schedulePublication(publication: Publication): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();

    void publication.publish().catch((exception: unknown) => {
      publication.reject(exception);
    });
  };
  channel.port2.postMessage(undefined);
}

function iteratorFor<T>(iterable: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> | Iterator<T> {
  const subject = Object(iterable);
  const asyncIterator: unknown = Reflect.get(subject, Symbol.asyncIterator);
  if (typeof asyncIterator === "function") return Reflect.apply(asyncIterator, iterable, []);
  const iterator: unknown = Reflect.get(subject, Symbol.iterator);
  if (typeof iterator === "function") return Reflect.apply(iterator, iterable, []);
  throw new TypeError("value is not async iterable or iterable");
}

function gatedIterator<T>(iterable: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  const iterator = iteratorFor(iterable);

  function invoke(methodName: "next" | "return" | "throw", args: unknown[]): Promise<IteratorResult<T>> {
    const method: unknown = Reflect.get(iterator, methodName);
    if (typeof method === "function") {
      return Promise.resolve(__gate(Reflect.apply(method, iterator, args)));
    }
    if (methodName === "throw") return Promise.reject(args[0]);
    return Promise.resolve({ done: true, value: args[0] });
  }

  return {
    next: (...args: [] | [unknown]) => invoke("next", args),
    return: (value?: unknown) => invoke("return", [value]),
    throw: (exception?: unknown) => invoke("throw", [exception]),
  };
}

/** Gate every operation used by `for await`, including early return and throw. */
export function __gateAsyncIterable<T, IterableType extends AsyncIterable<T> | Iterable<T>>(
  iterable: IterableType,
): IterableType;
export function __gateAsyncIterable<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> | Iterable<T> {
  const wrapper: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => gatedIterator(iterable),
  };
  if ((typeof iterable !== "object" || iterable === null) && typeof iterable !== "function") {
    return wrapper;
  }
  return new Proxy(iterable, {
    get(target, property, receiver): unknown {
      if (property === Symbol.asyncIterator) return wrapper[Symbol.asyncIterator];
      return Reflect.get(target, property, receiver);
    },
  });
}
