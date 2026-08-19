/**
 * There is NO upstream `io-context-test.c++`. `io-context-test.js` next to it is a
 * JS-level test of hang detection and `ctx.abort()`, neither of which has a port
 * here (§ "Substrate boundaries"), so nothing in this file is a translation.
 *
 * Every case is instead derived from a claim that was measured against a running
 * workerd, and carries that claim in its title — the convention
 * `conformance/suite/*.spec.ts` and `io-gate.test.ts` already follow. This is the
 * one layer where, per the design record, the conformance suite stops confirming a
 * translation and becomes the only oracle; these tests are the unit-level half of
 * that job.
 */

import { expect, it } from "vitest";
import {
  CanceledError,
  type CriticalSection,
  InputGate,
  type InputGateHooks,
  type Lock,
  OutputGate,
} from "./io-gate";
import {
  BLOCK_CONCURRENCY_WHILE_TIMEOUT_MESSAGE,
  type Actor,
  IoContext,
  type Timer,
} from "./io-context";

/**
 * ← `kj::Promise::poll(waitScope)`, with the extra turns `io-gate.test.ts`'s copy
 * says are the honest fix.
 *
 * That helper yields once to the macrotask queue, which is exactly right for a
 * module that schedules no macrotasks of its own. This one does: every lock leaves
 * the invocation stack at the end of a microtask checkpoint, which is one macrotask
 * (see `atCheckpointEnd` in io-context.ts). A hand-off therefore costs a turn per
 * link — release, waiter fulfilled, next slice, its own release — so a fixed budget
 * of turns replaces the single turn rather than a longer timeout.
 */
const POLL_TURNS = 8;

async function poll(promise: Promise<unknown>, turns = POLL_TURNS): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < turns && !settled; turn++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return settled;
}

/** Let every pending checkpoint-end release, and everything it unblocks, run. */
async function quiesce(turns = POLL_TURNS): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * ← `kj::Timer`. Nothing advances on its own: the 30-second deadline is not
 * assertable on wall-clock time, which is the reason the port takes this seam.
 */
class FakeTimer implements Timer {
  #now = 0;
  #pending: { at: number; fire: () => void; cancel: () => void }[] = [];

  now(): number {
    return this.#now;
  }

  afterDelay(ms: number, signal?: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const entry = {
      at: this.#now + ms,
      fire: resolve,
      cancel: () => {
        reject(new CanceledError("timer canceled"));
      },
    };
    this.#pending.push(entry);
    const drop = () => {
      const index = this.#pending.indexOf(entry);
      if (index >= 0) this.#pending.splice(index, 1);
    };
    void promise.then(drop, drop);
    if (signal !== undefined) {
      if (signal.aborted) entry.cancel();
      else signal.addEventListener("abort", () => entry.cancel(), { once: true });
    }
    return promise;
  }

