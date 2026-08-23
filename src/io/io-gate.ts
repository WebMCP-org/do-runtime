/**
 * ← workerd `src/workerd/io/io-gate.{h,c++}`
 *
 * An I/O gate allows someone to "lock" a type of I/O so that other concurrent tasks trying to
 * perform that type of I/O are blocked until the lock is released.
 *
 * I/O gates are used in actors to implement consistency guarantees, allowing in-memory state and
 * storage to be synchronized.
 *
 * Each Actor has two main gates:
 * - Input gate: While locked, blocks all incoming I/O events of any type from being delivered to
 *   the actor, other than the specific event or events that hold the lock. This includes
 *   blocking responses to subrequests, timer events, input streams, etc. Used when storage
 *   operations are outstanding, so that awaiting a storage operation does not risk allowing
 *   concurrent events that render the state inconsistent.
 * - Output gate: While locked, blocks all outgoing messages from an actor that would allow the
 *   rest of the world to observe the actor's state. Held while writes that have been confirmed
 *   to the application are still being flushed to disk. If the flush fails, these messages will
 *   never be sent, so that the rest of the world cannot observe a prematurely-confirmed write.
 *
 * Three things kj gives for free and JS does not, resolved the same way at every site:
 *
 *  1. **Destructors.** `~Lock` releases and `~CriticalSection` diagnoses a dropped section as
 *     deadlock. Both become explicit: `Lock.release()` and `CriticalSection.drop()`. A `Lock`
 *     released twice throws rather than corrupting the refcount.
 *  2. **Cancel-by-drop.** Dropping a `kj::Promise` unwinds its waiter. Every such site takes an
 *     `AbortSignal`, the convention `Timer.afterDelay` already set in `io-context.ts`. Aborting a
 *     `wait()` rejects it with `CanceledError`; a never-settling promise would be an invisible
 *     hang, which is what this repo's fail-closed tenet exists to prevent.
 *  3. **`kj::ForkedPromise` holding an exception with no branches.** JS reports that as an
 *     unhandled rejection, so every promise this module stores keeps a no-op `catch` of its own
 *     and hands observers a separate view.
 *
 * Error strings are copied verbatim from upstream; users and upstream tests match on them.
 *
 * Not ported: `SpanParent`/`SpanBuilder` tracing, since there is no `trace.h` here and upstream's
 * own tests pass `nullptr` at every call site; and the `~InputGate` assertion that no locks
 * outlive the gate, which guards against dangling references GC makes impossible.
 *
 * Spec: §1.1, §1.2, §1.5, decisions 3, 5 and 13 in
 * docs/decisions.md.
 */

/**
 * Raised when a `wait()` is cancelled through its `AbortSignal`.
 *
 * kj has no equivalent, because a cancelled continuation simply never runs. It is deliberately
 * NOT a gate failure: a cancelled waiter leaves the gate exactly as it found it, so
 * `CriticalSection.wait()` rethrows this one without calling `setBroken()`.
 */
export class CanceledError extends Error {
  override readonly name = "CanceledError";
}

/** Mirrors `OutputGate::makeUnfulfilledException()`: one place that spells the exception. */
function makeCanceledError(): CanceledError {
  return new CanceledError("input gate wait was canceled");
}

/**
 * `addEventListener("abort", ...)` never fires for a signal that has already aborted, so a
 * pre-aborted signal would silently hold its lock forever. Every cancellation site goes through
 * here, and every one of them first rejects a pre-aborted wait before touching gate state, so
 * "cancelled" always means "left the gate exactly as it found it".
 */
function onAbort(signal: AbortSignal | undefined, run: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    run();
    return () => {};
  }
  signal.addEventListener("abort", run, { once: true });
  return () => signal.removeEventListener("abort", run);
}

/**
 * ← `kj::OneOf<kj::Own<kj::PromiseFulfiller<void>>, kj::Exception> brokenState`.
 *
 * `InputGate` starts in `fulfiller` — it builds its promise in the constructor — while
 * `OutputGate` starts in `none` and only makes one when `onBroken()` is first called.
 */
type BrokenState =
  | { readonly kind: "none" }
  | { readonly kind: "fulfiller"; readonly reject: (exception: unknown) => void }
  | { readonly kind: "exception"; readonly exception: unknown };

// =======================================================================================
// InputGate

