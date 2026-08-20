/**
 * ← workerd `src/workerd/server/alarm-scheduler.{h,c++}`
 *
 * Delivery and retry: the `_cf_ALARM` table, the watchdog arming, the queued
 * alarm, and the retry ladder. Measured on real workerd: an alarm re-armed for
 * `Date.now()` from inside a running handler does NOT re-enter — delivery is
 * serialised (`enter:1, exit:1, enter:2, exit:2`). That property is load
 * bearing; `_cf_executingScheduleRowId` upstream is safe only because of it
 * (§2.3). Here it falls out of the queued alarm: a `setAlarm` that arrives
 * while a handler runs is stored on the entry and started only after the run
 * finishes (`alarm-scheduler.c++:116-124`, `:220-227`).
 *
 * **This is runtime-internal, and it is what a host puts behind
 * `ActorPorts.alarms`.** Upstream wires it the same way: `ActorSqliteHooks`
 * (`server.c++:3199-3219`) is a three-line adapter whose `scheduleRun` is
 * `setAlarm`/`deleteAlarm` on the scheduler, and the scheduler is built once per
 * namespace (`server.c++:2325-2350`) rather than once per actor. `hooks(actorId)`
 * below is that adapter, so a host composes the two instead of writing its own
 * ladder.
 *
 * **One deliberate divergence, and it is the table's shape.** Upstream keeps the
 * retry ladder in memory and reloads every alarm with its counters at zero,
 * which is right for a process that lives for hours and is a regression on a
 * service worker Chrome evicts after seconds — see `_cf_ALARM` below and the
 * README's divergence table. Everything else here is upstream's, line for line.
 *
 * Spec: §1.8, §2.6, decisions 6, 11 and 16 in
 * docs/decisions.md.
 */

import type { AlarmOutlet } from "../io/actor-sqlite";
import type { Timer } from "../io/io-context";
import {
  getInt64,
  getText,
  hasCurrentSqliteTable,
  isNull,
  type SqlDatabase,
  SqliteDatabase,
} from "../util/sqlite";

// =======================================================================================
// Constants

/**
 * ← `WorkerInterface::ALARM_RETRY_START_SECONDS` (`io/worker-interface.h:130`),
 * re-declared as `AlarmScheduler::RETRY_START_SECONDS` (`alarm-scheduler.h:42`).
 *
 * "not a duration so we can left shift it" — upstream's own comment, and the
 * reason the ladder below is a shift rather than a table.
 */
export const ALARM_RETRY_START_SECONDS = 2;

/**
 * ← `WorkerInterface::ALARM_RETRY_MAX_TRIES` (`io/worker-interface.h:131`) /
 * `AlarmScheduler::RETRY_MAX_TRIES` (`alarm-scheduler.h:45`).
 *
 * "Max number of 'valid' retry attempts, i.e the worker returned an error."
 * It bounds `countedRetry`, NOT `backoff`: a run of failures that do not count
 * against the limit is retried forever, and its delay is bounded by
 * `RETRY_BACKOFF_MAX` instead.
 */
export const ALARM_RETRY_MAX_TRIES = 6;

/**
 * ← `AlarmScheduler::RETRY_BACKOFF_MAX` (`alarm-scheduler.h:50`).
 *
 * "Bound for exponential backoff when RETRY_MAX_TRIES is exceeded due to
 * internal errors. 2 << 9 is 1024 seconds, about 17 minutes. Total time spent in
 * retries once the backoff limit is reached is over 30 minutes."
 */
export const RETRY_BACKOFF_MAX = 9;

/**
 * ← `AlarmScheduler::RETRY_JITTER_FACTOR` (`alarm-scheduler.h:54`).
 *
 * "How much jitter should be applied to retry times to avoid bundled retries
 * overloading some common dependency between a set of failed alarms."
 */
export const RETRY_JITTER_FACTOR = 0.25;

/**
 * ← `(AlarmScheduler::RETRY_START_SECONDS << backoff) * kj::SECONDS`
 * (`alarm-scheduler.c++:270`), before jitter.
 *
 * It refuses a backoff outside `[0, RETRY_BACKOFF_MAX]` rather than shifting it,
 * because JS's `<<` is a 32-bit operator: an unclamped counter would wrap to a
 * zero or negative delay — a hot retry loop — instead of saturating. The ladder
 * clamps immediately above its own call, exactly where upstream does; this is
 * what makes that clamp load bearing rather than decorative.
 */
export function alarmRetryDelayMs(backoff: number): number {
  if (!Number.isInteger(backoff) || backoff < 0 || backoff > RETRY_BACKOFF_MAX) {
    throw new Error(`Alarm retry backoff ${backoff} is outside [0, ${RETRY_BACKOFF_MAX}].`);
  }
  return (ALARM_RETRY_START_SECONDS << backoff) * 1_000;
}

