/**
 * ← workerd `src/workerd/io/io-gate-test.c++`
 *
 * All twelve `KJ_TEST` cases, name for name, so the correspondence is greppable.
 * Three translations run through every one of them:
 *
 *  - `kj::Own<Lock>` releases on destruction. Every `{ auto drop = kj::mv(x); }`
 *    and every scope exit becomes an explicit `x.release()`.
 *  - kj cancels a promise by dropping it. Every drop becomes an `AbortSignal`,
 *    matching the convention `Timer.afterDelay` already set in `io-context.ts`.
 *  - `promise.poll(ws)` becomes `poll(promise)` — see the comment on the helper
 *    for what that does and does not prove.
 *
 * Anything below the second banner has no upstream test. It covers behaviour
 * upstream only exercises from `io-context.h`, which is Section 2.
 */

import { expect, it, vi } from "vitest";
import {
  CanceledError,
  CriticalSection,
  InputGate,
  type InputGateHooks,
  type Lock,
  makeReentryCallback,
  OutputGate,
  type OutputGateHooks,
} from "./io-gate";

/**
 * ← `kj::Promise::poll(waitScope)`.
 *
 * kj's `poll()` runs the event loop until it can make no further progress
 * without waiting on external I/O, then reports whether the promise is done.
 * The JS equivalent is to yield once to the macrotask queue: every microtask
 * scheduled so far — including chains a microtask itself schedules — runs to
 * completion before a timer callback does.
 *
 * What that proves: the promise cannot settle without something *outside* this
 * module resolving first. `io-gate.ts` uses no timers, no I/O and no macrotask
 * of its own, so for this file "did not settle by the next macrotask" is
 * exactly "is blocked on a lock". What it does not prove: anything about a
 * module that does schedule its own macrotasks — a helper here would need more
 * turns, and the honest fix is more turns, not a longer timeout.
 *
 * Polling also attaches handlers, so a rejected promise stops counting as
 * unhandled. That is deliberate: upstream polls rejected promises before
 * asserting on them, and so do we.
 */
async function poll(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  return settled;
}

/** ← `kj::Promise<void>(kj::NEVER_DONE)`. */
function neverDone(): Promise<void> {
  return new Promise<void>(() => {});
}

/**
 * Counting hooks.
 *
 * The hooks are the one part of the gates with no observable effect on the gate itself, which is
 * exactly why they need counting: a miscounted hook is invisible to every other test in this
 * file. Both gates promise the same invariant — each pair balances, and neither half fires twice
 * for one lock or one waiter.
 */
interface HookCounts {
  locked: number;
  released: number;
  waiterAdded: number;
  waiterRemoved: number;
}

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

function recordingOutputGateHooks(counts: HookCounts): OutputGateHooks {
  return {
    makeTimeoutPromise: () => new Promise<never>(() => {}),
    outputGateLocked: () => void counts.locked++,
    outputGateReleased: () => void counts.released++,
    outputGateWaiterAdded: () => void counts.waiterAdded++,
    outputGateWaiterRemoved: () => void counts.waiterRemoved++,
  };
}

it("InputGate basics", async () => {
  const gate = new InputGate();

  const cancelPromise3 = new AbortController();
  const promise1 = gate.wait();
  const promise2 = gate.wait();
  const promise3 = gate.wait(cancelPromise3.signal);

  expect(await poll(promise1)).toBe(true);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  {
    const lock = await promise1;

    expect(await poll(promise2)).toBe(false);
    expect(await poll(promise3)).toBe(false);

    const lock2 = lock.addRef();
    lock.release();

    expect(await poll(promise2)).toBe(false);
    expect(await poll(promise3)).toBe(false);

    lock2.release();
  }

  expect(await poll(promise2)).toBe(true);
  expect(await poll(promise3)).toBe(false); // we'll cancel this waiter to make sure that works

  expect(await poll(gate.onBroken())).toBe(false);

  cancelPromise3.abort();
  await expect(promise3).rejects.toBeInstanceOf(CanceledError);
  (await promise2).release();
});

