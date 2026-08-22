/**
 * ← workerd `src/workerd/io/io-context.{h,c++}`
 *
 * IoContext: the one door, plus the two await forms.
 *
 * This is the file with no true upstream correspondence for its *enforcement*.
 * Workerd acquires the input gate at isolate entry, so acquisition is
 * structural. We have no isolate hook, so a lock is taken at our own dispatch
 * boundary instead. See "The enforcement point is the one thing we cannot port"
 * in the design record.
 *
 * What this file does, stated before anything about how it got here:
 *
 *  1. `#currentInputLocks` is a STACK of the locks held by the slices that are
 *     running. It is upstream's single `kj::Maybe<InputGate::Lock>
 *     currentInputLock` member (`io-context.h:993`) with the `Maybe` widened,
 *     and a "frame" is an entry in it. A frame carries nothing else: the only
 *     two things ever read from one are the lock (`getInputLock`) and the
 *     critical section that lock belongs to (`getCriticalSection`), and the
 *     lock answers both.
 *  2. A lock is released, and leaves the stack, at the END OF THE MICROTASK
 *     CHECKPOINT of the slice holding it — not when that slice's synchronous
 *     body returns. That is upstream's own boundary, not a relaxation of it:
 *     `runImpl`'s inner `KJ_DEFER` calls `js.runMicrotasks()`
 *     (`io-context.c++:1262`) and `runInContextScope`'s outer one then clears
 *     `currentInputLock` (`:1214`), inner scope first, so the whole checkpoint
 *     drains under the lock. `currentInputLock` holds the `Lock` by value, so
 *     clearing it is the release. `atCheckpointEnd` below is that point.
 *  3. NEITHER await form releases anything at the moment of the await.
 *     `awaitIo` reads `getCriticalSection()` and `awaitIoWithInputLock` takes
 *     an `addRef`; both then return a promise and let the slice end normally.
 *     So an invocation that calls `awaitIo` keeps the gate until its own
 *     checkpoint-end exit and the gate opens there — which is still before any
 *     real I/O can complete, so "a bare timer releases the input gate" holds.
 *     Upstream is the same: `getCriticalSection()` (`io-context.c++:362`) does
 *     not touch `currentInputLock`, and `:1214` is the only place that clears
 *     it. The difference between the two forms is entirely on the far side —
 *     `awaitIo` re-enters through `run(func, criticalSection)` and queues for a
 *     fresh lock, `awaitIoWithInputLock` re-enters holding the ref it took.
 *  4. Removal from the stack is by identity, not by popping, because entries do
 *     overlap — three deep in the unit tests. One invocation can have several
 *     held awaits outstanding (`Promise.all` over two storage reads), and a
 *     section's last body slice overlaps the slice that resolves it.
 *
 * Two mechanics were validated against real workerd before this scaffolding
 * landed, and both are easy to get wrong:
 *
 *  1. The ambient "which lock am I under" must be a STACK of invocation frames,
 *     not a single slot, so that `current` always names the running invocation.
 *     The prototype that found this stated it as "`awaitIo` splices its frame
 *     out and re-pushes the SAME frame on resume". That is not what happens
 *     here and the difference is worth knowing: nothing splices at the point of
 *     the await, because a lock already leaves the stack when its slice ends,
 *     which is the same event that releases it (`#exit` does both). A
 *     resumption then pushes a fresh lock. The prototype needed the splice
 *     because its door held one lock for a whole invocation; the identity that
 *     has to survive an await here is the critical section, and that is
 *     captured at the call rather than looked up later.
 *  2. That ambient is safe here for a reason that does NOT generalise to the
 *     §2.3 ambient-field hazard: the gate guarantees pushes and pops nest
 *     properly in time, because only one holder chain is inside at once.
 *     `_cf_currentSubAgentBridge` has no such guarantee, which is why it is a
 *     live bug and this is not.
 *
 * Consequence: no async context is required. Do not add a dependency on
 * decision 8 here without re-running the conformance gate suite first.
 *
 * The invariant a future simplifier has to re-check: a single slot would pass
 * every test in `io-context.test.ts`, and that was established by trying it,
 * not by argument. `current()` is only read from inside a slice, every slice
 * pushes its own lock last, and no second slice can begin while an earlier
 * frame is still waiting for its checkpoint-end exit — that frame is holding
 * the gate. So the top of a stack and the last write to a slot always agree.
 * The stack is still what is here, because a slot would be holding a stale
 * value at every one of the overlaps in (4), and that is unobservable for
 * exactly as long as the invariant holds. Tightening (2) back to the end of the
 * synchronous body breaks it immediately, which is the regime the mechanic was
 * found in.
 *
 * Spec: §1.2, §1.3, §1.5, §1.6, §1.7.1, §1.9, decisions 1, 2, 4 and 13 in
 * docs/decisions.md.
 *
 * `TimeoutManager` is the only part of this file a consumer's own code reaches
 * directly: every host-provided async primitive a
 * Durable Object can await has to route through here, or the continuation after
 * it resumes with an empty invocation stack. `TimeoutManager` below is the
 * timer half; `api/global-scope.ts` and `api/web-socket.ts` are the rest.
 *
 * Not ported, because the substrate has no equivalent to port onto: isolate and
 * async locks (`Worker::Lock`, `jsg::Lock`, `takeAsyncLock`) and everything
 * that exists to enter or leave an isolate — which is precisely the thing this
 * file substitutes for; the limit enforcer and `afterLimitTimeout` (the
 * deadline takes the `Timer` port instead); trace spans, already a recorded
 * divergence documented in §1.12; subrequest channels and HTTP, which are
 * `api/http.ts`'s gating over the substrate's own `fetch`;
 * `IoOwn`/`IoPtr`/`DeleteQueue`, which guard cross-context dereferences that GC
 * makes impossible; hang detection and `registerPendingEvent`, which need the
 * isolate's own idea of pending work; and the thread-local
 * `IoContext::current()` static, whose lock-resolving half the invocation stack
 * replaces — its *identity* half is `currentSlice` below, narrowed to the
 * synchronous slice, with one consumer and no resolver. `EventOutcome` and
 * `RequestObserver` are metrics types with no port, so `waitUntilStatus()`
 * returns the first exception instead.
 */

import {
  CriticalSection,
  type InputGate,
  Lock,
  type OutputGate,
} from "./io-gate";

/**
 * ← `kj::Timer`, threaded into IoContext upstream.
 *
 * A port with one production implementation would be an invented seam; this
 * one has two (real clock in browser and workerd) plus a fake the conformance
 * suite cannot exist without — the 30-second critical-section deadline and the
 * alarm retry ladder are not assertable on wall-clock time in CI.
 */