/**
 * Hooks that can be used to customize InputGate behavior.
 *
 * Technically, everything implemented here could be accomplished by a class that wraps
 * InputGate, but the part of the code that wants to implement these hooks is far away from the
 * part of the code that calls into the InputGate, and so it was more convenient to give the
 * caller a way to inject behavior into InputGate.
 */
export interface InputGateHooks {
  inputGateLocked(): void;
  inputGateReleased(): void;
  inputGateWaiterAdded(): void;
  inputGateWaiterRemoved(): void;
}

/** ← `InputGate::Hooks::DEFAULT`. */
export const DEFAULT_INPUT_GATE_HOOKS: InputGateHooks = {
  inputGateLocked() {},
  inputGateReleased() {},
  inputGateWaiterAdded() {},
  inputGateWaiterRemoved() {},
};

/** ← `InputGate::Waiter`: a `kj::List` node plus the adapted promise's fulfiller. */
class Waiter {
  /** Rewritten by `CriticalSection.succeeded()` when a straggler is reparented. */
  gate: InputGate;
  readonly isChildWaiter: boolean;
  /** ← `link.isLinked()`. */
  linked = true;

  readonly #resolve: (lock: Lock) => void;
  readonly #reject: (exception: unknown) => void;

  constructor(
    gate: InputGate,
    isChildWaiter: boolean,
    resolve: (lock: Lock) => void,
    reject: (exception: unknown) => void,
  ) {
    this.gate = gate;
    this.isChildWaiter = isChildWaiter;
    this.#resolve = resolve;
    this.#reject = reject;

    gate.hooks.inputGateWaiterAdded();
    if (isChildWaiter) {
      gate.waitingChildren.push(this);
    } else {
      gate.waiters.push(this);
    }
  }

  unlink(): void {
    if (!this.linked) return;
    this.linked = false;
    const list = this.isChildWaiter ? this.gate.waitingChildren : this.gate.waiters;
    const index = list.indexOf(this);
    if (index < 0) {
      throw new Error("InputGate::Waiter is linked but absent from its gate's list");
    }
    list.splice(index, 1);
  }

  fulfill(lock: Lock): void {
    this.unlink();
    this.gate.hooks.inputGateWaiterRemoved();
    this.#resolve(lock);
  }

  reject(exception: unknown): void {
    this.unlink();
    this.gate.hooks.inputGateWaiterRemoved();
    this.#reject(exception);
  }
}

/**
 * An InputGate blocks incoming events from being delivered to an actor while the lock is held.
 *
 * Upstream marks the state below `private` and befriends `Lock` and `CriticalSection`.
 * TypeScript has no friendship, and `protected` would not let `CriticalSection` reach these
 * members on its *parent* gate, which `succeeded()` does. The boundary that actually holds is
 * the package facade in `src/index.ts`, which exports none of these types.
 */
export class InputGate {
  readonly hooks: InputGateHooks;

  /**
   * How many instances of `Lock` currently exist? When this reaches zero, we'll release some
   * waiters.
   *
   * Upstream also carries a `bool isCriticalSection`, because `CriticalSection` inherits
   * `InputGate` privately and has to `static_cast` back. `instanceof` is the same test with no
   * cast and no field that can disagree with the object it describes.
   */
  lockCount = 0;

  readonly waiters: Waiter[] = [];

  /**
   * Waiters representing CriticalSections that are ready to start. These take priority over other
   * waiters.
   */
  readonly waitingChildren: Waiter[] = [];

  /** A fulfiller for onBroken(), or an exception if already broken. */
  brokenState: BrokenState;

  readonly #brokenPromise: Promise<never>;

  constructor(hooks: InputGateHooks = DEFAULT_INPUT_GATE_HOOKS) {
    this.hooks = hooks;
    const { promise, reject } = Promise.withResolvers<never>();
    this.#brokenPromise = promise;
    this.brokenState = { kind: "fulfiller", reject };
    // kj's ForkedPromise just holds the exception until someone adds a branch.
    void promise.catch(() => {});
  }

  /** Wait until there are no `Lock`s, then create a new one and return it. */
  wait(signal?: AbortSignal): Promise<Lock> {
    if (signal?.aborted === true) {
      return Promise.reject(makeCanceledError());
    } else if (this.brokenState.kind === "exception") {
      return Promise.reject(this.brokenState.exception);
    } else if (this.lockCount === 0) {
      return Promise.resolve(new Lock(this));
    } else {
      return this.newWaiterPromise(false, signal);
    }
  }

