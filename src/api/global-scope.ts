/**
 * ← workerd `src/workerd/api/global-scope.{h,c++}` — the alarm half, and the
 * async-primitive half `ServiceWorkerGlobalScope` exposes to an application.
 *
 * The event surface (`fetch`/`scheduled`/`trace`/`queue` handlers) still has no
 * port: that belongs to layers this package does not have. What is here is the
 * other thing that class is, and the thing a Durable Object actually reaches —
 * `JSG_METHOD(setTimeout)`, `clearTimeout`, `setInterval`, `clearInterval`,
 * `JSG_METHOD(fetch)`, and `JSG_LAZY_INSTANCE_PROPERTY(scheduler, getScheduler)`
 * (`global-scope.h:776-808`). `Scheduler` itself is `api/basics.h:781-797`; it
 * is one class with one method and it lives beside its only exposure rather than
 * in a `api/basics.ts` that would hold nothing else, since everything else in
 * that file — `Event`, `EventTarget`, `AbortController`, `AbortSignal` — the
 * substrate already provides.
 *
 * **Why this file gained a half.** Workerd's globals hold no context: each one
 * reads `IoContext::current()` at call time (`global-scope.c++:944`, `:961`,
 * `:989`, `:1160`), because acquisition is structural and every entry into the
 * isolate has already taken the lock. There is no isolate hook here, so a
 * continuation that resumes from a promise the runtime does not own comes back
 * with an empty invocation stack and its next `ctx.storage` call throws `no
 * input lock available in this context`. Every host-provided async primitive
 * therefore has to gate itself, and this is where they do.
 *
 * The three primitives take three different mechanisms, and flattening them into
 * "wrap it in awaitIo" would be wrong three ways:
 *
 *  - **Timers** capture the critical section at the ARMING call and re-enter
 *    through `ctx.run(callback, cs)` when they fire. Not `awaitIo`, deliberately
 *    — see `TimeoutManager` in `io/io-context.ts` for upstream's own reason.
 *  - **`fetch`** is `awaitIo` (`http.c++` has ten of them and zero
 *    `awaitIoWithInputLock`), preceded by an output-gate wait so nothing departs
 *    ahead of the writes it might reveal (`http.c++:1488`). §1.3.
 *  - **WebSocket** is neither: `api/web-socket.ts`, because a socket is a long
 *    stream of events rather than one result.
 *
 * **The context is held, not looked up, and that is the whole of the
 * enforcement substitution.** One scope per actor. See `requireOwnSlice` for
 * what happens when a facet reaches a scope that is not its own.
 *
 * Spec: §1.2, §1.3, §1.8 and decisions 1 and 16 in
 * docs/decisions.md.
 */

import {
  hasUserErrorDetail,
  isExceptionFromInputGateBroken,
  tryCurrentSlice,
  type IoContext,
} from "../io/io-context";
import { gateResponseBody } from "./http";

/**
 * ← `AlarmInvocationInfo` (`api/global-scope.h:386-412`): "a jsg::Object used to
 * pass alarm invocation info to an alarm handler."
 *
 * `scheduledTime` is already milliseconds here where upstream converts a
 * `kj::Date` to them at construction (`global-scope.h:390`), which is the same
 * unit `@cloudflare/workers-types` declares and the same one `setAlarm` takes.
 */
export class AlarmInvocationInfo implements globalThis.AlarmInvocationInfo {
  readonly scheduledTime: number;
  readonly retryCount: number;

  constructor(scheduledTime: number, retry: number) {
    this.scheduledTime = scheduledTime;
    this.retryCount = retry;
  }

  get isRetry(): boolean {
    return this.retryCount > 0;
  }
}

