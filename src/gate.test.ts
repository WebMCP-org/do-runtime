import { describe, expect, test } from "vitest";
import { __gate, __gateAsyncIterable } from "./gate";
import { InputGate, OutputGate } from "./io/io-gate";
import { IoContext, requireInputLock, type Actor, type Timer } from "./io/io-context";

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

describe("__gateAsyncIterable", () => {
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