  advance(ms: number): void {
    this.#now += ms;
    for (const entry of [...this.#pending]) {
      if (entry.at <= this.#now) entry.fire();
    }
  }

  get pendingCount(): number {
    return this.#pending.length;
  }
}

/** ← the `Worker::Actor` surface `io-context.c++` actually reaches for. */
class TestActor implements Actor {
  readonly inputGate: InputGate;
  readonly outputGate = new OutputGate();
  readonly shutdownReasons: unknown[] = [];

  constructor(hooks?: InputGateHooks) {
    this.inputGate = hooks === undefined ? new InputGate() : new InputGate(hooks);
  }

  getInputGate(): InputGate {
    return this.inputGate;
  }

  getOutputGate(): OutputGate {
    return this.outputGate;
  }

  shutdownActorCache(reason: unknown): void {
    this.shutdownReasons.push(reason);
  }

  /** No class instance in this fixture, so nothing to refuse. */
  assertCanSetAlarm(): void {}
}

type Fixture = { ctx: IoContext; actor: TestActor; timer: FakeTimer };

function newContext(hooks?: InputGateHooks): Fixture {
  const actor = new TestActor(hooks);
  const timer = new FakeTimer();
  return { ctx: new IoContext(actor, timer), actor, timer };
}

/** The counting hooks from `io-gate.test.ts`: a miscounted lock is invisible otherwise. */
type HookCounts = { locked: number; released: number; waiterAdded: number; waiterRemoved: number };

function newHookCounts(): HookCounts {
  return { locked: 0, released: 0, waiterAdded: 0, waiterRemoved: 0 };
}

function recordingInputGateHooks(counts: HookCounts): InputGateHooks {
  return {
    inputGateLocked: () => void counts.locked++,
    inputGateReleased: () => void counts.released++,
    inputGateWaiterAdded: () => void counts.waiterAdded++,
    inputGateWaiterRemoved: () => void counts.waiterRemoved++,
  };
}

/**
 * `IoContext::blockConcurrencyWhile` takes the CURRENT input lock, so upstream can only
 * reach it from inside an isolate run: `DurableObjectState::blockConcurrencyWhile` is a
 * one-line forward from a JS method, and a JS method always has a lock. Entering through
 * the door first is that same precondition, made explicit.
 */
function blockConcurrencyWhile<T>(
  ctx: IoContext,
  callback: (lock: Lock) => T | PromiseLike<T>,
): Promise<T> {
  return ctx.run(() => ctx.blockConcurrencyWhile(callback));
}

/**
 * Does a gated slice hold a lock right now? `getInputLock()` is the only way to ask,
 * and it throws when the invocation stack is empty — which is the answer we want to
 * assert on, not an accident to be avoided.
 */
function currentSection(ctx: IoContext): CriticalSection | "no-lock" | undefined {
  let lock: Lock;
  try {
    lock = ctx.getInputLock();
  } catch {
    return "no-lock";
  }
  const section = lock.getCriticalSection();
  lock.release();
  return section;
}

// =======================================================================================
// §1.2 — where the gate is held, and where it is released.

it("§1.2 the input gate covers the synchronous slice and is released when the invocation returns control", async () => {
  // Both failure directions in one trace. Too strict — holding until the returned
  // promise settles — and "concurrent" lands after "first:resume", rebuilding the
  // serialised tail. Too permissive — releasing inside the slice — and there is no
  // slice left to be atomic.
  const { ctx } = newContext();
  const trace: string[] = [];
  const resume = Promise.withResolvers<string>();

  const first = ctx.run(async () => {
    trace.push("first:enter");
    const value = await resume.promise;
    trace.push("first:resume");
    return value;
  });
  const concurrent = ctx.run(() => {
    trace.push("concurrent");
  });

  await concurrent;
  expect(trace).toEqual(["first:enter", "concurrent"]);

  resume.resolve("done");
  expect(await first).toBe("done");
  expect(trace).toEqual(["first:enter", "concurrent", "first:resume"]);
});

it("§1.2 a storage await HOLDS the input gate (awaitIoWithInputLock)", async () => {
  // The single most important row of the measured table. `marker` is read after the
  // await, so a concurrent event that got in would be visible as "B".
  const { ctx } = newContext();
  let marker = "init";
  const storage = Promise.withResolvers<void>();

  const slow = ctx.run(async () => {
    marker = "A";
    await ctx.awaitIoWithInputLock(storage.promise);
    return marker;
  });
  const fast = ctx.run(() => {
    marker = "B";
  });

  storage.resolve();
  await fast;
  expect(await slow).toBe("A");
});

it("§1.2 a timer or cross-actor await RELEASES the input gate (awaitIo)", async () => {
  // Same shape, opposite annotation. If this one also answered "A" the gate would be
  // the serialised tail with a new name.
  const { ctx } = newContext();
  let marker = "init";
  const outbound = Promise.withResolvers<void>();

  const slow = ctx.run(async () => {
    marker = "A";
    await ctx.awaitIo(outbound.promise);
    return marker;
  });
  const fast = ctx.run(() => {
    marker = "B";
  });

  await fast;
  outbound.resolve();
  expect(await slow).toBe("B");
});

it("§1.2 awaitIo does not open the gate at the await — the slice keeps it to its checkpoint end", async () => {
  // Both readings of upstream release "at the await"; they differ on when that is,
  // and Section 4 builds atomicity on the answer. The gate opens at `#exit`, not at
  // the call: `getCriticalSection()` (`io-context.c++:362`) never touches
  // `currentInputLock`, and `runInContextScope`'s `KJ_DEFER` (`:1214`) is the only
  // thing that clears it. So work still in the calling slice — including anything
  // reached through a microtask — is still gated.
  //
  // The tail of the order also pins §1.3's FIFO: the resumption queues for a fresh
  // lock BEHIND the event that arrived while the gate was still held.
  const { ctx } = newContext();
  const order: string[] = [];
  const outbound = Promise.withResolvers<void>();

  const slow = ctx.run(async () => {
    const pending = ctx.awaitIo(outbound.promise);
    order.push("slice:after-the-awaitIo-call");
    await Promise.resolve();
    order.push("slice:after-a-microtask");
    await pending;
    order.push("slice:resumed");
  });
  const other = ctx.run(() => void order.push("other"));

  outbound.resolve();
  await Promise.all([slow, other]);
  expect(order).toEqual([
    "slice:after-the-awaitIo-call",
    "slice:after-a-microtask",
    "other",
    "slice:resumed",
  ]);
});

it("§1.2 the awaitIo resumption re-enters under a fresh lock, so it is gated again", async () => {
  // `run(func, criticalSection)` on the far side of the await. Without it the
  // resumption would run outside the gate entirely and the next storage call would
  // have no lock to hold.
  const { ctx } = newContext();
  const outbound = Promise.withResolvers<void>();

  const invocation = ctx.run(async () => {
    await ctx.awaitIo(outbound.promise);
    return currentSection(ctx);
  });

  outbound.resolve();
  expect(await invocation).toBeUndefined();
});

// =======================================================================================
// §1.7.1 — the transaction boundary is the gate boundary.

it("§1.7.1 consecutive storage awaits are one uninterrupted stretch", async () => {
  // Measured: `put(p1)` → await storage.get → `put(p2)` survives or dies as one unit,
  // because nothing else is delivered in between.
  const { ctx } = newContext();
  const order: string[] = [];
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();

  const writer = ctx.run(async () => {
    order.push("write:1");
    await ctx.awaitIoWithInputLock(first.promise);
    order.push("write:2");
    await ctx.awaitIoWithInputLock(second.promise);
    order.push("write:3");
  });
  const other = ctx.run(() => {
    order.push("other");
  });

  first.resolve();
  second.resolve();
  await Promise.all([writer, other]);
  expect(order).toEqual(["write:1", "write:2", "write:3", "other"]);
});

it("§1.7.1 an awaitIo between two storage awaits ends the stretch", async () => {
  // The other half of the same line: only an await that releases the gate is a
  // boundary. This is what decision 7 commits a transaction on.
  const { ctx } = newContext();
  const order: string[] = [];
  const storage = Promise.withResolvers<void>();
  const outbound = Promise.withResolvers<void>();

  const writer = ctx.run(async () => {
    order.push("write:1");
    await ctx.awaitIoWithInputLock(storage.promise);
    order.push("write:2");
    await ctx.awaitIo(outbound.promise);
    order.push("write:3");
  });
  const other = ctx.run(() => {
    order.push("other");
  });

  storage.resolve();
  await other;
  outbound.resolve();
  await writer;
  expect(order).toEqual(["write:1", "write:2", "other", "write:3"]);
});

// =======================================================================================
// Part 4, mechanic 1 — the ambient current lock is a stack, not a slot.
//
// Honest limit, established by mutating the implementation: replacing the stack with a
// single slot does not fail anything below, and cannot. `current()` is only ever read
// from inside a slice, every slice pushes its own lock last, and no second slice can
// start while a frame is still awaiting its checkpoint-end exit — the pending frame is
// holding the gate. So the top of the stack and the last write to a slot are always the
// same value. The stack is nonetheless what is implemented: it is the shape the mechanic
// was settled on, entries do reach depth three in this file, and a slot would already
// hold a stale value at those moments — invisible only for as long as the invariant
// above holds. What these two cases do pin is the part that IS observable: every
// coexisting lock is accounted for, and a reentry callback does not cost the enclosing
// body its own.

it("Part 4 mechanic 1 two held awaits from one invocation each resume under a lock of their own", async () => {
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const seen: (CriticalSection | "no-lock" | undefined)[] = [];

  const invocation = ctx.run(
    async () =>
      await Promise.all([
        ctx.awaitIoWithInputLock(first.promise, () => void seen.push(currentSection(ctx))),
        ctx.awaitIoWithInputLock(second.promise, () => void seen.push(currentSection(ctx))),
      ]),
  );

  first.resolve();
  second.resolve();
  await invocation;
  await quiesce();

  // Both resumptions ran under a lock of their own...
  expect(seen).toEqual([undefined, undefined]);
  // ...and both were handed back, so the gate is free and balanced.
  expect(counts.locked).toBe(counts.released);
  expect(await poll(actor.inputGate.wait())).toBe(true);
});

it("Part 4 mechanic 1 a reentry callback inside a critical section leaves the enclosing lock intact", async () => {
  // The scenario the mechanic is named for. Against the real io-gate the callback
  // cannot overlap the enclosing slice — `CriticalSection.wait()` queues behind an
  // outstanding lock — so what is asserted is the property, not the overlap: the
  // enclosing body still has a lock of its own to hold on its next storage call.
  const { ctx } = newContext();
  const trace: string[] = [];
  const storage = Promise.withResolvers<void>();

  const blocking = blockConcurrencyWhile(ctx, async () => {
    const reentry = ctx.makeReentryCallback((_lock: Lock) => {
      trace.push(`callback:${currentSection(ctx) === undefined ? "root" : "section"}`);
      return "callback";
    });
    expect(await reentry()).toBe("callback");
    // Back in the enclosing body, and still inside the section.
    return await ctx.awaitIoWithInputLock(storage.promise, () => {
      const section = currentSection(ctx);
      trace.push(`body:${section === "no-lock" ? "no-lock" : section === undefined ? "root" : "section"}`);
      return "body";
    });
  });

  storage.resolve();
  expect(await blocking).toBe("body");
  expect(trace).toEqual(["callback:section", "body:section"]);
});

// =======================================================================================
// Part 4, mechanic 2 — inheritance travels through makeReentryCallback, never gate state.

it("Part 4 mechanic 2 a NEW external event does not inherit a running critical section", async () => {
  // The event has to arrive WHILE the section runs, which is the only moment the two
  // designs differ: one that arrived earlier queues on the parent lock either way. If
  // `run()` recovered the section from gate state rather than taking it as an
  // argument, this one would find it, skip the queue, and blockConcurrencyWhile would
  // silently block nothing.
  //
  // It is handed out rather than returned, because a section whose result waits on an
  // event it is itself blocking is a genuine deadlock and not the subject here.
  const { ctx } = newContext();
  let marker = "init";
  const inside = Promise.withResolvers<void>();
  const external = Promise.withResolvers<Promise<void>>();

  const blocking = blockConcurrencyWhile(ctx, async () => {
    marker = "A";
    const other = ctx.run(() => {
      marker = "B";
    });
    external.resolve(other);
    expect(await poll(other)).toBe(false);

    await inside.promise;
    return marker;
  });

  inside.resolve();
  expect(await blocking).toBe("A");
  await (await external.promise);
  expect(marker).toBe("B");
});

it("decision 13 a reentry callback captured inside a critical section runs inside it", async () => {
  // The mirror image, and the reason inheritance exists at all: a child's boot calls
  // back into a parent that is inside blockConcurrencyWhile. A callback that failed to
  // carry the section would queue behind it and deadlock the body waiting on it.
  const { ctx } = newContext();
  const order: string[] = [];
  const inside = Promise.withResolvers<void>();

  const blocking = blockConcurrencyWhile(ctx, async () => {
    const reentry = ctx.makeReentryCallback((_lock: Lock, tag: string) => {
      order.push(`reentry:${tag}:${currentSection(ctx) === undefined ? "root" : "section"}`);
      return tag.toUpperCase();
    });

    expect(await reentry("a")).toBe("A");
    expect(await reentry("b")).toBe("B");
    await inside.promise;
    order.push("body:done");
    return "body";
  });

  inside.resolve();
  expect(await blocking).toBe("body");
  expect(order).toEqual(["reentry:a:section", "reentry:b:section", "body:done"]);
});

it("decision 13 makeReentryCallback must be created from inside a gated slice", async () => {
  // "A reentry callback is meant for *re-*entry": captured outside a slice there is
  // no section to capture, and a callback that silently captured none would be the
  // mechanic-2 bug wearing the right name.
  const { ctx } = newContext();
  expect(() => ctx.makeReentryCallback(() => "x")).toThrow("no input lock available in this context");
});

// =======================================================================================
// §1.5 / decision 4 — blockConcurrencyWhile.

it("§1.5 nested blockConcurrencyWhile nests rather than deadlocking", async () => {
  const { ctx } = newContext();
  // Only the outer call enters through the door: the inner one is already inside a
  // slice, which is the whole point — it nests on the lock it finds there.
  const result = await blockConcurrencyWhile(
    ctx,
    async () => await ctx.blockConcurrencyWhile(() => "nested-ok"),
  );
  expect(result).toBe("nested-ok");
});

it("§1.5 blockConcurrencyWhile times out at 30 seconds against the Timer port", async () => {
  const { ctx, timer, actor } = newContext();
  const onBroken = actor.inputGate.onBroken();
  const never = new Promise<string>(() => {});

  const blocking = blockConcurrencyWhile(ctx, () => never);
  await quiesce();
  expect(timer.pendingCount).toBe(1);

  timer.advance(29_999);
  expect(await poll(blocking)).toBe(false);

  timer.advance(1);
  await expect(onBroken).rejects.toThrow(BLOCK_CONCURRENCY_WHILE_TIMEOUT_MESSAGE);
  // The deadline is a failure like any other, so the returned promise stays unsettled.
  expect(await poll(blocking)).toBe(false);
});

it("§1.5 the deadline timer is cancelled when the callback wins", async () => {
  const { ctx, timer } = newContext();
  expect(await blockConcurrencyWhile(ctx, () => "fast")).toBe("fast");
  await quiesce();
  expect(timer.pendingCount).toBe(0);
});

it("§1.5 a failed critical section breaks the gate and never settles its promise", async () => {
  // "we don't even bother calling resolver.reject() because it's meaningless at this
  // point" — the actor is aborted instead, which is what the caller observes.
  const { ctx, actor } = newContext();
  const onBroken = actor.inputGate.onBroken();
  const onAbort = ctx.onAbort();

  const blocking = blockConcurrencyWhile(ctx, () => {
    throw new Error("boot failed");
  });

  await expect(onBroken).rejects.toThrow("boot failed");
  await expect(onAbort).rejects.toThrow("boot failed");
  expect(await poll(blocking)).toBe(false);
  // Every future wait rejects, forever.
  await expect(ctx.run(() => "later")).rejects.toThrow("boot failed");
});

it("§1.5 a failure is annotated broken.inputGateBroken exactly once", async () => {
  const { ctx, actor } = newContext();
  const onBroken = actor.inputGate.onBroken();

  const blocking = blockConcurrencyWhile(ctx, () => {
    throw new Error("boom");
  });

  expect(await poll(blocking)).toBe(false);
  await expect(onBroken).rejects.toThrow("broken.inputGateBroken; boom");
});

it("§1.5 an abandoned critical section hands its parent lock back", async () => {
  // Section 1 has no finalizer: `succeeded()` and `drop()` are the only two ways a
  // section returns the parent lock, and exactly one of them has to run on every
  // path — including the one where the callback throws.
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));

  const blocking = blockConcurrencyWhile(ctx, () => {
    throw new Error("boom");
  });

  expect(await poll(blocking)).toBe(false);
  await quiesce();

  expect(counts.locked).toBe(counts.released);
  expect(counts.waiterAdded).toBe(counts.waiterRemoved);
  // The gate is broken, not merely wedged: a wait rejects rather than hanging.
  await expect(actor.inputGate.wait()).rejects.toThrow("boom");
});