it("InputGate critical section", async () => {
  const gate = new InputGate();

  let cs: CriticalSection;

  {
    const lock = await gate.wait();
    cs = lock.startCriticalSection();
    lock.release();
  }

  {
    // Take the first lock.
    const firstLock = await cs.wait();

    // Other locks are blocked.
    const wait1 = cs.wait();
    const wait2 = cs.wait();
    expect(await poll(wait1)).toBe(false);
    expect(await poll(wait2)).toBe(false);

    // Drop it.
    firstLock.release();

    // Now other locks make progress.
    {
      const lock = await wait1;
      expect(await poll(wait2)).toBe(false);
      lock.release();
    }
    (await wait2).release();
  }

  // Can't lock the top-level gate while CriticalSection still exists.
  const outerWait = gate.wait();
  expect(await poll(outerWait)).toBe(false);

  {
    const lock = await cs.wait();
    cs.succeeded().release();
    expect(await poll(outerWait)).toBe(false);
    lock.release();
  }

  (await outerWait).release();
});

it("InputGate multiple critical sections start together", async () => {
  const gate = new InputGate();

  let cs1: CriticalSection;
  let cs2: CriticalSection;

  {
    const lock = await gate.wait();
    cs1 = lock.startCriticalSection();
    cs2 = lock.startCriticalSection();
    lock.release();
  }

  // Start cs1.
  (await cs1.wait()).release();

  // Can't start cs2 yet.
  const cs2Wait = cs2.wait();
  expect(await poll(cs2Wait)).toBe(false);

  cs1.succeeded().release();

  (await cs2Wait).release();
});

it("InputGate nested critical sections", async () => {
  const gate = new InputGate();

  let cs1: CriticalSection;
  let cs2: CriticalSection;

  {
    const lock = await gate.wait();
    cs1 = lock.startCriticalSection();
    lock.release();
  }

  {
    const lock = await cs1.wait();
    cs2 = lock.startCriticalSection();
    lock.release();
  }

  // Start cs2.
  (await cs2.wait()).release();

  // Can't start new tasks in cs1 until cs2 finishes.
  const cs1Wait = cs1.wait();
  expect(await poll(cs1Wait)).toBe(false);

  cs2.succeeded().release();

  (await cs1Wait).release();
});

it("InputGate nested critical section outlives parent", async () => {
  const gate = new InputGate();

  let cs1: CriticalSection;
  let cs2: CriticalSection;

  {
    const lock = await gate.wait();
    cs1 = lock.startCriticalSection();
    lock.release();
  }

  {
    const lock = await cs1.wait();
    cs2 = lock.startCriticalSection();
    lock.release();
  }

  // Start cs2.
  (await cs2.wait()).release();

  // Mark cs1 done. (Note that, in a real program, this probably can't happen like this, because a
  // lock would be taken on cs1 before marking it done, and that lock would wait for cs2 to
  // finish. But I want to make sure it works anyway.)
  cs1.succeeded().release();

  // Can't start new tasks in at root until cs2 finishes.
  const rootWait = gate.wait();
  expect(await poll(rootWait)).toBe(false);

  cs2.succeeded().release();

  (await rootWait).release();
});