  /**
   * Rejects if and when calls to `wait()` become broken due to a failed critical section. The
   * actor should be shut down in this case. This promise never resolves, only rejects.
   */
  onBroken(): Promise<never> {
    if (this.brokenState.kind === "exception") {
      return Promise.reject(this.brokenState.exception);
    } else {
      return this.#brokenPromise;
    }
  }

  /** ← `kj::newAdaptedPromise<Lock, Waiter>(gate, isChildWaiter, span)`. */
  newWaiterPromise(isChildWaiter: boolean, signal?: AbortSignal): Promise<Lock> {
    const { promise, resolve, reject } = Promise.withResolvers<Lock>();
    const waiter = new Waiter(this, isChildWaiter, resolve, reject);
    const removeAbort = onAbort(signal, () => {
      // ← `~Waiter` on the cancellation path. A waiter that already settled is unlinked, and
      // cancelling it is the no-op that dropping a settled promise is.
      if (!waiter.linked) return;
      waiter.reject(makeCanceledError());
    });
    void promise.then(removeAbort, removeAbort);
    return promise;
  }

  releaseLock(): void {
    if (this instanceof CriticalSection && this.state === "REPARENTED") {
      // This lock was for a critical section that has already completed, therefore the lock
      // should be considered "reparented", and we should forward the release to the parent.

      // Ensure any waiters on us have already been reparented.
      if (this.waitingChildren.length !== 0 || this.waiters.length !== 0 || this.lockCount !== 0) {
        throw new Error("releasing a lock on a reparented CriticalSection that still holds state");
      }

      this.parentAsInputGate().releaseLock();
      return;
    }

    if (this.lockCount === 0) {
      throw new Error("InputGate::releaseLock() with no locks outstanding");
    }
    this.lockCount--;

    // Check if any waiters can be released.
    if (this.lockCount === 0) {
      this.hooks.inputGateReleased();
      const child = this.waitingChildren[0];
      if (child !== undefined) {
        child.fulfill(new Lock(this));
      } else {
        const waiter = this.waiters[0];
        if (waiter !== undefined) {
          waiter.fulfill(new Lock(this));
        }
      }
    }
  }

  /** Called when a critical section fails. All future waiters will throw this exception. */
  setBroken(exception: unknown): void {
    // `reject()` unlinks the waiter it settles, so walk copies of both lists.
    for (const waiter of [...this.waitingChildren]) waiter.reject(exception);
    for (const waiter of [...this.waiters]) waiter.reject(exception);
    if (this.brokenState.kind === "fulfiller") {
      this.brokenState.reject(exception);
    }
    this.brokenState = { kind: "exception", exception };
  }
}

/** ← `InputGate::Lock`. A lock that blocks all new events from being delivered while it exists. */
export class Lock {
  /** ← "Becomes null on move." Here it becomes undefined on `release()`. */
  #gate: InputGate | undefined;

  constructor(gate: InputGate) {
    this.#gate = gate;

    // Upstream keeps a second member, `kj::Own<CriticalSection> cs`, whose job is to hold the
    // section alive for the lock's lifetime. `gate` already points at the same object, and GC
    // does the holding, so here it is a local.
    let gateToLock: InputGate = gate;
    if (gate instanceof CriticalSection && gate.state === "REPARENTED") {
      gateToLock = gate.parentAsInputGate();
    }

    if (++gateToLock.lockCount === 1) {
      gateToLock.hooks.inputGateLocked();
    }
  }

  /** ← `~Lock`. */
  release(): void {
    const gate = this.#gate;
    if (gate === undefined) {
      throw new Error("InputGate::Lock was released twice");
    }
    this.#gate = undefined;
    gate.releaseLock();
  }