export interface Timer {
  now(): number;
  /** `kj::Timer::afterDelay`. The signal replaces kj's cancel-by-drop. */
  afterDelay(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * ← the `Worker::Actor` surface reached through an `IoContext`:
 * `a.getInputGate()`, `a.getOutputGate()` and `a.shutdownActorCache()` from
 * `io-context.{h,c++}` itself, plus `assertCanSetAlarm()`, which
 * `api/actor-state.c++:486` reaches through
 * `IoContext::current().getActorOrThrow()`.
 *
 * `Worker::Actor` lives in `io/worker.h`, the same Bazel target as this file, so
 * naming the members its consumers use is upstream's own layering rather than a
 * new seam. Every context here is an actor context — there is no non-actor
 * request in a Durable Object runtime — so upstream's
 * `kj::Maybe<Worker::Actor&>` and every branch that tests it collapse to this
 * being required, and `getActorOrThrow()` cannot actually throw.
 */
export interface Actor {
  getInputGate(): InputGate;
  getOutputGate(): OutputGate;
  /** Abort abandons scheduled writes rather than flushing them (§1.6). */
  shutdownActorCache(reason: unknown): void;
  /**
   * ← `Worker::Actor::assertCanSetAlarm()` (`io/worker.c++:4090`). Every branch
   * of it reads the actor's class-instance lifecycle, which `server/` owns, so
   * `api/actor-state.ts`'s obligation is to call it and the container's is to
   * answer it.
   */
  assertCanSetAlarm(): void;
}

/** ← `static constexpr int64_t max = 3153600000000;  // Milliseconds in 100 years`. */
const MAX_TIMEOUT_MS = 3_153_600_000_000;

/** ← `afterLimitTimeout(30 * kj::SECONDS)` in `IoContext::blockConcurrencyWhile`. */
export const BLOCK_CONCURRENCY_WHILE_TIMEOUT_MS = 30_000;

/** Copied verbatim: users and upstream tests match on it. */
export const BLOCK_CONCURRENCY_WHILE_TIMEOUT_MESSAGE =
  "A call to blockConcurrencyWhile() in a Durable Object waited for too long. " +
  "The call was canceled and the Durable Object was reset.";

/** ← `jsg::annotateBroken(msg, "broken.inputGateBroken")`. */
const INPUT_GATE_BROKEN_PREFIX = "broken.inputGateBroken; ";

/**
 * THE check every storage entry point in `api/` makes before touching the
 * database, and the only place this package throws for a missing input lock.
 *
 * Upstream never faces the question. `IoContext::current()` is a thread-local
 * read with a `KJ_REQUIRE` behind it, and it cannot fail for a storage call
 * because isolate entry is the only way into an actor and it always took a
 * lock. We have no isolate hook (see this file's header), so a continuation
 * that resumed from a raw `setTimeout`, a raw `fetch`, or any other promise the
 * runtime does not own comes back with an empty invocation stack, and its next
 * storage call reaches `ActorSqlite` — which is synchronous, touches no gate,
 * and would happily serve it outside any transaction boundary.
 *
 * So this throws, matching the assert. It is deliberately ONE function called
 * from every entry point rather than a check written at each of them: the
 * policy is a design decision that belongs to the design record, and when it
 * changes it has to change in one place rather than across a surface the
 * vendored consumer reaches from hundreds of call sites. There is no lenient
 * mode, no flag, and no implicit acquire — a lost invocation is loud, and a
 * lost transaction boundary is not.
 */
export function requireInputLock(ctx: IoContext, op: string): void {
  if (ctx.hasCurrent()) return;
  throw new Error(`${op}: no input lock available in this context${ctx.describeLostLock()}`);
}

/**
 * A stack for `noteGateUse`, captured where user frames are still on the stack.
 *
 * The invocation stack's own push and pop are scheduler moments — `#runImpl`
 * runs from a gate resumption and `#exit` from a `MessageChannel` callback — so
 * a trace taken there names only runtime internals. The moments that still see
 * the caller are the synchronous entries into the gate machinery: an `awaitIo`
 * call, an `entry` dispatch, a callback's registration. V8's zero-cost async
 * traces extend those with the awaiting chain, which is usually the frame the
 * reader actually wants.
 *
 * The first slice drops the `Error` header (absent on SpiderMonkey) and the two
 * runtime frames: this helper and the gate entry point that called it.
 */
export function captureGateStack(): string | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  const frames = stack.split("\n");
  const trimmed = frames.slice(frames[0]?.startsWith("Error") ? 3 : 2).join("\n");
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The end of the microtask checkpoint — the moment `runImpl`'s `KJ_DEFER` fires.
 *
 * Upstream drains the whole checkpoint INSIDE the isolate run: the defer calls
 * `js.runMicrotasks()` and only the outer defer in `runInContextScope` then
 * clears `currentInputLock`. So a continuation that awaits nothing but
 * already-resolved promises stays under the same lock, and a continuation that
 * waits on real I/O does not. In JS the only observable end of a microtask drain
 * is the next macrotask, so that is where a lock leaves the invocation stack.
 *
 * Measured, because the obvious alternatives are wrong in ways nothing catches:
 * releasing synchronously when the invoked function returns, or on the next
 * microtask, both hand the lock back BEFORE the code awaiting the I/O resumes as
 * soon as one promise sits between the two — one `async` wrapper, a `.then`, a
 * `Promise.all` — and `actor-state.ts` is exactly such a wrapper. The gate would
 * then open in the middle of a storage await with no test failing, which is the
 * silent loss of atomicity §1.7.1 names.
 *
 * `MessageChannel` and not `setTimeout`, decided by benchmark rather than by
 * argument, because the two are three orders of magnitude apart on the shapes
 * that wait for a release. A chain of these schedules each hand-off from inside
 * the previous one's callback, so a `setTimeout` chain's nesting level climbs
 * past five and stays there, where browsers clamp it to 4ms. Median per hand-off
 * over 50 chained hops:
 *
 *   |                        | setTimeout | MessageChannel |
 *   | node                   | 1.273 ms   | 0.018 ms       |
 *   | chromium page          | 4.96 ms    | 0.024 ms       |
 *   | chromium Worker        | 5.542 ms   | 0.022 ms       |
 *
 * Only two shapes pay it: an `awaitIo` chain, which has to re-acquire the lock
 * its slice gave up, and a queue of events waiting on the holder. A chain of
 * held storage awaits does not — the lock passes from `addRef` to `addRef` and
 * the release is off the critical path. So 50 sequential facet RPCs cost 277ms
 * of pure clamp in a Worker under `setTimeout` and 1.1ms under this.
 *
 * One channel per BATCH, and a batch is an explicit array: `atCheckpointEnd`
 * pushes onto `pendingCheckpointEnds` and only the push that finds it empty opens
 * a channel. Ordering then comes from the array, which the language guarantees,
 * rather than from delivery order across separate channels, which no
 * specification does. That mattered because the storage engine below depends on
 * a commit scheduled inside a slice running before the release scheduled at the
 * end of that slice; separate channels do deliver in post order in Node,
 * measured across 200 of them including one scheduled from inside another's
 * callback, but a browser that chose otherwise would open the gate onto a
 * transaction a previous event left open, and nothing would say so.
 *
 * A callback scheduled DURING a drain lands in the next batch, which is the
 * semantics to want: one hand-off is one checkpoint end, and a slice that begins
 * inside this drain gets its own. The drain runs every callback even if one
 * throws, and rethrows the first exception afterwards, because abandoning the
 * rest of a batch is how a gate wedges with nothing to see.
 *
 * A long-lived shared port was rejected for the reason it always is: it has to be
 * closed on abort and `unref`'d so it cannot hold a test runner's event loop
 * open, and an `unref`'d port can drop a release at exit — a wedged gate. A
 * channel that lives for exactly one message cannot. Batching gets most of what
 * a shared port was worth anyway: a slice that schedules a commit and a release
 * now allocates one channel where it used to allocate two.
 *
 * **Exported because `kj::evalLater()` is this same point.** `ActorSqlite` opens
 * its implicit transaction on the first write and commits it "on the next turn of
 * the event loop" (`actor-sqlite.c++:352-357`); upstream's next turn is after the
 * isolate run, which is after `js.runMicrotasks()`, which is after
 * `currentInputLock` is cleared. Upstream's two boundaries are one boundary, and
 * they stay one here only if the commit rides the same primitive as the release.
 * Two consequences the storage engine depends on, both properties of this
 * function rather than of `ActorSqlite`:
 *
 *  1. **Everything that holds the input lock across an await is a microtask
 *     chain.** `awaitIoWithInputLock` resumes through `#awaitIoImpl`'s `.then`
 *     into `run(func, lock)`, which never waits on the gate. So a whole run of
 *     held storage awaits finishes before the next hand-off and its writes are
 *     one transaction (§1.7.1 row 1).
 *  2. **Everything that releases it needs at least one hand-off.** `awaitIo`
 *     resumes through `gate.wait()`, which cannot resolve until `#exit` runs
 *     here. So a timer or outbound await puts the commit between the two writes
 *     (§1.7.1 row 2).
 *
 */
export function atCheckpointEnd(run: () => void): void {
  pendingCheckpointEnds.push(run);
  if (pendingCheckpointEnds.length > 1) return;

  const channel = new MessageChannel();
  // Assigning `onmessage` starts the port; `addEventListener` would need `start()`.
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    // A snapshot, so a callback scheduled by one of these belongs to the next batch — and, since
    // the queue is empty while the batch runs, that push opens the next channel by itself.
    const batch = pendingCheckpointEnds.splice(0);
    let failure: { readonly exception: unknown } | undefined;
    for (const callback of batch) {
      try {
        callback();
      } catch (exception) {
        failure ??= { exception };
      }
    }
    if (failure !== undefined) throw failure.exception;
  };
  channel.port2.postMessage(0);
}

/** The current batch. Its order is the hand-off order every consumer below relies on. */
const pendingCheckpointEnds: (() => void)[] = [];

// =======================================================================================
// `IoContext::current()`, narrowed to what JS can express

/**
 * ← `static thread_local IoContext* threadLocalRequest` (`io-context.c++:25`).
 *
 * **This is NOT an async context and must not become one.** It is set on entry
 * to a slice's SYNCHRONOUS body and restored the instant that body returns —
 * which for an `async` function is its first `await`. It propagates through
 * exactly nothing. The package's "no async context is required" property
 * (README, Part 4 mechanic 1) is undisturbed: nothing resolves a lock through
 * this, and deleting it would change no gate behaviour.
 *
 * Upstream's scope is wider and cannot be matched. `runInContextScope` saves the
 * previous context, installs itself, and restores at the end of the isolate run
 * — which drains the whole microtask checkpoint synchronously, so upstream's
 * `current()` covers a slice's continuations too. JS cannot drain a checkpoint
 * synchronously, so covering continuations here would mean holding the value
 * until `atCheckpointEnd`, and by then a SECOND actor's body can have run and
 * left. That is not a hazard upstream has: two actors' slices genuinely overlap
 * in this window (§1.10 gives every facet its own gates, so nothing serialises
 * a parent against its child), and the value would be wrong with nothing to say
 * so.
 *
 * So the port keeps only the half that is exact, and the one consumer is a
 * tripwire that refuses on mismatch and stays quiet on `undefined` — never a
 * resolver. See `requireOwnSlice` in `api/global-scope.ts`.
 */
let currentSlice: IoContext | undefined;

/** ← `IoContext::tryCurrent()` (`io-context.c++:1416-1422`), over the narrowed scope above. */
export function tryCurrentSlice(): IoContext | undefined {
  return currentSlice;
}

/**
 * ← the `SuppressIoContextScope` constructor's `threadLocalRequest = this` half
 * (`io-context.c++:1208`), as a function rather than an assignment in `#runImpl`.
 *
 * A function because `currentSlice = this` reads to a linter as a `this` alias — the
 * ES5 `var self = this` habit — when it is the opposite: publishing the running
 * context to a module scope, which is exactly what the C++ does to a thread local.
 */
function enterSlice(context: IoContext | undefined): void {
  currentSlice = context;
}

/** ← `kj::OneOf<T, kj::Exception>`, the result of `promiseForExceptionOrT()`. */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly exception: unknown };

