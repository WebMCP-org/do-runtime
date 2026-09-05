import { describe, expect, test, vi } from "vitest";
import { __gate, __gateAsyncIterable, __gateAwait, __resumeAwait } from "./gate";
import { InputGate, OutputGate } from "./io/io-gate";
import {
  BrokenActorError,
  IoContext,
  requireInputLock,
  type Actor,
  type Timer,
} from "./io/io-context";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle), { once: true });
    }),
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

function newContext(): IoContext {
  return new IoContext(new TestActor(), timer);
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

describe("__gate", () => {
  test("returns values and thenables unchanged outside an actor", () => {
    const value = { answer: 42 };
    const thenable = Promise.resolve("done");

    expect(__gate(value)).toBe(value);
    expect(__gate(thenable)).toBe(thenable);
  });

  test("warns once only when a development transform reaches a lockless continuation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = Promise.resolve("done");
    try {
      expect(__gateAwait(value)).toBe(value);
      const context = newContext();
      await context.run(async () => {
        __resumeAwait(await __gateAwait(value, "/actor-with-a-lock.js"));
      });
      await portHop();
      expect(__gateAwait(value, "/actor-with-a-gap.js")).toBe(value);
      expect(__gateAwait(value, "/actor-with-a-gap.js")).toBe(value);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("/actor-with-a-gap.js"));
    } finally {
      warn.mockRestore();
    }
  });

  test("re-enters the same actor after sequential foreign awaits", async () => {
    const context = newContext();

    const held = await context.run(async () => {
      await __gate(portHop());
      const afterFirst = context.hasCurrent();
      await __gate(portHop());
      return [afterFirst, context.hasCurrent()];
    });

    expect(held).toEqual([true, true]);
  });

  test("carries context through a plain-value await", async () => {
    const context = newContext();

    const held = await context.run(async () => {
      await __gate(1);
      await __gate(portHop());
      return context.hasCurrent();
    });

    expect(held).toBe(true);
  });

  test("keeps interleaved actor continuations isolated", async () => {
    const first = newContext();
    const second = newContext();
    const run = (context: IoContext, label: string) =>
      context.run(async () => {
        await __gate(Promise.resolve());
        await __gate(portHop());
        requireInputLock(context, label);
        return label;
      });

    await expect(Promise.all([run(first, "first"), run(second, "second")])).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  test("does not let one blocked actor hold up another actor's publication", async () => {
    const blockedActor = new TestActor();
    const blocked = new IoContext(blockedActor, timer);
    const unblocking = newContext();
    const blockedValue = Promise.withResolvers<void>();
    const unblockingValue = Promise.withResolvers<void>();
    let releaseBlockedLock = () => {};
    let blockedContinuation!: Promise<void>;
    let unblockingContinuation!: Promise<void>;

    await blocked.run(() => {
      const lock = blocked.getInputLock();
      let released = false;
      releaseBlockedLock = () => {
        if (released) return;
        released = true;
        lock.release();
      };
      blockedContinuation = Promise.resolve(__gate(blockedValue.promise));
    });
    await portHop();

    await unblocking.run(() => {
      unblockingContinuation = (async () => {
        await __gate(unblockingValue.promise);
        releaseBlockedLock();
      })();
    });
    await portHop();

    blockedValue.resolve();
    await expect.poll(() => blockedActor.inputGate.waiters.length).toBe(1);
    unblockingValue.resolve();
    const completed = Promise.all([blockedContinuation, unblockingContinuation]);
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("an unrelated blocked publication stalled the actor")), 1_000);
    });

    try {
      await expect(Promise.race([completed, deadline])).resolves.toEqual([undefined, undefined]);
    } finally {
      releaseBlockedLock();
      await Promise.allSettled([blockedContinuation, unblockingContinuation]);
      blocked.abort(new Error("test cleanup"));
      unblocking.abort(new Error("test cleanup"));
    }
  });

  test("clears continuation context before a later macrotask", async () => {
    const context = newContext();
    await context.run(async () => {
      await __gate(Promise.resolve());
    });
    await portHop();
    const outside = Promise.resolve("outside");

    expect(__gate(outside)).toBe(outside);
  });

  test("keeps sampled provenance for transformed awaits", async () => {
    const context = newContext();
    await context.run(async () => {
      await __gate(portHop());
    });

    expect(context.describeLostLock()).toContain("transformed await sampled at the site below");
  });

  test("re-enters the actor when an awaited promise rejects", async () => {
    const context = newContext();

    await context.run(async () => {
      await expect(__gate(Promise.reject(new Error("expected")))).rejects.toThrow("expected");
      requireInputLock(context, "after rejection");
    });
  });

  test("re-enters the critical section captured by blockConcurrencyWhile", async () => {
    const context = newContext();
    const completed = context.run(() =>
      context.blockConcurrencyWhile(async () => {
        await __gate(portHop());
        requireInputLock(context, "critical section continuation");
        return "done";
      }),
    );
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("critical-section continuation did not resume")), 1_000);
    });

    try {
      await expect(Promise.race([completed, deadline])).resolves.toBe("done");
    } finally {
      context.abort(new Error("test cleanup"));
    }
  });
});