// =======================================================================================
// Lock accounting on the ordinary paths.

it("every lock taken by run(), awaitIo and awaitIoWithInputLock is released exactly once", async () => {
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));
  const storage = Promise.withResolvers<void>();
  const outbound = Promise.withResolvers<void>();

  const invocation = ctx.run(async () => {
    await ctx.awaitIoWithInputLock(storage.promise);
    await ctx.awaitIo(outbound.promise);
    return "done";
  });

  storage.resolve();
  await quiesce();
  outbound.resolve();
  expect(await invocation).toBe("done");
  await quiesce();

  expect(counts.locked).toBe(counts.released);
  expect(counts.waiterAdded).toBe(counts.waiterRemoved);
  expect(await poll(actor.inputGate.wait())).toBe(true);
});

it("a throwing slice releases its lock", async () => {
  // The `finally` is the only thing between a throwing invocation and a permanently
  // wedged gate.
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));

  await expect(
    ctx.run(() => {
      throw new Error("slice failed");
    }),
  ).rejects.toThrow("slice failed");
  await quiesce();

  expect(counts.locked).toBe(counts.released);
  expect(await poll(actor.inputGate.wait())).toBe(true);
});

it("a transform that throws rejects the caller and still releases the lock", async () => {
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));
  const storage = Promise.withResolvers<void>();

  const invocation = ctx.run(
    async () =>
      await ctx.awaitIoWithInputLock(storage.promise, (): string => {
        throw new Error("transform failed");
      }),
  );

  storage.resolve();
  await expect(invocation).rejects.toThrow("transform failed");
  await quiesce();

  expect(counts.locked).toBe(counts.released);
  expect(await poll(actor.inputGate.wait())).toBe(true);
});