/** ← `promiseForExceptionOrT()`: merge the rejection into the value so it survives the hop. */
function promiseForExceptionOrT<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (exception: unknown): Outcome<T> => ({ ok: false, exception }),
  );
}

/** ← `IdentityFunc<T>`. */
function identity<T>(value: T): T {
  return value;
}

/**
 * ← the `if (!msg.startsWith("broken."))` guard in `blockConcurrencyWhile`'s error
 * handler. Upstream rewrites the exception's description in place, so this does
 * too. `jsg`'s exception tunnelling — the `jsg.Error:` / `remote.` prefixes
 * `annotateBroken()` also produces — has no port here, so only the brokenness tag
 * it exists to carry survives.
 */
function annotateInputGateBroken(exception: unknown): void {
  if (!(exception instanceof Error)) return;
  if (exception.message.startsWith("broken.") || exception.message.startsWith("remote.broken.")) {
    return;
  }
  exception.message = INPUT_GATE_BROKEN_PREFIX + exception.message;
}

/**
 * ← `jsg::isExceptionFromInputGateBroken` (`jsg/exception.c++:168-172`):
 * "annotateBroken() produces 'broken.inputGateBroken; {message}', optionally
 * prefixed with 'remote.' when crossing RPC boundaries. Strip the remote prefix
 * first, then check the tag."
 *
 * Its writer is `annotateInputGateBroken` directly above, which is why the two
 * live together rather than the reader moving to its consumer: `jsg/` has no
 * module here, and a prefix known in two places is a prefix that drifts.
 */