it("InputGate deeply nested critical sections", async () => {
  const gate = new InputGate();

  let cs1: CriticalSection;
  let cs2: CriticalSection;
  let cs3: CriticalSection;
  let cs4: CriticalSection;

  {
    const lock = await gate.wait();
    cs1 = lock.startCriticalSection();
    lock.release();
  }

  {
    const lock = await cs1.wait();
    cs2 = lock.startCriticalSection();
    lock.release();
  }

  {
    const lock = await cs2.wait();
    cs3 = lock.startCriticalSection();
    cs4 = lock.startCriticalSection();
    lock.release();
  }

  // Start cs2
  (await cs2.wait()).release();

  // Add some waiters to cs2, some of which are waiting to start more nested critical sections
  const lock = await cs2.wait();
  const cancelWaiter1 = new AbortController();
  const cancelWaiter2 = new AbortController();
  const waiter1 = cs2.wait(cancelWaiter1.signal);
  const waiter2 = cs2.wait(cancelWaiter2.signal);

  // Both of these wait on cs2 indirectly, as they are nested under cs2
  const cancelWaiter4 = new AbortController();
  const waiter3 = cs3.wait();
  const waiter4 = cs4.wait(cancelWaiter4.signal);

  expect(await poll(waiter1)).toBe(false);
  expect(await poll(waiter2)).toBe(false);
  expect(await poll(waiter3)).toBe(false);
  expect(await poll(waiter4)).toBe(false);

  // Mark cs2 as complete with outstanding waiters, and drop our reference to it.
  cs2.succeeded().release();

  // Our waiters should still be outstanding as we have not released the lock
  expect(await poll(waiter1)).toBe(false);
  expect(await poll(waiter2)).toBe(false);
  expect(await poll(waiter3)).toBe(false);
  expect(await poll(waiter4)).toBe(false);

  // Drop some outstanding waiters
  cancelWaiter2.abort();
  cancelWaiter4.abort();
  await expect(waiter2).rejects.toBeInstanceOf(CanceledError);
  await expect(waiter4).rejects.toBeInstanceOf(CanceledError);

  // Release the lock on cs2
  lock.release();

  // cs3 should have started
  expect(await poll(waiter1)).toBe(false);
  expect(await poll(waiter3)).toBe(true);
  const lock2 = await waiter3;

  // Add a waiter on cs3
  const cancelWaiter5 = new AbortController();
  const waiter5 = cs3.wait(cancelWaiter5.signal);
  expect(await poll(waiter5)).toBe(false);

  // Can't start new tasks on the root until both cs1 and cs3 have succeeded, and all outstanding
  // tasks have either been dropped or completed.
  const waiter6 = gate.wait();
  expect(await poll(waiter6)).toBe(false);

  cs1.succeeded().release();
  cs3.succeeded().release();

  // drop waiter5
  cancelWaiter5.abort();
  await expect(waiter5).rejects.toBeInstanceOf(CanceledError);

  // Release the lock on cs3
  lock2.release();

  // Our root task should be ready now.
  expect(await poll(waiter6)).toBe(true);
  (await waiter6).release();

  // Releasing waiter6's lock hands the gate to waiter1, which is the evidence that it was
  // reparented onto the root behind waiter6 rather than dropped with cs2. Upstream's scope exit
  // does the same thing; it just never looks.
  expect(await poll(waiter1)).toBe(true);
  (await waiter1).release();

  // Cancelling a waiter that already settled is the no-op that dropping a settled promise is.
  cancelWaiter1.abort();
  cs4.drop();
});

it("InputGate critical section lock outlives critical section", async () => {
  const gate = new InputGate();

  let cs: CriticalSection;

  {
    const lock = await gate.wait();
    cs = lock.startCriticalSection();
    lock.release();
  }

  // Start critical section.
  const lock = await cs.wait();
  expect(lock.isFor(gate)).toBe(true);

  // Mark it done, even though a lock is still outstanding.
  cs.succeeded().release();

  // Lock should have been reparented, so should still work.
  expect(lock.isFor(gate)).toBe(true);

  // Adding a ref and dropping it shouldn't cause trouble.
  lock.addRef().release();

  // The gate should still be locked
  const waiter = gate.wait();
  expect(await poll(waiter)).toBe(false);

  // Drop the outstanding lock
  lock.release();

  // Our waiter should resolve now
  expect(await poll(waiter)).toBe(true);
  const waiterLock = await waiter;
  expect(waiterLock.isFor(gate)).toBe(true);
  waiterLock.release();
});