/**
 * ← `_cf_ALARM` (`alarm-scheduler.c++:54-59`), plus the two prepared statements
 * (`alarm-scheduler.h:117-123`).
 *
 * Prepared statements are not part of the backend seam, so they survive as SQL
 * text under upstream's own member names — the treatment `util/sqlite-kv.ts`'s
 * `STMT` already records.
 *
 * `scheduled_time` holds **milliseconds** where upstream holds nanoseconds
 * (`:72`, `:102`). Same reason as `_cf_METADATA`'s alarm column: a JS number
 * runs out of integer precision 104 days into the epoch at nanosecond scale, so
 * storing what upstream stores would silently round every alarm.
 *
 * **Five columns upstream does not have, and they are this section's
 * divergence.** Upstream stores `(actor_id, scheduled_time)` and keeps the whole
 * retry ladder — `backoff`, `countedRetry`, `previousRetryCountedAgainstLimit`
 * and the fact that a delivery is in flight — in the `ScheduledAlarm` struct,
 * because a workerd process lives for hours and `loadAlarmsFromDb` runs once.
 * An MV3 service worker is evicted after seconds, so a scheduler rebuilt per
 * worker lifetime never accumulates any of them: `countedRetry` cannot reach
 * `ALARM_RETRY_MAX_TRIES`, so `#abandon` is unreachable and a permanently
 * failing alarm is never given up on, and `backoff` never leaves its first rung,
 * so that alarm wakes the browser every two seconds forever. Persisting the four
 * makes the ladder a property of the alarm rather than of the process that
 * happened to be running when it failed. See the README's divergence table.
 *
 * `retry_time` is the wake, which upstream never needs to store: its retries
 * live in the timer and the row's `scheduled_time` — which stays the alarm's own
 * time, because that is the identity `deliverAlarm` and `abandonAlarm` are told
 * — is by then in the past. Reloading without it re-arms every pending retry for
 * immediately, so the counters would climb while the delay was ignored.
 *
 * `running` is written before a delivery and cleared by whatever the delivery
 * turns into. A row still marked running at load is a delivery no result ever
 * came back from, which on this substrate is the ordinary case rather than a
 * crash: Chrome evicted the worker mid-alarm. Without it that alarm is
 * redelivered on every restart with no counter moved and no delay applied, which
 * is the hot loop above in its worst form, because nothing about it is bounded.
 */
const STMT = {
  createTable: `
    CREATE TABLE IF NOT EXISTS _cf_ALARM (
      actor_id TEXT PRIMARY KEY,
      scheduled_time INTEGER,
      retry_time INTEGER,
      backoff INTEGER NOT NULL,
      counted_retry INTEGER NOT NULL,
      previous_retry_counted INTEGER NOT NULL,
      running INTEGER NOT NULL
    ) WITHOUT ROWID
  `,
  loadAlarms: `
    SELECT actor_id, scheduled_time, retry_time, backoff, counted_retry,
           previous_retry_counted, running
      FROM _cf_ALARM
  `,
  // A new alarm time is new work, so it carries a fresh retry budget — which is
  // upstream's behaviour too, since every path that changes an entry's scheduled
  // time replaces the whole `ScheduledAlarm` and zeroes its counters with it.
  // `running` is deliberately NOT in the SET list: a delivery that is in flight
  // is still in flight, and clearing the mark here would erase the only evidence
  // that it never finished.
  setAlarm: `
    INSERT INTO _cf_ALARM VALUES(?, ?, NULL, 0, 0, 0, 0)
      ON CONFLICT DO UPDATE SET
        scheduled_time = excluded.scheduled_time,
        retry_time = NULL,
        backoff = 0,
        counted_retry = 0,
        previous_retry_counted = 0
  `,
  markRunning: `
    UPDATE _cf_ALARM SET running = 1 WHERE actor_id = ?
  `,
  // One statement, because the retry state and the end of the delivery have to
  // land together: a restart between them would resume the alarm with a stale
  // wake and a ladder one rung behind.
  saveRetry: `
    UPDATE _cf_ALARM
       SET retry_time = ?, backoff = ?, counted_retry = ?,
           previous_retry_counted = ?, running = 0
     WHERE actor_id = ?
  `,
  clearRunning: `
    UPDATE _cf_ALARM SET running = 0 WHERE actor_id = ?
  `,
  deleteAlarm: `
    DELETE FROM _cf_ALARM WHERE actor_id = ?
  `,
  deleteAll: `
    DELETE FROM _cf_ALARM
  `,
} as const;

// =======================================================================================
// The result a delivery reports back

/**
 * ← `EventOutcome` (`io/outcome.capnp`), restricted to the values the alarm path
 * can produce.
 *
 * The whole enum is a metrics type with no port — divergence 154 records that
 * for `waitUntilStatus()` — but `runAlarm` reads one bit of it
 * (`alarm-scheduler.c++:162`, `result.outcome != EventOutcome::OK`), so the
 * values `ServiceWorkerGlobalScope::runAlarm` actually returns are named here
 * and the rest are not.
 */