it("a rejected I/O promise propagates and still releases the lock", async () => {
  const counts = newHookCounts();
  const { ctx, actor } = newContext(recordingInputGateHooks(counts));
  const storage = Promise.withResolvers<void>();

  const invocation = ctx.run(async () => await ctx.awaitIoWithInputLock(storage.promise));
  storage.reject(new Error("disk failed"));

  await expect(invocation).rejects.toThrow("disk failed");
  await quiesce();

  expect(counts.locked).toBe(counts.released);
  expect(await poll(actor.inputGate.wait())).toBe(true);
});

it("awaitIoWithInputLock outside a gated slice throws rather than inventing a lock", async () => {
  // ← `KJ_ASSERT_NONNULL(currentInputLock, "no input lock available in this context")`.
  // Silently taking a fresh lock here would turn a lost invocation into a lost
  // transaction boundary, which is the §1.7.1 failure nothing else detects.
  const { ctx } = newContext();
  await expect(ctx.awaitIoWithInputLock(Promise.resolve(1))).rejects.toThrow(
    "no input lock available in this context",
  );
});

// =======================================================================================
// §1.6 — the output gate, and abort.

it("§1.1 lockOutputWhile blocks waitForOutputLocks until the write confirms", async () => {
  const { ctx } = newContext();
  const flush = Promise.withResolvers<void>();

  expect(await poll(ctx.waitForOutputLocks())).toBe(true);
  const write = ctx.lockOutputWhile(flush.promise);
  const send = ctx.waitForOutputLocks();
  expect(await poll(send)).toBe(false);

  flush.resolve();
  await write;
  expect(await poll(send)).toBe(true);
  expect(ctx.isOutputGateBroken()).toBe(false);
});