it("InputGate broken", async () => {
  const gate = new InputGate();

  const brokenPromise = gate.onBroken();

  let cs1: CriticalSection;
  let cs2: CriticalSection;
  let cs3: CriticalSection;

  {
    const lock = await gate.wait();
    cs1 = lock.startCriticalSection();
    cs3 = lock.startCriticalSection();
    lock.release();
  }

  {
    const lock = await cs1.wait();
    cs2 = lock.startCriticalSection();
    lock.release();
  }

  // start cs2
  (await cs2.wait()).release();

  const cs1Wait = cs1.wait();
  expect(await poll(cs1Wait)).toBe(false);

  const cs3Wait = cs3.wait();
  expect(await poll(cs3Wait)).toBe(false);

  const rootWait = gate.wait();
  expect(await poll(rootWait)).toBe(false);

  cs2.failed(new Error("foobar"));

  await expect(cs1Wait).rejects.toThrow("foobar");
  await expect(cs3Wait).rejects.toThrow("foobar");
  await expect(rootWait).rejects.toThrow("foobar");
  await expect(cs2.wait()).rejects.toThrow("foobar");
  await expect(brokenPromise).rejects.toThrow("foobar");
  await expect(gate.onBroken()).rejects.toThrow("foobar");
});

// =======================================================================================

it("OutputGate basics", async () => {
  const gate = new OutputGate();

  expect(await poll(gate.wait())).toBe(true);

  const paf1 = Promise.withResolvers<void>();
  const blocker1 = gate.lockWhile(paf1.promise);

  const promise1 = gate.wait();
  const promise2 = gate.wait();

  const paf2 = Promise.withResolvers<void>();
  const blocker2 = gate.lockWhile(paf2.promise);

  const promise3 = gate.wait();

  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  expect(await poll(blocker1)).toBe(false);
  paf1.resolve();
  expect(await poll(blocker1)).toBe(true);
  await blocker1;

  expect(await poll(promise1)).toBe(true);
  await promise1;
  expect(await poll(promise2)).toBe(true);
  await promise2;
  expect(await poll(promise3)).toBe(false);

  expect(await poll(blocker2)).toBe(false);
  paf2.resolve();
  expect(await poll(blocker2)).toBe(true);
  await blocker2;

  expect(await poll(promise3)).toBe(true);
  await promise3;

  expect(await poll(gate.onBroken())).toBe(false);
});

it("OutputGate out-of-order", async () => {
  const gate = new OutputGate();

  expect(await poll(gate.wait())).toBe(true);

  const paf1 = Promise.withResolvers<void>();
  const blocker1 = gate.lockWhile(paf1.promise);

  const promise1 = gate.wait();
  const promise2 = gate.wait();

  const paf2 = Promise.withResolvers<void>();
  const blocker2 = gate.lockWhile(paf2.promise);

  const promise3 = gate.wait();

  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // Fulfill second blocker first.
  expect(await poll(blocker2)).toBe(false);
  paf2.resolve();
  expect(await poll(blocker2)).toBe(true);
  await blocker2;

  // Everything is still blocked.
  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // Fulfill the first one.
  expect(await poll(blocker1)).toBe(false);
  paf1.resolve();
  expect(await poll(blocker1)).toBe(true);
  await blocker1;

  // Everything unblocked.
  expect(await poll(promise1)).toBe(true);
  await promise1;
  expect(await poll(promise2)).toBe(true);
  await promise2;
  expect(await poll(promise3)).toBe(true);
  await promise3;

  expect(await poll(gate.onBroken())).toBe(false);
});