export type EventOutcome =
  | "ok"
  | "canceled"
  | "script-not-found"
  | "exception"
  | "exceeded-cpu"
  | "unknown";

/**
 * ← `WorkerInterface::AlarmResult` (`io/worker-interface.h:71-81`).
 *
 * Upstream defaults all three fields; here every one is required, because the
 * producer is `server/actor-container.ts` rather than a capnp wire default and a
 * silently-defaulted `retryCountsAgainstLimit` is the difference between an
 * alarm that survives a broken actor and one that is abandoned.
 */
export type AlarmResult = {
  readonly retry: boolean;
  readonly retryCountsAgainstLimit: boolean;
  readonly outcome: EventOutcome;
  readonly errorDescription?: string;
};

/**
 * ← the `WorkerInterface` `GetActorFn` hands back
 * (`alarm-scheduler.c++:160`, `:244`), restricted to its two alarm members.
 *
 * `WorkerInterface` itself has no port — it is capnp dispatch, and divergence
 * 176 records it collapsing into the stub the transport returns — so the seam is
 * the two methods the scheduler calls. `ActorContainer` satisfies it
 * structurally; `deliverAlarm` is upstream's `runAlarm` under the name Section
 * 6b already gave it.
 */
export interface AlarmTarget {
  deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult>;
  /**
   * ← `WorkerInterface::abandonAlarm` (`io/worker-interface.h:114`): "Returns the
   * actor's stored alarm time if it differs from scheduledTime (i.e. the user
   * set a new alarm), or null if the alarm was cleared or no alarm was stored."
   */
  abandonAlarm(scheduledTime: number): Promise<number | null>;
}

/** ← `AlarmScheduler::GetActorFn` (`alarm-scheduler.h:56`). */
export type GetActorFn = (actorId: string) => AlarmTarget;

export type AlarmSchedulerOptions = {
  /**
   * ← the `const kj::Clock&` and the `kj::Timer&` upstream takes separately
   * (`alarm-scheduler.h:58-59`). One object here because `Timer.now()` is
   * already wall-clock milliseconds — `IoContext::now()` reads the same one —
   * so nothing distinguishes the two. `checkTimestamp`'s re-check loop stays,
   * because a JS timer really can fire a fraction of a millisecond early
   * relative to the clock it is compared against.
   */
  timer: Timer;
  /**
   * The database `_cf_ALARM` lives in — upstream's `metadata.sqlite`, one per
   * namespace beside the per-actor files (`server.c++:2336-2346`).
   *
   * Already open, where upstream's constructor opens it from a vfs and a path:
   * `SqlDatabaseProvider.open` is asynchronous and a constructor cannot await,
   * which is the same reason `createActorContainer` is a promise.
   */
  db: SqlDatabase;
  getActor: GetActorFn;
  /**
   * Browser hosts can mirror the earliest durable wake onto a platform watchdog
   * such as `chrome.alarms`. Workerd needs no such seam because its process owns
   * the scheduler timer.
   */
  projectWake?: (scheduledTime: number | null) => Promise<void> | void;
  /**
   * ← `std::default_random_engine`, seeded from the monotonic clock
   * (`alarm-scheduler.c++:20-27`). A test seam on a runtime-internal class, not
   * a substrate port: the jitter is the one part of the ladder that is
   * deliberately not a function of its inputs.
   */
  random?: () => number;
};

// =======================================================================================
// The scheduler

/** ← `AlarmScheduler::AlarmStatus` (`alarm-scheduler.h:72`). */
type AlarmStatus = "WAITING" | "STARTED" | "FINISHED";

/** ← `AlarmScheduler::ScheduledAlarm` (`alarm-scheduler.h:80-99`). */
type ScheduledAlarm = {
  readonly actorId: string;
  readonly scheduledTime: number;
  /** The timer's actual wake, including persisted retry delay; null while running. */
  wakeTime: number | null;
  /**
   * ← `kj::Promise<void> task`. It exists upstream so the entry OWNS the task and
   * destroying the entry cancels it; JS has no such destruction, so the two
   * halves of that are explicit here — `cancel` stops the pending wake, and every
   * resumption re-reads the map to see whether it is still the live entry.
   */
  task: Promise<void> | undefined;
  /** The half of kj's cancel-by-drop that stops the timer. Divergence 147's shape. */
  readonly cancel: AbortController;
  /** Once started, an alarm can have a single alarm queued behind it. */
  queuedAlarm: number | null;
  status: AlarmStatus;
  previousRetryCountedAgainstLimit: boolean;
  /**
   * Counter for calculating backoff -- separate from retry, so we can reset
   * backoff without losing the total count of retry attempts
   */
  backoff: number;
  /** Counter for retry attempts that apply to the retry limit. */
  countedRetry: number;
};

