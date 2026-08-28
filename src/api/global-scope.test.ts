/**
 * ← workerd `src/workerd/api/global-scope-test.c++`, which has no alarm cases —
 * `runAlarm`'s classification is exercised only through integration tests
 * upstream.
 *
 * So these are this section's own, and they are aimed at the one function whose
 * inputs this runtime had to redesign: `isAlarmFailureUserError` reads kj
 * exception details upstream, and there are none here. What it decides is
 * whether an alarm belonging to a broken actor is retried or abandoned, so
 * every arm is pinned.
 */

import { describe, expect, test } from "vitest";
import type { Actor, Timer } from "../io/io-context";
import { IoContext, setUserErrorDetail } from "../io/io-context";
import { InputGate, OutputGate } from "../io/io-gate";
import type { ActorGlobalScopeOptions, ActorScopeBindings } from "./global-scope";
import {
  ActorGlobalScope,
  AlarmInvocationInfo,
  FOREIGN_SLICE_MESSAGE,
  actorScopeBindings,
  installActorScope,
  isAlarmFailureUserError,
  NO_GLOBAL_OUTBOUND_MESSAGE,
} from "./global-scope";

describe("AlarmInvocationInfo", () => {
  test("carries the scheduled time and the retry count", () => {
    // ← `AlarmInvocationInfo` (`api/global-scope.h:387-412`).
    const info = new AlarmInvocationInfo(1_700_000_000_000, 3);
    expect(info.scheduledTime).toBe(1_700_000_000_000);
    expect(info.retryCount).toBe(3);
    expect(info.isRetry).toBe(true);
  });

  test("isRetry is retryCount > 0", () => {
    // ← `bool getIsRetry() { return retryCount > 0; }` (`global-scope.h:393-395`).
    expect(new AlarmInvocationInfo(0, 0).isRetry).toBe(false);
    expect(new AlarmInvocationInfo(0, 1).isRetry).toBe(true);
  });

  test("satisfies the shape a handler is typed against", () => {
    const info: AlarmInvocationInfo = new AlarmInvocationInfo(5, 0);
    const pinned: globalThis.AlarmInvocationInfo = info;
    expect(pinned.retryCount).toBe(0);
  });
});

describe("isAlarmFailureUserError", () => {
  test("an exception carrying the user-error detail is a user error", () => {
    // ← `if (hasUserErrorDetail) return true;` (`global-scope.c++:511`), whose
    // detail is set by `DurableObjectState::abort` (`actor-state.c++:1143`).
    const error = new Error("Application called abort() to reset Durable Object.");
    expect(isAlarmFailureUserError(error)).toBe(false);
    setUserErrorDetail(error);
    expect(isAlarmFailureUserError(error)).toBe(true);
  });

  test("an exception from a broken input gate is a user error", () => {
    // ← `if (jsg::isExceptionFromInputGateBroken(description)) return true;`
    // (`global-scope.c++:512`): user code threw inside blockConcurrencyWhile,
    // which breaks the input gate as a secondary side-effect.
    expect(isAlarmFailureUserError(new Error("broken.inputGateBroken; boom"))).toBe(true);
    expect(isAlarmFailureUserError(new Error("remote.broken.inputGateBroken; boom"))).toBe(true);
    expect(isAlarmFailureUserError(new Error("remote.remote.broken.inputGateBroken; boom"))).toBe(
      true,
    );
  });

  test("a broken output gate is NOT a user error", () => {
    // ← `!tunneled.isDurableObjectReset` (`global-scope.c++:514`). This is the
    // arm the product ranking leans on: an alarm belonging to an actor the
    // runtime reset must survive to be retried, never be abandoned.
    expect(isAlarmFailureUserError(new Error("broken.outputGateBroken; jsg.Error: nope"))).toBe(
      false,
    );
  });

  test("an unclassifiable exception is NOT a user error", () => {
    // Deliberately the opposite default from a plain `jsg.Error` upstream — see
    // `isAlarmFailureUserError`'s own comment for why the safe direction here is
    // "retry it" rather than "count it".
    expect(isAlarmFailureUserError(new Error("something went wrong"))).toBe(false);
    expect(isAlarmFailureUserError("a thrown string")).toBe(false);
    expect(isAlarmFailureUserError(undefined)).toBe(false);
  });
});

// =======================================================================================
// The async primitives

/**
 * The `Worker::Actor` and `kj::Timer` surfaces an `IoContext` reaches, inline for
 * the reason `io/io-context.test.ts` keeps its own: a shared fixture would be a
 * layer, and that file's `FakeTimer` counts pending waits and rejects a cancelled
 * one — detail these tests must not inherit.
 */
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