it("OutputGate exception", async () => {
  const gate = new OutputGate();
  let onBroken = gate.onBroken();

  expect(await poll(gate.wait())).toBe(true);

  const paf1 = Promise.withResolvers<void>();
  const blocker1 = gate.lockWhile(paf1.promise);

  const promise1 = gate.wait();
  const promise2 = gate.wait();

  const paf2 = Promise.withResolvers<void>();
  const blocker2 = gate.lockWhile(paf2.promise);

  const promise3 = gate.wait();

  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // Let's have the second blocker fail first.
  paf2.reject(new Error("foo"));
  expect(await poll(blocker2)).toBe(true);
  await expect(blocker2).rejects.toThrow("foo");

  // Promises are all still waiting. TECHNICALLY, it would be OK to fail-fast the third promise,
  // but for now we don't.
  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // We are marked broken at this point, though.
  expect(await poll(onBroken)).toBe(true);
  await expect(onBroken).rejects.toThrow("foo");

  // Fulfill the first blocker (normally, not with an exception).
  expect(await poll(blocker1)).toBe(false);
  paf1.resolve();
  expect(await poll(blocker1)).toBe(true);
  await blocker1;

  // Everything unblocked, but only the third promise fails.
  expect(await poll(promise1)).toBe(true);
  await promise1;
  expect(await poll(promise2)).toBe(true);
  await promise2;
  expect(await poll(promise3)).toBe(true);
  await expect(promise3).rejects.toThrow("foo");

  // Still broken.
  onBroken = gate.onBroken();
  expect(await poll(onBroken)).toBe(true);
  await expect(onBroken).rejects.toThrow("foo");
});

it("OutputGate canceled", async () => {
  const gate = new OutputGate();
  let onBroken = gate.onBroken();

  expect(await poll(gate.wait())).toBe(true);

  const paf1 = Promise.withResolvers<void>();
  const blocker1 = gate.lockWhile(paf1.promise);

  const promise1 = gate.wait();
  const promise2 = gate.wait();

  const cancelBlocker2 = new AbortController();
  const blocker2 = gate.lockWhile(neverDone(), cancelBlocker2.signal);

  const promise3 = gate.wait();

  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // Let's cancel the second blocker first.
  cancelBlocker2.abort();

  // Upstream drops `blocker2` here and never observes its outcome. A JS promise
  // has to settle with something, and a never-settling one is an invisible hang,
  // so the cancellation exception propagates to it too.
  await expect(blocker2).rejects.toThrow("output lock was canceled before completion");

  // Promises are all still waiting. TECHNICALLY, it would be OK to fail-fast the third promise,
  // but for now we don't.
  expect(await poll(promise1)).toBe(false);
  expect(await poll(promise2)).toBe(false);
  expect(await poll(promise3)).toBe(false);

  // We are marked broken at this point, though.
  expect(await poll(onBroken)).toBe(true);
  await expect(onBroken).rejects.toThrow("output lock was canceled before completion");

  // Fulfill the first blocker (normally, not with an exception).
  expect(await poll(blocker1)).toBe(false);
  paf1.resolve();
  expect(await poll(blocker1)).toBe(true);
  await blocker1;

  // Everything unblocked, but only the third promise fails.
  expect(await poll(promise1)).toBe(true);
  await promise1;
  expect(await poll(promise2)).toBe(true);
  await promise2;
  expect(await poll(promise3)).toBe(true);
  await expect(promise3).rejects.toThrow("output lock was canceled before completion");

  // Still broken.
  onBroken = gate.onBroken();
  expect(await poll(onBroken)).toBe(true);
  await expect(onBroken).rejects.toThrow("output lock was canceled before completion");
});

// =======================================================================================
// No upstream test. `~CriticalSection` and `makeReentryCallback` are exercised from
// io-context.h upstream, which is Section 2 here; these cover the io-gate half.

