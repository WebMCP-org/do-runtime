/**
 * ← workerd `src/workerd/io/actor-sqlite.{h,c++}`
 *
 * The storage engine. Owns:
 *  - implicit transactions, bounded by GATE RELEASE rather than by an
 *    event-loop turn (§1.7.1 — measured; a storage await does not end the
 *    transaction, a timer or outbound await does);
 *  - `onWrite` taking the output-gate lock at the first must-confirm write,
 *    one lock per flush batch;
 *  - `transactionSync` as SAVEPOINT/RELEASE/ROLLBACK TO with a depth counter,
 *    plus the async-callback guard today's version lacks;
 *  - alarm arm/consume/deferred-deletion, and `deleteAll`.
 *
 * Sole `ActorCacheInterface` implementation, exactly as on workerd-with-SQLite.
 *
 * The single most important constraint in the whole port lives here: the
 * transaction boundary and the gate boundary are the same line. Implement them
 * as one mechanism. Release at every await — the naive reading of §1.2 — and
 * every multi-statement write silently loses atomicity, with nothing failing
 * until a crash lands between two statements that were meant to be one.
 *
 * **How that one line is drawn here, since it is the question the design record
 * left open.** Upstream needs no gate hook: `startImplicitTxn` wraps the commit
 * in `kj::evalLater`, which runs it on the next turn of the KJ event loop, and
 * the next KJ turn is by construction after the isolate run — which is after
 * `js.runMicrotasks()`, which is after `KJ_DEFER` clears `currentInputLock`.
 * "Next turn" and "gate release" are one boundary upstream, so `ActorSqlite`
 * hangs the commit on the cheaper of the two. They are one boundary here for the
 * same reason, provided the commit rides `atCheckpointEnd` — the primitive
 * `io-context.ts` releases on. Its comment carries the proof; the short form is
 * that holding the lock across an await is a pure microtask chain and releasing
 * it always costs a hand-off, so no write can cross a hand-off inside one
 * transaction and no two events can share one. `IoContext` therefore grows no
 * per-invocation exit notification, and the root gate's `inputGateReleased` hook
 * is *not* the right edge: it fires when `lockCount` hits zero, which never
 * happens inside a critical section, so decision 4's fifteen boot phases would
 * become a single transaction nobody chose.
 *
 * `onWrite` and `onCriticalError` are `SqliteDatabase`'s, in `util/sqlite.ts`,
 * exactly as upstream has them, and the constructor binds itself to both the way
 * `ActorSqlite`'s does. What is ours is only the substitute for the question
 * upstream answers with `sqlite3_stmt_readonly()` — see `isWrite` there.
 *
 * Not ported, because the substrate has no equivalent to port onto: `SpanParent`
 * tracing, already a Section 1 divergence, so every `traceSpan` parameter and
 * `currentCommitSpan` with it; `debugAlarmSync` and every `LOG_*`, which are a
 * logger this package does not have; and `TxnCommitRegulator::onError`, which
 * re-reports `SQLITE_CONSTRAINT` during commit as a user-visible error — error
 * codes do not cross the backend seam, the same reason Section 3 dropped
 * `SqliteKvRegulator::onError`.
 *
 * Spec: §1.4, §1.7, §1.7.1, §1.8, §2.4, §2.6, decisions 2, 5, 6 and 7 in
 * docs/decisions.md.
 */

import type {
  ActorCacheInterface,
  ActorCacheTransaction,
  ArmAlarmResult,
  DeferredAlarmDeleter,
  DeleteAllOptions,
  DeleteAllResults,
  GetResultList,
  Key,
  KeyValuePair,
  ReadOptions,
  Value,
  WriteOptions,
} from "./actor-cache";
import {
  PITR_UNIMPLEMENTED_MESSAGE,
  REPLICATION_UNIMPLEMENTED_MESSAGE,
  SHUTDOWN_ERROR_MESSAGE,
} from "./actor-cache";
import { atCheckpointEnd } from "./io-context";
import type { OutputGate } from "./io-gate";
import { SqliteKv } from "../util/sqlite-kv";
import { SqliteMetadata } from "../util/sqlite-metadata";
import { type SqliteCriticalError, SqliteDatabase } from "../util/sqlite";

/**
 * The alarm port — one outbound method, matching upstream's seam exactly.
 *
 * Everything else about alarms is runtime-internal: arm/consume semantics here,
 * retry ladder and serialised delivery in `server/alarm-scheduler.ts`. Delivery
 * comes back IN through `ActorContainer.deliverAlarm`, not through this port.
 */
export interface AlarmOutlet {
  /**
   * Must be durable before the returned promise resolves.
   *
   * `priorTask` is upstream's second parameter and is load bearing rather than
   * decorative: "any work we must wait on prior to scheduling the new request,
   * as of this writing, this would be the alarmLaterInFlight promise, which
   * tracks any in-flight request to move the alarm 'later' than is currently
   * set." An implementation that ignores it can send a move-earlier request
   * concurrently with a move-later one and lose the ordering invariant that the
   * scheduled alarm is always at or before the persisted one.
   *
   * May throw synchronously; `ActorSqlite` relies on it, because a scheduling
   * failure has to reach the caller before the local database commits.
   */
  scheduleRun(newAlarmTime: number | null, priorTask: Promise<void>): Promise<void>;
}

/** ← `ActorSqlite::Hooks::DEFAULT`, whose `scheduleRun` refuses. */
export const DEFAULT_ALARM_OUTLET: AlarmOutlet = {
  scheduleRun(): Promise<void> {
    throw new Error("alarms are not yet implemented for SQLite-backed Durable Objects");
  },
};

// =======================================================================================
// The anonymous namespace at the top of actor-sqlite.c++

/** Returns true if a given (set or unset) alarm will fire earlier than another. */
function willFireEarlier(alarm1: number | null, alarm2: number | null): boolean {
  // Intuitively, an unset alarm is effectively indistinguishable from an alarm set at infinity.
  return (alarm1 ?? Infinity) < (alarm2 ?? Infinity);
}

/**
 * Set options.allowUnconfirmed to false and log a reason why.
 *
 * Upstream mutates the caller's bag and logs; there is no logger here and the
 * bag belongs to the caller, so the disabled copy is returned instead.
 */
function disableAllowUnconfirmed(options: WriteOptions, _reason: string): WriteOptions {
  return { ...options, allowUnconfirmed: false };
}

/**
 * ← `kj::evalLater`, which is where upstream's implicit transaction commits.
 *
 * See `atCheckpointEnd` in `io-context.ts` for why that primitive and not
 * `queueMicrotask`, `setTimeout`, or a hook on the input gate.
 */
function evalLater<T>(func: () => Promise<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  atCheckpointEnd(() => {
    func().then(resolve, reject);
  });
  return promise;
}