it("§1.6 breaking either gate aborts the context and abandons scheduled writes", async () => {
  {
    const { ctx, actor } = newContext();
    const onAbort = ctx.onAbort();
    const lock = await actor.inputGate.wait();
    const cs = lock.startCriticalSection();
    lock.release();
    (await cs.wait()).release();
    cs.failed(new Error("input gate broke"));

    await expect(onAbort).rejects.toThrow("input gate broke");
    expect(actor.shutdownReasons).toHaveLength(1);
    cs.drop();
  }

  {
    const { ctx, actor } = newContext();
    const onAbort = ctx.onAbort();
    const flush = Promise.withResolvers<void>();
    const write = actor.outputGate.lockWhile(flush.promise);
    flush.reject(new Error("flush failed"));
    await expect(write).rejects.toThrow("flush failed");

    await expect(onAbort).rejects.toThrow("flush failed");
    expect(ctx.isOutputGateBroken()).toBe(true);
  }
});

it("§1.6 run() refuses to re-enter an aborted context", async () => {
  const { ctx } = newContext();
  ctx.abort(new Error("aborted by test"));

  await expect(ctx.run(() => "nope")).rejects.toThrow("aborted by test");
  // abort() is idempotent — the first reason wins.
  ctx.abort(new Error("second"));
  await expect(ctx.onAbort()).rejects.toThrow("aborted by test");
});