it("dropping a running critical section is diagnosed as deadlock", async () => {
  // §1.5 quotes this string, and `~CriticalSection` is the only thing that
  // produces it. In JS the destructor is `drop()`.
  const gate = new InputGate();
  const onBroken = gate.onBroken();

  const lock = await gate.wait();
  const cs = lock.startCriticalSection();
  lock.release();

  (await cs.wait()).release();
  cs.drop();

  await expect(onBroken).rejects.toThrow(
    "A critical section within this Durable Object awaited a Promise that apparently will " +
      "never complete.",
  );
  await expect(gate.wait()).rejects.toThrow("leads to deadlock");
});

it("a wait cancelled before it starts leaves the gate untouched", async () => {
  // `addEventListener("abort", ...)` does not fire for a signal that already aborted, so without
  // an explicit check a pre-aborted wait would take a lock nothing ever releases. Every arm has
  // to reject before it touches gate state — including the uncontended fast paths, which are the
  // ones that hand back a Lock synchronously.
  const gate = new InputGate();
  const aborted = AbortSignal.abort();

  await expect(gate.wait(aborted)).rejects.toBeInstanceOf(CanceledError);

  const lock = await gate.wait();
  const cs = lock.startCriticalSection();
  lock.release();
  await expect(cs.wait(aborted)).rejects.toBeInstanceOf(CanceledError);

  // Neither rejection left a lock behind, so the gate still hands one out.
  (await gate.wait()).release();

  // And an output lock cancelled before it starts still breaks the gate.
  const outputGate = new OutputGate();
  const onBroken = outputGate.onBroken();
  await expect(outputGate.lockWhile(neverDone(), aborted)).rejects.toThrow(
    "output lock was canceled before completion",
  );
  await expect(onBroken).rejects.toThrow("output lock was canceled before completion");
});

it("a reentry callback inherits the critical section it was captured in", async () => {
  const gate = new InputGate();

  const outer = await gate.wait();
  const cs = outer.startCriticalSection();
  outer.release();

  const csLock = await cs.wait();
  const seen: string[] = [];
  const reentry = makeReentryCallback(gate, csLock.getCriticalSection(), (_lock: Lock, n: number) => {
    seen.push(`ran:${n}`);
    return n * 2;
  });
  csLock.release();

  // An ordinary external event queues behind the critical section...
  const external = gate.wait();
  expect(await poll(external)).toBe(false);

  // ...while the inherited callback runs inside it, more than once.
  expect(await reentry(21)).toBe(42);
  expect(await reentry(1)).toBe(2);
  expect(seen).toEqual(["ran:21", "ran:1"]);
  expect(await poll(external)).toBe(false);

  cs.succeeded().release();
  expect(await poll(external)).toBe(true);
  (await external).release();
});

it("a reentry callback with no captured section queues like any other event", async () => {
  // The failure mode Part 4 names: if inheritance were read from gate state
  // rather than captured, this would skip the queue and blockConcurrencyWhile
  // would block nothing.
  const gate = new InputGate();

  const outer = await gate.wait();
  const cs = outer.startCriticalSection();
  outer.release();
  (await cs.wait()).release();

  const notInherited = makeReentryCallback(gate, undefined, () => "ran");
  const pending = notInherited();
  expect(await poll(pending)).toBe(false);

  cs.succeeded().release();
  expect(await pending).toBe("ran");
});