/** ← `AlarmScheduler::RetryInfo` (`alarm-scheduler.h:103-106`). */
type RetryInfo = {
  readonly retry: boolean;
  readonly retryCountsAgainstLimit: boolean;
};

/**
 * The half of a `ScheduledAlarm` that outlives the process holding it: one row
 * of `_cf_ALARM` past `scheduled_time`, validated.
 */
type PersistedAlarm = {
  /** When the next attempt is due, or null while the alarm waits for its own time. */
  readonly retryTime: number | null;
  readonly backoff: number;
  readonly countedRetry: number;
  readonly previousRetryCountedAgainstLimit: boolean;
  /** A delivery started and nothing recorded how it ended. */
  readonly running: boolean;
};

/**
 * Allows scheduling alarm executions at specific times, returning a promise
 * representing the completion of the alarm event.
 */
export class AlarmScheduler {
  readonly #timer: Timer;
  readonly #random: () => number;
  readonly #getActor: GetActorFn;
  readonly #projectWake: ((scheduledTime: number | null) => Promise<void> | void) | undefined;
  readonly #db: SqliteDatabase;
  /** ← `kj::HashMap<ActorKey, ScheduledAlarm> alarms`, whose key is one string. */
  readonly #alarms = new Map<string, ScheduledAlarm>();
  /** ← `kj::TaskSet tasks`, which holds a task that has outlived its entry. */
  readonly #tasks = new Set<Promise<void>>();
  #taskFailure: { readonly exception: unknown } | undefined;
  #projection: Promise<void> = Promise.resolve();