/**
 * ← `isAlarmFailureUserError` (`api/global-scope.c++:501-515`), whose own
 * comment lists the three arms: "Returns true if an alarm failure should count
 * against the user's retry limit. A failure is user-generated if any of: the
 * exception was explicitly tagged with EXCEPTION_IS_USER_ERROR at construction
 * time (e.g. state.abort(), exceededCpu, exceededMemory, overload queue); the
 * exception originated from user code throwing inside blockConcurrencyWhile,
 * which breaks the input gate as a secondary side-effect; the exception is a
 * plain jsg.* error without broken.* or jsg-internal.* prefixes, meaning the
 * user's handler threw directly."
 *
 * The first two arms port exactly: this package writes both markers itself —
 * `DurableObjectState.abort()` sets the detail, and `IoContext` annotates a
 * broken input gate with upstream's own prefix.
 *
 * **The third arm has no input here, and its default is inverted deliberately.**
 * Upstream reads it off jsg's exception tunnelling: a `jsg.Error:` prefix that
 * is neither `jsg-internal.` nor a Durable Object reset means the user's handler
 * threw. There is no tunnelling in this runtime — an `Error` out of a handler
 * carries no provenance at all — so a plain exception is reported here as NOT a
 * user error, where upstream would report it as one.
 *
 * That inversion is narrower than it sounds, and it is the safe direction. The
 * caller is
 * `shouldRetryCountsAgainstLimits = !isOutputGateBroken() || isUserGeneratedError`
 * (`global-scope.c++:624`), so for an intact actor a handler failure counts
 * whatever this answers; the only case the two readings disagree on is a handler
 * failure that arrives together with a broken output gate. Upstream counts that
 * and eventually abandons the alarm. This does not, so the alarm outlives the
 * actor's reset and is retried after the restart — which is what
 * `!tunneled.isDurableObjectReset` (`:514`) is reaching for on the arm above it
 * and what the product ranking asks for outright. A default of "user error"
 * would abandon exactly the alarms that most need keeping.
 */
export function isAlarmFailureUserError(exception: unknown): boolean {
  if (hasUserErrorDetail(exception)) return true;
  if (isExceptionFromInputGateBroken(exception)) return true;
  return false;
}

// =======================================================================================
// The async primitives an application reaches

/** ← `Scheduler::WaitOptions` (`api/basics.h:775-778`). */
export type SchedulerWaitOptions = { signal?: AbortSignal };

/**
 * ← `Scheduler` (`api/basics.h:781-797`), whose own comment is: "The scheduler
 * class is an emerging web platform standard API that is meant to be global and
 * provides task scheduling APIs. We currently only implement a subset of the API
 * that is being defined."
 *
 * `wait` is "essentially an awaitable alternative to setTimeout()", and upstream
 * implements it as exactly that — `setTimeoutInternal` onto the same timeout
 * manager (`basics.c++:1007`), which is why it inherits the gating rather than
 * having any of its own.
 */
export class Scheduler {
  readonly #scope: ActorGlobalScope;

  constructor(scope: ActorGlobalScope) {
    this.#scope = scope;
  }

  /** ← `Scheduler::wait` (`basics.c++:989-1020`). */
  wait(delay: number, options?: SchedulerWaitOptions): Promise<void> {
    // ← the pre-check: an already-aborted signal rejects without arming anything.
    if (options?.signal?.aborted === true) {
      return Promise.reject(abortReasonOf(options.signal));
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let id: number;
    try {
      id = this.#scope.setTimeout(() => {
        resolve();
      }, delay);
    } catch (exception) {
      // The exception is unchanged; only its shape is. A method that returns a promise and
      // sometimes throws synchronously instead escapes the caller's `.catch` — the same reason
      // `IoContext.awaitIoWithInputLock` reshapes `getInputLock()`'s throw. The one thing that
      // can throw here is the foreign-slice refusal, and it must reach a caller that only wrote
      // `await scheduler.wait(…).catch(…)`.
      return Promise.reject(exception);
    }

    // ← the `signal` branch below `paf`: aborting clears the timeout and rejects.
    options?.signal?.addEventListener("abort", () => {
      this.#scope.clearTimeout(id);
      reject(abortReasonOf(options.signal));
    });

    return promise;
  }

  /**
   * NO upstream correspondence: `scheduler.yield()` is the Prioritized Task
   * Scheduling API's, which workerd does not implement — `Scheduler` above has
   * exactly one `JSG_METHOD`. It is here because Chrome ships a `scheduler`
   * global in workers that DOES have `yield` and no `wait`, so a scope that
   * replaced Chrome's and dropped `yield` would break page-shaped code that a
   * Durable Object never runs but a shared worker global might. A zero-delay
   * gated timer is the closest honest reading and it keeps the lock property.
   */
  yield(): Promise<void> {
    return this.wait(0);
  }
}

/**
 * ← `SubtleCrypto` (`api/crypto.h`), whose every method is a `jsg::Promise`
 * built inside the isolate's `IoContext` — so on workerd a continuation after
 * `await crypto.subtle.digest(...)` holds the input lock, and nothing has to say
 * so.
 *
 * Here `globalThis.crypto` is the PLATFORM's, and its promise is one this
 * package does not own. The vendored `agents` package hashes inside a method
 * that then writes, so an ungated `digest` made every routine mutation throw at
 * its own `setState` — three frames below the await that lost the lock, with
 * nothing naming the cause. `conformance/suite/gates.spec.ts` is the row that
 * settles it against workerd.
 *
 * `getRandomValues` and `randomUUID` are NOT gated and are forwarded as they
 * are: both are synchronous, so there is no continuation to lose a lock.
 */