describe("transformed await resume", () => {
  test.each(["fulfillment", "rejection"])("stays busy through a foreign await and queued %s", async (outcome) => {
    const actor = new TestActor();
    const context = new IoContext(actor, timer);
    const pending = Promise.withResolvers<number>();
    const failure = new Error("foreign await failed");
    const resumed = context.run(async () => {
      try {
        return __resumeAwait(await __gateAwait(pending.promise));
      } catch (error) {
        requireInputLock(context, "caught foreign rejection");
        return error;
      }
    });
    await portHop();

    let drained = false;
    const draining = context.drainWaitUntil().then(() => { drained = true; });
    await portHop();
    expect(context.hasCurrent()).toBe(false);
    expect(context.waitUntilTaskCount()).toBeGreaterThan(0);
    expect(drained).toBe(false);

    // Another event can enter during the wait, then hold up its publication.
    const lock = await context.run(() => context.getInputLock());
    try {
      if (outcome === "fulfillment") pending.resolve(42);
      else pending.reject(failure);
      await expect.poll(() => actor.inputGate.waiters.length).toBe(1);
      expect(context.waitUntilTaskCount()).toBeGreaterThan(0);
      expect(drained).toBe(false);
    } finally {
      lock.release();
    }

    await expect(resumed).resolves.toBe(outcome === "fulfillment" ? 42 : failure);
    await draining;
    expect(context.waitUntilTaskCount()).toBe(0);
    expect(context.waitUntilStatus()).toBeUndefined();
  });

  test("preserves BrokenActorError when a failed section cannot re-enter", async () => {
    const context = newContext();
    const cause = new Error("section failed");

    const exception = await context.run(async () => {
      try {
        __resumeAwait(
          await __gateAwait(
            context.blockConcurrencyWhile(() => {
              throw cause;
            }),
          ),
        );
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(exception).toBeInstanceOf(BrokenActorError);
    expect(exception).toHaveProperty("cause", cause);
  });

  test("ignores a continuation marker after its input lock is gone", () => {
    const context = newContext();
    const key = Symbol.for("@mcp-b/do-runtime/current-continuation");
    const value = Promise.resolve("outside");
    Reflect.set(globalThis, key, { context, token: {} });

    try {
      expect(__gate(value)).toBe(value);
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  test("publishes continuation identity for separately bundled runtime copies", async () => {
    const context = newContext();
    const key = Symbol.for("@mcp-b/do-runtime/current-continuation");

    await context.run(async () => {
      __resumeAwait(await __gateAwait(portHop()));
      expect(Reflect.get(globalThis, key)).toMatchObject({ context });
    });
    await portHop();
    expect(Reflect.has(globalThis, key)).toBe(false);
  });

  test("restores context at the first instruction after fulfillment", async () => {
    const context = newContext();

    const held = await context.run(async () => {
      __resumeAwait(await __gateAwait(portHop()));
      requireInputLock(context, "explicit transformed continuation");
      return true;
    });

    expect(held).toBe(true);
  });

  test("carries context across nested native promise continuations", async () => {
    const context = newContext();

    const held = await context.run(async () => {
      __resumeAwait(await __gateAwait(portHop()));
      await Promise.resolve();
      __resumeAwait(await __gateAwait(portHop()));
      requireInputLock(context, "nested native continuation");
      return true;
    });

    expect(held).toBe(true);
  });

  test("restores context before throwing a rejection", async () => {
    const context = newContext();

    await context.run(async () => {
      let caught: unknown;
      try {
        __resumeAwait(await __gateAwait(Promise.reject(new Error("expected"))));
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(new Error("expected"));
      requireInputLock(context, "rejected transformed continuation");
    });
  });
});

describe("__gateAsyncIterable", () => {
  test("awaits sync iterable values while retaining async iterator values", async () => {
    const promised = Promise.resolve(42);
    const values: unknown[] = [];
    for await (const value of __gateAsyncIterable([promised])) values.push(value);
    expect(values).toEqual([42]);

    const asyncIterable: AsyncIterable<Promise<number>> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: promised }),
      }),
    };
    for await (const value of __gateAsyncIterable(asyncIterable)) {
      expect(value).toBe(promised);
      break;
    }
  });

  test("matches native sync iterator cleanup after rejection and early return", async () => {
    const failure = new Error("yield failed");
    async function consume(gated: boolean, reject: boolean) {
      let closed = false;
      function* source() {
        try {
          yield reject ? Promise.reject(failure) : Promise.resolve(42);
        } finally {
          closed = true;
        }
      }
      const iterable = source();
      let caught: unknown;
      try {
        for await (const value of gated ? __gateAsyncIterable(iterable) : iterable) {
          expect(value).toBe(42);
          break;
        }
      } catch (error) {
        caught = error;
      }
      return { closed, caught };
    }

    for (const reject of [false, true]) {
      expect(await consume(true, reject)).toEqual(await consume(false, reject));
    }
  });

  test("rejects a non-callable async iterator instead of using its sync iterator", async () => {
    const iterable = Object.assign([1], { [Symbol.asyncIterator]: 1 });
    await expect(async () => {
      for await (const value of __gateAsyncIterable(iterable)) void value;
    }).rejects.toThrow(TypeError);
  });

  test("forwards early return to the underlying iterator", async () => {
    let canceled = false;
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: 1 }),
          return: () => {
            canceled = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    for await (const value of __gateAsyncIterable(iterable)) {
      expect(value).toBe(1);
      break;
    }

    expect(canceled).toBe(true);
  });

  test("supports primitive sync iterables", async () => {
    const values: string[] = [];

    for await (const value of __gateAsyncIterable("ab")) values.push(value);

    expect(values).toEqual(["a", "b"]);
  });
});