it("InputGate hooks balance across fulfilled, cancelled and broken waiters", async () => {
  // Fulfilled. `inputGateLocked`/`Released` are edge-triggered on the 0↔1 boundary, not once per
  // Lock, so handing the gate from one holder to the next counts a release and a fresh lock —
  // while a second, concurrent Lock over the same held gate counts nothing. `addRef` is the only
  // way to hold two at once, and without it the two readings are indistinguishable.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const first = await gate.wait();
    const second = first.addRef();
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const queued = gate.wait(controller.signal);
    expect(counts).toEqual({ locked: 1, released: 0, waiterAdded: 1, waiterRemoved: 0 });

    first.release();
    expect(await poll(queued)).toBe(false);
    expect(counts).toEqual({ locked: 1, released: 0, waiterAdded: 1, waiterRemoved: 0 });

    second.release();
    (await queued).release();
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(counts).toEqual({ locked: 2, released: 2, waiterAdded: 1, waiterRemoved: 1 });
  }

  // Cancelled, both while queued and before the wait ever starts. A pre-aborted wait never
  // reaches the waiter list at all, so it must not count an add.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const holder = await gate.wait();
    const controller = new AbortController();
    const cancelled = gate.wait(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(CanceledError);
    // Aborting again must not count a second removal.
    controller.abort();

    await expect(gate.wait(AbortSignal.abort())).rejects.toBeInstanceOf(CanceledError);

    holder.release();
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 1, waiterRemoved: 1 });
  }

  // Broken. A rejected waiter is still a removed waiter. The lock pair deliberately does NOT
  // balance while the failed section is still alive: it holds a parent lock it will never hand
  // back through `succeeded()`, which is what "permanently breaks the input gate" means. It
  // hands it back when it is destroyed, and `drop()` is that destruction — so the two halves of
  // this scenario are the contrast between a failed section and a dropped one.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const lock = await gate.wait();
    const cs = lock.startCriticalSection();
    lock.release();
    (await cs.wait()).release();

    const doomed = gate.wait();
    cs.failed(new Error("boom"));
    await expect(doomed).rejects.toThrow("boom");

    expect(counts.waiterAdded).toBe(counts.waiterRemoved);
    expect(counts.waiterAdded).toBe(1);
    expect(counts.locked - counts.released).toBe(1);

    cs.drop();
    expect(counts).toEqual({ locked: 2, released: 2, waiterAdded: 1, waiterRemoved: 1 });

    // A destructor runs once. Dropping again must not release a second time.
    cs.drop();
    expect(counts).toEqual({ locked: 2, released: 2, waiterAdded: 1, waiterRemoved: 1 });
  }
});

it("drop() hands back a parent lock only in the arm that can still hold one", async () => {
  // `~CriticalSection` is the switch body followed by the destruction of its `parentLock`
  // member, so every arm has to be checked for one, not just the arm with a body.

  // NOT_STARTED: `wait()` was never called, so no lock was ever taken.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const lock = await gate.wait();
    lock.startCriticalSection().drop();
    lock.release();
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 0, waiterRemoved: 0 });
  }

  // INITIAL_WAIT: the initial wait was cancelled before it ever produced a lock.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const holder = await gate.wait();
    const cs = holder.startCriticalSection();
    const controller = new AbortController();
    const starting = cs.wait(controller.signal);
    controller.abort();
    await expect(starting).rejects.toBeInstanceOf(CanceledError);

    cs.drop();
    holder.release();
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 1, waiterRemoved: 1 });
  }

  // REPARENTED: `succeeded()` already returned the lock and cleared the field.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const lock = await gate.wait();
    const cs = lock.startCriticalSection();
    lock.release();
    (await cs.wait()).release();
    cs.succeeded().release();

    cs.drop();
    expect(counts).toEqual({ locked: 2, released: 2, waiterAdded: 0, waiterRemoved: 0 });
  }

  // RUNNING without a lock: `wait()`'s catch arm sets the state before it assigns one, so a
  // section broken during its initial wait ends up RUNNING and empty. Releasing
  // unconditionally would throw here.
  {
    const counts = newHookCounts();
    const gate = new InputGate(recordingInputGateHooks(counts));

    const lock = await gate.wait();
    const cs1 = lock.startCriticalSection();
    const cs2 = lock.startCriticalSection();
    lock.release();
    (await cs1.wait()).release();

    const starting = cs2.wait();
    cs1.failed(new Error("boom"));
    await expect(starting).rejects.toThrow("boom");

    cs2.drop();
    expect(counts).toEqual({ locked: 2, released: 1, waiterAdded: 1, waiterRemoved: 1 });

    // cs1 is the one actually holding it.
    cs1.drop();
    expect(counts).toEqual({ locked: 2, released: 2, waiterAdded: 1, waiterRemoved: 1 });
  }
});