export function isExceptionFromInputGateBroken(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  let description = exception.message;
  // "there are cases where we return a tunneled error through multiple workers, so let's be
  // paranoid and allow for multiple 'remote.' prefixes" (`jsg/exception.c++:52-57`).
  while (description.startsWith(REMOTE_EXCEPTION_PREFIX)) {
    description = description.slice(REMOTE_EXCEPTION_PREFIX.length);
  }
  return description.startsWith(INPUT_GATE_BROKEN_PREFIX);
}

/** ← `ERROR_REMOTE_PREFIX` (`jsg/exception.h`). */
const REMOTE_EXCEPTION_PREFIX = "remote.";

/**
 * ← `jsg::EXCEPTION_IS_USER_ERROR` (`jsg/exception.h:160`), a
 * `kj::Exception::DetailTypeId` attached to an arbitrary exception rather than a
 * type of exception.
 *
 * A symbol-keyed property is the closest JS has: it rides any thrown object,
 * survives a rethrow, and cannot collide with anything an application writes.
 * `Symbol.for` rather than `Symbol()` so the detail is still legible after the
 * exception crosses a realm — the mistake decision 18 records capnweb making.
 */
export const EXCEPTION_IS_USER_ERROR = Symbol.for("workerd.exceptionIsUserError");

/** ← `error.setDetail(jsg::EXCEPTION_IS_USER_ERROR, kj::heapArray<byte>(0))`. */
export function setUserErrorDetail(exception: unknown): void {
  if (typeof exception !== "object" || exception === null) return;
  Object.defineProperty(exception, EXCEPTION_IS_USER_ERROR, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

/** ← `e.getDetail(jsg::EXCEPTION_IS_USER_ERROR) != kj::none`. */
export function hasUserErrorDetail(exception: unknown): boolean {
  if (typeof exception !== "object" || exception === null) return false;
  return (exception as Record<symbol, unknown>)[EXCEPTION_IS_USER_ERROR] === true;
}

// =======================================================================================
// Timers

/**
 * ← `TimeoutManager::TimeoutParameters` (`io/io-timers.h:71-80`).
 *
 * `callback` is nullable for upstream's stated reason: "This is a maybe to allow
 * cancel to clear it and free the reference when it is no longer needed."
 */
type TimeoutParameters = {
  readonly repeat: boolean;
  readonly msDelay: number;
  callback: (() => void) | undefined;
};

/** ← `IoContext::TimeoutManagerImpl::TimeoutState` (`io-context.c++:133-148`). */
type TimeoutState = {
  readonly params: TimeoutParameters;
  isCanceled: boolean;
  /**
   * ← `kj::Maybe<kj::Promise<void>> maybePromise`, whose presence upstream reads
   * as "this timeout is armed". kj cancels by dropping the promise; there is no
   * drop here, so the signal that aborts the underlying `Timer.afterDelay` is
   * carried beside it — the same substitution Section 1 made for every kj
   * cancel-by-drop.
   */
  armed: AbortController | undefined;
};

/**
 * ← `IoContext::TimeoutManagerImpl` (`io-context.c++:40-140`, `:742-880`).
 *
 * **The one mechanic worth reading twice: a timer is NOT `awaitIo`.** Upstream
 * says why in a comment on the very line (`io-context.c++:756-758`): "the manual
 * use of run() here (including carrying over the critical section) is kind of
 * ugly, but using awaitIo() doesn't work here because we need the ability to
 * cancel the timer, so we don't want to addTask() it, which awaitIo() does
 * implicitly." So the shape is `cs = ctx.getCriticalSection()` captured at the
 * call, then `ctx.run(callback, cs)` when it fires. The captured section is what
 * makes a timer armed inside `blockConcurrencyWhile` run INSIDE that section
 * rather than queueing on the root gate behind it.
 *
 * **Substrate divergence: one `Timer.afterDelay` per timeout, where upstream
 * keeps a sorted `timeoutTimes` map and a single `timerTask` for the nearest.**
 * That structure exists because `kj::TimerChannel::atTime` supports one pending
 * wait, so upstream has to multiplex; `Timer.afterDelay` takes as many
 * concurrent waits as are asked for. The observable properties it produced —
 * timers fire in deadline order, ties broken by arming order — are the ones both
 * lane timers already have, since both are `setTimeout` underneath. Nothing else
 * in `resetTimerTask` is observable, so nothing else is ported.
 *
 * Not ported: `TimeoutId::Generator` and its cross-`ServiceWorkerGlobalScope`
 * assertion (`io-context.c++:52-60`), which exists to catch an IoContext being
 * current for a different V8 context — a confusion with no shape here, since a
 * timeout id is minted by the manager that owns it; `registerPendingEvent`,
 * which needs the isolate's own idea of pending work; and `getNextTimeout`,
 * whose only caller is the limit enforcer.
 */
class TimeoutManager {
  readonly #timer: Timer;
  readonly #timeouts = new Map<number, TimeoutState>();
  #nextId = 1;

  constructor(timer: Timer) {
    this.#timer = timer;
  }

  /** ← `TimeoutManagerImpl::setTimeout` (`io-context.c++:51-67`). */
  setTimeout(ctx: IoContext, params: TimeoutParameters): number {
    const id = this.#nextId++;
    const state: TimeoutState = { params, isCanceled: false, armed: undefined };
    this.#timeouts.set(id, state);
    this.#arm(ctx, id, state);
    return id;
  }

  /** ← `TimeoutManagerImpl::clearTimeout` (`io-context.c++:874-883`). */
  clearTimeout(id: number): void {
    const state = this.#timeouts.get(id);
    // "We can't find this timeout, thus we act as if it was already canceled."
    if (state === undefined) return;
    this.#cancel(id, state);
  }

  /** ← `TimeoutManagerImpl::getTimeoutCount` (`io-context.c++:71-73`). */
  getTimeoutCount(): number {
    return this.#timeouts.size;
  }

  /** ← `TimeoutManagerImpl::cancelAll` (`io-context.c++:83-87`). */
  cancelAll(): void {
    for (const [id, state] of [...this.#timeouts]) this.#cancel(id, state);
  }

  /** ← `TimeoutState::cancel` — clear the flag, drop the callback reference, disarm. */
  #cancel(id: number, state: TimeoutState): void {
    state.isCanceled = true;
    state.params.callback = undefined;
    state.armed?.abort();
    state.armed = undefined;
    this.#timeouts.delete(id);
  }

  /** ← `TimeoutManagerImpl::setTimeoutImpl` (`io-context.c++:742-853`). */
  #arm(ctx: IoContext, id: number, state: TimeoutState): void {
    // Captured HERE, at the arming call, exactly as upstream captures it into the `.then` lambda.
    // Reading it when the timer fires would give a new external event the running section and
    // `blockConcurrencyWhile` would silently block nothing (Part 4, mechanic 2).
    const criticalSection = ctx.getCriticalSection();
    const wake = new AbortController();
    state.armed = wake;

    const fired = this.#timer.afterDelay(state.params.msDelay, wake.signal).then(
      async () => {
        if (state.isCanceled) return;
        state.armed = undefined;
        await this.#fire(ctx, id, state, criticalSection);
      },
      (exception: unknown) => {
        // kj cancels by dropping the promise, which cannot report anything; Section 1 records
        // that the substitution turns every cancel-by-drop into an `AbortSignal` whose waiter
        // rejects with `CanceledError`. A wake THIS manager aborted is that cancellation and not
        // a failure. Anything else is the timer port's and is reported, so a substrate that
        // fails to keep time cannot look like a timer nobody armed.
        if (!state.isCanceled) throw exception;
      },
    );

    // ← `context.addWaitUntil(kj::mv(paf.promise))` (`io-context.c++:845-851`): "Add a wait-until
    // task which resolves when this timer completes. This ensures that `IncomingRequest::drain()`
    // waits until all timers finish."
    //
    // Divergence, and it is the fail-closed direction. Upstream additionally swallows the chain's
    // rejection outright (`[](kj::Exception&&) {}`, `io-context.c++:817`) because a JS throw from
    // the callback has already reached the isolate's uncaught-exception path. There is no such path
    // here, so a swallow would lose it entirely; routing the rejection through the waitUntil set
    // records it in `waitUntilStatus()` — the context's existing failure channel — instead of
    // inventing a second one.
    ctx.addWaitUntil(fired);
  }

  /** ← the body of the `.then` at `io-context.c++:759-816`, which is one `context.run`. */
  async #fire(
    ctx: IoContext,
    id: number,
    state: TimeoutState,
    criticalSection: CriticalSection | undefined,
  ): Promise<void> {
    await ctx.run(() => {
      // "We've been canceled before running. Nothing more to do."
      if (state.isCanceled) return;
      const callback = state.params.callback;
      if (callback === undefined) return;

      // ← "First, move our timeout promise to the task set so it's safe to call clearInterval()
      // inside the user's callback." A non-repeating timeout is done with its entry either way; a
      // repeating one keeps it so `clearInterval` inside the callback still finds it.
      if (!state.params.repeat) {
        state.params.callback = undefined;
        this.#timeouts.delete(id);
      }

      // ← the `KJ_DEFER(unwindDetector.catchExceptionsIfUnwinding(...))`: "The user's callback
      // might throw, but we need to at least attempt to reschedule interval callbacks even if
      // they throw."
      try {
        callback();
      } finally {
        if (state.params.repeat && !state.isCanceled) this.#arm(ctx, id, state);
      }
    }, criticalSection);
  }
}