  /**
   * Increments the lock's refcount, returning a duplicate `Lock`. All `Lock`s must be released
   * before the gate is unlocked.
   */
  addRef(): Lock {
    return new Lock(this.#requireGate());
  }

  /**
   * Start a new critical section from this lock. After `wait()` has been called on the returned
   * critical section for the first time, no further Locks will be handed out by
   * InputGate::wait() until the CriticalSection has been dropped.
   *
   * CriticalSections can be nested. If this Lock is itself part of a CriticalSection, the new
   * CriticalSection will be nested within it and the outer CriticalSection's wait() won't
   * produce a Lock again until the inner CriticalSection is dropped.
   */
  startCriticalSection(): CriticalSection {
    return new CriticalSection(this.#requireGate());
  }

  /** If this lock was taken in a CriticalSection, return it. */
  getCriticalSection(): CriticalSection | undefined {
    const gate = this.#requireGate();
    return gate instanceof CriticalSection ? gate : undefined;
  }

  isFor(otherGate: InputGate): boolean {
    if (otherGate instanceof CriticalSection) {
      throw new Error("InputGate::Lock::isFor() takes the root gate, not a CriticalSection");
    }

    let ptr = this.#requireGate();
    while (ptr instanceof CriticalSection) {
      ptr = ptr.parentAsInputGate();
    }
    return ptr === otherGate;
  }

  /** ← `operator==`. */
  equals(other: Lock): boolean {
    return this.#requireGate() === other.#requireGate();
  }

  #requireGate(): InputGate {
    const gate = this.#gate;
    if (gate === undefined) {
      throw new Error("InputGate::Lock was used after release");
    }
    return gate;
  }
}

/** ← `InputGate::CriticalSection::State`. */
type CriticalSectionState =
  /** wait() hasn't been called. */
  | "NOT_STARTED"
  /** wait() has been called once, and that wait hasn't finished yet. */
  | "INITIAL_WAIT"
  /** First lock has been obtained, waiting for success() or failed(). */
  | "RUNNING"
  /** success() or failed() has been called. */
  | "REPARENTED";

/**
 * A CriticalSection is a procedure that must not be interrupted by anything "external".
 * While a CriticalSection is running, all events that were not initiated by the
 * CriticalSection itself will be blocked from being delivered.
 *
 * The difference between a Lock and a CriticalSection is that a critical section may succeed
 * or fail. A failed critical section permanently breaks the input gate. Locks, on the other
 * hand, are simply released when dropped.
 *
 * A CriticalSection itself holds a Lock, which blocks the "parent scope" from continuing
 * execution until the critical section is done. Meanwhile, the code running inside the critical
 * section obtains nested Locks. These nested locks control concurrency of the operations
 * initiated within the critical section in the same way that input locks normally do at the
 * top-level scope. E.g., if a critical section initiates a storage read and a fetch() at the
 * same time, the fetch() is prevented from returning until after the storage read has returned.
 */
export class CriticalSection extends InputGate {
  state: CriticalSectionState = "NOT_STARTED";

  /**
   * Points to the parent scope, which may be another CriticalSection in the case of nesting.
   * ← `kj::OneOf<InputGate*, kj::Own<CriticalSection>>`; the two arms are one `instanceof` apart.
   */
  readonly #parent: InputGate;

  /**
   * A lock in the parent scope. `parentLock` becomes non-null after the first lock is obtained,
   * and becomes null again when succeeded() is called.
   */
  #parentLock: Lock | undefined;

  constructor(parent: InputGate) {
    // Upstream's CriticalSection has no base initializer, so it gets `Hooks::DEFAULT` rather than
    // the parent gate's hooks: metrics are counted once, at the root.
    super();
    this.#parent = parent;
  }

  /**
   * Wait for a nested lock in order to continue this CriticalSection.
   *
   * The first call to wait() begins the CriticalSection. After that wait completes, until the
   * CriticalSection is done and dropped, no other locks will be allowed on this InputGate, except
   * locks requested by calling wait() on this CriticalSection -- or one of its children.
   *
   * Everything before the first `await` runs in the caller's synchronous slice, which is what
   * lets the NOT_STARTED path take its parent lock before any other event can queue behind it.
   */
  override async wait(signal?: AbortSignal): Promise<Lock> {
    // Before the state machine, not inside it: the NOT_STARTED arm takes a parent lock in its
    // synchronous slice, and a cancelled wait must not leave one behind.
    if (signal?.aborted === true) throw makeCanceledError();

    for (;;) {
      switch (this.state) {
        case "NOT_STARTED": {
          this.state = "INITIAL_WAIT";

          const target = this.parentAsInputGate();
          if (target.brokenState.kind === "exception") {
            // Oops, we're broken.
            const exception = target.brokenState.exception;
            this.setBroken(exception);
            throw exception;
          }

          // Add ourselves to this parent's child waiter list.
          if (target.lockCount === 0) {
            this.state = "RUNNING";
            this.#parentLock = new Lock(target);
            continue;
          } else {
            let lock: Lock;
            try {
              lock = await target.newWaiterPromise(true, signal);
            } catch (exception) {
              // kj destroys the coroutine on cancellation, so no catch runs and the state stays
              // INITIAL_WAIT — the case `drop()` calls "had better have been canceled".
              if (exception instanceof CanceledError) throw exception;
              this.state = "RUNNING";
              this.setBroken(exception);
              throw exception;
            }
            this.state = "RUNNING";
            this.#parentLock = lock;
            continue;
          }
        }
        case "INITIAL_WAIT":
          // To avoid the need for a ForkedPromise, we assume wait() is called once initially to
          // get things started. This is the case in practice because any further tasks would be
          // started only after some code runs under the initial lock.
          throw new Error("CriticalSection::wait() should be called once initially");
        case "RUNNING":
          // CriticalSection is active, so defer to InputGate implementation.
          return await super.wait(signal);
        case "REPARENTED":
          // Once the CriticalSection has declared itself done, then any straggler tasks it
          // initiated are adopted by the parent. Upstream needs a KJ_SWITCH_ONEOF here so as not
          // to bypass a parent CriticalSection's own override of wait(); JS is always virtual.
          return await this.#parent.wait(signal);
      }
    }
  }