class GatedSubtleCrypto {
  readonly #requireOwnSlice: (op: string) => void;
  readonly #ctx: IoContext;
  readonly #subtle: SubtleCrypto;

  constructor(requireOwnSlice: (op: string) => void, ctx: IoContext, subtle: SubtleCrypto) {
    this.#requireOwnSlice = requireOwnSlice;
    this.#ctx = ctx;
    this.#subtle = subtle;
  }

  /**
   * Every asynchronous `SubtleCrypto` method, forwarded through `awaitIo`.
   *
   * Written as one generic hop rather than twelve near-identical methods,
   * because the shape is identical for all of them — the arguments are opaque to
   * this layer and the only thing added is the gate. `requireOwnSlice` runs
   * first for the reason `fetch` runs it: a facet that reached a parent's global
   * would resume under the wrong actor's gate.
   */
  #gated<K extends AsyncSubtleMethod>(method: K): SubtleCrypto[K] {
    const forward = (...args: unknown[]): Promise<unknown> => {
      try {
        this.#requireOwnSlice(`crypto.subtle.${method}`);
      } catch (exception) {
        // Reshaped rather than thrown, for `Scheduler.wait`'s reason: this returns a promise,
        // so a synchronous throw would escape the caller's `.catch`.
        return Promise.reject(exception);
      }
      const call = this.#subtle[method] as (...rest: unknown[]) => Promise<unknown>;
      return this.#ctx.awaitIo(call.apply(this.#subtle, args));
    };
    return forward as SubtleCrypto[K];
  }

  readonly decrypt = this.#gated("decrypt");
  readonly deriveBits = this.#gated("deriveBits");
  readonly deriveKey = this.#gated("deriveKey");
  readonly digest = this.#gated("digest");
  readonly encrypt = this.#gated("encrypt");
  readonly exportKey = this.#gated("exportKey");
  readonly generateKey = this.#gated("generateKey");
  readonly importKey = this.#gated("importKey");
  readonly sign = this.#gated("sign");
  readonly unwrapKey = this.#gated("unwrapKey");
  readonly verify = this.#gated("verify");
  readonly wrapKey = this.#gated("wrapKey");
}

/** Every `SubtleCrypto` member that returns a promise. */
type AsyncSubtleMethod = {
  [K in keyof SubtleCrypto]: SubtleCrypto[K] extends (...args: never[]) => Promise<unknown>
    ? K
    : never;
}[keyof SubtleCrypto];

/**
 * ← `ServiceWorkerGlobalScope`'s `crypto`. The synchronous members are the
 * platform's own; `subtle` is the gated one above.
 */
class GatedCrypto {
  readonly subtle: SubtleCrypto;
  readonly #crypto: Crypto;

  constructor(requireOwnSlice: (op: string) => void, ctx: IoContext, crypto: Crypto) {
    this.#crypto = crypto;
    this.subtle = new GatedSubtleCrypto(
      requireOwnSlice,
      ctx,
      crypto.subtle,
    ) as unknown as SubtleCrypto;
  }

  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    return this.#crypto.getRandomValues(array as never) as T;
  }

  randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    return this.#crypto.randomUUID();
  }
}