/**
 * A set of background promises, with the one behaviour `kj::TaskSet` adds over an
 * array: a failing task reports to `taskFailed` instead of becoming an unhandled
 * rejection, and the set can be waited on until empty.
 */
class TaskSet {
  readonly #tasks = new Set<Promise<void>>();
  readonly #taskFailed: (exception: unknown) => void;

  constructor(taskFailed: (exception: unknown) => void) {
    this.#taskFailed = taskFailed;
  }

  add(promise: Promise<void>): void {
    const task = promise.then(
      () => {
        this.#tasks.delete(task);
      },
      (exception: unknown) => {
        this.#tasks.delete(task);
        this.#taskFailed(exception);
      },
    );
    this.#tasks.add(task);
  }

  /** ← `kj::TaskSet::onEmpty()`. Re-checks, since a task can add another. */
  async onEmpty(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.all([...this.#tasks]);
    }
  }
}

// =======================================================================================
// IoContext

export class IoContext {
  readonly #actor: Actor;
  readonly #timer: Timer;

  /**
   * ← `kj::Maybe<InputGate::Lock> currentInputLock`, made a stack.
   *
   * The top entry is the lock of the slice that is running right now. Entries are
   * removed by identity rather than popped, so `#exit` never depends on the order
   * the overlapping slices happen to leave in.
   */
  readonly #currentInputLocks: Lock[] = [];

  /**
   * Where this context's gate was last deliberately engaged, for
   * `describeLostLock`. One slot, overwritten on every engagement — the gate
   * serialises slices, so the latest note is the best available ancestor of
   * whatever continuation is running lockless now.
   */
  #lastGateUse: { readonly what: string; readonly stack: string | undefined; readonly at: number } | undefined;

  #abortException: { readonly exception: unknown } | undefined;
  readonly #abortPromise: Promise<never>;
  readonly #rejectAbort: (exception: unknown) => void;

  /**
   * Two sets, as upstream: `abortWhen()` always uses `tasks` so that a monitor
   * which never completes cannot hold up a drain, while `addTask()` in an actor
   * is a waitUntil task.
   */
  readonly #tasks: TaskSet;
  readonly #waitUntilTasks: TaskSet;
  #addTaskCounter = 0;
  #waitUntilStatus: { readonly exception: unknown } | undefined;

  /** ← `kj::Own<TimeoutManager> timeoutManager` (`io-context.h:1043`). */
  readonly #timeouts: TimeoutManager;

  constructor(actor: Actor, timer: Timer) {
    this.#actor = actor;
    this.#timer = timer;
    this.#timeouts = new TimeoutManager(timer);

    const { promise, reject } = Promise.withResolvers<never>();
    this.#abortPromise = promise;
    this.#rejectAbort = reject;
    // kj's ForkedPromise just holds the exception until someone adds a branch.
    void promise.catch(() => {});

    this.#tasks = new TaskSet((exception) => this.#taskFailed(exception));
    this.#waitUntilTasks = new TaskSet((exception) => this.#taskFailed(exception));

    // Arrange to complain if the input gate is broken, which indicates a critical section
    // failed and the actor can no longer be used.
    this.abortWhen(actor.getInputGate().onBroken());

    // Also complain if the output gate is broken, which indicates a critical storage failure
    // that means we cannot continue execution.
    this.abortWhen(actor.getOutputGate().onBroken());
  }

  // -----------------------------------------------------------------
  // The ambient lock

  /**
   * Get the current input lock. Throws an exception if no input lock is held (e.g. because
   * this is not an actor request).
   *
   * ← `KJ_ASSERT_NONNULL(currentInputLock, ...).addRef()`. The `addRef` IS the §1.2
   * distinction: it is the only way to hold the gate past the end of this slice.
   */
  getInputLock(): Lock {
    return this.#requireCurrent().addRef();
  }

  /** Get the current CriticalSection, if there is one, or returns null if not. */
  getCriticalSection(): CriticalSection | undefined {
    return this.#currentInputLocks.at(-1)?.getCriticalSection();
  }

  /** Is a gated slice running? The question `IoContext::hasCurrent()` answers upstream. */
  hasCurrent(): boolean {
    return this.#currentInputLocks.length > 0;
  }

  /**
   * ← `IoContext::isCurrent()` (`io-context.c++:1428-1430`), over the narrowed
   * scope `currentSlice` documents: true only while a synchronous body of THIS
   * context is on the JS stack.
   *
   * Distinct from `hasCurrent()` above, which asks whether this context holds a
   * lock at all — true throughout an outstanding held await, and true for a
   * parent whose slice is awaiting a facet while the facet's body runs. This one
   * is the question a shared global has to answer: is the code calling me this
   * actor's?
   */
  isCurrentSlice(): boolean {
    return currentSlice === this;
  }

