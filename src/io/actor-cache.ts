/**
 * ← workerd `src/workerd/io/actor-cache.h` — INTERFACE ONLY.
 *
 * The `actor-cache.c++` LRU implementation is ABSENT rather than skipped: it
 * caches a remote storage service that none of our substrates have. Upstream
 * does not use it in SQLite mode either — `ActorSqlite` is the sole
 * `ActorCacheInterface` implementation there, and the same is true here.
 *
 * The two behaviours decision 5 names live in `io/actor-sqlite.ts`, which is
 * where workerd's SQLite path exhibits them: `allowUnconfirmed` skips the
 * output-gate lock but STILL breaks the gate on error, and a batch started as
 * unconfirmed is retroactively upgraded when a must-confirm write joins it.
 *
 * Ordering guarantee, upstream's words (`actor-cache.h:334-340`): writes are
 * never committed out-of-order, by brute force — one transaction commits all
 * dirty keys at once.
 *
 * This file carries only what `ActorSqlite` genuinely implements. Everything in
 * `ActorCacheInterface` that exists solely for the LRU — `evictStale`'s
 * backpressure, the RPC storage client, the shared LRU and its hooks — is
 * absent with it.
 *
 * The one shape that is ours rather than upstream's: **every read and write is
 * synchronous.** Upstream returns `kj::OneOf<T, kj::Promise<T>>` so a cache miss
 * can go to the network; §1.4 measures that a SQLite-backed actor never does,
 * and the SQLite arm of every one of those `OneOf`s is the immediate value. A
 * `OneOf` with one reachable arm is a promise nobody can observe, and keeping it
 * would make `api/actor-state.ts` unwrap something that is never a promise.
 * `onNoPendingFlush` and `abandonAlarm` stay asynchronous because upstream's
 * SQLite arm is genuinely asynchronous there.
 *
 * Spec: §1.7, decisions 2 and 5.
 */

/** ← `ActorCacheOps::Key`. "Keys are text for now." */
export type Key = string;

/** ← `ActorCacheOps::Value`. Values are raw bytes; the value encoding is `api/`'s. */
export type Value = Uint8Array;

/** ← `ActorCacheOps::KeyValuePair`. */
export type KeyValuePair = {
  readonly key: Key;
  readonly value: Value;
};

/**
 * ← `ActorCacheOps::GetResultList`, which upstream makes a class so it can
 * iterate pointers into the cache's own storage. Ours has already copied.
 */
export type GetResultList = readonly KeyValuePair[];

/**
 * The option bags. Per §1.2 `allowConcurrency` is precisely the input-gate
 * opt-out: it selects `awaitIo` over `awaitIoWithInputLock`, which per §1.7.1
 * also ends the implicit transaction.
 *
 * Nothing passes any of these today — not upstream, not this repo, not the
 * vendored tests. They are built anyway; building half of the
 * `awaitIoWithInputLock` branch is the feature-subset failure the porting
 * philosophy rejects. The conformance suite exercises them deliberately.
 *
 * Placement note: upstream's `ActorCacheReadOptions` holds only `noCache`, and
 * `allowConcurrency` is read one layer up, in `DurableObjectStorageOperations`
 * (`actor-state.c++:68-79`) — `ActorCacheOps` never sees it. Part 4's table puts
 * decision 2 in this file, so it is declared here and consumed by `api/`;
 * `ActorSqlite` itself reads neither `allowConcurrency` nor `noCache`, exactly
 * as upstream's does not.
 */
export type ReadOptions = {
  /** Release the input gate across the await. Ends the implicit transaction. */
  allowConcurrency?: boolean;
  /** Do not retain the value in cache. */
  noCache?: boolean;
};

export type WriteOptions = ReadOptions & {
  /** Skip the output-gate lock. Never skips break-on-error. */
  allowUnconfirmed?: boolean;
};

/** ← `DeleteAllOptions`. */
export type DeleteAllOptions = {
  /**
   * When true, deleteAll() will also delete any scheduled alarm. The alarm
   * deletion is guaranteed to take effect only after the deleteAll() itself
   * succeeds, so that we never end up in a state where the alarm is deleted but
   * KV data remains.
   */
  deleteAlarm?: boolean;
};

/**
 * ← `ActorCacheInterface::DeleteAllResults`.
 *
 * Upstream splits these "so client code that doesn't need the count doesn't have
 * to wait for it just to account for backpressure". Both arms are immediate for
 * SQLite: `backpressure` is always `kj::none` and `count` is a ready promise.
 */
export type DeleteAllResults = {
  readonly backpressure: Promise<void> | undefined;
  readonly count: number;
};

/**
 * ← `ActorCacheInterface::CancelAlarmHandler`. Alarm should be canceled without
 * retry, because alarm state has changed such that the requested alarm time is
 * no longer valid.
 */