/**
 * ← `kj::TaskSet` plus its `ErrorHandler`. `ActorSqlite` owns one of its own,
 * separate from `IoContext`'s, exactly as upstream does.
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
}

// =======================================================================================
// ActorSqlite

/** ← `kj::OneOf<NoTxn, ImplicitTxn*, ExplicitTxn*>`. */
type CurrentTxn =
  | { readonly kind: "none" }
  | { readonly kind: "implicit"; readonly txn: ImplicitTxn }
  | { readonly kind: "explicit"; readonly txn: ExplicitTxn };

const NO_TXN: CurrentTxn = { kind: "none" };

/** ← `ActorSqlite::PrecommitAlarmState`. */
type PrecommitAlarmState = {
  /** Promise for the completion of precommit alarm scheduling */
  schedulingPromise?: Promise<void>;
};

/**
 * An implementation of ActorCacheOps that is backed by SqliteKv.
 *
 * Constructing one arranges to honor the output gate, that is, any writes to the
 * database which occur without any `await`s in between will automatically be
 * combined into a single atomic write. This is accomplished using transactions.
 * In addition to ensuring atomicity, this tends to improve performance, as
 * SQLite is able to coalesce writes across statements that modify the same page.
 *
 * `commitCallback` will be invoked after committing a transaction. The output
 * gate will block on the returned promise. This can be used e.g. when the
 * database needs to be replicated to other machines before being considered
 * durable.
 *
 * Members upstream marks `private` and reaches through `ImplicitTxn` and
 * `ExplicitTxn`, which are nested classes with implicit friendship, are ordinary
 * members here for the reason `io-gate.ts` gives: TypeScript has no friendship,
 * and the boundary that actually holds is the package facade in `src/index.ts`.
 */
export class ActorSqlite implements ActorCacheInterface {
  /** Upstream-private; reached by the two transaction classes. */
  readonly db: SqliteDatabase;
  /** Upstream-private; reached by the two transaction classes. */
  readonly outputGate: OutputGate;
  /** Upstream-private; reached by the two transaction classes. */
  readonly commitTasks: TaskSet;
  readonly #kv: SqliteKv;
  readonly #metadata: SqliteMetadata;

  readonly #commitCallback: () => Promise<void>;
  readonly #hooks: AlarmOutlet;

  /** Upstream-private; the transaction classes read it to skip their rollback. */
  broken: unknown | undefined;

  /**
   * When set to `none`, there is no transaction outstanding.
   *
   * When set to an `ImplicitTxn`, an implicit transaction is currently open,
   * owned by `commitTasks`. If there is a need to commit this early, e.g. to
   * start an explicit transaction, that can be done through this reference.
   *
   * When set to an `ExplicitTxn`, an explicit transaction is currently open, so
   * no implicit transactions should be used in the meantime.
   */
  currentTxn: CurrentTxn = NO_TXN;

  /** If true, then a commit is scheduled as a result of deleteAll() having been called. */
  #deleteAllCommitScheduled = false;

  /**
   * State for tracking completion of all commits (both confirmed and
   * unconfirmed) for implementing sync() in onNoPendingFlush.
   *
   * Upstream-private; `ExplicitTxn::commit` replaces it.
   */
  lastCommit: Promise<void> = Promise.resolve();

  /**
   * We need to track some additional alarm state to guarantee at-least-once
   * alarm delivery: within an alarm handler, we want the observable alarm state
   * to look like the running alarm was deleted at the start of the handler (when
   * armAlarmHandler() is called), but we don't actually want to persist that
   * deletion until after the handler has successfully completed.
   *
   * Upstream-private; `ExplicitTxn::commit` clears it when the txn was alarm-dirty.
   */
  haveDeferredDelete = false;

  /** Some state only used for tracking calling invariants. */
  #inAlarmHandler = false;

  /** The alarm state for which we last received confirmation that the db was durably stored. */
  #lastConfirmedAlarmDbState: number | null;

  /**
   * The latest time we'd expect a scheduled alarm to fire, given the current set
   * of in-flight scheduling requests, without yet knowing if any of them
   * succeeded or failed. We use this value to maintain the invariant that the
   * scheduled alarm is always equal to or earlier than the alarm value in the
   * persisted database state.
   */
  #alarmScheduledNoLaterThan: number | null;

  /** A promise for an in-progress alarm notification update and database commit. */
  #pendingCommit: Promise<void> | undefined;

  /**
   * Promise for the currently in-flight "move alarm later" operation, if any.
   * Used to serialize move-earlier operations against any pending move-later
   * operation.
   */
  #alarmLaterInFlight: Promise<void> = Promise.resolve();

  /** True when a "move alarm later" request is currently in-flight via scheduleLaterAlarm(). */
  #alarmLaterIsInFlight = false;

  /**
   * When a "move alarm later" request is already in-flight and we need to
   * schedule another one, we store the desired alarm time here. When the
   * in-flight request completes, it checks this variable and starts a new
   * request if needed. `undefined` means there is no pending time at all; null
   * means "clear the alarm".
   */
  #pendingLaterAlarmTime: number | null | undefined;

  /**
   * Version counter that increments on every alarm change. Used to detect if
   * another commit modified the alarm while we were async, allowing us to skip
   * redundant post-commit alarm syncs. This provides automatic coalescing of
   * rapid alarm changes.
   */
  #alarmVersion = 0;

  /** ← `DurableObjectStorage::transactionSyncDepth`; see `transactionSync`. */
  #transactionSyncDepth = 0;

  constructor(
    db: SqliteDatabase,
    outputGate: OutputGate,
    commitCallback: () => Promise<void>,
    hooks: AlarmOutlet = DEFAULT_ALARM_OUTLET,
  ) {
    this.db = db;
    this.outputGate = outputGate;
    this.#commitCallback = commitCallback;
    this.#hooks = hooks;
    this.#kv = new SqliteKv(db);
    this.#metadata = new SqliteMetadata(db);
    this.commitTasks = new TaskSet((exception) => {
      this.#taskFailed(exception);
    });

    db.onWrite((allowUnconfirmed) => {
      this.#onWrite(allowUnconfirmed);
    });
    db.onCriticalError((exception) => {
      this.#onCriticalError(exception);
    });
    this.#lastConfirmedAlarmDbState = this.#metadata.getAlarm();

    // Because we preserve an invariant that scheduled alarms are always at or earlier than
    // persisted db alarm state, it should be OK to populate our idea of the latest scheduled alarm
    // using the current db alarm state. At worst, it may perform one unnecessary scheduling
    // request in cases where a previous alarm-state-altering transaction failed.
    this.#alarmScheduledNoLaterThan = this.#metadata.getAlarm();
  }

  isCommitScheduled(): boolean {
    return this.currentTxn.kind !== "none" || this.#deleteAllCommitScheduled;
  }

  getSqliteDatabase(): SqliteDatabase {
    return this.db;
  }