  /**
   * Record that user code just engaged this context's gate — an `awaitIo`, an
   * `entry` dispatch, a re-entry callback firing. No upstream analogue, because
   * upstream cannot lose the lock; here a continuation that awaits a promise
   * the runtime does not own comes back lockless, the throw lands at the next
   * storage call three layers later, and the gap between "where the code last
   * verifiably ran gated" and the throw site is exactly where the foreign await
   * hides. This is that first coordinate. Always on: the capture rides calls
   * that already allocate promise machinery, and a stack costs microseconds
   * against the diagnosis it replaces.
   */
  noteGateUse(what: string, stack: string | undefined): void {
    this.#lastGateUse = { what, stack, at: this.now() };
  }

  /**
   * The suffix `requireInputLock` appends when the invocation stack is empty:
   * where this context's gate was last engaged, and how long before the throw.
   *
   * "Last engaged" is the honest claim, not "this continuation's ancestor" —
   * once the offending chain went lockless the gate reopened, so another slice
   * may have run in between and be the note this reports. In practice the loss
   * is discovered within the same event storm and the note is the parent; when
   * it is not, an engagement of this actor moments earlier is still the right
   * neighbourhood to search.
   */
  describeLostLock(): string {
    const use = this.#lastGateUse;
    if (use === undefined) {
      return " (this context has never held its gate: the call arrived from outside any actor invocation)";
    }
    const age = Math.round(this.now() - use.at);
    const stackSuffix = use.stack === undefined ? "" : `, at:\n${use.stack}`;
    return ` (an await after the last gated point resumed from a promise the runtime does not own; the gate was last engaged by ${use.what} ${age}ms before this call${stackSuffix})`;
  }

  /**
   * ← `IoContext::getActorOrThrow()`. Upstream's throws when the request is not
   * an actor request; there is no such request here, so it is a plain accessor.
   */
  getActorOrThrow(): Actor {
    return this.#actor;
  }

  /** ← `IoContext::now()` (`io-context.h:703`), which reads the same timer. */
  now(): number {
    return this.#timer.now();
  }

  // -----------------------------------------------------------------
  // Timers

  /**
   * ← `IoContext::setTimeoutImpl` (`io-context.c++:885-899`), clamp included.
   *
   * The generator parameter is gone with `TimeoutId::Generator` — see
   * `TimeoutManager`'s header — so the signature is upstream's minus that one
   * argument.
   */
  setTimeoutImpl(repeat: boolean, callback: () => void, msDelay: number): number {
    // "Clamp the range on timers to [0, 3153600000000] (inclusive). The specs do not indicate a
    // clear maximum range for setTimeout/setInterval so the limit here is fairly arbitrary. 100
    // years max should be plenty safe."
    const delay =
      msDelay <= 0 || Number.isNaN(msDelay)
        ? 0
        : msDelay >= MAX_TIMEOUT_MS
          ? MAX_TIMEOUT_MS
          : Math.trunc(msDelay);
    return this.#timeouts.setTimeout(this, { repeat, msDelay: delay, callback });
  }

  /** ← `IoContext::clearTimeoutImpl` (`io-context.c++:901-903`). */
  clearTimeoutImpl(id: number): void {
    this.#timeouts.clearTimeout(id);
  }

  /** ← `IoContext::getTimeoutCount` (`io-context.c++:905-907`). */
  getTimeoutCount(): number {
    return this.#timeouts.getTimeoutCount();
  }

  // -----------------------------------------------------------------
  // The output gate

  /**
   * Wait until all outstanding output locks have been unlocked. Does not wait for future
   * output locks, even if they are created before past locks are unlocked.
   */
  waitForOutputLocks(): Promise<void> {
    return this.#actor.getOutputGate().wait();
  }

  /**
   * Check if the output gate is currently broken. This indicates that there was a problem
   * with committing storage writes.
   */
  isOutputGateBroken(): boolean {
    return this.#actor.getOutputGate().isBroken();
  }

  /** Lock output until the given promise completes. */
  lockOutputWhile<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#actor.getOutputGate().lockWhile(promise, signal);
  }

  // -----------------------------------------------------------------
  // Abort

  /**
   * Rejects if and when the context should be aborted, e.g. because a gate broke. This
   * promise never resolves, only rejects.
   */
  onAbort(): Promise<never> {
    return this.#abortPromise;
  }

  /** Force context abort now. */
  abort(exception: unknown): void {
    if (this.#abortException !== undefined) {
      return;
    }
    this.#abortException = { exception };

    // Stop the ActorCache from flushing any scheduled write operations to prevent any
    // unnecessary or unintentional async work.
    this.#actor.shutdownActorCache(exception);

    // ← `timeoutManager->cancelAll()` in `~IoContext_IncomingRequest`, plus the
    // `context.abortException == kj::none` guard that stops `setTimeoutImpl` rescheduling into an
    // aborted context (`io-context.c++:832`). Upstream reaches both through destruction; with no
    // destructors, abort is the one event that stands for it. Without this a pending timer wakes
    // into `run()`, which refuses an aborted context, and the refusal lands in `waitUntilStatus()`
    // as a failure nobody caused.
    this.#timeouts.cancelAll();

    this.#rejectAbort(exception);
  }