  /**
   * Call when the critical section has completed successfully. If this is not called before the
   * CriticalSection is dropped, then failed() is called implicitly.
   *
   * Returns the input lock that was held on the parent critical section. This can be used to
   * continue execution in the parent before any other input arrives.
   */
  succeeded(): Lock {
    if (this.state !== "RUNNING") {
      throw new Error("CriticalSection::succeeded() requires a running critical section");
    }

    // Once the CriticalSection has declared itself done, then any straggler tasks it initiated are
    // adopted by the parent. Appending preserves FIFO order against the parent's own waiters.
    const parentGate = this.parentAsInputGate();
    for (const waiter of this.waitingChildren) waiter.gate = parentGate;
    parentGate.waitingChildren.push(...this.waitingChildren);
    this.waitingChildren.length = 0;
    for (const waiter of this.waiters) waiter.gate = parentGate;
    parentGate.waiters.push(...this.waiters);
    this.waiters.length = 0;
    parentGate.lockCount += this.lockCount;
    this.lockCount = 0;

    this.state = "REPARENTED";
    const result = this.#parentLock;
    if (result === undefined) {
      throw new Error("CriticalSection::succeeded() with no parent lock");
    }
    this.#parentLock = undefined;
    return result;
  }

  /**
   * Call to indicate the CriticalSection has failed with the given exception. This immediately
   * breaks the InputGate.
   */
  failed(exception: unknown): void {
    if (this.brokenState.kind === "exception") {
      // Already failed I guess.
      return;
    }

    this.setBroken(exception);
    if (this.#parent instanceof CriticalSection) {
      this.#parent.failed(exception);
    } else {
      this.#parent.setBroken(exception);
    }
  }

  /** ← `~CriticalSection`. */
  drop(): void {
    switch (this.state) {
      case "NOT_STARTED":
        // Oh well.
        break;
      case "INITIAL_WAIT":
        // The initial wait() had better have been canceled... but we have no way to tell here.
        break;
      case "RUNNING":
        this.failed(
          new Error(
            "jsg.Error: A critical section within this Durable Object awaited a Promise that " +
              "apparently will never complete. This could happen in particular if a critical " +
              "section awaits a task that was initiated outside of the critical section. Since " +
              "a critical section blocks all other tasks from completing, this leads to " +
              "deadlock.",
          ),
        );
        break;
      case "REPARENTED":
        // Common case.
        break;
    }

    // `parentLock` is a `kj::Maybe<Lock>` MEMBER (`io-gate.h:234`), so the destructor body above
    // is followed by its destruction, which hands the parent lock back. After the switch, not
    // inside it: `failed()` must see the lock count upstream would show it.
    //
    // Only RUNNING can still hold one, and not even always — see `wait()`'s catch arm, which
    // sets RUNNING for a section broken during its initial wait without ever acquiring a lock.
    // NOT_STARTED and INITIAL_WAIT never assign it, and REPARENTED gave it away in
    // `succeeded()`. Clearing first, as `succeeded()` does, makes a second drop a no-op rather
    // than a "released twice" throw.
    const parentLock = this.#parentLock;
    if (parentLock !== undefined) {
      this.#parentLock = undefined;
      parentLock.release();
    }
  }