// =======================================================================================
// §1.9 — waitUntil touches neither gate.

it("§1.9 waitUntil tasks touch neither gate and drain independently", async () => {
  const { ctx, actor } = newContext();
  const background = Promise.withResolvers<void>();

  const before = ctx.taskCount();
  ctx.addWaitUntil(background.promise);
  expect(ctx.taskCount()).toBe(before);

  // Neither gate is held by the pending task.
  expect(await poll(actor.inputGate.wait())).toBe(true);
  expect(await poll(ctx.waitForOutputLocks())).toBe(true);

  const drained = ctx.drainWaitUntil();
  expect(await poll(drained)).toBe(false);
  background.resolve();
  expect(await poll(drained)).toBe(true);
});

it("§1.9 a failed waitUntil task is recorded rather than swallowed", async () => {
  const { ctx } = newContext();
  ctx.addWaitUntil(Promise.reject(new Error("background failed")));
  await ctx.drainWaitUntil();
  expect(ctx.waitUntilStatus()).toBeInstanceOf(Error);
  expect((ctx.waitUntilStatus() as Error).message).toBe("background failed");
});

it("§1.9 drainWaitUntil gives up when the context aborts", async () => {
  const { ctx } = newContext();
  ctx.addWaitUntil(new Promise<void>(() => {}));
  const drained = ctx.drainWaitUntil();
  expect(await poll(drained)).toBe(false);

  ctx.abort(new Error("shutting down"));
  expect(await poll(drained)).toBe(true);
});

it("addTask counts and, in an actor, is a waitUntil task", async () => {
  // "In Actors, we treat all tasks as wait-until tasks" — every context here is an
  // actor context, so the branch is unconditional.
  const { ctx } = newContext();
  const task = Promise.withResolvers<void>();

  expect(ctx.taskCount()).toBe(0);
  ctx.addTask(task.promise);
  expect(ctx.taskCount()).toBe(1);

  const drained = ctx.drainWaitUntil();
  expect(await poll(drained)).toBe(false);
  task.resolve();
  expect(await poll(drained)).toBe(true);
});


// =======================================================================================
// Timers
//
// Every case here is a claim about `IoContext::TimeoutManagerImpl`
// (`io-context.c++:40-140`, `:742-880`) — and the ones that matter are the two
// that make a timer different from `awaitIo`: the callback runs INSIDE a gated
// slice, and the critical section it carries is the one captured when it was
// armed.

/** What a callback can see about the gate it ran under. */
function observeGate(ctx: IoContext, log: (entry: string) => void): () => void {
  return () => {
    log(ctx.hasCurrent() ? "gated" : "UNGATED");
  };
}

it("§1.2 a setTimeout callback runs inside a gated slice", async () => {
  // The whole reason this exists. Upstream reaches the same place through
  // `context.run(cb, cs)` (`io-context.c++:759-760`), and a callback that ran outside
  // one would resume with an empty invocation stack — divergence 147.
  const { ctx, timer } = newContext();
  const seen: string[] = [];

  await ctx.run(() => {
    ctx.setTimeoutImpl(false, observeGate(ctx, (e) => seen.push(e)), 50);
  });
  expect(seen).toEqual([]);

  timer.advance(50);
  await quiesce();
  expect(seen).toEqual(["gated"]);
});

it("§1.2 a timer armed inside a critical section runs inside that section", async () => {
  // ← `cs = context.getCriticalSection()`, captured in the arming call and replayed at
  // `io-context.c++:816`. Without it the callback queues on the root gate behind the
  // section and cannot run until it ends — which is the difference this asserts.
  const { ctx, timer } = newContext();
  const seen: (CriticalSection | "no-lock" | undefined)[] = [];
  const release = Promise.withResolvers<void>();

  const section = blockConcurrencyWhile(ctx, async (lock) => {
    // Read synchronously: a `Lock` is released at the end of the slice that holds it, and
    // `getCriticalSection()` on a released one throws. That throw would fail the critical
    // section, and a failed one is never settled at all (§1.5) — so the mistake presents as a
    // hung test rather than as an assertion, which is worth knowing before making it.
    const own = lock.getCriticalSection();
    ctx.setTimeoutImpl(
      false,
      () => {
        seen.push(currentSection(ctx));
      },
      10,
    );
    await release.promise;
    return own;
  });

  await quiesce();
  timer.advance(10);
  await quiesce();

  // It ran while the section was still open, and under that same section.
  expect(seen).toHaveLength(1);
  release.resolve();
  expect(seen[0]).toBe(await section);
});