  constructor(options: AlarmSchedulerOptions) {
    this.#timer = options.timer;
    this.#random = options.random ?? Math.random;
    this.#getActor = options.getActor;
    this.#projectWake = options.projectWake;
    this.#db = new SqliteDatabase(options.db);
    ensureInitialized(this.#db);
    this.#loadAlarmsFromDb();
    this.#projectNextWake();
  }

  /**
   * ← `getAlarm` (`alarm-scheduler.c++:84-99`), including its TODO: "Might be
   * able to simplify AlarmScheduler somewhat, now that ActorSqlite no longer
   * relies on it for getAlarm()?"
   */
  getAlarm(actorId: string): number | null {
    const alarm = this.#alarms.get(actorId);
    if (alarm === undefined) {
      // We currently retain the entire set of queued alarms in memory, no need to hit sqlite
      return null;
    }
    if (alarm.status === "STARTED") {
      // getAlarm() when the alarm handler is running should return null, unless an alarm is queued;
      return alarm.queuedAlarm;
    }
    return alarm.scheduledTime;
  }

  /**
   * ← `setAlarm` (`alarm-scheduler.c++:101-127`).
   *
   * The `boolean` is upstream's `query.changeCount() > 0`, and it is constant
   * true against SQLite's semantics: an `INSERT … ON CONFLICT DO UPDATE` always
   * reports one changed row, even when the value is unchanged. No caller reads it
   * — `ActorSqliteHooks::scheduleRun` discards it — so it is kept as upstream's
   * shape rather than as a signal.
   */
  setAlarm(actorId: string, scheduledTime: number): boolean {
    const query = this.#db.run(STMT.setAlarm, actorId, scheduledTime);

    const entry = this.#alarms.get(actorId);
    if (entry === undefined) {
      this.#alarms.set(actorId, this.#scheduleAlarm(this.#timer.now(), actorId, scheduledTime));
    } else if (entry.status !== "WAITING") {
      // We queue any new alarm after the existing alarm even if the new alarm has the same scheduled
      // time, as receiving a notification directly maps to a write for that time in the actor.
      entry.queuedAlarm = scheduledTime;
    } else {
      this.#replace(entry, this.#scheduleAlarm(this.#timer.now(), actorId, scheduledTime));
    }

    this.#projectNextWake();

    return query.rowsWritten > 0;
  }

  /** ← `deleteAll` (`alarm-scheduler.c++:129-134`). */
  deleteAll(): void {
    // Cancel all in-memory alarm tasks. Upstream's `alarms.clear()` destroys every task with its
    // entry; here the abort is that destruction's timer half, and a task that has already passed
    // its wake finds itself unmapped and returns.
    for (const entry of this.#alarms.values()) entry.cancel.abort();
    this.#alarms.clear();
    // Wipe the persistent store.
    this.#db.run(STMT.deleteAll);
    this.#projectNextWake();
  }

  /** ← `deleteAlarm` (`alarm-scheduler.c++:136-156`). */
  deleteAlarm(actorId: string): boolean {
    const query = this.#db.run(STMT.deleteAlarm, actorId);

    const entry = this.#alarms.get(actorId);
    if (entry !== undefined) {
      const queued = entry.queuedAlarm;
      if (queued !== null) {
        if (entry.status === "STARTED") {
          // If we are currently running an alarm, we want to delete the queued instead of current.
          entry.queuedAlarm = null;
        } else {
          this.#replace(entry, this.#scheduleAlarm(this.#timer.now(), actorId, queued));
        }
      } else if (entry.status !== "STARTED") {
        // We can't remove running alarms.
        entry.cancel.abort();
        this.#alarms.delete(actorId);
      }
    }

    this.#projectNextWake();

    return query.rowsWritten > 0;
  }

  /**
   * ← `ActorSqliteHooks` (`server.c++:3199-3219`), which is the whole of how an
   * actor's storage engine reaches a scheduler: one adapter per actor, holding
   * that actor's key, turning a time into `setAlarm` or `deleteAlarm`.
   */
  hooks(actorId: string): AlarmOutlet {
    return {
      // Deliberately not `async`: `AlarmOutlet.scheduleRun` may throw synchronously and
      // `ActorSqlite` relies on it, because a scheduling failure has to reach the caller before
      // the local database commits. `priorTask` is ignored for upstream's reason — "We ignore the
      // priorTask in workerd because everything should run synchronously."
      scheduleRun: (scheduledTime: number | null, _priorTask: Promise<void>): Promise<void> => {
        if (scheduledTime !== null) this.setAlarm(actorId, scheduledTime);
        else this.deleteAlarm(actorId);
        return this.#projection;
      },
    };
  }

  /**
   * ← `taskFailed`'s `KJ_LOG(WARNING, e)` (`alarm-scheduler.c++:289-291`), and
   * the two other log sites in `makeAlarmTask` that report a failure and carry
   * on (`:202`, `:285`).
   *
   * This package has no logger, so the exception is kept instead of written —
   * the same treatment divergence 154 records for `waitUntilStatus()`, and for
   * the same reason: a background failure that is neither logged nor readable is
   * one nothing can notice.
   */
  taskFailure(): unknown {
    return this.#taskFailure?.exception;
  }

  // -----------------------------------------------------------------

  /**
   * ← `loadAlarmsFromDb` (`alarm-scheduler.c++:62-82`), plus the retry state
   * upstream has no columns for.
   *
   * This is the whole of the divergence's read side. Upstream's loop rebuilds
   * every entry with zeroed counters, which is what makes a per-worker-lifetime
   * scheduler forget; here the counters come off the row, and a row that says a
   * delivery was in flight is recovered before its entry is built.
   */
  #loadAlarmsFromDb(): void {
    const now = this.#timer.now();

    // TODO(someday): don't maintain the entire alarm set in memory -- right now for the usecase of
    // local development, doing so is sufficient.
    for (const row of this.#db.run(STMT.loadAlarms).rawRows) {
      const actorId = getText(row, 0);
      const scheduledTime = getInt64(row, 1);
      const persisted = readPersistedAlarm(actorId, row);
      const resumed = persisted.running
        ? this.#recoverInterruptedDelivery(actorId, now, persisted)
        : persisted;
      this.#alarms.set(actorId, this.#scheduleAlarm(now, actorId, scheduledTime, resumed));
    }
  }

  /**
   * A delivery that started and never reported an outcome, turned into an
   * **uncounted** retry: `backoff` climbs so the next attempt is further away,
   * and `countedRetry` does not move, so no number of them can abandon the
   * alarm.
   *
   * That split is decision 6's ranking applied to the one failure this substrate
   * produces routinely. Chrome evicting the worker mid-alarm is an
   * infrastructure failure, which is exactly the category upstream retries
   * forever and bounds by `RETRY_BACKOFF_MAX` rather than by
   * `ALARM_RETRY_MAX_TRIES` — "a default of user error would abandon precisely
   * the alarms that most need keeping". So a handler that reliably kills its
   * worker settles at one attempt every 1024 seconds and is never dropped. The
   * The browser host preserves that classification by reconstructing this
   * scheduler over the same namespace database. A row left `running` is the
   * durable evidence of the interrupted delivery; the Chrome-side watchdog
   * merely recreates the worker so this recovery path can read it.
   */
  #recoverInterruptedDelivery(
    actorId: string,
    now: number,
    persisted: PersistedAlarm,
  ): PersistedAlarm {
    const backoff = Math.min(RETRY_BACKOFF_MAX, persisted.backoff);
    let delay = alarmRetryDelayMs(backoff);
    delay += this.#jitterMsForDelay(delay);

    const resumed: PersistedAlarm = {
      retryTime: now + delay,
      backoff: backoff + 1,
      countedRetry: persisted.countedRetry,
      // Uncounted, which is what makes the next counted failure reset the
      // backoff — upstream's own rule for a user error arriving after an
      // internal one (`alarm-scheduler.c++:257-265`).
      previousRetryCountedAgainstLimit: false,
      running: false,
    };
    this.#db.run(
      STMT.saveRetry,
      resumed.retryTime,
      resumed.backoff,
      resumed.countedRetry,
      0,
      actorId,
    );
    return resumed;
  }

  /** ← `scheduleAlarm` (`alarm-scheduler.c++:166-171`). */
  #scheduleAlarm(
    now: number,
    actorId: string,
    scheduledTime: number,
    resumed?: PersistedAlarm,
  ): ScheduledAlarm {
    // The entry exists before its task, where upstream's task exists before the entry that owns it:
    // the task has to be able to ask whether it is still the live entry, which is what stands in
    // for kj cancelling it when the entry it lives on is destroyed. Nothing observes the ordering,
    // because `makeAlarmTask` awaits its wake before touching anything.
    const entry: ScheduledAlarm = {
      actorId,
      scheduledTime,
      wakeTime: null,
      task: undefined,
      cancel: new AbortController(),
      queuedAlarm: null,
      status: "WAITING",
      previousRetryCountedAgainstLimit: resumed?.previousRetryCountedAgainstLimit ?? false,
      backoff: resumed?.backoff ?? 0,
      countedRetry: resumed?.countedRetry ?? 0,
    };
    // A pending retry can only DELAY the wake, never pull it before the alarm's own time. The two
    // disagree when a delivery was interrupted and the actor had already asked for a later alarm:
    // the row then holds a future `scheduled_time` and a retry due seconds from now, and honouring
    // the retry would fire the newer alarm early.
    const wake = Math.max(scheduledTime, resumed?.retryTime ?? scheduledTime);
    entry.wakeTime = wake;
    entry.task = this.#makeAlarmTask(wake - now, entry, scheduledTime);
    return entry;
  }

  /** ← `entry.value = scheduleAlarm(...)`, whose assignment destroys the old task. */
  #replace(previous: ScheduledAlarm, next: ScheduledAlarm): void {
    previous.cancel.abort();
    this.#alarms.set(next.actorId, next);
  }

  /** ← `checkTimestamp` (`alarm-scheduler.c++:173-185`), as a loop rather than tail recursion. */
  async #checkTimestamp(delay: number, scheduledTime: number, signal: AbortSignal): Promise<void> {
    let remaining = delay;
    for (;;) {
      await this.#timer.afterDelay(remaining, signal);

      // Since we are waiting on timer.afterDelay, it's possible that timer.now() was behind
      // the real time by a few ms, leading to premature alarm() execution. This checks it the current
      // time is >= than scheduledTime to ensure we run alarms only on or after their scheduled time.
      const now = this.#timer.now();
      if (now >= scheduledTime) return;
      // If it's not yet time to trigger the alarm, we shall wait a while longer until we can
      // trigger it. This repeats until it's time for the alarm to run.
      remaining = scheduledTime - now;
    }
  }

  /** ← `runAlarm` (`alarm-scheduler.c++:158-164`). */
  async #runAlarm(actorId: string, scheduledTime: number, retryCount: number): Promise<RetryInfo> {
    const result = await this.#getActor(actorId).deliverAlarm(scheduledTime, retryCount);
    return {
      retry: result.outcome !== "ok" && result.retry,
      retryCountsAgainstLimit: result.retryCountsAgainstLimit,
    };
  }

  /** ← the try/catch lambda around `runAlarm` (`alarm-scheduler.c++:197-211`). */
  async #runAlarmGuarded(
    actorId: string,
    scheduledTime: number,
    retryCount: number,
  ): Promise<RetryInfo> {
    try {
      return await this.#runAlarm(actorId, scheduledTime, retryCount);
    } catch (exception) {
      this.#taskFailed(exception);
      return {
        retry: true,
        // An exception here is "weird", they should normally be turned into AlarmResult statuses in
        // the sandbox for any user-caused error. Let's not count this retry attempt against the
        // limit.
        retryCountsAgainstLimit: false,
      };
    }
  }

  /** ← `makeAlarmTask` (`alarm-scheduler.c++:187-287`). */
  async #makeAlarmTask(delay: number, entry: ScheduledAlarm, scheduledTime: number): Promise<void> {
    const actorId = entry.actorId;
    await this.#checkTimestamp(delay, scheduledTime, entry.cancel.signal);

    // ← `KJ_ASSERT_NONNULL(alarms.findEntry(actorRef))` (`:192`). Upstream can assert here because
    // dropping the entry destroyed this task before it could resume; this is that cancellation.
    if (this.#alarms.get(actorId) !== entry) return;

    // Before the delivery, so that a worker that dies during it leaves the mark behind. A failure
    // to write it refuses the delivery rather than running one nothing can notice the end of: the
    // row is untouched, so the alarm is still due and a later scheduler picks it up unchanged. The
    // entry is left WAITING with no task, which a `setAlarm` re-arms; a metadata database this
    // scheduler cannot write is already failing every `setAlarm` too.
    try {
      this.#db.run(STMT.markRunning, actorId);
    } catch (exception) {
      this.#taskFailed(exception);
      return;
    }

    entry.status = "STARTED";
    entry.wakeTime = null;
    this.#projectNextWake();
    const retryCount = entry.countedRetry;

    const retryInfo = await this.#runAlarmGuarded(actorId, scheduledTime, retryCount);

    try {
      // ← `:214`'s second `KJ_ASSERT_NONNULL`, which upstream reaches by way of its outer catch when
      // `deleteAll()` cleared the map during the run.
      if (this.#alarms.get(actorId) !== entry) return;

      // We can't overwrite our entry before moving ourselves out of it, as a promise cannot
      // delete itself.
      const task = entry.task;
      if (task === undefined) throw new Error("An alarm task ran before it was recorded.");
      this.#addTask(task);
      entry.task = undefined;

      // If an alarm is queued, there's no point in retrying the current one -- proceed
      // to running the queued alarm instead.
      const queued = entry.queuedAlarm;
      if (queued !== null) {
        // The delivery is over, and the row already describes the queued alarm — `setAlarm` wrote
        // its time and zeroed the retry state when it arrived — so the mark is all that is left to
        // clear.
        this.#db.run(STMT.clearRunning, actorId);
        // creating a new alarm and overwriting the old one will reset
        // `status` to WAITING and `queuedAlarm` to null
        this.#replace(entry, this.#scheduleAlarm(this.#timer.now(), actorId, queued));
        this.#projectNextWake();
        return;
      }

      // When we reach this block of code and alarm has either succeeded or failed and may (or may
      // not) retry. Setting the status of an alarm as FINISHED here, will allow deletion of alarms
      // between retries. If there's a retry, `makeAlarmTask` is called, setting status as RUNNING
      // again.
      entry.status = "FINISHED";

      if (retryInfo.retry) {
        // recreate the task, running after a delay determined using the retry factor
        if (entry.countedRetry >= ALARM_RETRY_MAX_TRIES) {
          await this.#abandon(entry, scheduledTime);
          return;
        }
        if (retryInfo.retryCountsAgainstLimit) {
          entry.countedRetry += 1;

          if (!entry.previousRetryCountedAgainstLimit) {
            // The last retry didn't count against the limit, indicating it was due to some internal
            // error. However, this retry does, meaning it's due to an error in user code,
            // most likely a different error. We should reset the retry counter used for
            // calculating backoff, so user-caused retries don't have an unnecessarily high backoff
            // time if they come after internal-caused retries.

            entry.backoff = 0;
          }
        }
        entry.previousRetryCountedAgainstLimit = retryInfo.retryCountsAgainstLimit;

        entry.backoff = Math.min(RETRY_BACKOFF_MAX, entry.backoff);
        let retryDelay = alarmRetryDelayMs(entry.backoff);

        retryDelay += this.#jitterMsForDelay(retryDelay);

        entry.backoff += 1;
        // Persisted before the task is armed, and it also clears `running`, so the two facts a
        // restart needs — that this delivery ended, and where the ladder now stands — are one
        // write. If it throws, the outer catch records it and the mark stays set, which a later
        // scheduler reads as an interrupted delivery: the alarm keeps its counters and is retried,
        // rather than being armed here in memory the process is about to lose.
        const retryTime = this.#timer.now() + retryDelay;
        this.#db.run(
          STMT.saveRetry,
          retryTime,
          entry.backoff,
          entry.countedRetry,
          entry.previousRetryCountedAgainstLimit ? 1 : 0,
          actorId,
        );

        entry.wakeTime = retryTime;
        entry.task = this.#makeAlarmTask(retryDelay, entry, scheduledTime);
        this.#projectNextWake();
      } else {
        if (entry.queuedAlarm !== null) {
          throw new Error("An alarm that will not retry still has an alarm queued behind it.");
        }
        this.deleteAlarm(actorId);
      }
    } catch (exception) {
      // ← `KJ_LOG(ERROR, "Failed to run alarm and was unable to schedule a retry", exception)`.
      this.#taskFailed(exception);
    }
  }

  /**
   * ← the `countedRetry >= RETRY_MAX_TRIES` block (`alarm-scheduler.c++:237-253`).
   *
   * Its comment, verbatim, because the second half is the whole point: "Notify
   * the actor to clear its in-memory alarm state so getAlarm() reflects the
   * deletion. We ignore the returned remaining time — the workerd-local alarm
   * scheduler already has visibility into the actor's alarm state via its SQLite
   * hooks. If the notification fails, we keep the alarm in the scheduler so it is
   * not silently lost."
   *
   * **Divergence: the returned time is not ignored** (upstream's
   * `.ignoreResult()`, `:244`). Upstream is right that the newer alarm normally
   * arrives on its own — `ActorSqlite` reports it through `scheduleRun`, and it
   * lands in `queuedAlarm`, which `deleteAlarm` below then reschedules for. But
   * that is a race, not an invariant: `abandonAlarm` reads the actor's committed
   * metadata, and there is a window in which the actor's alarm is newer than
   * anything the scheduler has been told about. In that window upstream's
   * unconditional `deleteAlarm` removes both the row and the entry, and the alarm
   * only comes back if a later commit happens to re-announce it. Re-registering
   * what `abandonAlarm` reports closes the window, is a no-op whenever the
   * queued alarm already covered it, and takes the side that preserves the alarm.
   */
  async #abandon(entry: ScheduledAlarm, scheduledTime: number): Promise<void> {
    const actorId = entry.actorId;
    let newerAlarm: number | null;
    try {
      newerAlarm = await this.#getActor(actorId).abandonAlarm(scheduledTime);
    } catch (exception) {
      this.#taskFailed(exception);
      return;
    }
    this.deleteAlarm(actorId);
    if (newerAlarm !== null && !this.#alarms.has(actorId)) {
      this.setAlarm(actorId, newerAlarm);
    }
  }

  /**
   * ← `maxJitterMsForDelay` (`alarm-scheduler.c++:13-16`) drawn through
   * `std::uniform_int_distribution<>(0, max)` (`:272-273`), whose range is
   * inclusive at both ends.
   */
  #jitterMsForDelay(delayMs: number): number {
    const max = Math.floor(RETRY_JITTER_FACTOR * delayMs);
    return Math.min(max, Math.floor(this.#random() * (max + 1)));
  }

  /** The earliest wake a browser watchdog must keep alive across process death. */
  #projectNextWake(): void {
    if (this.#projectWake === undefined) return;
    let earliest: number | null = null;
    for (const entry of this.#alarms.values()) {
      const wake = entry.status === "STARTED" ? entry.queuedAlarm : entry.wakeTime;
      if (wake !== null && (earliest === null || wake < earliest)) earliest = wake;
    }
    this.#projection = Promise.resolve(this.#projectWake(earliest));
    void this.#projection.catch((exception: unknown) => this.#taskFailed(exception));
  }

  /** ← `tasks.add`, whose failures reach `taskFailed`. */
  #addTask(task: Promise<void>): void {
    const tracked = task.then(
      () => {
        this.#tasks.delete(tracked);
      },
      (exception: unknown) => {
        this.#tasks.delete(tracked);
        this.#taskFailed(exception);
      },
    );
    this.#tasks.add(tracked);
  }

  /** ← `taskFailed` (`alarm-scheduler.c++:289-291`). */
  #taskFailed(exception: unknown): void {
    this.#taskFailure ??= { exception };
  }
}