/** ← `s->getReason(js)`, which is what `Scheduler::wait` rejects with. */
function abortReasonOf(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** What the host supplies beneath `ServiceWorkerGlobalScope::fetch`. */
export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ActorGlobalScopeOptions = {
  /** Opaque identity of the external entry whose synchronous body is running. */
  readonly currentExternalEntry?: (() => object | undefined) | undefined;
  /**
   * The `Crypto` the gated one delegates to. Defaults to the realm's own, which
   * is what a host wants: unlike `fetch`, there is no per-actor outbound to
   * route this through — `SubtleCrypto` is pure computation, and the only thing
   * the actor's scope adds is the gate around its promise.
   */
  readonly crypto?: Crypto | undefined;
  /**
   * ← the global outbound `Fetcher` `ServiceWorkerGlobalScope::fetch` resolves
   * (`global-scope.c++:1160`). Absent means this actor has no ambient outbound,
   * which is upstream's `globalOutbound: null` posture (§1.11) — `fetch` then
   * refuses by name rather than reaching a `fetch` this package does not own.
   */
  readonly fetch?: FetchPort | undefined;
};

/** Thrown where `globalOutbound` is absent. Asserted rather than skipped, so it cannot drift. */
export const NO_GLOBAL_OUTBOUND_MESSAGE =
  "fetch(): this actor has no global outbound, so an ambient fetch cannot be gated.";

/**
 * The message a scope answers with when it is reached from another actor's
 * slice. Exported because the failure it names is the one thing about this layer
 * that cannot be found by reading the calling code — see `requireOwnSlice`.
 */
export const FOREIGN_SLICE_MESSAGE =
  "was reached from a different actor's slice. A facet that reads a global " +
  "instead of its own binding gets its parent's scope, and its continuation would resume " +
  "under the wrong actor's input gate.";

/**
 * ← `ServiceWorkerGlobalScope`, the async-primitive half. One per actor.
 *
 * A consumer installs this into whatever scope its actor's code reads —
 * `globalThis` for a class in the worker's own module graph, a module-scoped
 * binding for a class that arrived as a dynamically-loaded Worker source, which
 * is upstream's own arrangement (a dynamic Worker has its own global scope bound
 * to its own context, §1.11).
 */
export class ActorGlobalScope {
  readonly #ctx: IoContext;
  readonly #fetch: FetchPort | undefined;
  readonly #readCurrentExternalEntry: (() => object | undefined) | undefined;
  readonly scheduler: Scheduler;
  readonly crypto: GatedCrypto;

  constructor(ctx: IoContext, options: ActorGlobalScopeOptions = {}) {
    this.#ctx = ctx;
    this.#fetch = options.fetch;
    this.#readCurrentExternalEntry = options.currentExternalEntry;
    this.scheduler = new Scheduler(this);
    this.crypto = new GatedCrypto(
      (op) => {
        this.#requireOwnSlice(op);
      },
      ctx,
      // `platformCrypto`, captured at import, and NOT `globalThis.crypto` read here: a
      // host installs its scope before it builds the container, so reading the global now
      // would find the installed binding and recurse into itself on the first digest.
      options.crypto ?? platformCrypto,
    );
  }

  /** Opaque identity available only during an external entry's synchronous body. */
  get currentExternalEntry(): object | undefined {
    return this.#readCurrentExternalEntry?.();
  }

  /** Re-enter this actor after a host promise settles. */
  awaitIo<T>(promise: Promise<T>): Promise<T> {
    return this.#ctx.awaitIo(promise);
  }

  /**
   * The tripwire, and the reason this class can be bound rather than ambient.
   *
   * A scope is reached lexically, so a facet source that writes
   * `globalThis.scheduler.wait(…)` instead of the `scheduler` its own module
   * scope binds gets its PARENT's scope. Upstream cannot have this: a dynamic
   * Worker is a separate isolate with a separate global object, so the wrong
   * scope is not nameable. Here there is one realm, and the design record says
   * of it: "nothing can detect it."
   *
   * This detects the case that occurs, and refuses. `IoContext.isCurrentSlice()`
   * is true only while a synchronous body of that context is on the JS stack,
   * and a facet's body calling a foreign global IS such a moment — the facet
   * entered through `entry()`/`run()`, and its body runs to its first `await`
   * with the ambient set. So the mismatch is certain, and the refusal names the
   * actor rather than surfacing three layers away as `no input lock available in
   * this context` from a storage call that had nothing to do with it.
   *
   * **What it does not catch, stated rather than implied.** A call made from a
   * CONTINUATION — after the calling body's first `await` — finds no ambient at
   * all, because `currentSlice` is restored when the body returns and JS cannot
   * drain a microtask checkpoint synchronously the way `runInContextScope` does.
   * The check then passes and the bound context is used, which is the status quo
   * behaviour and no worse than it. Widening the ambient to cover continuations
   * is not available: two actors' slices genuinely overlap in that window (§1.10
   * gives a facet its own gates, so nothing serialises it against its parent),
   * so a wider ambient would be WRONG rather than merely absent, and wrong with
   * nothing to say so. A tripwire that is silent when it cannot tell is worth
   * more than one that guesses.
   */
  #requireOwnSlice(op: string): void {
    const running = tryCurrentSlice();
    if (running === undefined || running === this.#ctx) return;
    throw new Error(`${op}: this actor's global scope ${FOREIGN_SLICE_MESSAGE}`);
  }

  /** ← `ServiceWorkerGlobalScope::setTimeout` (`global-scope.c++:944-950`). */
  setTimeout(callback: (...args: never[]) => void, msDelay = 0, ...args: unknown[]): number {
    this.#requireOwnSlice("setTimeout");
    return this.#ctx.setTimeoutImpl(false, () => callback(...(args as never[])), msDelay);
  }

  /** ← `ServiceWorkerGlobalScope::clearTimeout` (`global-scope.c++:967-975`). */
  clearTimeout(id?: number | null): void {
    // ← `KJ_IF_SOME(id, timeoutId)`: a missing or non-numeric id is not an error, it is a no-op.
    if (typeof id !== "number") return;
    this.#ctx.clearTimeoutImpl(id);
  }

  /** ← `ServiceWorkerGlobalScope::setInterval` (`global-scope.c++:959-965`). */
  setInterval(callback: (...args: never[]) => void, msDelay = 0, ...args: unknown[]): number {
    this.#requireOwnSlice("setInterval");
    return this.#ctx.setTimeoutImpl(true, () => callback(...(args as never[])), msDelay);
  }

  /** ← `ServiceWorkerGlobalScope::clearInterval`, which is `clearTimeout`'s own body. */
  clearInterval(id?: number | null): void {
    this.clearTimeout(id);
  }

  /**
   * ← `ServiceWorkerGlobalScope::fetch` (`global-scope.h:703-705`) reaching
   * `fetchImpl` (`http.c++:1740-1760`).
   *
   * Two gates, in upstream's order. The OUTPUT gate first, because an outbound
   * request is exactly the observation §1.1 exists to hold back — "blocks all
   * outgoing messages from an actor that would allow the rest of the world to
   * observe the actor's state" — and `fetchImpl` waits on it before the request
   * departs (`http.c++:1488`, `:1759`). The INPUT gate is released for the
   * duration and re-taken on resumption, which is `awaitIo` and which is what
   * makes an actor awaiting the network stay re-entrant (§1.3).
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      // Reshaped rather than thrown, for the reason `Scheduler.wait` gives above: this returns a
      // promise, so a synchronous throw would escape the caller's `.catch`.
      this.#requireOwnSlice("fetch");
    } catch (exception) {
      return Promise.reject(exception);
    }
    const outbound = this.#fetch;
    if (outbound === undefined) return Promise.reject(new Error(NO_GLOBAL_OUTBOUND_MESSAGE));

    const ctx = this.#ctx;
    return ctx.awaitIo(
      (async (): Promise<Response> => {
        await ctx.waitForOutputLocks();
        return await outbound(input, init);
      })(),
      // A `Response` is a promise for its body as much as it is a value: `await res.json()`
      // resumes from a promise this package would not own, so the body is gated too.
      (response) => gateResponseBody(ctx, response),
    );
  }
}

// =======================================================================================
// Installing a scope

/**
 * The bound form of `ActorGlobalScope`, which is what a scope object actually
 * holds. Bound, because these are read as free variables — `setTimeout(…)`, not
 * `scope.setTimeout(…)` — so a method that needed its receiver would break the
 * moment it was destructured, which is exactly how a dynamically-loaded Worker
 * source receives them.
 */
export type ActorScopeBindings = {
  readonly awaitIo: <T>(promise: Promise<T>) => Promise<T>;
  readonly scheduler: {
    wait(delay: number, options?: SchedulerWaitOptions): Promise<void>;
    yield(): Promise<void>;
  };
  readonly setTimeout: (
    callback: (...args: never[]) => void,
    msDelay?: number,
    ...args: unknown[]
  ) => number;
  readonly clearTimeout: (id?: number | null) => void;
  readonly setInterval: (
    callback: (...args: never[]) => void,
    msDelay?: number,
    ...args: unknown[]
  ) => number;
  readonly clearInterval: (id?: number | null) => void;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly crypto: Crypto;
  readonly currentExternalEntry?: object | undefined;
};

/**
 * The capabilities an actor's code reads, bound to one scope.
 *
 * `resolve` is a thunk because the owner may change across root respawns, or a
 * shared realm may select the actor whose synchronous slice is running. It is
 * consulted only when an operation begins; it does not propagate identity
 * across a promise continuation. Actor-owned code should retain its explicit
 * scope instead. A single-actor host simply writes `() => scope`.
 */
export function actorScopeBindings(resolve: () => ActorGlobalScope): ActorScopeBindings {
  return {
    awaitIo: (promise) => resolve().awaitIo(promise),
    scheduler: {
      wait: (delay, options) => resolve().scheduler.wait(delay, options),
      yield: () => resolve().scheduler.yield(),
    },
    setTimeout: (callback, msDelay, ...args) => resolve().setTimeout(callback, msDelay, ...args),
    clearTimeout: (id) => {
      resolve().clearTimeout(id);
    },
    setInterval: (callback, msDelay, ...args) => resolve().setInterval(callback, msDelay, ...args),
    clearInterval: (id) => {
      resolve().clearInterval(id);
    },
    fetch: (input, init) => resolve().fetch(input, init),
    crypto: scopeCrypto(resolve),
    get currentExternalEntry(): object | undefined {
      return resolve().currentExternalEntry;
    },
  };
}

/**
 * `crypto`, bound the way every other name here is bound: nothing resolves until
 * an operation actually runs.
 *
 * That laziness is required rather than tidy, and both lanes proved it. A facet's
 * module destructures its seven names at module scope, which is BEFORE its container
 * exists — so a `crypto` that resolved on read threw at import. And on the root
 * path `globalThis.crypto` is read by things that are not the actor at all: capnweb,
 * the sqlite driver, the test runner. So the binding is a pair of plain objects
 * whose methods resolve, and reading `crypto` or `crypto.subtle` resolves nothing.
 *
 * The synchronous members go to the PLATFORM's `crypto` rather than through the
 * scope, because gating buys nothing for a call with no continuation — and because
 * they are exactly the ones a non-actor caller reaches for.
 */
function scopeCrypto(resolve: () => ActorGlobalScope): Crypto {
  const subtle: Record<string, unknown> = {};
  for (const method of ASYNC_SUBTLE_METHODS) {
    subtle[method] = (...args: unknown[]): Promise<unknown> => {
      const target = resolve().crypto.subtle;
      const call = target[method] as (...rest: unknown[]) => Promise<unknown>;
      return Reflect.apply(call, target, args);
    };
  }
  return {
    subtle: subtle as unknown as SubtleCrypto,
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      platformCrypto.getRandomValues(array as never) as T,
    randomUUID: () => platformCrypto.randomUUID(),
  } as unknown as Crypto;
}

/** Captured at import, before any host installs a scope over it. */
const platformCrypto = globalThis.crypto;

/** ← every `SubtleCrypto` member that returns a promise, as a value the binding can iterate. */
const ASYNC_SUBTLE_METHODS = [
  "decrypt",
  "deriveBits",
  "deriveKey",
  "digest",
  "encrypt",
  "exportKey",
  "generateKey",
  "importKey",
  "sign",
  "unwrapKey",
  "verify",
  "wrapKey",
] as const satisfies readonly AsyncSubtleMethod[];

/**
 * Write the web-platform bindings onto a scope object — `globalThis` for a class in the worker's
 * own module graph, a plain object a dynamically-loaded source destructures for
 * one that is not.
 *
 * **A host should call this rather than assigning the names itself**, and the
 * reason is the failure it prevents: a host that installs five of the six leaves
 * one primitive ungated, and an ungated primitive that WORKS is invisible until
 * a continuation after it touches storage — possibly never, on the path that
 * matters. The set is the package's, so it can grow without every host growing
 * with it.
 *
 * **It ASSIGNS, and that is not incidental.** Chrome ships a `scheduler` global
 * in dedicated workers — the Prioritized Task Scheduling API, `postTask` and
 * `yield`, no `wait` — so a host writing `??=` silently keeps Chrome's and every
 * timer await fails somewhere else entirely with `scheduler.wait is not a
 * function`. Measured on the browser conformance lane, and the extension meets
 * the same global at cutover.
 *
 * **What a host must do first:** capture whatever raw timers its own substrate
 * needs. Everything BELOW the runtime — a `Timer` port, a transport's own
 * retries — has to keep the platform's, or arming a timeout goes through a
 * timeout. That is not hypothetical: pointing the node lane at these primitives
 * without capturing first produced `RangeError: Maximum call stack size
 * exceeded` on the first row.
 */
export function installActorScope(target: object, resolve: () => ActorGlobalScope): void {
  const bindings = actorScopeBindings(resolve);
  // Descriptors, not values: `crypto` is a getter, and reading it here would resolve the scope
  // at install time — which is before the container exists on the facet path, where the whole
  // arrangement is a late binding.
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(bindings))) {
    // These are explicit actor capabilities, not web-platform globals.
    if (name === "awaitIo" || name === "currentExternalEntry") continue;
    Object.defineProperty(target, name, { ...descriptor, configurable: true });
  }
}