export type CancelAlarmHandler = {
  /** Caller should wait for this promise to complete before canceling. */
  readonly waitBeforeCancel: Promise<void>;
};

/**
 * ← the `kj::Own<void>` that `RunAlarmHandler` carries, whose disposer runs
 * `maybeDeleteDeferredAlarm()`. Section 1's rule applies: a kj destructor
 * becomes an explicit call, so the caller attaches `drop()` to the promise
 * representing the handler's execution rather than a scope exit.
 */
export interface DeferredAlarmDeleter {
  drop(): void;
}

/** ← `ActorCacheInterface::RunAlarmHandler`. Alarm should be run. */
export type RunAlarmHandler = {
  readonly deferredDelete: DeferredAlarmDeleter;
};

/** ← `kj::OneOf<CancelAlarmHandler, RunAlarmHandler>`. */
export type ArmAlarmResult =
  | { readonly kind: "cancel"; readonly cancel: CancelAlarmHandler }
  | { readonly kind: "run"; readonly run: RunAlarmHandler };

/** ← `ActorCache::SHUTDOWN_ERROR_MESSAGE`, which `ActorSqlite::shutdown` reuses. */
export const SHUTDOWN_ERROR_MESSAGE =
  "broken.ignored; jsg.Error: Durable Object storage is no longer accessible.";

/**
 * ← the message every unimplemented `ActorCacheInterface` PITR method throws.
 * `ActorSqlite` overrides two of the four; the other two keep this.
 */
export const PITR_UNIMPLEMENTED_MESSAGE =
  "This Durable Object's storage back-end does not implement point-in-time recovery.";

/** ← the message the three replication methods throw. */
export const REPLICATION_UNIMPLEMENTED_MESSAGE =
  "This Durable Object's storage back-end does not support replication.";

/**
 * Common interface between the storage engine and a transaction on it.
 *
 * ← `ActorCacheOps`. Upstream's `list`/`listReverse` split exists because the
 * two directions "require a subtly different implementation of pretty much the
 * entire algorithm" in the cache; both are kept, because both are separate
 * entry points a caller reaches.
 */
export interface ActorCacheOps {
  get(key: Key, options: ReadOptions): Value | undefined;
  getMultiple(keys: readonly Key[], options: ReadOptions): GetResultList;
  getAlarm(options: ReadOptions): number | null;
  list(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    options: ReadOptions,
  ): GetResultList;
  listReverse(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    options: ReadOptions,
  ): GetResultList;

  put(key: Key, value: Value, options: WriteOptions): void;
  putMultiple(pairs: readonly KeyValuePair[], options: WriteOptions): void;
  /** Returns whether the key was present. */
  delete(key: Key, options: WriteOptions): boolean;
  /** Returns how many of the keys were present. */
  deleteMultiple(keys: readonly Key[], options: WriteOptions): number;
  setAlarm(newAlarmTime: number | null, options: WriteOptions): void;
}

/**
 * ← `ActorCacheInterface::Transaction`.
 *
 * "If commit() is not called before the Transaction is destroyed, nothing is
 * written." JS has no destruction, so `drop()` is that moment and exactly one of
 * `commit()`/`rollback()`+`drop()` has to run — the same contract Section 1
 * established for `Lock` and `CriticalSection`.
 */
export interface ActorCacheTransaction extends ActorCacheOps {
  /**
   * Write all changes to the underlying storage.
   *
   * "This will NOT detect conflicts, it will always just write blindly, because
   * conflicts inherently cannot happen."
   */
  commit(): void;
  rollback(): void;
  /** ← `~ExplicitTxn`: roll back if not committed, then leave the txn stack. */
  drop(): void;
}

/**
 * Abstract interface that upstream implements twice, and that this package
 * implements once — `ActorSqlite` is the sole implementation, exactly as on
 * workerd-with-SQLite.
 */
export interface ActorCacheInterface extends ActorCacheOps {
  startTransaction(): ActorCacheTransaction;
  deleteAll(options: WriteOptions, deleteAllOptions?: DeleteAllOptions): DeleteAllResults;
  /**
   * "Call each time the isolate lock is taken to evict stale entries." There is
   * no cache to evict from and never any backpressure to apply.
   */
  evictStale(now: number): undefined;
  shutdown(exception?: unknown): void;

  armAlarmHandler(scheduledTime: number, currentTime: number): ArmAlarmResult;
  cancelDeferredAlarmDeletion(): void;
  abandonAlarm(scheduledTime: number): Promise<number | null>;

  /** Implements `sync()`. */
  onNoPendingFlush(): Promise<void>;

  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
  waitForBookmark(bookmark: string): Promise<void>;

  ensureReplicas(): void;
  disableReplicas(): void;
  configureReadReplication(enabled: boolean): Promise<void>;
}