/** ← `kj::Timer`. Cancellation leaves the waiter unsettled, as kj's cancel-by-drop does. */
class TestTimer implements Timer {
  #now = 0;
  #pending: { at: number; fire: () => void }[] = [];
  now(): number {
    return this.#now;
  }
  afterDelay(ms: number, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const entry = { at: this.#now + ms, fire: resolve };
    this.#pending.push(entry);
    const drop = (): void => {
      const at = this.#pending.indexOf(entry);
      if (at >= 0) this.#pending.splice(at, 1);
    };
    signal?.addEventListener("abort", drop, { once: true });
    return promise;
  }
  advance(ms: number): void {
    this.#now += ms;
    for (const entry of [...this.#pending]) {
      if (entry.at <= this.#now) {
        const at = this.#pending.indexOf(entry);
        if (at >= 0) this.#pending.splice(at, 1);
        entry.fire();
      }
    }
  }
}

async function quiesce(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function newScope(options?: ActorGlobalScopeOptions): {
  ctx: IoContext;
  timer: TestTimer;
  scope: ActorGlobalScope;
} {
  const timer = new TestTimer();
  const ctx = new IoContext(new TestActor(), timer);
  return { ctx, timer, scope: new ActorGlobalScope(ctx, options) };
}

describe("Scheduler", () => {
  test("§1.2 the continuation after wait() holds a fresh input lock", async () => {
    // The property the whole section exists for. `scheduler.wait` is
    // `setTimeoutInternal` upstream (`basics.c++:1007`), so it inherits the timer's
    // gating rather than having any of its own.
    const { ctx, timer, scope } = newScope();
    const seen: string[] = [];

    await ctx.run(() => {
      void scope.scheduler.wait(20).then(() => {
        seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
      });
    });

    expect(seen).toEqual([]);
    timer.advance(20);
    await quiesce();
    expect(seen).toEqual(["gated"]);
  });

  test("an already-aborted signal rejects without arming anything", async () => {
    // ← the pre-check at `basics.c++:991-997`, which returns before `paf`.
    const { ctx, scope } = newScope();
    const reason = new Error("already gone");

    await ctx.run(async () => {
      await expect(scope.scheduler.wait(20, { signal: AbortSignal.abort(reason) })).rejects.toBe(
        reason,
      );
      expect(ctx.getTimeoutCount()).toBe(0);
    });
  });

  test("aborting mid-wait clears the timeout and rejects", async () => {
    const { ctx, timer, scope } = newScope();
    const controller = new AbortController();
    const reason = new Error("caller gave up");

    // Not `await ctx.run(...)`: `run` awaits whatever the body returns, so returning the
    // wait would make the slice itself wait for it.
    let waited: Promise<void> | undefined;
    await ctx.run(() => {
      waited = scope.scheduler.wait(50, { signal: controller.signal });
    });
    const settled = Promise.allSettled([waited]);
    expect(ctx.getTimeoutCount()).toBe(1);

    controller.abort(reason);
    expect(ctx.getTimeoutCount()).toBe(0);
    expect(await settled).toEqual([{ status: "rejected", reason }]);

    // And the cleared timer does not fire afterwards.
    timer.advance(50);
    await quiesce();
  });

  test("yield() is a zero-delay wait, and it is still gated", async () => {
    // No upstream referent — workerd's `Scheduler` has one method. It exists because
    // Chrome's worker `scheduler` has `yield` and no `wait`, so a scope that dropped it
    // would be a downgrade for anything already using the platform's.
    const { ctx, timer, scope } = newScope();
    const seen: string[] = [];

    await ctx.run(() => {
      void scope.scheduler.yield().then(() => {
        seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
      });
    });
    timer.advance(0);
    await quiesce();
    expect(seen).toEqual(["gated"]);
  });
});

describe("ActorGlobalScope timers", () => {
  test("setTimeout and setInterval reach the context's timeout manager", async () => {
    const { ctx, timer, scope } = newScope();
    const seen: string[] = [];

    await ctx.run(() => {
      scope.setTimeout(() => seen.push("once"), 10);
      const id = scope.setInterval(() => seen.push("tick"), 10);
      expect(ctx.getTimeoutCount()).toBe(2);
      scope.setTimeout(() => scope.clearInterval(id), 25);
    });

    for (let tick = 0; tick < 4; tick++) {
      timer.advance(10);
      await quiesce();
    }
    expect(seen).toEqual(["once", "tick", "tick"]);
  });

  test("the callback receives the extra arguments, as the web platform specifies", async () => {
    const { ctx, timer, scope } = newScope();
    const seen: unknown[][] = [];
    await ctx.run(() => {
      scope.setTimeout((...args: never[]) => seen.push(args), 10, "a", 1);
    });
    timer.advance(10);
    await quiesce();
    expect(seen).toEqual([["a", 1]]);
  });

  test("clearTimeout ignores a missing or non-numeric id", async () => {
    // ← `KJ_IF_SOME(id, timeoutId)` (`global-scope.c++:967-975`): absent is a no-op, not
    // an error. `clearInterval` is upstream's same body.
    const { ctx, scope } = newScope();
    await ctx.run(() => {
      expect(() => scope.clearTimeout()).not.toThrow();
      expect(() => scope.clearTimeout(null)).not.toThrow();
      expect(() => scope.clearInterval()).not.toThrow();
    });
  });
});

describe("ActorGlobalScope.fetch", () => {
  test("§1.3 the continuation after a fetch holds a fresh input lock", async () => {
    const { ctx, scope } = newScope({ fetch: async () => new Response("ok") });
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = await scope.fetch("https://example.invalid/");
      seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
      seen.push(await response.text());
      seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
    });
    expect(seen).toEqual(["gated", "ok", "gated"]);
  });

  test("§1.1 the request does not depart before the output gate is clear", async () => {
    // ← `fetchImpl`'s `awaitIo(js, context.waitForOutputLocks(), …)` (`http.c++:1488`).
    // An outbound request is exactly the observation the output gate exists to hold back.
    const { ctx, scope } = newScope({
      fetch: async () => {
        order.push("request-departed");
        return new Response("ok");
      },
    });
    const order: string[] = [];
    const write = Promise.withResolvers<void>();

    void ctx.lockOutputWhile(
      write.promise.then(() => {
        order.push("write-confirmed");
      }),
    );

    const fetched = ctx.run(() => scope.fetch("https://example.invalid/"));
    await quiesce();
    expect(order).toEqual([]);

    write.resolve();
    await fetched;
    expect(order).toEqual(["write-confirmed", "request-departed"]);
  });

  test("an actor with no global outbound refuses by name", async () => {
    // ← `globalOutbound: null` (§1.11), which is how Code Mode forces every I/O through
    // connectors. Reaching a `fetch` the runtime does not own would be an ungated await
    // that works, which is the failure this layer exists to prevent.
    const { ctx, scope } = newScope();
    await ctx.run(async () => {
      await expect(scope.fetch("https://example.invalid/")).rejects.toThrow(
        NO_GLOBAL_OUTBOUND_MESSAGE,
      );
    });
  });
});

describe("the foreign-slice tripwire", () => {
  test("a scope reached from another actor's slice refuses, naming the cause", async () => {
    // THE case the design record says "nothing can detect": a facet source that writes
    // `globalThis.scheduler.wait(…)` instead of its own binding gets its PARENT's scope.
    // A facet's body IS a synchronous slice of the facet's context, so the mismatch is
    // certain here — see `requireOwnSlice`.
    const parent = newScope();
    const facet = new IoContext(new TestActor(), new TestTimer());

    // Every call is made SYNCHRONOUSLY inside the facet's body, which is not tidiness: after
    // the body's first `await` the ambient is already restored, and the next test states that
    // the tripwire is silent there. Writing this one with `await`s between the calls makes the
    // later ones succeed against the parent — which is how that property was confirmed.
    let fetched: Promise<Response> | undefined;
    let waited: Promise<void> | undefined;
    await facet.run(() => {
      // The two synchronous arming calls throw; the two promise-returning ones REJECT, because
      // a promise-returning method that throws synchronously escapes the caller's `.catch`.
      expect(() => parent.scope.setTimeout(() => {}, 10)).toThrow(FOREIGN_SLICE_MESSAGE);
      expect(() => parent.scope.setInterval(() => {}, 10)).toThrow(FOREIGN_SLICE_MESSAGE);
      fetched = parent.scope.fetch("https://example.invalid/");
      waited = parent.scope.scheduler.wait(10);
    });
    await expect(fetched).rejects.toThrow(FOREIGN_SLICE_MESSAGE);
    await expect(waited).rejects.toThrow(FOREIGN_SLICE_MESSAGE);
    // Nothing was armed on the parent, so the refusal is complete rather than advisory.
    expect(parent.ctx.getTimeoutCount()).toBe(0);
  });

  test("its own actor's slice passes, and so does a call with no slice running", async () => {
    // Two halves of "silent when it cannot tell". Inside its own body the ambient
    // matches; from a continuation there is no ambient at all, because `currentSlice` is
    // restored when a body returns and JS cannot drain a checkpoint synchronously. The
    // second is the case this deliberately does NOT catch — widening the ambient to
    // cover it would make it WRONG rather than absent, since two actors' slices overlap
    // in that window (§1.10 gives a facet its own gates).
    const { ctx, scope } = newScope();

    await ctx.run(() => {
      expect(() => scope.setTimeout(() => {}, 10)).not.toThrow();
    });
    expect(ctx.isCurrentSlice()).toBe(false);
    expect(() => scope.setTimeout(() => {}, 10)).not.toThrow();
  });

  test("clearTimeout does not trip, because cancelling is safe from anywhere", async () => {
    // The check guards ARMING, which is what binds a continuation to a gate. Cancelling
    // an id the caller already holds cannot bind anything, and refusing it would make a
    // facet unable to clean up a timer it legitimately owns.
    const parent = newScope();
    const facet = new IoContext(new TestActor(), new TestTimer());
    const id = await parent.ctx.run(() => parent.scope.setTimeout(() => {}, 10));

    await facet.run(() => {
      expect(() => parent.scope.clearTimeout(id)).not.toThrow();
    });
    expect(parent.ctx.getTimeoutCount()).toBe(0);
  });
});

describe("installActorScope", () => {
  test("the bound scope reads the current external entry without installing it", () => {
    let currentExternalEntry: object | undefined;
    const { scope } = newScope({ currentExternalEntry: () => currentExternalEntry });
    const bound = actorScopeBindings(() => scope);

    expect(bound.currentExternalEntry).toBeUndefined();
    currentExternalEntry = {};
    expect(bound.currentExternalEntry).toBe(currentExternalEntry);
  });

  test("writes all actor globals onto a scope object, bound", async () => {
    // Bound, because a dynamically-loaded Worker source destructures them: `const
    // { scheduler, setTimeout } = …` would lose `this` on a method.
    const { ctx, timer, scope } = newScope({ fetch: async () => new Response("ok") });
    const target: Record<string, unknown> = {};
    installActorScope(target, () => scope);

    expect(Object.keys(target).sort()).toEqual([
      "WebSocket",
      "WebSocketPair",
      "WebSocketRequestResponsePair",
      "clearInterval",
      "clearTimeout",
      "crypto",
      "fetch",
      "scheduler",
      "setInterval",
      "setTimeout",
    ]);

    const { setTimeout: armed, scheduler: sched } = target as unknown as ActorScopeBindings;
    const seen: string[] = [];
    await ctx.run(() => {
      armed(() => seen.push("timer"), 10);
      void sched.wait(10).then(() => seen.push("wait"));
    });
    timer.advance(10);
    await quiesce();
    expect(seen).toEqual(["timer", "wait"]);
  });

  test("the crypto binding resolves nothing until an operation runs", async () => {
    // A facet's module destructures its names at module scope, which is before its container
    // exists — so reading `crypto`, and reading `crypto.subtle`, must resolve nothing. Only a
    // call does.
    let resolved = 0;
    const { ctx, scope } = newScope();
    const target: Record<string, unknown> = {};
    installActorScope(target, () => {
      resolved += 1;
      return scope;
    });

    const { crypto: bound } = target as unknown as ActorScopeBindings;
    void bound.subtle;
    expect(resolved).toBe(0);

    // Synchronous members never resolve at all: they have no continuation to gate.
    expect(bound.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved).toBe(0);

    const digest = await ctx.run(() => bound.subtle.digest("SHA-256", new Uint8Array([1])));
    expect(new Uint8Array(digest)).toHaveLength(32);
    expect(resolved).toBeGreaterThan(0);
  });

  test("it ASSIGNS, so a platform scheduler already on the scope is replaced", async () => {
    // Chrome ships a `scheduler` in dedicated workers — `postTask` and `yield`, no
    // `wait`. A host writing `??=` keeps Chrome's and every timer await fails somewhere
    // else entirely with `scheduler.wait is not a function`. Measured on the browser
    // conformance lane.
    const { scope } = newScope();
    const target: Record<string, unknown> = {
      scheduler: { postTask: () => {}, yield: () => Promise.resolve() },
    };
    installActorScope(target, () => scope);
    expect(typeof (target.scheduler as { wait?: unknown }).wait).toBe("function");
  });

  test("the thunk is consulted per call, so a host can repoint it", async () => {
    // The one host shape that needs it: a worker hosting one root across respawns has to
    // reach whichever container is live now, and a captured reference would reach a torn
    // down one.
    const first = newScope();
    const second = newScope();
    let live = first;
    const target: Record<string, unknown> = {};
    installActorScope(target, () => live.scope);
    const { setTimeout: armed } = target as unknown as ActorScopeBindings;

    await first.ctx.run(() => armed(() => {}, 10));
    expect(first.ctx.getTimeoutCount()).toBe(1);
    expect(second.ctx.getTimeoutCount()).toBe(0);

    live = second;
    await second.ctx.run(() => armed(() => {}, 10));
    expect(second.ctx.getTimeoutCount()).toBe(1);
  });
});