it("OutputGate hooks balance on every path a lock can leave by", async () => {
  // Resolve. The waiter pair comes from `wait()`, which is the only thing that adds one.
  {
    const counts = newHookCounts();
    const gate = new OutputGate(recordingOutputGateHooks(counts));
    const paf = Promise.withResolvers<void>();
    const blocker = gate.lockWhile(paf.promise);
    const waiter = gate.wait();

    paf.resolve();
    await blocker;
    await waiter;
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 1, waiterRemoved: 1 });
    expect(gate.isBroken()).toBe(false);
  }

  // Reject.
  {
    const counts = newHookCounts();
    const gate = new OutputGate(recordingOutputGateHooks(counts));
    const paf = Promise.withResolvers<void>();
    const blocker = gate.lockWhile(paf.promise);

    paf.reject(new Error("flush failed"));
    await expect(blocker).rejects.toThrow("flush failed");
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 0, waiterRemoved: 0 });
    expect(gate.isBroken()).toBe(true);
  }

  // Abort while pending. The lock never settles on its own afterwards, so the release has to
  // come from the abort path and only from there.
  {
    const counts = newHookCounts();
    const gate = new OutputGate(recordingOutputGateHooks(counts));
    const controller = new AbortController();
    const blocker = gate.lockWhile(neverDone(), controller.signal);

    controller.abort();
    await expect(blocker).rejects.toThrow("output lock was canceled before completion");
    controller.abort(); // a second abort is a no-op
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 0, waiterRemoved: 0 });
    expect(gate.isBroken()).toBe(true);
  }

  // Pre-aborted: `addEventListener` would never fire, so this runs synchronously inside
  // `lockWhile` — still exactly one lock and one release.
  {
    const counts = newHookCounts();
    const gate = new OutputGate(recordingOutputGateHooks(counts));

    await expect(gate.lockWhile(neverDone(), AbortSignal.abort())).rejects.toThrow(
      "output lock was canceled before completion",
    );
    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 0, waiterRemoved: 0 });
    expect(gate.isBroken()).toBe(true);
  }

  // Settle, then abort. One AbortController covering a batch of writes, aborted during cleanup
  // after the writes landed: its settled listener is removed and the gate stays healthy.
  {
    const counts = newHookCounts();
    const gate = new OutputGate(recordingOutputGateHooks(counts));
    const controller = new AbortController();
    const paf = Promise.withResolvers<void>();
    const blocker = gate.lockWhile(paf.promise, controller.signal);

    paf.resolve();
    await blocker;
    controller.abort();

    expect(counts).toEqual({ locked: 1, released: 1, waiterAdded: 0, waiterRemoved: 0 });
    // A late abort must not break a gate whose write already confirmed.
    expect(gate.isBroken()).toBe(false);
    await gate.wait();
  }
});

it("a reentry callback releases its lock when the callback throws", async () => {
  // The `finally` is the only thing standing between a throwing callback and a permanently
  // wedged gate, which is the worst failure this module has.
  const gate = new InputGate();
  const reentry = makeReentryCallback(gate, undefined, (): string => {
    throw new Error("callback failed");
  });

  await expect(reentry()).rejects.toThrow("callback failed");

  (await gate.wait()).release();
});

it("a reentry callback releases its lock when the callback returns control", async () => {
  // Decision 1 expressed at the one call site io-gate owns: the lock covers the
  // synchronous slice, not the returned promise.
  const gate = new InputGate();
  const resume = Promise.withResolvers<string>();

  const reentry = makeReentryCallback(gate, undefined, async (_lock: Lock) => await resume.promise);
  const running = reentry();

  // The gate is already free even though `running` has not settled.
  const concurrent = await gate.wait();
  concurrent.release();

  resume.resolve("done");
  expect(await running).toBe("done");
});