  getSqliteKv(): SqliteKv {
    this.requireNotBroken();
    return this.#kv;
  }

  // -----------------------------------------------------------------
  // Transaction plumbing

  #onCriticalError(exception: SqliteCriticalError): void {
    // If we have already experienced a terminal exception, no need to replace it
    if (this.broken === undefined) {
      const broken = new Error(`broken.outputGateBroken; ${exception.message}`, {
        cause: exception,
      });
      this.broken = broken;

      // Also ensure output gate is explicitly broken.
      this.commitTasks.add(this.outputGate.lockWhile(Promise.reject(broken)));
    }
  }

  #startImplicitTxn(): void {
    const txn = new ImplicitTxn(this);

    // We implement the magic of accumulating all of the writes between JavaScript awaits in one
    // transaction by wrapping the commit function with evalLater, which runs the function on the
    // next turn of the event loop.
    const commitPromise = evalLater(async (): Promise<void> => {
      try {
        // Don't commit if shutdown() has been called.
        this.requireNotBroken();

        // Start the schedule request before commit(), for correctness in workerd.
        const precommitAlarmState = this.startPrecommitAlarmScheduling();

        try {
          txn.commit();
        } catch (exception) {
          // HACK: If we became broken during `COMMIT TRANSACTION` then throw the broken exception
          // instead of whatever SQLite threw.
          this.requireNotBroken();

          // No, we're not broken, so propagate the exception as-is.
          throw exception;
        }

        // The callback is only expected to commit writes up until this point. Any new writes that
        // occur while the callback is in progress are NOT included, therefore require a new commit
        // to be scheduled. So, we should drop `txn` to cause `currentTxn` to become NoTxn now,
        // rather than after the callback.
        txn.drop();

        await this.commitImpl(precommitAlarmState);
      } finally {
        // ← the coroutine frame's destruction, which rolls the transaction back on any path that
        // did not reach the drop above.
        txn.drop();
      }
    }).catch(async (exception: unknown): Promise<void> => {
      // Unconditionally break the output gate if commit threw an error, no matter whether the
      // commit was confirmed or unconfirmed.
      await this.outputGate.lockWhile(Promise.reject(exception));
    });

    this.commitTasks.add(commitPromise);

    // Commits must be executed in order, so we only have to track the most recent commit promise.
    this.lastCommit = commitPromise;
  }

  #onWrite(allowUnconfirmed: boolean): void {
    this.requireNotBroken();
    if (this.currentTxn.kind === "none") {
      this.#startImplicitTxn();
    }

    // Update the status of the current transaction.
    const current = this.currentTxn;
    switch (current.kind) {
      case "none":
        throw new Error("we must have a transaction at this point");
      case "implicit":
        if (!current.txn.isSomeWriteConfirmed() && !allowUnconfirmed) {
          // This is adding a must-confirm write to the transaction, so we must ensure the
          // outputGate locks for remainder of this transaction.
          current.txn.setSomeWriteConfirmed(true);
          this.commitTasks.add(this.outputGate.lockWhile(this.lastCommit));
        }
        break;
      case "explicit":
        if (!current.txn.isSomeWriteConfirmed() && !allowUnconfirmed) {
          // ExplicitTxns don't have a pending commit and don't lock the output gate during the
          // transaction, so there's nothing to do here.
          current.txn.setSomeWriteConfirmed(true);
        }
        break;
    }
  }

  // -----------------------------------------------------------------
  // Alarm scheduling

  /**
   * Issues a request to the alarm scheduler for the given time, returning a
   * promise that resolves when the request is confirmed.
   *
   * Not an `async` function, because it is important for correctness that a
   * synchronously thrown exception in scheduleRun() can escape synchronously to
   * the caller.
   */
  #requestScheduledAlarm(requestedTime: number | null, priorTask: Promise<void>): Promise<void> {
    const movingAlarmLater = willFireEarlier(this.#alarmScheduledNoLaterThan, requestedTime);
    if (movingAlarmLater) {
      // Since we are setting the alarm to be later, we can update alarmScheduledNoLaterThan
      // immediately and still preserve the invariant that the scheduled alarm time is equal to or
      // earlier than the persisted db alarm value.
      this.#alarmScheduledNoLaterThan = requestedTime;
    }

    return this.#hooks.scheduleRun(requestedTime, priorTask).then(() => {
      if (!movingAlarmLater) {
        this.#alarmScheduledNoLaterThan = requestedTime;
      }
    });
  }

  /**
   * Schedules a "move alarm later" operation. If no move-later is currently
   * in-flight, starts one immediately. If one is already in-flight, stores the
   * desired time in `pendingLaterAlarmTime` so it will be picked up when the
   * current in-flight operation completes.
   */
  #scheduleLaterAlarm(newAlarmTime: number | null): void {
    if (this.#alarmLaterIsInFlight) {
      // There's already a move-later request in-flight. Just store the desired time; the in-flight
      // request's completion handler will pick it up and start a new request. This overwrites any
      // previously pending time, which is fine -- only the latest value matters.
      this.#pendingLaterAlarmTime = newAlarmTime;
      return;
    }

    this.#alarmLaterIsInFlight = true;
    this.#alarmLaterInFlight = this.#requestScheduledAlarm(
      newAlarmTime,
      this.#alarmLaterInFlight,
    ).catch(() => {
      // If an exception occurs when scheduling the alarm later, it's OK -- the alarm will
      // eventually fire at the earlier time, and the rescheduling will be retried.
      // We catch here to prevent the chain from breaking on errors.
    });

    this.commitTasks.add(
      this.#alarmLaterInFlight
        .then(() => {
          this.#alarmLaterIsInFlight = false;
          const nextTime = this.#pendingLaterAlarmTime;
          if (nextTime !== undefined) {
            this.#pendingLaterAlarmTime = undefined;
            this.#scheduleLaterAlarm(nextTime);
          }
        })
        .catch(() => {
          // Move-later alarm failures are non-fatal; catch here to prevent taskFailed() from
          // breaking the output gate.
        }),
    );
  }

  /**
   * To be called just before committing the local sqlite db, to synchronously
   * start any necessary alarm scheduling.
   *
   * Upstream-private; `ExplicitTxn::commit` calls it for the root transaction.
   */
  startPrecommitAlarmScheduling(): PrecommitAlarmState {
    const state: PrecommitAlarmState = {};
    if (
      this.#pendingCommit === undefined &&
      willFireEarlier(this.#metadata.getAlarm(), this.#alarmScheduledNoLaterThan)
    ) {
      // We must wait on the `alarmLaterInFlight` promise here, otherwise, if there is an in-flight
      // "move later" alarm task and it fails, our "move earlier" alarm might interleave, succeed,
      // and be followed by a retry of the in-flight "move later" alarm.
      //
      // Clear any pending move-later alarm time. Since we are about to move the alarm earlier, any
      // coalesced later time is now obsolete. This also prevents the scheduleLaterAlarm completion
      // handler from starting a concurrent scheduleRun when it drains pendingLaterAlarmTime after
      // the current in-flight request resolves.
      this.#pendingLaterAlarmTime = undefined;
      state.schedulingPromise = this.#requestScheduledAlarm(
        this.#metadata.getAlarm(),
        this.#alarmLaterInFlight,
      );
    }
    return state;
  }

  /**
   * Performs the rest of the asynchronous commit, to be waited on after
   * committing the local sqlite db. Should be called in the same turn of the
   * event loop as startPrecommitAlarmScheduling() and passed the state that it
   * returned.
   *
   * Upstream-private; `ExplicitTxn::commit` calls it for the root transaction.
   */
  async commitImpl(precommitAlarmState: PrecommitAlarmState): Promise<void> {
    // We assume that exceptions thrown during commit will propagate to the caller, such that they
    // will ensure cancelDeferredAlarmDeletion() is called, if necessary.

    const pending = this.#pendingCommit;
    if (pending !== undefined) {
      // If an earlier commitImpl() invocation is already in the process of updating precommit
      // alarms but has not yet made the commitCallback() call, it should be OK to wait on it to
      // perform the precommit alarm update and db commit for this invocation, too.
      await pending;
      return;
    }

    // There are no pending commits in-flight, so we set up a promise that other callers can wait
    // on, to perform the alarm scheduling and database persistence work for all of them. If an
    // exception is thrown below, it is propagated to the other waiters before it is rethrown, which
    // is what upstream gets from the fulfiller's destructor noticing the stack unwinding.
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#pendingCommit = promise;
    void promise.catch(() => {});

    try {
      // Wait for the first precommit alarm scheduling request to complete, if any. This was set up
      // in startPrecommitAlarmScheduling() and is essentially the first iteration of the below
      // loop, but needed to be initiated synchronously before the local database commit to ensure
      // correctness in workerd.
      if (precommitAlarmState.schedulingPromise !== undefined) {
        await precommitAlarmState.schedulingPromise;
      }

      // While the local db state requires an earlier alarm than is known might be scheduled, issue
      // an alarm update request for the earlier time and wait for it to complete. This helps ensure
      // that the successfully scheduled alarm time is always earlier or equal to the alarm state in
      // the successfully persisted db.
      //
      // Note that we do not pass alarmLaterInFlight here: we already waited for it above, and
      // `pendingCommit` was set before yielding, so no one could have started another "move-later"
      // alarm until we finish.
      while (willFireEarlier(this.#metadata.getAlarm(), this.#alarmScheduledNoLaterThan)) {
        await this.#requestScheduledAlarm(this.#metadata.getAlarm(), Promise.resolve());
      }

      // Issue the commitCallback() request to persist the db state, then synchronously clear the
      // pending commit so that the next commitImpl() invocation starts its own set of precommit
      // alarm updates and db commit.
      const alarmStateForCommit = this.#metadata.getAlarm();

      // Capture the alarm version before going async to detect concurrent alarm changes. If the
      // alarmVersion changes while we are in-flight, we should skip attempting any move-later alarm
      // update.
      const alarmVersionBeforeAsync = this.#alarmVersion;

      const commitCallbackPromise = this.#commitCallback();
      this.#pendingCommit = undefined;

      // Wait for the db to persist.
      await commitCallbackPromise;
      this.#lastConfirmedAlarmDbState = alarmStateForCommit;

      // Notify any merged commitImpl() requests that the db persistence completed.
      resolve();

      // If another commit modified the alarm while we were async, skip post-commit alarm sync.
      //
      //  1. The other commit will handle its own alarm sync
      //  2. Post-commit syncs are inherently optional (the alarm will self-correct)
      //  3. This coalesces redundant alarm updates for better performance
      //  4. This avoids race conditions where a later commit moved the alarm earlier, requiring a
      //     pre-commit alarm update, and this update may have already been made before we get here.
      if (this.#alarmVersion === alarmVersionBeforeAsync) {
        // No intervening alarm changes, it is safe to schedule a move-later alarm update if needed.
        if (willFireEarlier(this.#alarmScheduledNoLaterThan, alarmStateForCommit)) {
          this.#scheduleLaterAlarm(alarmStateForCommit);
        }
      }
    } catch (exception) {
      // Upstream leaves `pendingCommit` holding the now-rejected forked promise rather than
      // clearing it: a merged commit still has to see the failure, and by this point the output
      // gate is breaking anyway.
      reject(exception);
      throw exception;
    }
  }

  #taskFailed(exception: unknown): void {
    // The output gate should already have been broken since it wraps all commit tasks that can
    // throw. So, we don't have to report anything here, the exception will already propagate
    // elsewhere. We should block further operations, though.
    if (this.broken === undefined) {
      this.broken = exception;
    }
  }

  /** Upstream-private; the transaction classes call it before touching the db. */
  requireNotBroken(): void {
    if (this.broken !== undefined) {
      throw this.broken;
    }
  }

  /** Called when the deferred alarm deleter is dropped, to delete the alarm if not reset or cancelled during the handler. */
  #maybeDeleteDeferredAlarm(): void {
    // Upstream warns when this runs outside a handler ("pretty sure this can't happen"); there is
    // no logger, and the state update below is what the warning accompanies rather than guards.
    this.#inAlarmHandler = false;

    if (this.haveDeferredDelete) {
      // If we have reached this point, the client is destroying its DeferredAlarmDeleter at the end
      // of an alarm handler run, and deletion hasn't been cancelled, indicating that the handler
      // returned success.
      //
      // If the output gate has somehow broken in the interim, attempting to write the deletion here
      // will cause the drop to throw, which the caller probably isn't expecting. So we'll skip the
      // deletion attempt, and let the caller detect the gate brokenness through other means.
      if (this.broken === undefined) {
        // The safe thing to do is to require confirmation.
        if (this.#metadata.setAlarm(null, false)) {
          this.#alarmVersion += 1;
        }
      }
      this.haveDeferredDelete = false;
    }
  }

  // =======================================================================================
  // ActorCacheInterface implementation

  get(key: Key, _options: ReadOptions = {}): Value | undefined {
    this.requireNotBroken();
    return this.#kv.get(key);
  }

  getMultiple(keys: readonly Key[], _options: ReadOptions = {}): GetResultList {
    this.requireNotBroken();

    const results: KeyValuePair[] = [];
    for (const key of keys) {
      const value = this.#kv.get(key);
      if (value !== undefined) results.push({ key, value });
    }
    results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return results;
  }

  getAlarm(_options: ReadOptions = {}): number | null {
    this.requireNotBroken();

    let transactionAlarmDirty = false;
    if (this.currentTxn.kind === "explicit") {
      transactionAlarmDirty = this.currentTxn.txn.getAlarmDirty();
    }

    if (this.haveDeferredDelete && !transactionAlarmDirty) {
      // If an alarm handler is currently running, and a new alarm time has not been set yet, we
      // need to return that there is no alarm.
      return null;
    }
    return this.#metadata.getAlarm();
  }

  list(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    _options: ReadOptions = {},
  ): GetResultList {
    this.requireNotBroken();

    const results: KeyValuePair[] = [];
    this.#kv.list(begin, end, limit, "FORWARD", (key, value) => {
      results.push({ key, value });
    });

    // Already guaranteed sorted.
    return results;
  }

  listReverse(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    _options: ReadOptions = {},
  ): GetResultList {
    this.requireNotBroken();

    const results: KeyValuePair[] = [];
    this.#kv.list(begin, end, limit, "REVERSE", (key, value) => {
      results.push({ key, value });
    });

    // Already guaranteed sorted (reversed).
    return results;
  }

  put(key: Key, value: Value, options: WriteOptions = {}): void {
    this.requireNotBroken();
    this.#kv.put(key, value, { allowUnconfirmed: options.allowUnconfirmed ?? false });
  }

  putMultiple(pairs: readonly KeyValuePair[], options: WriteOptions = {}): void {
    this.requireNotBroken();
    if (this.currentTxn.kind === "none") {
      // If we are not in a transaction, start an ImplicitTxn since that's what would happen on the
      // first write anyway. `SqliteKv::put(pairs)` opens with a SAVEPOINT, which is not a write, so
      // without this the savepoint would stand alone instead of nesting inside the transaction.
      this.#startImplicitTxn();
    }
    if (this.currentTxn.kind === "none") {
      throw new Error("we must have a transaction at this point");
    }

    this.#kv.put(pairs, { allowUnconfirmed: options.allowUnconfirmed ?? false });
  }

  delete(key: Key, options: WriteOptions = {}): boolean {
    this.requireNotBroken();
    return this.#kv.delete(key, { allowUnconfirmed: options.allowUnconfirmed ?? false });
  }

  deleteMultiple(keys: readonly Key[], options: WriteOptions = {}): number {
    this.requireNotBroken();

    let count = 0;
    for (const key of keys) {
      if (this.#kv.delete(key, { allowUnconfirmed: options.allowUnconfirmed ?? false })) count += 1;
    }
    return count;
  }

  setAlarm(newAlarmTime: number | null, options: WriteOptions = {}): void {
    this.requireNotBroken();

    // Only increment version counter if the alarm value actually changed. This is important because
    // if the value didn't change, no SQLite write occurs, so no implicit transaction is started,
    // and we don't want to invalidate in-flight commits without a replacement commit.
    if (this.#metadata.setAlarm(newAlarmTime, options.allowUnconfirmed ?? false)) {
      this.#alarmVersion += 1;
    }

    if (this.currentTxn.kind === "explicit") {
      this.currentTxn.txn.setAlarmDirty();
    } else {
      this.haveDeferredDelete = false;
    }
  }

  startTransaction(): ActorCacheTransaction {
    this.requireNotBroken();
    return new ExplicitTxn(this);
  }

  deleteAll(options: WriteOptions = {}, deleteAllOptions: DeleteAllOptions = {}): DeleteAllResults {
    this.requireNotBroken();
    const effectiveOptions = disableAllowUnconfirmed(options, "deleteAll is not supported");

    // kv.deleteAll() clears the database, so save and possibly restore the alarm state.
    const localAlarmState = this.#metadata.getAlarm();

    // deleteAll() cannot be part of a transaction because it deletes the database altogether. So,
    // we have to close our transactions or fail.
    const current = this.currentTxn;
    switch (current.kind) {
      case "none":
        // good
        break;
      case "implicit":
        // Whatever the implicit transaction did, it's about to be blown away anyway. Roll it back
        // so we don't waste time flushing these writes anywhere.
        current.txn.rollback();
        this.currentTxn = NO_TXN;
        break;
      case "explicit":
        // Keep in mind:
        //
        //   ctx.storage.transaction(txn => {
        //     txn.deleteAll();          // calls the transaction's deleteAll()
        //     ctx.storage.deleteAll();  // calls this method
        //   });
        //
        // Directly calling `ctx.storage` inside a transaction (as opposed to using the `txn`
        // object) should still be treated as part of the transaction, and so should throw the
        // same thing.
        throw new Error("Cannot call deleteAll() within a transaction");
    }

    if (!this.#deleteAllCommitScheduled) {
      // Make sure a commit callback is queued for the deleteAll().
      this.commitTasks.add(
        this.outputGate.lockWhile(
          evalLater(async (): Promise<void> => {
            // Don't commit if shutdown() has been called.
            this.requireNotBroken();

            this.#deleteAllCommitScheduled = false;
            if (this.currentTxn.kind === "implicit") {
              // An implicit transaction is already scheduled, so we'll count on it to perform a
              // commit when it's done. This is particularly important for the case where
              // deleteAll() was called while an alarm is outstanding; resetting the alarm state
              // (below) starts an implicit transaction. We don't want to commit the deletion
              // without that transaction.
              return;
            }
            // Use commitImpl() rather than commitCallback() so that alarm scheduling is handled.
            // This is important when deleteAll() deletes an alarm: commitImpl() detects that
            // getAlarm() moved to null and notifies the scheduler via requestScheduledAlarm(null).
            const precommitAlarmState = this.startPrecommitAlarmScheduling();
            await this.commitImpl(precommitAlarmState);
          }),
        ),
      );
      this.#deleteAllCommitScheduled = true;
    }

    const count = this.#kv.deleteAll();

    // Reset alarm state, if necessary. If no alarm is set, leave the metadata table uninitialized.
    if (localAlarmState !== null) {
      if (deleteAllOptions.deleteAlarm === true) {
        // The reset already removed the alarm metadata. Bump the version so an in-flight commit
        // cannot perform stale post-commit scheduling, and let this commit sync the cancellation.
        this.#alarmVersion += 1;
        this.haveDeferredDelete = false;
      } else if (
        this.#metadata.setAlarm(localAlarmState, effectiveOptions.allowUnconfirmed ?? false)
      ) {
        this.#alarmVersion += 1;
      }
    }

    return { backpressure: undefined, count };
  }

  evictStale(_now: number): undefined {
    // This implementation never needs to apply backpressure.
    return undefined;
  }

  shutdown(exception?: unknown): void {
    if (this.broken === undefined) {
      // Any scheduled flushes will fail once the commit is invoked and notices that `broken` has a
      // value. Any in-flight flushes will continue to run in the background. Remember that these
      // in-flight flushes may or may not be awaited by the worker, but they still hold the output
      // lock as long as `allowUnconfirmed` wasn't used.
      this.broken = exception ?? new Error(SHUTDOWN_ERROR_MESSAGE);

      // We explicitly do not schedule a flush to break the output gate. This means that if a
      // request is ongoing after the actor cache is shutting down, the output gate is only broken
      // if they had to send a flush after shutdown, either from a scheduled flush or a retry after
      // failure.
    } else {
      // We've already experienced a terminal exception either from shutdown or OOM, there should
      // already be a flush scheduled that will break the output gate.
    }
  }

  armAlarmHandler(scheduledTime: number, currentTime: number): ArmAlarmResult {
    if (this.#inAlarmHandler) {
      throw new Error("armAlarmHandler() called while an alarm handler is already running");
    }

    // Upstream warns when `haveDeferredDelete` is already set here ("unlikely to happen, unless
    // caller is starting new alarm handler before previous alarm handler cleanup has completed").

    const localAlarmState = this.#metadata.getAlarm();
    if (localAlarmState !== scheduledTime) {
      if (localAlarmState === this.#lastConfirmedAlarmDbState) {
        // If the local alarm time is already in the past, just run the handler now. This avoids
        // blocking alarm execution on the alarm manager sync when storage is overloaded. The alarm
        // will either delete itself on success or reschedule on failure.
        if (willFireEarlier(localAlarmState, currentTime)) {
          this.haveDeferredDelete = true;
          this.#inAlarmHandler = true;
          return { kind: "run", run: { deferredDelete: this.#newDeferredAlarmDeleter() } };
        }

        // If there's a clean db time that differs from the requested handler's scheduled time, this
        // run should be canceled.
        if (willFireEarlier(scheduledTime, localAlarmState)) {
          // If the handler's scheduled time is earlier than the clean scheduled time, we may be
          // recovering from a failed db commit or scheduling request, so we need to request that
          // the alarm be rescheduled for the current db time, and tell the caller to wait for
          // successful rescheduling before cancelling the current handler invocation.
          //
          // Since we're requesting to move the alarm time to later, we need to update the
          // alarmLaterInFlight promise. One branch feeds alarmLaterInFlight with error catching so
          // the chain remains usable, and the other is the returned promise, which propagates
          // errors to the caller. We update alarmLaterInFlight here rather than using
          // scheduleLaterAlarm(), because we need that separate un-caught branch.
          const schedulingPromise = this.#requestScheduledAlarm(
            localAlarmState,
            this.#alarmLaterInFlight,
          );
          // Clear any stale pending time so that when the existing completion handler fires it does
          // not start a redundant scheduleLaterAlarm for the same time that armAlarmHandler is
          // already scheduling.
          this.#pendingLaterAlarmTime = undefined;
          this.#alarmLaterInFlight = schedulingPromise.catch(() => {
            // If an exception occurs when scheduling the alarm later, it's OK -- the alarm will
            // eventually fire at the earlier time, and the rescheduling will be retried.
          });
          return { kind: "cancel", cancel: { waitBeforeCancel: schedulingPromise } };
        }

        // We have a clean local alarm time that is earlier than the handler's scheduled time, which
        // suggests that either the alarm manager is working with stale data or that the local alarm
        // time has somehow gotten out of sync with the scheduled alarm time.
        //
        // We pass a ready promise because being in this branch (SQLite is ahead of the alarm
        // manager) means there's no recent move-later operation to wait for.
        return {
          kind: "cancel",
          cancel: {
            waitBeforeCancel: this.#requestScheduledAlarm(localAlarmState, Promise.resolve()),
          },
        };
      }
      // There's an alarm write that hasn't been set yet pending for a time different than ours --
      // we won't cancel the alarm because it hasn't been confirmed, but we shouldn't delete the
      // pending write.
      this.haveDeferredDelete = false;
    } else {
      this.haveDeferredDelete = true;
    }
    this.#inAlarmHandler = true;

    return { kind: "run", run: { deferredDelete: this.#newDeferredAlarmDeleter() } };
  }

  cancelDeferredAlarmDeletion(): void {
    // Upstream warns when this runs outside a handler ("pretty sure this can't happen").
    this.haveDeferredDelete = false;
  }

  async abandonAlarm(scheduledTime: number): Promise<number | null> {
    // Called when the alarm scheduler has given up retrying an alarm after too many counted
    // failures. Clear the alarm from SQLite so getAlarm() returns null instead of a stale time.
    // Only clear if SQLite currently has the exact alarm being abandoned and we're not mid-handler.
    // The time check guards against the race where the user set a new alarm (which always has a
    // time >= now() > scheduledTime due to past-time clamping in setAlarm) before this call
    // arrived.
    if (this.#inAlarmHandler) {
      // Shouldn't happen -- the scheduler shouldn't call abandonAlarm while a handler is running.
      return null;
    }
    const storedTime = this.#metadata.getAlarm();
    if (storedTime !== null) {
      if (storedTime === scheduledTime) {
        this.setAlarm(null, {});
        return null;
      }
      // The user set a different alarm. Return it so the scheduler can re-register.
      return storedTime;
    }
    return null;
  }

  /**
   * This implements sync().
   *
   * sync() should wait for ALL writes (both confirmed and unconfirmed) that are
   * outstanding at the time sync() is called. We use lastCommit which keeps track
   * of the most recent commit to be formed. We join with the outputGate because
   * there are a lot of edge cases where we break the output gate and it's easiest
   * to catch all of those instances here rather than updating everything to also
   * break lastCommit.
   */
  async onNoPendingFlush(): Promise<void> {
    // ← `kj::joinPromisesFailFast`, which `Promise.all` already is.
    await Promise.all([this.lastCommit, this.outputGate.wait()]);
  }

  /**
   * This is an ersatz implementation that's good enough for local dev with D1's
   * Session API.
   *
   * The returned bookmark satisfies the properties that D1 cares about:
   *
   * * Later bookmarks sort after earlier bookmarks. We implement this by
   *   incrementing the bookmark whenever getCurrentBookmark() is called.
   *
   * * Bookmarks from the current session sort after bookmarks from previous
   *   sessions. We implement this by saving an ersatz bookmark in the metadata
   *   table.
   *
   * This is NOT the point-in-time-recovery bookmark API, which is a substrate
   * boundary: it needs nothing the substrate lacks, which is exactly why Section
   * 3 ported `getLocalDevelopmentBookmark`/`setLocalDevelopmentBookmark`.
   */
  async getCurrentBookmark(): Promise<string> {
    this.requireNotBroken();
    let bookmark = 0;
    const stored = this.#metadata.getLocalDevelopmentBookmark();
    if (stored !== null) {
      bookmark = stored + 1;
    }
    this.#metadata.setLocalDevelopmentBookmark(bookmark);

    const paddedHex = (value: number): string => value.toString(16).padStart(8, "0");

    // Turn the bookmark into a format matching what Cloudflare's production returns.
    const uint32Max = 0xffff_ffff;
    return [
      paddedHex(Math.floor(bookmark / uint32Max)),
      paddedHex(bookmark % uint32Max),
      paddedHex(0),
      "0".repeat(32),
    ].join("-");
  }

  async waitForBookmark(_bookmark: string): Promise<void> {
    // This is an ersatz implementation that's good enough for local dev with D1's Session API.
    this.requireNotBroken();
  }

  async getBookmarkForTime(_timestamp: number): Promise<string> {
    throw new Error(PITR_UNIMPLEMENTED_MESSAGE);
  }

  async onNextSessionRestoreBookmark(_bookmark: string): Promise<string> {
    throw new Error(PITR_UNIMPLEMENTED_MESSAGE);
  }

  ensureReplicas(): void {
    throw new Error(REPLICATION_UNIMPLEMENTED_MESSAGE);
  }

  disableReplicas(): void {
    throw new Error(REPLICATION_UNIMPLEMENTED_MESSAGE);
  }

  async configureReadReplication(_enabled: boolean): Promise<void> {
    throw new Error(REPLICATION_UNIMPLEMENTED_MESSAGE);
  }

  // =======================================================================================
  // transactionSync

  /**
   * ← `DurableObjectStorage::transactionSync` (`actor-state.c++:713-753`).
   *
   * One layer lower than upstream, which is where `util/sqlite.ts` already
   * records it belongs: the savepoint depth counter and `notifyWrite` both live
   * here, and `api/actor-state.ts`'s `transactionSync` becomes a one-line forward
   * the way `blockConcurrencyWhile` already is.
   *
   * The nesting guard §2.4 asks for is upstream's own and is the depth-named
   * savepoint: a second `BEGIN IMMEDIATE` is a SQLite error, a nested SAVEPOINT
   * is not, which is why this issues savepoints and lets the implicit transaction
   * underneath be the only `BEGIN`.
   *
   * The async-callback guard is ours and has no upstream twin, because upstream's
   * `jsg::Function<jsg::JsRef<jsg::JsValue>()>` callback cannot be awaited at
   * all: it returns a value, and a JS function that returns a promise simply has
   * its promise ignored. Here the same mistake is silent and corrupting — the
   * RELEASE fires at the first await and everything after it lands outside the
   * transaction — so a thenable result is refused and the savepoint rolled back.
   * Work the callback already started is not cancellable and keeps running; the
   * throw is what stops it being mistaken for transactional.
   */
  transactionSync<T>(callback: () => T): T {
    // SAVEPOINT is a readonly statement, but we need to trigger an outer TRANSACTION.
    this.db.notifyWrite();

    const depth = this.#transactionSyncDepth++;
    try {
      this.db.run(`SAVEPOINT _cf_sync_savepoint_${depth}`);
      try {
        const result = callback();

        if (isThenable(result)) {
          throw new Error(
            "transactionSync() callback returned a promise. The transaction commits when the " +
              "callback returns, so everything after its first await would land outside it.",
          );
        }

        // If a critical error forced an automatic rollback, we throw an exception to convey failure
        // to the caller of transactionSync(), even if the callback did not throw.
        if (this.db.observedCriticalError() !== undefined) {
          throw new Error("Cannot commit transaction due to an earlier SQL critical error");
        }

        this.db.run(`RELEASE _cf_sync_savepoint_${depth}`);
        return result;
      } catch (exception) {
        // If a critical error forced an automatic rollback, we skip the rollback and release
        // attempt, because savepoints should already be released.
        if (this.db.observedCriticalError() === undefined) {
          this.db.run(`ROLLBACK TO _cf_sync_savepoint_${depth}`);
          this.db.run(`RELEASE _cf_sync_savepoint_${depth}`);
        }
        throw exception;
      }
    } finally {
      this.#transactionSyncDepth -= 1;
    }
  }

  #newDeferredAlarmDeleter(): DeferredAlarmDeleter {
    let dropped = false;
    return {
      drop: (): void => {
        if (dropped) throw new Error("the deferred alarm deleter was dropped twice");
        dropped = true;
        this.#maybeDeleteDeferredAlarm();
      },
    };
  }
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

// =======================================================================================
// ImplicitTxn

/** ← `ActorSqlite::ImplicitTxn`. */
class ImplicitTxn {
  readonly #parent: ActorSqlite;
  #committed = false;
  #dropped = false;

  /** True if any of the writes in this commit are confirmed writes. */
  #someWriteConfirmed = false;

  constructor(parent: ActorSqlite) {
    if (parent.currentTxn.kind !== "none") {
      throw new Error("an implicit transaction requires that no transaction is open");
    }
    this.#parent = parent;
    parent.db.run("BEGIN TRANSACTION");
    parent.currentTxn = { kind: "implicit", txn: this };
  }

  commit(): void {
    // Ignore redundant commit()s.
    if (!this.#committed) {
      this.#parent.db.run("COMMIT TRANSACTION");
      this.#committed = true;
    }
  }

  rollback(): void {
    // As of this writing, rollback() is only called when the database is about to be reset.
    if (!this.#committed) {
      this.#parent.db.run("ROLLBACK TRANSACTION");
      this.#committed = true;
    }
  }

  setSomeWriteConfirmed(someWriteConfirmed: boolean): void {
    this.#someWriteConfirmed = someWriteConfirmed;
  }

  isSomeWriteConfirmed(): boolean {
    return this.#someWriteConfirmed;
  }

  /** ← `~ImplicitTxn`. Idempotent, because the commit path drops before and after the callback. */
  drop(): void {
    if (this.#dropped) return;
    this.#dropped = true;

    const current = this.#parent.currentTxn;
    if (current.kind === "implicit" && current.txn === this) {
      this.#parent.currentTxn = NO_TXN;
    }
    if (!this.#committed && this.#parent.broken === undefined) {
      // Failed to commit, so roll back.
      //
      // This should only happen in cases of catastrophic error.
      this.#parent.db.run("ROLLBACK TRANSACTION");
    }
  }
}

// =======================================================================================
// ExplicitTxn

/** ← `ActorSqlite::ExplicitTxn`. */
class ExplicitTxn implements ActorCacheTransaction {
  readonly #actorSqlite: ActorSqlite;
  readonly #parent: ExplicitTxn | undefined;
  readonly #depth: number;
  #hasChild = false;
  #committed = false;
  #dropped = false;
  #alarmDirty = false;
  /** True if any of the writes in this commit are confirmed writes. */
  #someWriteConfirmed = false;

  constructor(actorSqlite: ActorSqlite) {
    this.#actorSqlite = actorSqlite;

    const current = actorSqlite.currentTxn;
    if (current.kind === "implicit") {
      // An implicit transaction is open, commit it now because it would be weird if writes
      // performed before the explicit transaction started were postponed until the transaction
      // completes. Note that this isn't violating any atomicity guarantees because the transaction
      // API is async, and atomicity is only guaranteed over synchronous code.
      current.txn.commit();
      this.#parent = undefined;
      this.#depth = 0;
    } else if (current.kind === "explicit") {
      const exp = current.txn;
      if (exp.#hasChild) {
        throw new Error(
          "critical section should have blocked creation of more than one child at a time",
        );
      }
      this.#parent = exp;
      exp.#hasChild = true;
      this.#depth = exp.#depth + 1;
      this.#alarmDirty = exp.#alarmDirty;
      this.#someWriteConfirmed = exp.#someWriteConfirmed;
    } else {
      this.#parent = undefined;
      this.#depth = 0;
    }
    actorSqlite.currentTxn = { kind: "explicit", txn: this };

    // To support nested transactions, we assign each savepoint a name based on its nesting depth.
    actorSqlite.db.run(`SAVEPOINT _cf_savepoint_${this.#depth}`);
  }

  getAlarmDirty(): boolean {
    return this.#alarmDirty;
  }

  setAlarmDirty(): void {
    this.#alarmDirty = true;
  }

  setSomeWriteConfirmed(someWriteConfirmed: boolean): void {
    this.#someWriteConfirmed = someWriteConfirmed;
  }

  isSomeWriteConfirmed(): boolean {
    return this.#someWriteConfirmed;
  }

  commit(): void {
    const actor = this.#actorSqlite;
    actor.requireNotBroken();
    if (this.#hasChild) {
      throw new Error(
        "critical sections should have prevented committing transaction while nested txn is " +
          "outstanding",
      );
    }

    // Start the schedule request before root transaction commit(), for correctness in workerd.
    const precommitAlarmState =
      this.#parent === undefined ? actor.startPrecommitAlarmScheduling() : undefined;

    actor.db.run(`RELEASE _cf_savepoint_${this.#depth}`);
    this.#committed = true;

    const parent = this.#parent;
    if (parent !== undefined) {
      if (this.#alarmDirty) parent.#alarmDirty = true;
      if (this.#someWriteConfirmed) parent.#someWriteConfirmed = true;
      // No backpressure for SQLite.
      return;
    }

    if (this.#alarmDirty) {
      actor.haveDeferredDelete = false;
    }

    // We committed the root transaction, so it's time to signal any replication layer and lock the
    // output gate in the meantime.
    //
    // Unlike ImplicitTxn, which locks the output gate at the start of the first write that requires
    // confirmation, ExplicitTxn only locks when we're going to confirm the commit.
    if (precommitAlarmState === undefined) {
      throw new Error("a root transaction committed without precommit alarm state");
    }
    let commitPromise = actor.commitImpl(precommitAlarmState).catch(
      async (exception: unknown): Promise<void> => {
        // Unconditionally break the output gate if commit threw an error, no matter whether the
        // commit was confirmed or unconfirmed.
        await actor.outputGate.lockWhile(Promise.reject(exception));
      },
    );
    if (this.#someWriteConfirmed) {
      commitPromise = actor.outputGate.lockWhile(commitPromise);
    }
    actor.commitTasks.add(commitPromise);
    actor.lastCommit = commitPromise;
  }

  rollback(): void {
    this.#actorSqlite.requireNotBroken();
    if (this.#hasChild) {
      throw new Error(
        "Cannot roll back an outer transaction while a nested transaction is still running.",
      );
    }
    if (!this.#committed) {
      this.#rollbackImpl();
      this.#committed = true;
    }
  }

  /** ← `~ExplicitTxn`. */
  drop(): void {
    if (this.#dropped) return;
    this.#dropped = true;

    let rollbackFailure: { readonly exception: unknown } | undefined;
    if (!this.#committed && this.#actorSqlite.broken === undefined) {
      // Assume rollback if not committed.
      try {
        this.#rollbackImpl();
      } catch (exception) {
        rollbackFailure = { exception };
      }
    }

    // ← the `KJ_DEFER([&]() noexcept {...})`: "We'd better crash if any of this state update fails,
    // otherwise dangling pointers." It runs after the rollback no matter what. A JS `finally` that
    // throws would swallow the rollback's own exception, so the rollback's is held and rethrown
    // below instead; if the state update itself throws, that one wins, which is the same ordering
    // upstream's `noexcept` produces.
    if (this.#hasChild) {
      throw new Error("an explicit transaction was dropped while a nested one was outstanding");
    }
    const current = this.#actorSqlite.currentTxn;
    if (current.kind !== "explicit" || current.txn !== this) {
      throw new Error("an explicit transaction was dropped out of order");
    }
    const parent = this.#parent;
    if (parent !== undefined) {
      parent.#hasChild = false;
      this.#actorSqlite.currentTxn = { kind: "explicit", txn: parent };
    } else {
      this.#actorSqlite.currentTxn = NO_TXN;
    }

    if (rollbackFailure !== undefined) throw rollbackFailure.exception;
  }

  #rollbackImpl(): void {
    this.#actorSqlite.db.run(`ROLLBACK TO _cf_savepoint_${this.#depth}`);
    this.#actorSqlite.db.run(`RELEASE _cf_savepoint_${this.#depth}`);
    const parent = this.#parent;
    if (parent !== undefined) {
      this.#alarmDirty = parent.#alarmDirty;
      this.#someWriteConfirmed = parent.#someWriteConfirmed;
    } else {
      this.#alarmDirty = false;
      this.#someWriteConfirmed = false;
    }
  }

  // Implements ActorCacheOps. These all forward to the ActorSqlite instance.

  get(key: Key, options: ReadOptions = {}): Value | undefined {
    return this.#actorSqlite.get(key, options);
  }
  getMultiple(keys: readonly Key[], options: ReadOptions = {}): GetResultList {
    return this.#actorSqlite.getMultiple(keys, options);
  }
  getAlarm(options: ReadOptions = {}): number | null {
    return this.#actorSqlite.getAlarm(options);
  }
  list(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    options: ReadOptions = {},
  ): GetResultList {
    return this.#actorSqlite.list(begin, end, limit, options);
  }
  listReverse(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    options: ReadOptions = {},
  ): GetResultList {
    return this.#actorSqlite.listReverse(begin, end, limit, options);
  }
  put(key: Key, value: Value, options: WriteOptions = {}): void {
    this.#actorSqlite.put(key, value, options);
  }
  putMultiple(pairs: readonly KeyValuePair[], options: WriteOptions = {}): void {
    this.#actorSqlite.putMultiple(pairs, options);
  }
  delete(key: Key, options: WriteOptions = {}): boolean {
    return this.#actorSqlite.delete(key, options);
  }
  deleteMultiple(keys: readonly Key[], options: WriteOptions = {}): number {
    return this.#actorSqlite.deleteMultiple(keys, options);
  }
  setAlarm(newAlarmTime: number | null, options: WriteOptions = {}): void {
    this.#actorSqlite.setAlarm(newAlarmTime, options);
  }
}