it("clearTimeout before the deadline stops the callback and frees the entry", async () => {
  // ← `TimeoutManagerImpl::clearTimeout` (`io-context.c++:874-883`).
  const { ctx, timer } = newContext();
  const seen: string[] = [];

  await ctx.run(() => {
    const id = ctx.setTimeoutImpl(false, observeGate(ctx, (e) => seen.push(e)), 50);
    expect(ctx.getTimeoutCount()).toBe(1);
    ctx.clearTimeoutImpl(id);
    expect(ctx.getTimeoutCount()).toBe(0);
  });

  timer.advance(50);
  await quiesce();
  expect(seen).toEqual([]);
  // A cancelled wake is a cancellation, not a background failure.
  expect(ctx.waitUntilStatus()).toBeUndefined();
});

it("clearTimeout for an unknown id is a no-op", async () => {
  // "We can't find this timeout, thus we act as if it was already canceled."
  const { ctx } = newContext();
  await ctx.run(() => {
    expect(() => ctx.clearTimeoutImpl(9999)).not.toThrow();
  });
});

it("a non-repeating timeout releases its entry once it has fired", async () => {
  const { ctx, timer } = newContext();
  await ctx.run(() => {
    ctx.setTimeoutImpl(false, () => {}, 10);
  });
  expect(ctx.getTimeoutCount()).toBe(1);

  timer.advance(10);
  await quiesce();
  expect(ctx.getTimeoutCount()).toBe(0);
});

it("setInterval repeats, each tick gated, until it is cleared", async () => {
  const { ctx, timer } = newContext();
  const seen: string[] = [];
  let id = 0;

  await ctx.run(() => {
    id = ctx.setTimeoutImpl(true, observeGate(ctx, (e) => seen.push(e)), 10);
  });

  for (let tick = 0; tick < 3; tick++) {
    timer.advance(10);
    await quiesce();
  }
  expect(seen).toEqual(["gated", "gated", "gated"]);

  ctx.clearTimeoutImpl(id);
  timer.advance(10);
  await quiesce();
  expect(seen).toHaveLength(3);
  expect(ctx.getTimeoutCount()).toBe(0);
});

it("clearInterval from inside the callback stops it, and the entry is still there to find", async () => {
  // ← "First, move our timeout promise to the task set so it's safe to call
  // clearInterval() inside the user's callback." The entry survives the tick precisely
  // so that this lookup succeeds.
  const { ctx, timer } = newContext();
  let ticks = 0;
  let id = 0;

  await ctx.run(() => {
    id = ctx.setTimeoutImpl(
      true,
      () => {
        ticks += 1;
        if (ticks === 2) ctx.clearTimeoutImpl(id);
      },
      10,
    );
  });

  for (let tick = 0; tick < 4; tick++) {
    timer.advance(10);
    await quiesce();
  }
  expect(ticks).toBe(2);
  expect(ctx.getTimeoutCount()).toBe(0);
});

it("an interval whose callback throws is still rescheduled, and the throw is reported", async () => {
  // ← the `KJ_DEFER(unwindDetector.catchExceptionsIfUnwinding(...))`: "The user's
  // callback might throw, but we need to at least attempt to reschedule interval
  // callbacks even if they throw." Upstream then swallows; this records it in
  // `waitUntilStatus()`, which is the recorded divergence.
  const { ctx, timer } = newContext();
  let ticks = 0;

  await ctx.run(() => {
    ctx.setTimeoutImpl(
      true,
      () => {
        ticks += 1;
        throw new Error(`tick ${ticks} failed`);
      },
      10,
    );
  });

  timer.advance(10);
  await quiesce();
  timer.advance(10);
  await quiesce();

  expect(ticks).toBe(2);
  expect((ctx.waitUntilStatus() as Error).message).toBe("tick 1 failed");
});

it("the delay is clamped to [0, 100 years] and NaN becomes 0", async () => {
  // ← `IoContext::setTimeoutImpl`'s clamp (`io-context.c++:886-893`), including
  // `TimeoutParameters`' own "Don't allow pushing Date.now() backwards!".
  const { ctx, timer } = newContext();
  const seen: number[] = [];

  await ctx.run(() => {
    ctx.setTimeoutImpl(false, () => seen.push(1), -5_000);
    ctx.setTimeoutImpl(false, () => seen.push(2), Number.NaN);
    ctx.setTimeoutImpl(false, () => seen.push(3), Number.POSITIVE_INFINITY);
  });

  timer.advance(0);
  await quiesce();
  expect(seen).toEqual([1, 2]);

  timer.advance(3_153_600_000_000);
  await quiesce();
  expect(seen).toEqual([1, 2, 3]);
});