/**
 * Reads one `_cf_ALARM` row's retry state, refusing anything this scheduler
 * could not have written.
 *
 * No upstream twin — upstream reads two columns and neither can be out of range.
 * It fails closed rather than clamping because every value here decides how long
 * an alarm waits or whether it is given up on, and a repaired counter is a
 * silent behaviour change on the one path that has nobody watching it. There is
 * no reader for any older shape: a database written before these columns existed
 * fails at the SELECT, which is what pre-production means here.
 *
 * The ranges are the ladder's own. `backoff` reaches `RETRY_BACKOFF_MAX + 1`
 * because the clamp is applied before the shift and the increment after it
 * (`alarm-scheduler.c++:269-275`), and `counted_retry` reaches
 * `ALARM_RETRY_MAX_TRIES` because the limit is checked before the increment
 * (`:237`).
 */
function readPersistedAlarm(actorId: string, row: readonly unknown[]): PersistedAlarm {
  const retryTime = isNull(row, 2) ? null : getInt64(row, 2);
  const backoff = requireRange(actorId, "backoff", getInt64(row, 3), RETRY_BACKOFF_MAX + 1);
  const countedRetry = requireRange(
    actorId,
    "counted_retry",
    getInt64(row, 4),
    ALARM_RETRY_MAX_TRIES,
  );
  const previous = requireRange(actorId, "previous_retry_counted", getInt64(row, 5), 1);
  const running = requireRange(actorId, "running", getInt64(row, 6), 1);
  return {
    retryTime,
    backoff,
    countedRetry,
    previousRetryCountedAgainstLimit: previous === 1,
    running: running === 1,
  };
}

function requireRange(actorId: string, column: string, value: number, max: number): number {
  if (value < 0 || value > max) {
    throw new Error(
      `Alarm ${column} ${value} for actor ${actorId} is outside [0, ${max}]; ` +
        `_cf_ALARM holds a state this scheduler cannot have written.`,
    );
  }
  return value;
}

/** ← `ensureInitialized` (`alarm-scheduler.c++:50-60`). */
function ensureInitialized(db: SqliteDatabase): void {
  hasCurrentSqliteTable(db, "_cf_ALARM", STMT.createTable);
  // TODO(sqlite): Do this automatically at a lower layer?
  db.run("PRAGMA journal_mode=WAL");

  db.run(STMT.createTable);
}