  /** Return a reference for the parent scope, skipping any reparented CriticalSections */
  parentAsInputGate(): InputGate {
    // Upstream walks a `ptr` starting at `this` and reads `ptr->parent` each turn; walking the
    // parent link itself visits the same chain without aliasing `this`.
    let parent = this.#parent;
    for (;;) {
      if (!(parent instanceof CriticalSection)) return parent;
      if (parent.state !== "REPARENTED") return parent;
      // Keep looping...
      parent = parent.#parent;
    }
  }
}

// =======================================================================================
// makeReentryCallback

/**
 * ← the gate half of `IoContext::makeReentryCallback()` (`io-context.h:1507`), which is
 * `ctx.run(func, { input: cs })` with the critical section captured here rather than looked up later.
 *
 * Upstream, on why the critical section travels with the callback at all:
 *
 * > "What if the call was made within blockConcurrencyWhile()? The callback will be blocked until
 * > the critical section ends, which could lead to deadlock if the critical section code is
 * > waiting on it? ... The callback is allowed to run within the critical section
 * > (blockConcurrencyWhile()) from which it was called."
 *
 * `criticalSection` must come from the capturing lock's `getCriticalSection()`, at the moment of
 * capture. It cannot be recovered from gate state on invocation: a *new* external event that
 * inherited the running section would skip the queue, and `blockConcurrencyWhile` would silently
 * block nothing (Part 4).
 *
 * The lock covers the callback's synchronous slice and is released when the callback returns
 * control — decision 1, and the reason a callback that awaits something does not wedge the gate.
 * A callback needing the lock across an await takes `lock.addRef()`, which is upstream's
 * `awaitIoWithInputLock` in the one shape io-gate can express (§1.2).
 *
 * The returned function can be called multiple times.
 */
export function makeReentryCallback<Args extends unknown[], Result>(
  gate: InputGate,
  criticalSection: CriticalSection | undefined,
  func: (lock: Lock, ...args: Args) => Result | PromiseLike<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const lock = await (criticalSection === undefined ? gate.wait() : criticalSection.wait());

    let result: Result | PromiseLike<Result>;
    try {
      result = func(lock, ...args);
    } finally {
      lock.release();
    }
    return await result;
  };
}

// =======================================================================================
// OutputGate

/**
 * Hooks that can be used to customize OutputGate behavior. See `InputGateHooks` for why these
 * are injected rather than wrapped.
 */
export interface OutputGateHooks {
  /**
   * Optionally make a promise which should be raced with the lock promise to implement a
   * timeout. The returned promise should be something that throws an exception after some
   * timeout has expired.
   */
  makeTimeoutPromise(): Promise<never>;

  outputGateLocked(): void;
  outputGateReleased(): void;
  outputGateWaiterAdded(): void;
  outputGateWaiterRemoved(): void;
}

/** ← `OutputGate::Hooks::DEFAULT`. */
export const DEFAULT_OUTPUT_GATE_HOOKS: OutputGateHooks = {
  /** ← `kj::NEVER_DONE`. */
  makeTimeoutPromise: () => new Promise<never>(() => {}),
  outputGateLocked() {},
  outputGateReleased() {},
  outputGateWaiterAdded() {},
  outputGateWaiterRemoved() {},
};

/** ← `kj::Own<kj::PromiseFulfiller<void>>`, the one link `lockWhile` holds in the chain. */
interface VoidFulfiller {
  isWaiting(): boolean;
  fulfill(): void;
  reject(exception: unknown): void;
}

/** ← `OutputGate::makeUnfulfilledException()`. */
function makeUnfulfilledException(): Error {
  return new Error("output lock was canceled before completion");
}

/**
 * An OutputGate blocks outgoing messages from an Actor until writes which they might depend on
 * are confirmed.
 *
 * A promise chain, not a counter (§1.1): each `lockWhile` joins a new link onto the chain and
 * re-forks it, so a `wait()` is bound to exactly the locks outstanding when it was taken and is
 * unaffected by any later `lockWhile`.
 */
export class OutputGate {
  readonly #hooks: OutputGateHooks;
  #pastLocksPromise: Promise<void> = Promise.resolve();
  /** A fulfiller for onBroken(), or an exception if already broken. */
  #brokenState: BrokenState = { kind: "none" };