  /**
   * Await the given promise and, if it throws, call `abort()` with the exception. The promise
   * given here should just be a monitoring promise, it should not represent any sort of
   * background work beyond monitoring.
   */
  abortWhen(promise: Promise<unknown>): void {
    if (this.#abortException === undefined) {
      this.#tasks.add(
        promise.then(
          () => {},
          (exception: unknown) => {
            this.abort(exception);
          },
        ),
      );
    }
  }

  // -----------------------------------------------------------------
  // Task scheduling

  /**
   * Arrange for the given promise to execute as part of this request.
   *
   * "In Actors, we treat all tasks as wait-until tasks, because it's perfectly legit to start
   * a task under one request and then expect some other request to handle it later." Every
   * context here is an actor context, so that branch is the only branch.
   */
  addTask(promise: Promise<void>): void {
    ++this.#addTaskCounter;
    this.addWaitUntil(promise);
  }

  /**
   * Indicates that the script has requested that it stay active until the given promise
   * resolves. `drainWaitUntil()` waits until all such promises have completed. Touches
   * neither gate (§1.9).
   */
  addWaitUntil(promise: Promise<void>): void {
    this.#waitUntilTasks.add(promise);
  }

  /** Returns the number of times addTask() has been called (even if the tasks have completed). */
  taskCount(): number {
    return this.#addTaskCounter;
  }

  /**
   * The first exception a background task failed with, if any.
   *
   * ← `waitUntilStatus()`, which returns an `EventOutcome` derived from the exception by
   * `RequestObserver`. There is no observer here, so the exception itself is the status —
   * and keeping it is what stops a failed background task from being swallowed, since
   * upstream's other half of `taskFailed()` is a log this package has no port for.
   */
  waitUntilStatus(): unknown {
    return this.#waitUntilStatus?.exception;
  }

  /**
   * ← `IncomingRequest::drain()`, actor branch. "For actors, all promises are canceled on
   * actor shutdown, not on a fixed timeout, because work doesn't necessarily happen on a
   * per-request basis in actors."
   */
  async drainWaitUntil(): Promise<void> {
    await Promise.race([this.#waitUntilTasks.onEmpty(), this.#abortPromise.catch(() => {})]);
  }

  // -----------------------------------------------------------------
  // Entry

  /**
   * Run the given callback within this context, holding an input lock.
   *
   * ← the two `IoContext::run()` overloads: given a CriticalSection it waits on that, given
   * an already-held Lock it runs under it, and given neither it takes a fresh lock from the
   * gate. The third case is what a new external event does, and it is the reason inheritance
   * cannot be read from gate state — see `makeReentryCallback`.
   */
  async run<T>(
    func: (lock: Lock) => T | PromiseLike<T>,
    ilOrCs?: Lock | CriticalSection,
  ): Promise<T> {
    // Before we try running anything, let's make sure our IoContext hasn't been aborted. If it
    // has been aborted, there's likely not an active request so later operations will fail
    // anyway.
    const aborted = this.#abortException;
    if (aborted !== undefined) {
      throw aborted.exception;
    }

    let lock: Lock;
    if (ilOrCs === undefined) {
      lock = await this.#actor.getInputGate().wait();
    } else if (ilOrCs instanceof CriticalSection) {
      lock = await ilOrCs.wait();
    } else {
      lock = ilOrCs;
    }

    return await this.#runImpl(func, lock);
  }

  /**
   * Make a function which, when called, re-enters this IoContext to run some code.
   *
   * Upstream, on why the critical section travels with the callback at all:
   *
   * > "What if the call was made within blockConcurrencyWhile()? The callback will be blocked
   * > until the critical section ends, which could lead to deadlock if the critical section
   * > code is waiting on it? ... The callback is allowed to run within the critical section
   * > (blockConcurrencyWhile()) from which it was called."
   *
   * The section is read here, at the point of capture, and never on invocation: a new
   * external event that inherited the running section would skip the queue and
   * `blockConcurrencyWhile` would silently block nothing (Part 4, mechanic 2).
   *
   * The returned function can be called multiple times.
   *
   * It does not route through `io-gate.ts`'s `makeReentryCallback`, which is the same idea
   * expressed at the gate. Upstream's `IoContext::makeReentryCallback` is literally
   * `ctx.run(func, cs)`, and going through the gate helper instead would take a lock this
   * file then has to make current a second time. The gate copy stays: it is the shape a
   * consumer holding only a gate needs, and Section 1's tests cover it.
   */
  makeReentryCallback<Args extends unknown[], Result>(
    func: (lock: Lock, ...args: Args) => Result | PromiseLike<Result>,
  ): (...args: Args) => Promise<Result> {
    // A reentry callback is meant for *re-*entry, so should only be created while already
    // inside the IoContext. Initial entry should just use run().
    this.#requireCurrent();
    const criticalSection = this.getCriticalSection();
    // Captured once, here, because the fire is a scheduler moment with no user
    // frames — the registration site is the trace a reader can act on.
    const registrationStack = captureGateStack();

    return async (...args: Args): Promise<Result> => {
      this.noteGateUse("a re-entry callback registered at the site below", registrationStack);
      const call = this.run((lock) => func(lock, ...args), criticalSection);

      // ← the `addTask()` + `registerPendingEvent()` pair, which keeps the context live while
      // a callback is outstanding. Upstream scopes that to the callback's lifetime via a
      // destructor; with no destructors the closest live analogue is the in-flight call, which
      // is what should stop `drainWaitUntil()` reporting idle. The outcome is swallowed here
      // only because the caller already receives it.
      this.addTask(
        call.then(
          () => {},
          () => {},
        ),
      );

      return await call;
    };
  }

  // -----------------------------------------------------------------
  // The two await forms

  /**
   * Waits for some background I/O to complete, then executes `func` on the result.
   *
   * The input lock is NOT held across the wait: the resumption re-enters through
   * `run(func, criticalSection)` and takes a fresh lock, so it queues behind whatever
   * arrived in the meantime. This is what makes a Durable Object awaiting another Durable
   * Object fully re-entrant (§1.3).
   *
   * `func` is a parameter rather than something the caller chains, for upstream's reason:
   * chaining "required returning to the KJ event loop between running func() and running
   * whatever JavaScript code was waiting on it". Here the equivalent cost is a promise hop
   * outside the lock.
   */
  awaitIo<T>(promise: Promise<T>): Promise<T>;
  awaitIo<T, R>(promise: Promise<T>, func: (value: T) => R | PromiseLike<R>): Promise<R>;
  awaitIo<T, R>(
    promise: Promise<T>,
    func: (value: T) => R | PromiseLike<R> = identity as (value: T) => R,
  ): Promise<R> {
    this.noteGateUse("awaitIo", captureGateStack());
    return this.#awaitIoImpl(promise, this.getCriticalSection(), func);
  }

  /**
   * Waits for the given I/O while holding the input lock, so that all other I/O is blocked
   * from completing in the meantime (unless it is also holding the same input lock).
   *
   * This is the whole of §1.2's asymmetry, and per §1.7.1 it is also the implicit-transaction
   * boundary: the four async storage calls take this form, everything else takes `awaitIo`.
   * Calling it outside a gated slice throws rather than inventing a lock — a lost invocation
   * is loud, a lost transaction boundary is not.
   */
  awaitIoWithInputLock<T>(promise: Promise<T>): Promise<T>;
  awaitIoWithInputLock<T, R>(
    promise: Promise<T>,
    func: (value: T) => R | PromiseLike<R>,
  ): Promise<R>;
  awaitIoWithInputLock<T, R>(
    promise: Promise<T>,
    func: (value: T) => R | PromiseLike<R> = identity as (value: T) => R,
  ): Promise<R> {
    let inputLock: Lock;
    try {
      // The exception is unchanged; only its shape is. A method that returns a promise and
      // sometimes throws synchronously instead escapes the caller's `.catch`, and this is the
      // one call every storage method makes.
      inputLock = this.getInputLock();
    } catch (exception) {
      return Promise.reject(exception);
    }
    this.noteGateUse("awaitIoWithInputLock", captureGateStack());
    return this.#awaitIoImpl(promise, inputLock, func);
  }

  // -----------------------------------------------------------------
  // blockConcurrencyWhile

  /**
   * Runs `callback` within its own critical section, returning its final result. If
   * `callback` throws, the input lock will break, resetting the actor.
   *
   * Three behaviours live here rather than in `io-gate.ts`, which has no timer, and rather
   * than in `api/actor-state.ts`, whose own `blockConcurrencyWhile` is a one-line forward:
   * the 30-second deadline, the brokenness annotation, and the fact that on failure the
   * returned promise is never settled at all.
   */
  blockConcurrencyWhile<T>(callback: (lock: Lock) => T | PromiseLike<T>): Promise<T> {
    const lock = this.getInputLock();
    this.noteGateUse("blockConcurrencyWhile", captureGateStack());
    const criticalSection = lock.startCriticalSection();
    const { promise: result, resolve } = Promise.withResolvers<T>();

    this.addTask(
      (async () => {
        try {
          const value = await this.#runCriticalSection(criticalSection, callback);

          // Hand the parent lock back and resolve under it, so the caller's continuation runs
          // before any other input arrives.
          await this.#runImpl(() => {
            resolve(value);
          }, criticalSection.succeeded());
        } catch (exception) {
          // Annotate as broken for periodic metrics. If we already set up a brokenness reason,
          // we shouldn't override it.
          annotateInputGateBroken(exception);

          // Note that on failure, no further InputLocks will be obtainable and the actor will
          // shut down, so don't worry about holding a lock until we get back to application
          // code -- we won't! In fact, we don't even bother calling resolver.reject() because
          // it's meaningless at this point.
          criticalSection.failed(exception);

          throw exception;
        } finally {
          // ← `~CriticalSection`. A no-op after `succeeded()`; on the failure path it is what
          // hands the parent lock back, since `failed()` does not.
          criticalSection.drop();
        }
      })(),
    );

    // ← the destruction of `auto lock` at the end of the upstream scope. Everything above is
    // synchronous, so the end of the setup is the end of the scope.
    lock.release();

    return result;
  }

  // -----------------------------------------------------------------

  /**
   * ← `runImpl()` + `runInContextScope()`: check the lock belongs to this actor, make it the
   * current one, run, and let `KJ_DEFER` clear it.
   *
   * The defer fires after the microtask checkpoint, not when `func` returns — see
   * `atCheckpointEnd`. Everything else about the scope is isolate machinery with no port.
   */
  async #runImpl<T>(func: (lock: Lock) => T | PromiseLike<T>, lock: Lock): Promise<T> {
    if (!lock.isFor(this.#actor.getInputGate())) {
      throw new Error("IoContext::runImpl() was given a lock belonging to another actor");
    }

    this.#currentInputLocks.push(lock);
    let result: T | PromiseLike<T>;
    // ← `SuppressIoContextScope previousRequest; threadLocalRequest = this;` (`io-context.c++:1208`)
    // and its restoring destructor. Scoped to the synchronous body only — see `currentSlice`.
    const previousSlice = currentSlice;
    enterSlice(this);
    try {
      result = func(lock);
    } finally {
      enterSlice(previousSlice);
      atCheckpointEnd(() => {
        this.#exit(lock);
      });
    }
    return await result;
  }

  /**
   * ← `requireCurrent()`. Upstream asks whether this IoContext is the thread's current one;
   * with no thread-local there is only one question left, and it is the one every caller of
   * `requireCurrent()` actually depends on: is a gated slice running?
   */
  #requireCurrent(): Lock {
    const lock = this.#currentInputLocks.at(-1);
    if (lock === undefined) {
      throw new Error(`no input lock available in this context${this.describeLostLock()}`);
    }
    return lock;
  }

  /** ← the far side of `runInContextScope`'s `KJ_DEFER`. */
  #exit(lock: Lock): void {
    const at = this.#currentInputLocks.lastIndexOf(lock);
    if (at < 0) {
      throw new Error("IoContext invocation stack lost a lock it was holding");
    }
    this.#currentInputLocks.splice(at, 1);
    lock.release();
  }

  /**
   * ← `awaitIoImpl()`.
   *
   * The KJ-side rejection is merged into the value so a single continuation handles both, the
   * continuation re-enters through `run(func, ilOrCs)`, and the whole thing rides `addTask()`.
   * When `ilOrCs` is a Lock this is `awaitIoWithInputLock` and the gate never opened; when it
   * is a CriticalSection or nothing this is `awaitIo` and the resumption queues for a fresh
   * lock like any other event.
   */
  #awaitIoImpl<T, R>(
    promise: Promise<T>,
    ilOrCs: Lock | CriticalSection | undefined,
    func: (value: T) => R | PromiseLike<R>,
  ): Promise<R> {
    const { promise: result, resolve, reject } = Promise.withResolvers<R>();

    this.addTask(
      promiseForExceptionOrT(promise).then(async (outcome) => {
        try {
          await this.run((): void => {
            if (outcome.ok) {
              // `func` runs under the lock, which is the guarantee that makes it a parameter.
              try {
                resolve(func(outcome.value));
              } catch (exception) {
                reject(exception);
              }
            } else {
              reject(outcome.exception);
            }
          }, ilOrCs);
        } catch (exception) {
          // `run()` refuses to re-enter an aborted context, and both of its throws happen
          // before the lock reaches the invocation stack. Upstream would destroy the whole
          // continuation here, releasing the held lock with it; with no destructors it has to
          // be handed back by name. `result` is deliberately left unsettled, as upstream
          // leaves it: the actor is being torn down and `onAbort()` is what reports that.
          if (ilOrCs instanceof Lock) ilOrCs.release();
          throw exception;
        }
      }),
    );

    return result;
  }

  /**
   * ← the first `.then()` of `blockConcurrencyWhile`: start the section, run the callback
   * under its first nested lock, and race the deadline.
   */
  async #runCriticalSection<T>(
    criticalSection: CriticalSection,
    callback: (lock: Lock) => T | PromiseLike<T>,
  ): Promise<T> {
    const inputLock = await criticalSection.wait();

    return await this.#runImpl((lock) => {
      // Remember that this can throw synchronously, and it's important that we catch such
      // throws and call cs->failed().
      const running = callback(lock);

      // Arrange to time out if the critical section runs more than 30 seconds, so that objects
      // won't be hung forever if they have a critical section that deadlocks.
      const deadline = new AbortController();
      const timeout = this.#timer
        .afterDelay(BLOCK_CONCURRENCY_WHILE_TIMEOUT_MS, deadline.signal)
        .then((): never => {
          throw new Error(BLOCK_CONCURRENCY_WHILE_TIMEOUT_MESSAGE);
        });

      // ← `exclusiveJoin`. The loser cannot be cancelled — a recorded divergence — but the
      // timer half of it can, which is what the signal is for: a section that finishes must
      // not leave a live 30-second timer behind.
      return Promise.race([Promise.resolve(running), timeout]).finally(() => {
        deadline.abort();
      });
    }, inputLock);
  }

  /** ← `IoContext::taskFailed()`, minus the logging half, which has no port. */
  #taskFailed(exception: unknown): void {
    if (this.#waitUntilStatus === undefined) {
      this.#waitUntilStatus = { exception };
    }
  }
}