it("§1.9 drainWaitUntil waits for an outstanding timer", async () => {
  // ← "Add a wait-until task which resolves when this timer completes. This ensures
  // that `IncomingRequest::drain()` waits until all timers finish."
  const { ctx, timer } = newContext();
  await ctx.run(() => {
    ctx.setTimeoutImpl(false, () => {}, 50);
  });

  const drained = ctx.drainWaitUntil();
  expect(await poll(drained)).toBe(false);
  timer.advance(50);
  expect(await poll(drained)).toBe(true);
});

it("§1.6 abort cancels every outstanding timer rather than waking into a dead context", async () => {
  // ← `timeoutManager->cancelAll()` in `~IoContext_IncomingRequest`, plus the
  // `abortException == kj::none` guard at `io-context.c++:832`. Without it a pending
  // timer wakes into `run()`, which refuses an aborted context, and the refusal lands
  // in `waitUntilStatus()` as a failure nobody caused.
  const { ctx, timer } = newContext();
  const seen: string[] = [];

  await ctx.run(() => {
    ctx.setTimeoutImpl(false, () => seen.push("fired"), 50);
  });
  expect(ctx.getTimeoutCount()).toBe(1);

  ctx.abort(new Error("gone"));
  expect(ctx.getTimeoutCount()).toBe(0);

  timer.advance(50);
  await quiesce();
  expect(seen).toEqual([]);
  expect(ctx.waitUntilStatus()).toBeUndefined();
});

it("a timer port that fails for a reason nobody asked for is reported", async () => {
  // The other half of the cancellation branch: only a wake this manager itself aborted
  // is consumed. A substrate that cannot keep time must not look like a cleared timer.
  const { ctx } = newContext();
  const broken: Timer = {
    now: () => 0,
    afterDelay: () => Promise.reject(new Error("the clock stopped")),
  };
  const brokenCtx = new IoContext(new TestActor(), broken);

  await brokenCtx.run(() => {
    brokenCtx.setTimeoutImpl(false, () => {}, 10);
  });
  await quiesce();
  expect((brokenCtx.waitUntilStatus() as Error).message).toBe("the clock stopped");
  void ctx;
});

// =======================================================================================
// `IoContext::current()`, narrowed — the tripwire's input

it("isCurrentSlice is true only while a synchronous body of this context is running", async () => {
  // ← `IoContext::isCurrent()` (`io-context.c++:1428-1430`). The scope is narrower than
  // upstream's on purpose (see `currentSlice`), and this pins exactly how much narrower:
  // set inside the body, gone the moment it returns.
  const { ctx } = newContext();
  const seen: boolean[] = [];

  expect(ctx.isCurrentSlice()).toBe(false);
  await ctx.run(() => {
    seen.push(ctx.isCurrentSlice());
  });
  expect(ctx.isCurrentSlice()).toBe(false);
  expect(seen).toEqual([true]);
});

it("isCurrentSlice distinguishes two contexts in one realm", async () => {
  // The whole point: two actors share a realm here, where upstream would have two
  // isolates. A global bound to one has to be able to tell it is being called by the
  // other — see `requireOwnSlice` in `api/global-scope.ts`.
  const first = newContext().ctx;
  const second = newContext().ctx;
  const seen: string[] = [];

  await first.run(() => {
    seen.push(first.isCurrentSlice() ? "first:self" : "first:other");
    seen.push(second.isCurrentSlice() ? "second:self" : "second:other");
  });
  expect(seen).toEqual(["first:self", "second:other"]);
});

it("a second context's slice cannot leave the ambient pointing at it", async () => {
  // ← `SuppressIoContextScope previousRequest`, which upstream needs because
  // `runInContextScope` genuinely nests — "especially to support destructors". It cannot
  // nest here: `run()` awaits the gate, so a slice started from inside another's body
  // begins after that body has returned. The save/restore is kept as upstream's rather
  // than simplified to a clear, and what IS observable is that the ambient never gets
  // stuck: an inner slice sees only itself, and nothing is current afterwards.
  const { ctx } = newContext();
  const other = newContext().ctx;
  const seen: string[] = [];

  await ctx.run(() => {
    seen.push(`outer:${String(ctx.isCurrentSlice())}`);
    void other.run(() => {
      seen.push(`inner-sees-outer:${String(ctx.isCurrentSlice())}`);
      seen.push(`inner-sees-self:${String(other.isCurrentSlice())}`);
    });
    seen.push(`outer-after-starting-inner:${String(ctx.isCurrentSlice())}`);
  });
  await quiesce();

  expect(seen).toEqual([
    "outer:true",
    "outer-after-starting-inner:true",
    "inner-sees-outer:false",
    "inner-sees-self:true",
  ]);
  expect(ctx.isCurrentSlice()).toBe(false);
  expect(other.isCurrentSlice()).toBe(false);
});