  constructor(hooks: OutputGateHooks = DEFAULT_OUTPUT_GATE_HOOKS) {
    this.#hooks = hooks;
  }

  /**
   * Block all future `wait()` calls until `promise` completes. Returns a wrapper around
   * `promise`. If `promise` rejects, the exception will propagate to all future `wait()`s. If the
   * returned promise is canceled before completion, all future `wait()`s will also throw.
   */
  lockWhile<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    const fulfiller = this.#lock();
    const raced = Promise.race([promise, this.#hooks.makeTimeoutPromise()]);

    this.#hooks.outputGateLocked();

    return new Promise<T>((resolve, reject) => {
      // ← the `kj::defer(rejectIfCanceled)` arm that runs when the coroutine is destroyed.
      // Upstream leaves the dropped promise unobservable; here the caller still holds it, and a
      // promise that never settles is a hang nobody can see, so it takes the same exception.
      const removeAbort = onAbort(signal, () => {
        // The guard comes first, as it does in `Waiter`. Upstream can call the hook before its
        // own check because `kj::defer` runs once ever, on whichever path exits the scope; an
        // abort listener can fire after the lock already settled, so the invariant to preserve
        // is "exactly one release per lockWhile", not upstream's statement order.
        if (!fulfiller.isWaiting()) return;
        this.#hooks.outputGateReleased();
        const exception = makeUnfulfilledException();
        this.#setBroken(exception);
        fulfiller.reject(exception);
        reject(exception);
      });

      void raced.then(
        (value) => {
          removeAbort();
          // kj would have destroyed this frame on cancellation; there is nothing left to settle.
          if (!fulfiller.isWaiting()) return;
          fulfiller.fulfill();
          this.#hooks.outputGateReleased();
          resolve(value);
        },
        (exception: unknown) => {
          removeAbort();
          if (!fulfiller.isWaiting()) return;
          this.#setBroken(exception);
          fulfiller.reject(exception);
          this.#hooks.outputGateReleased();
          reject(exception);
        },
      );
    });
  }

  /**
   * Wait until all preceding locks are released. The wait will not be affected by any future
   * call to `lockWhile()`.
   */
  wait(): Promise<void> {
    this.#hooks.outputGateWaiterAdded();
    return this.#pastLocksPromise.then(
      () => {
        this.#hooks.outputGateWaiterRemoved();
      },
      (exception: unknown) => {
        this.#hooks.outputGateWaiterRemoved();
        throw exception;
      },
    );
  }

  /**
   * Rejects if and when calls to `wait()` become broken due to a failed lockWhile(). The actor
   * should be shut down in this case. This promise never resolves, only rejects.
   *
   * This method can only be called once.
   */
  onBroken(): Promise<never> {
    if (this.#brokenState.kind === "fulfiller") {
      throw new Error("onBroken() can only be called once");
    }

    if (this.#brokenState.kind === "exception") {
      return Promise.reject(this.#brokenState.exception);
    } else {
      const { promise, reject } = Promise.withResolvers<never>();
      this.#brokenState = { kind: "fulfiller", reject };
      void promise.catch(() => {});
      return promise;
    }
  }

  isBroken(): boolean {
    return this.#brokenState.kind === "exception";
  }

  #lock(): VoidFulfiller {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    // ← `kj::joinPromises`, which waits for EVERY branch and only then propagates the first
    // exception. `Promise.all` is fail-fast, which "OutputGate exception" explicitly forbids: a
    // later lock failing must not release an earlier `wait()`.
    this.#setPastLocks(
      Promise.allSettled([this.#pastLocksPromise, promise]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
      }),
    );

    let waiting = true;
    return {
      isWaiting: () => waiting,
      fulfill: () => {
        waiting = false;
        resolve();
      },
      reject: (exception) => {
        waiting = false;
        reject(exception);
      },
    };
  }

  #setPastLocks(promise: Promise<void>): void {
    this.#pastLocksPromise = promise;
    // kj's ForkedPromise holds a rejection with no branches attached; JS calls that unhandled.
    void promise.catch(() => {});
  }

  #setBroken(exception: unknown): void {
    // We assume the exception is already propagated into `pastLocksPromise`, so all we need to do
    // is handle onBroken().
    if (this.#brokenState.kind === "fulfiller") {
      this.#brokenState.reject(exception);
    }
    this.#brokenState = { kind: "exception", exception };
  }
}
