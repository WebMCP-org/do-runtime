/**
 * ← workerd `NO upstream test file` — `alarm-scheduler.c++` has no `KJ_TEST`s.
 *
 * So these are this section's own, derived from upstream's behaviour rather
 * than from the implementation: every assertion below names the
 * `alarm-scheduler.c++` line it is reading. The observable half — that an alarm
 * fires, that a re-armed alarm does not overlap, that a failing handler is
 * retried with its retry count — is asserted against workerd in
 * `conformance/suite/alarms.spec.ts` instead.
 *
 * The clock is a fake `Timer`, because none of this is assertable on wall time,
 * and the jitter source is the `random` constructor option for the same reason.
 */

import { describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import type { Timer } from "../io/io-context";
import type { SqlDatabase } from "../util/sqlite";
import type { AlarmResult, AlarmTarget } from "./alarm-scheduler";
import {
  ALARM_RETRY_MAX_TRIES,
  ALARM_RETRY_START_SECONDS,
  AlarmScheduler,
  RETRY_BACKOFF_MAX,
  RETRY_JITTER_FACTOR,
  alarmRetryDelayMs,
} from "./alarm-scheduler";

// =======================================================================================
// Harness

/** A pending `afterDelay`, so a test can fire exactly the wake it means to. */
type PendingDelay = {
  readonly at: number;
  readonly resolve: () => void;
};

/**
 * ← `kj::Clock` and `kj::Timer` together. `now()` never moves on its own, so a
 * test's `advance()` is the only thing that can make an alarm due — which is
 * what makes the re-check loop in `checkTimestamp` reachable at all.
 */
class FakeTimer implements Timer {
  #now: number;
  #pending: PendingDelay[] = [];

  constructor(now = 1_000_000) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  afterDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry: PendingDelay = { at: this.#now + ms, resolve };
      this.#pending.push(entry);
      // A cancelled wake leaves the queue and never settles, which is what kj's cancel-by-drop
      // does and what makes `delays()` below report only the wakes still armed.
      signal?.addEventListener("abort", () => {
        this.#pending = this.#pending.filter((other) => other !== entry);
      });
    });
  }

  /** Moves the clock and resolves every wake now due. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    await this.fireDue();
  }

  /** Resolves every due wake without moving the clock. */
  async fireDue(): Promise<void> {
    const due = this.#pending.filter((entry) => entry.at <= this.#now);
    this.#pending = this.#pending.filter((entry) => entry.at > this.#now);
    for (const entry of due) entry.resolve();
    await settle();
  }

  /**
   * Resolves the earliest pending wake WITHOUT moving the clock past its
   * deadline — the premature fire `checkTimestamp` exists to survive.
   */
  async fireEarly(): Promise<void> {
    const earliest = this.#pending[0];
    if (earliest === undefined) throw new Error("no pending wake to fire early");
    this.#pending = this.#pending.filter((entry) => entry !== earliest);
    earliest.resolve();
    await settle();
  }

  /** Every still-armed wake's delay from now, in schedule order. */
  delays(): number[] {
    return this.#pending.map((entry) => entry.at - this.#now);
  }
}

/** Lets every pending microtask chain run out. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

const OK: AlarmResult = { outcome: "ok", retry: false, retryCountsAgainstLimit: true };

/** A handler failure the user caused: counts against the limit. */
const USER_FAILURE: AlarmResult = {
  outcome: "exception",
  retry: true,
  retryCountsAgainstLimit: true,
};

/** An infrastructure failure: retried forever, never counted. */
const INTERNAL_FAILURE: AlarmResult = {
  outcome: "exception",
  retry: true,
  retryCountsAgainstLimit: false,
};

type Delivery = { readonly scheduledTime: number; readonly retryCount: number };

/** ← the `WorkerInterface` `getActor()` hands back. */
class FakeActor implements AlarmTarget {
  readonly deliveries: Delivery[] = [];
  readonly abandoned: number[] = [];

  /** Consulted per delivery, by index; the last entry repeats. */
  results: AlarmResult[] = [OK];
  /** Thrown instead of returning a result, by delivery index. */
  throwOn = new Set<number>();
  /** Held open by delivery index, so a test can assert what happens mid-run. */
  holds = new Map<number, Promise<void>>();
  /** What `ActorSqlite.abandonAlarm` answers: a newer alarm time, or null. */
  abandonResult: number | null = null;
  abandonFails = false;

  async deliverAlarm(scheduledTime: number, retryCount: number): Promise<AlarmResult> {
    const index = this.deliveries.length;
    this.deliveries.push({ scheduledTime, retryCount });
    const hold = this.holds.get(index);
    if (hold !== undefined) await hold;
    if (this.throwOn.has(index)) throw new Error(`delivery ${index} exploded`);
    return this.results[Math.min(index, this.results.length - 1)] ?? OK;
  }

  async abandonAlarm(scheduledTime: number): Promise<number | null> {
    this.abandoned.push(scheduledTime);
    if (this.abandonFails) throw new Error("abandon notification failed");
    return this.abandonResult;
  }
}

/** Every persisted column, for the tests that assert the retry state itself. */
type StateRow = {
  actor_id: string;
  scheduled_time: number;
  retry_time: number | null;
  backoff: number;
  counted_retry: number;
  previous_retry_counted: number;
  running: number;
};

type Harness = {
  readonly scheduler: AlarmScheduler;
  readonly timer: FakeTimer;
  readonly actor: FakeActor;
  readonly db: SqlDatabase;
  rows(): { actor_id: string; scheduled_time: number }[];
  state(): StateRow[];
};

async function newDatabase(): Promise<SqlDatabase> {
  return await createNodeSqlProvider().open("alarms");
}

/** `random()` returns 0 by default, so the jitter is deterministic and zero. */
async function harness(
  options: {
    db?: SqlDatabase;
    random?: () => number;
    now?: number;
    projectWake?: (scheduledTime: number | null) => void;
  } = {},
): Promise<Harness> {
  const timer = new FakeTimer(options.now);
  const actor = new FakeActor();
  const db = options.db ?? (await newDatabase());
  const scheduler = new AlarmScheduler({
    timer,
    db,
    getActor: () => actor,
    random: options.random ?? ((): number => 0),
    ...(options.projectWake === undefined ? {} : { projectWake: options.projectWake }),
  });
  return {
    scheduler,
    timer,
    actor,
    db,
    rows: () =>
      db
        .exec("SELECT actor_id, scheduled_time FROM _cf_ALARM ORDER BY actor_id", [])
        .rawRows.map((row) => ({ actor_id: String(row[0]), scheduled_time: Number(row[1]) })),
    state: () =>
      db.exec("SELECT * FROM _cf_ALARM ORDER BY actor_id", []).rawRows.map(
        (row) =>
          ({
            actor_id: String(row[0]),
            scheduled_time: Number(row[1]),
            retry_time: row[2] === null ? null : Number(row[2]),
            backoff: Number(row[3]),
            counted_retry: Number(row[4]),
            previous_retry_counted: Number(row[5]),
            running: Number(row[6]),
          }) satisfies StateRow,
      ),
  };
}

// =======================================================================================
// The constants and the ladder formula

describe("the retry ladder constants", () => {
  test("carry upstream's values", () => {
    // ← `WorkerInterface::ALARM_RETRY_START_SECONDS` / `_MAX_TRIES`
    // (`io/worker-interface.h:130-131`) and `AlarmScheduler::RETRY_BACKOFF_MAX` /
    // `RETRY_JITTER_FACTOR` (`alarm-scheduler.h:50`, `:54`).
    expect(ALARM_RETRY_START_SECONDS).toBe(2);
    expect(ALARM_RETRY_MAX_TRIES).toBe(6);
    expect(RETRY_BACKOFF_MAX).toBe(9);
    expect(RETRY_JITTER_FACTOR).toBe(0.25);
  });

  test("alarmRetryDelayMs is `(RETRY_START_SECONDS << backoff) * SECONDS`", () => {
    // ← `alarm-scheduler.c++:270`.
    expect(alarmRetryDelayMs(0)).toBe(2_000);
    expect(alarmRetryDelayMs(1)).toBe(4_000);
    expect(alarmRetryDelayMs(5)).toBe(64_000);
    // "2 << 9 is 1024 seconds, about 17 minutes" (`alarm-scheduler.h:48-49`).
    expect(alarmRetryDelayMs(RETRY_BACKOFF_MAX)).toBe(1_024_000);
  });

  test("alarmRetryDelayMs refuses a backoff the clamp should have bounded", () => {
    // JS's `<<` is 32-bit, so an unclamped shift silently wraps to zero or to a
    // negative delay. The ladder clamps before it shifts; this makes that clamp
    // load bearing rather than decorative.
    expect(() => alarmRetryDelayMs(RETRY_BACKOFF_MAX + 1)).toThrow(/backoff/);
    expect(() => alarmRetryDelayMs(-1)).toThrow(/backoff/);
  });
});

// =======================================================================================
// The persistent table

describe("_cf_ALARM", () => {
  test("projects the earliest durable wake after every public schedule change", async () => {
    const projected: (number | null)[] = [];
    const { scheduler } = await harness({ projectWake: (wake) => projected.push(wake) });
    expect(projected).toEqual([null]);

    scheduler.setAlarm("later", 1_009_000);
    scheduler.setAlarm("earlier", 1_005_000);
    scheduler.deleteAlarm("earlier");
    scheduler.deleteAlarm("later");

    expect(projected).toEqual([null, 1_009_000, 1_005_000, 1_009_000, null]);
  });

  test("refuses an incompatible present table before changing the database", async () => {
    const db = await newDatabase();
    db.exec("CREATE TABLE _cf_ALARM (sentinel INTEGER)", []);
    const before = db.exec("SELECT type, name, sql FROM sqlite_master", []).rawRows;

    await expect(harness({ db })).rejects.toThrow("Incompatible @mcp-b/do-runtime storage schema");
    expect(db.exec("SELECT type, name, sql FROM sqlite_master", []).rawRows).toEqual(before);
  });

  test("is created at construction, keyed by actor id, WITHOUT ROWID", async () => {
    // ← `ensureInitialized` (`alarm-scheduler.c++:50-60`).
    const { db } = await harness();
    const sql = db.exec(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_cf_ALARM'",
      [],
    );
    const definition = String(sql.rawRows[0]?.[0]);
    expect(definition).toMatch(/actor_id\s+TEXT\s+PRIMARY\s+KEY/i);
    expect(definition).toMatch(/scheduled_time\s+INTEGER/i);
    expect(definition).toMatch(/WITHOUT\s+ROWID/i);
    // The five columns upstream does not have. Every one is NOT NULL except the
    // wake, which is null while an alarm waits for its own time.
    expect(definition).toMatch(/retry_time\s+INTEGER,/i);
    expect(definition).toMatch(/backoff\s+INTEGER\s+NOT\s+NULL/i);
    expect(definition).toMatch(/counted_retry\s+INTEGER\s+NOT\s+NULL/i);
    expect(definition).toMatch(/previous_retry_counted\s+INTEGER\s+NOT\s+NULL/i);
    expect(definition).toMatch(/running\s+INTEGER\s+NOT\s+NULL/i);
  });

  test("setAlarm writes the row and reports the change", async () => {
    const { scheduler, rows } = await harness();
    // ← `stmtSetAlarm` plus `return query.changeCount() > 0` (`:117-120`, `:126`).
    expect(scheduler.setAlarm("a", 2_000_000)).toBe(true);
    expect(rows()).toEqual([{ actor_id: "a", scheduled_time: 2_000_000 }]);

    expect(scheduler.setAlarm("a", 3_000_000)).toBe(true);
    expect(rows()).toEqual([{ actor_id: "a", scheduled_time: 3_000_000 }]);
  });

  test("deleteAlarm removes the row and reports whether it was there", async () => {
    const { scheduler, rows } = await harness();
    scheduler.setAlarm("a", 2_000_000);
    expect(scheduler.deleteAlarm("a")).toBe(true);
    expect(rows()).toEqual([]);
    expect(scheduler.deleteAlarm("a")).toBe(false);
  });

  test("deleteAll cancels every pending alarm and wipes the store", async () => {
    // ← `deleteAll` (`:129-134`).
    const { scheduler, timer, rows } = await harness();
    scheduler.setAlarm("a", 2_000_000);
    scheduler.setAlarm("b", 3_000_000);
    expect(timer.delays()).toHaveLength(2);

    scheduler.deleteAll();

    expect(rows()).toEqual([]);
    expect(scheduler.getAlarm("a")).toBe(null);
    expect(timer.delays()).toEqual([]);
  });

  test("loadAlarmsFromDb reschedules everything a previous session left behind", async () => {
    // ← `loadAlarmsFromDb` (`:62-82`), called from the constructor (`:47`).
    const db = await newDatabase();
    const first = await harness({ db });
    first.scheduler.setAlarm("a", 1_000_000 + 5_000);
    first.scheduler.setAlarm("b", 1_000_000 + 9_000);

    const second = await harness({ db });
    expect(second.scheduler.getAlarm("a")).toBe(1_005_000);
    expect(second.scheduler.getAlarm("b")).toBe(1_009_000);
    expect(second.timer.delays()).toEqual([5_000, 9_000]);
  });
});

// =======================================================================================
// getAlarm / setAlarm / deleteAlarm around a running handler

describe("the queued alarm", () => {
  /** Arms an alarm and drives it into a delivery that has not yet resolved. */
  async function running(): Promise<Harness & { finish: (result?: AlarmResult) => Promise<void> }> {
    const context = await harness();
    const { promise, resolve } = Promise.withResolvers<void>();
    context.actor.holds.set(0, promise);
    context.scheduler.setAlarm("a", 1_005_000);
    await context.timer.advance(5_000);
    expect(context.actor.deliveries).toHaveLength(1);
    return {
      ...context,
      finish: async (result = OK): Promise<void> => {
        context.actor.results = [result, OK];
        resolve();
        await settle();
      },
    };
  }

  test("getAlarm answers the scheduled time while WAITING", async () => {
    // ← `getAlarm` (`:84-99`).
    const { scheduler } = await harness();
    expect(scheduler.getAlarm("a")).toBe(null);
    scheduler.setAlarm("a", 2_000_000);
    expect(scheduler.getAlarm("a")).toBe(2_000_000);
  });

  test("getAlarm answers null while a handler runs, and the queued alarm once there is one", async () => {
    // ← "getAlarm() when the alarm handler is running should return null, unless
    // an alarm is queued" (`:88-91`).
    const context = await running();
    expect(context.scheduler.getAlarm("a")).toBe(null);

    context.scheduler.setAlarm("a", 1_009_000);
    expect(context.scheduler.getAlarm("a")).toBe(1_009_000);
    await context.finish();
  });

  test("setAlarm during a run queues behind rather than replacing, even for the same time", async () => {
    // ← "We queue any new alarm after the existing alarm even if the new alarm
    // has the same scheduled time" (`:117-120`).
    const context = await running();
    context.scheduler.setAlarm("a", 1_005_000);
    await context.finish();

    expect(context.actor.deliveries).toHaveLength(1);
    await context.timer.fireDue();
    expect(context.actor.deliveries).toHaveLength(2);
    expect(context.actor.deliveries[1]).toEqual({ scheduledTime: 1_005_000, retryCount: 0 });
  });

  test("deleteAlarm during a run deletes the queued alarm and cannot remove the running one", async () => {
    // ← "If we are currently running an alarm, we want to delete the queued
    // instead of current" (`:140-143`) and "We can't remove running alarms"
    // (`:148-151`).
    const context = await running();
    context.scheduler.setAlarm("a", 1_009_000);

    expect(context.scheduler.deleteAlarm("a")).toBe(true);
    expect(context.scheduler.getAlarm("a")).toBe(null);

    // The running alarm survives the delete: a second one finds the entry still there.
    context.actor.results = [OK, OK];
    await context.finish();
    expect(context.actor.deliveries).toHaveLength(1);
  });

  test("deleteAlarm during a run with nothing queued leaves the entry, so a retry still arms", async () => {
    // ← "We can't remove running alarms" (`:148-151`). The row goes, but the
    // entry does not — erasing it would cancel the in-flight run's ladder, which
    // is the one thing a delete cannot be allowed to do silently.
    const context = await running();
    expect(context.scheduler.deleteAlarm("a")).toBe(true);
    expect(context.rows()).toEqual([]);

    await context.finish(USER_FAILURE);
    expect(context.timer.delays()).toEqual([2_000]);
  });

  test("deleteAlarm outside a run reschedules for the queued alarm rather than dropping it", async () => {
    // ← `entry.value = scheduleAlarm(clock.now(), ..., queued)` (`:145`).
    //
    // Reachable because a retry leaves the entry FINISHED while it waits: a
    // `setAlarm` in that window queues (status is not WAITING), and the delete
    // then has a queued alarm to promote rather than an entry to erase.
    const context = await running();
    await context.finish(USER_FAILURE);
    expect(context.timer.delays()).toEqual([2_000]);

    context.scheduler.setAlarm("a", 1_020_000);
    expect(context.scheduler.deleteAlarm("a")).toBe(true);
    expect(context.scheduler.getAlarm("a")).toBe(1_020_000);
    expect(context.timer.delays()).toEqual([15_000]);
  });

  test("a queued alarm short-circuits a retry", async () => {
    // ← "If an alarm is queued, there's no point in retrying the current one"
    // (`:220-227`).
    const context = await running();
    context.scheduler.setAlarm("a", 1_040_000);
    await context.finish(USER_FAILURE);

    // The retry ladder never armed: the queued alarm's own delay did.
    expect(context.timer.delays()).toEqual([35_000]);
    expect(context.scheduler.getAlarm("a")).toBe(1_040_000);
  });

  test("a queued alarm resets the retry counters, because the entry is replaced", async () => {
    // "creating a new alarm and overwriting the old one will reset `status` to
    // WAITING and `queuedAlarm` to null" (`:223-225`) — and every counter with
    // them, since the whole `ScheduledAlarm` is replaced.
    const context = await running();
    context.scheduler.setAlarm("a", 1_005_000);
    await context.finish(USER_FAILURE);

    await context.timer.fireDue();
    expect(context.actor.deliveries[1]?.retryCount).toBe(0);
  });
});

// =======================================================================================
// The retry ladder

/** Arms an alarm for right now and lets it fire. */
async function fire(context: Harness): Promise<void> {
  context.scheduler.setAlarm("a", context.timer.now());
  await context.timer.fireDue();
}

/** Walks up to `rounds` retry wakes, returning the delay each one waited. */
async function ladder(context: Harness, rounds: number): Promise<number[]> {
  const seen: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const next = context.timer.delays()[0];
    if (next === undefined) break;
    seen.push(next);
    await context.timer.advance(next);
  }
  return seen;
}

describe("the retry ladder", () => {
  test("counted failures climb `2 << backoff` seconds and stop at RETRY_MAX_TRIES", async () => {
    // ← `:235-278`. Six retries because the limit bounds `countedRetry`, and the
    // seventh delivery finds `countedRetry >= RETRY_MAX_TRIES` and abandons.
    const context = await harness();
    context.actor.results = [USER_FAILURE];
    await fire(context);

    expect(await ladder(context, 10)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
    expect(context.actor.deliveries).toHaveLength(ALARM_RETRY_MAX_TRIES + 1);
  });

  test("the handler is told how many counted retries preceded it", async () => {
    // ← `retryCount = entry.value.countedRetry` (`:194`), which becomes
    // `AlarmInvocationInfo{scheduledTime, retryCount}` in the handler.
    const context = await harness();
    context.actor.results = [USER_FAILURE];
    await fire(context);
    await ladder(context, 10);

    expect(context.actor.deliveries.map((delivery) => delivery.retryCount)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  test("every delivery carries the original scheduled time", async () => {
    // ← `makeAlarmTask(delay, actorRef, scheduledTime)` (`:278`) — the retry is
    // for the same alarm, so the time the handler sees never moves.
    const context = await harness();
    context.actor.results = [USER_FAILURE];
    const scheduledTime = context.timer.now();
    await fire(context);
    await ladder(context, 3);

    expect(new Set(context.actor.deliveries.map((delivery) => delivery.scheduledTime))).toEqual(
      new Set([scheduledTime]),
    );
  });

  test("uncounted failures are retried forever and clamp at RETRY_BACKOFF_MAX", async () => {
    // ← `kj::min(RETRY_BACKOFF_MAX, backoff)` BEFORE the shift (`:269-270`), and
    // the `backoff++` after it (`:275`). Without the clamp the shift wraps: JS's
    // `<<` is 32-bit, so backoff 31 would be a zero delay and a hot loop.
    const context = await harness();
    context.actor.results = [INTERNAL_FAILURE];
    await fire(context);

    expect(await ladder(context, 14)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_024_000, 1_024_000,
      1_024_000, 1_024_000, 1_024_000,
    ]);
    // abandonAlarm is NEVER called: `countedRetry` never moved off zero.
    expect(context.actor.abandoned).toEqual([]);
    expect(context.scheduler.getAlarm("a")).not.toBe(null);
  });

  test("a counted retry after uncounted ones resets the backoff, but a second one does not", async () => {
    // ← "The last retry didn't count against the limit ... We should reset the
    // retry counter used for calculating backoff" (`:257-265`), guarded by
    // `previousRetryCountedAgainstLimit` (`:267`).
    const context = await harness();
    context.actor.results = [
      INTERNAL_FAILURE,
      INTERNAL_FAILURE,
      INTERNAL_FAILURE,
      USER_FAILURE,
      USER_FAILURE,
      OK,
    ];
    await fire(context);

    expect(await ladder(context, 6)).toEqual([
      // Three internal failures walk the backoff up.
      2_000, 4_000, 8_000,
      // The first counted one resets it, because the previous retry did not count.
      2_000,
      // The second counted one does not, because the previous one did.
      4_000,
    ]);
  });

  test("a counted retry after counted ones leaves the backoff alone", async () => {
    const context = await harness();
    context.actor.results = [USER_FAILURE, USER_FAILURE, INTERNAL_FAILURE, USER_FAILURE, OK];
    await fire(context);

    expect(await ladder(context, 5)).toEqual([
      2_000, 4_000,
      // The internal failure does not touch `countedRetry` and does not reset backoff.
      8_000,
      // This one counts and the previous did not, so backoff resets.
      2_000,
    ]);
  });

  test("jitter is drawn from [0, 25% of the delay] and added after the clamp", async () => {
    // ← `maxJitterMsForDelay` (`:13-16`) through
    // `std::uniform_int_distribution<>(0, max)` (`:272-273`).
    const context = await harness({ random: () => 0.999_999 });
    context.actor.results = [INTERNAL_FAILURE];
    await fire(context);

    expect(await ladder(context, 11)).toEqual([
      2_500, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 1_280_000, 1_280_000,
    ]);
  });

  test("jitter never exceeds its bound even for a random source that returns 1", async () => {
    const context = await harness({ random: () => 1 });
    context.actor.results = [USER_FAILURE];
    await fire(context);

    expect(await ladder(context, 2)).toEqual([2_500, 5_000]);
  });

  test("a result that says retry but reports success is not retried", async () => {
    // ← `result.outcome != EventOutcome::OK && result.retry` (`:162`).
    const context = await harness();
    context.actor.results = [{ outcome: "ok", retry: true, retryCountsAgainstLimit: true }];
    await fire(context);

    expect(await ladder(context, 3)).toEqual([]);
    expect(context.scheduler.getAlarm("a")).toBe(null);
  });

  test("a delivery that throws is retried without counting against the limit", async () => {
    // ← the catch around `runAlarm` (`:197-211`): "An exception here is 'weird'
    // ... Let's not count this retry attempt against the limit."
    const context = await harness();
    context.actor.throwOn = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    await fire(context);

    expect(await ladder(context, 8)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
    ]);
    expect(context.actor.abandoned).toEqual([]);
    expect(String(context.scheduler.taskFailure())).toContain("delivery 0 exploded");
  });

  test("a successful delivery deletes the alarm", async () => {
    // ← `KJ_ASSERT(queuedAlarm == none); deleteAlarm(actorRef)` (`:279-282`).
    const context = await harness();
    await fire(context);

    expect(context.scheduler.getAlarm("a")).toBe(null);
    expect(context.rows()).toEqual([]);
  });
});

// =======================================================================================
// Abandoning

describe("abandonAlarm", () => {
  /** Drives an alarm all the way to the abandon block. */
  async function exhaust(context: Harness): Promise<void> {
    context.actor.results = [USER_FAILURE];
    await fire(context);
    await ladder(context, ALARM_RETRY_MAX_TRIES);
  }

  test("is notified once, with the alarm's own scheduled time, and clears the alarm", async () => {
    // ← `:243-252`.
    const context = await harness();
    const scheduledTime = context.timer.now();
    await exhaust(context);

    expect(context.actor.abandoned).toEqual([scheduledTime]);
    expect(context.scheduler.getAlarm("a")).toBe(null);
    expect(context.rows()).toEqual([]);
  });

  test("re-registers the newer alarm the actor reports instead of dropping it", async () => {
    // Divergence from `.ignoreResult()` (`:244`) — see `#abandon`'s comment.
    const context = await harness();
    context.actor.abandonResult = 9_000_000;
    await exhaust(context);

    expect(context.scheduler.getAlarm("a")).toBe(9_000_000);
    expect(context.rows()).toEqual([{ actor_id: "a", scheduled_time: 9_000_000 }]);
  });

  test("a failed notification keeps the alarm in the scheduler rather than losing it", async () => {
    // ← "If the notification fails, we keep the alarm in the scheduler so it is
    // not silently lost" (`:243-250`).
    const context = await harness();
    const scheduledTime = context.timer.now();
    context.actor.abandonFails = true;
    await exhaust(context);

    expect(context.scheduler.getAlarm("a")).toBe(scheduledTime);
    expect(context.rows()).toEqual([{ actor_id: "a", scheduled_time: scheduledTime }]);
    expect(String(context.scheduler.taskFailure())).toContain("abandon notification failed");
  });

  test("an alarm queued while the notification was in flight is promoted, not deleted", async () => {
    // `deleteAlarm` finds the queued alarm and reschedules for it (`:139-146`),
    // which is why upstream can ignore what `abandonAlarm` returned.
    const context = await harness();
    const { promise, resolve } = Promise.withResolvers<void>();
    const actor = context.actor;
    actor.abandonAlarm = async (scheduledTime: number): Promise<number | null> => {
      actor.abandoned.push(scheduledTime);
      await promise;
      return null;
    };
    await exhaust(context);

    context.scheduler.setAlarm("a", 8_000_000);
    resolve();
    await settle();

    expect(context.scheduler.getAlarm("a")).toBe(8_000_000);
  });
});

// =======================================================================================
// The ActorSqlite hooks

describe("hooks", () => {
  test("turn a time into setAlarm and deleteAlarm", async () => {
    // ← `ActorSqliteHooks::scheduleRun` (`server.c++:3206-3214`).
    const { scheduler, rows } = await harness();
    const outlet = scheduler.hooks("a");

    await outlet.scheduleRun(2_000_000, Promise.resolve());
    expect(scheduler.getAlarm("a")).toBe(2_000_000);
    expect(rows()).toEqual([{ actor_id: "a", scheduled_time: 2_000_000 }]);

    await outlet.scheduleRun(null, Promise.resolve());
    expect(scheduler.getAlarm("a")).toBe(null);
    expect(rows()).toEqual([]);
  });

  test("report a scheduling failure synchronously, before the caller commits", async () => {
    const { scheduler, db } = await harness();
    db.close();
    expect(() =>
      scheduler.hooks("a").scheduleRun(1, Promise.resolve()),
    ).toThrow();
  });
});

// =======================================================================================
// checkTimestamp

describe("checkTimestamp", () => {
  test("re-waits when the timer fires before the scheduled time has arrived", async () => {
    // ← "it's possible that timer.now() was behind the real time by a few ms,
    // leading to premature alarm() execution" (`:173-185`).
    const { scheduler, timer, actor } = await harness();
    scheduler.setAlarm("a", 1_010_000);

    await timer.fireEarly();
    expect(actor.deliveries).toHaveLength(0);
    // A fresh wake for exactly the remaining time.
    expect(timer.delays()).toEqual([10_000]);

    await timer.advance(4_000);
    await timer.fireEarly();
    expect(actor.deliveries).toHaveLength(0);
    expect(timer.delays()).toEqual([6_000]);

    await timer.advance(6_000);
    expect(actor.deliveries).toHaveLength(1);
  });
});

// =======================================================================================
// The retry state across a restart — this package's divergence from upstream

/**
 * Builds a second scheduler over the same database at the first one's clock,
 * which is what an MV3 service-worker restart looks like from here: the process
 * is gone, the database is not, and the wall clock did not rewind.
 */
async function restart(previous: Harness): Promise<Harness> {
  return await harness({ db: previous.db, now: previous.timer.now() });
}

/** A delivery that never returns, which is what an evicted worker looks like. */
const NEVER = new Promise<void>(() => {});

/** Refuses one statement and passes everything else through. */
function refusing(db: SqlDatabase, statement: RegExp): SqlDatabase {
  return {
    prepare: (sql) => {
      const prepared = db.prepare(sql);
      if (statement.test(prepared.sql)) {
        prepared.close();
        throw new Error("metadata write refused");
      }
      return prepared;
    },
    exec: (sql, params) => {
      if (statement.test(sql)) throw new Error("metadata write refused");
      return db.exec(sql, params);
    },
    get databaseSize(): number {
      return db.databaseSize;
    },
    get inTransaction(): boolean {
      return db.inTransaction;
    },
    reset: () => db.reset(),
    close: () => db.close(),
  };
}

describe("the retry state survives a restart", () => {
  test("the ladder continues where the previous scheduler left it", async () => {
    // The regression this section exists to prevent. Upstream rebuilds every
    // entry with `countedRetry = 0` and `backoff = 0`, which is affordable for a
    // process that lives for hours and is not for one that lives for seconds.
    const first = await harness();
    first.actor.results = [USER_FAILURE];
    await fire(first);
    expect(await ladder(first, 2)).toEqual([2_000, 4_000]);
    expect(first.actor.deliveries).toHaveLength(3);

    const second = await restart(first);
    second.actor.results = [USER_FAILURE];

    // The wake the previous scheduler armed, with the time already served
    // deducted rather than restarted.
    expect(second.timer.delays()).toEqual([8_000]);
    expect(await ladder(second, 2)).toEqual([8_000, 16_000]);
    expect(second.actor.deliveries.map((delivery) => delivery.retryCount)).toEqual([3, 4]);
  });

  test("abandonAlarm is reachable across a restart boundary", async () => {
    // The half of the regression with no upper bound: with `countedRetry` reset
    // per worker lifetime, `#abandon` is unreachable and a permanently failing
    // alarm is retried forever. One restart per rung, which is the shape of a
    // service worker that is evicted between wakes.
    let context = await harness();
    const scheduledTime = context.timer.now();
    context.actor.results = [USER_FAILURE];
    await fire(context);

    const retryCounts: number[] = [];
    for (let restarts = 0; restarts < ALARM_RETRY_MAX_TRIES; restarts += 1) {
      context = await restart(context);
      context.actor.results = [USER_FAILURE];
      await ladder(context, 1);
      retryCounts.push(context.actor.deliveries[0]?.retryCount ?? -1);
    }

    expect(retryCounts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(context.actor.abandoned).toEqual([scheduledTime]);
    expect(context.rows()).toEqual([]);
  });

  test("the delay grows across restarts rather than pinning to the first rung", async () => {
    // A handler whose delivery never returns, restarted after each one: the
    // exact poison alarm this substrate produces, because Chrome evicting the
    // worker mid-alarm is indistinguishable from a handler that hangs.
    let context = await harness();
    context.actor.holds.set(0, NEVER);
    await fire(context);
    expect(context.actor.deliveries).toHaveLength(1);

    const delays: number[] = [];
    for (let restarts = 0; restarts < 11; restarts += 1) {
      context = await restart(context);
      context.actor.holds.set(0, NEVER);
      const delay = context.timer.delays()[0] ?? -1;
      delays.push(delay);
      await context.timer.advance(delay);
      expect(context.actor.deliveries).toHaveLength(1);
    }

    expect(delays).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_024_000, 1_024_000,
    ]);
    // Never abandoned, and never counted: an evicted worker is an infrastructure
    // failure, which is the category upstream retries forever and bounds by
    // RETRY_BACKOFF_MAX rather than by ALARM_RETRY_MAX_TRIES.
    expect(context.actor.abandoned).toEqual([]);
    expect(context.state()[0]?.counted_retry).toBe(0);
    expect(context.state()[0]?.backoff).toBe(RETRY_BACKOFF_MAX + 1);
  });

  test("an interrupted delivery is recovered as an uncounted retry, once", async () => {
    const first = await harness();
    const scheduledTime = first.timer.now();
    first.actor.holds.set(0, NEVER);
    await fire(first);
    expect(first.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime,
        retry_time: null,
        backoff: 0,
        counted_retry: 0,
        previous_retry_counted: 0,
        running: 1,
      },
    ]);

    const second = await restart(first);
    // The mark is cleared as it is recovered, so a third scheduler over the same
    // database does not charge the same interruption a second rung.
    expect(second.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime,
        retry_time: scheduledTime + 2_000,
        backoff: 1,
        counted_retry: 0,
        previous_retry_counted: 0,
        running: 0,
      },
    ]);

    const third = await restart(second);
    expect(third.timer.delays()).toEqual([2_000]);
    expect(third.state()[0]?.backoff).toBe(1);
  });

  test("an interruption makes the next counted failure reset the backoff", async () => {
    // The recovery is an UNCOUNTED retry, so upstream's rule for a user error
    // arriving after an internal one applies to the failure after it: reset the
    // backoff, "so user-caused retries don't have an unnecessarily high backoff
    // time if they come after internal-caused retries" (`:257-265`). Carrying
    // the previous flag through the recovery instead would charge a user error
    // the rungs an evicted worker had built up.
    const first = await harness();
    first.actor.results = [USER_FAILURE];
    await fire(first);
    expect(first.state()[0]?.previous_retry_counted).toBe(1);

    const second = await restart(first);
    second.actor.holds.set(0, NEVER);
    await ladder(second, 1);
    expect(second.state()[0]?.running).toBe(1);

    const third = await restart(second);
    expect(third.state()[0]?.previous_retry_counted).toBe(0);
    third.actor.results = [USER_FAILURE];
    // The recovery's own rung, then the counted failure starting over.
    expect(await ladder(third, 2)).toEqual([4_000, 2_000]);
  });

  test("the recovered wake carries the jitter every other retry gets", async () => {
    // ← `maxJitterMsForDelay` (`:13-16`): a recovery is a retry, and a fleet of
    // alarms interrupted by the same eviction is exactly the bundle the jitter
    // exists to spread out.
    const first = await harness({ random: () => 0.999_999 });
    first.actor.holds.set(0, NEVER);
    await fire(first);

    const second = await harness({
      db: first.db,
      now: first.timer.now(),
      random: () => 0.999_999,
    });
    expect(second.timer.delays()).toEqual([2_500]);
  });

  test("recovering an interrupted delivery never pulls a later alarm earlier", async () => {
    // A `setAlarm` from inside the handler is the common case, and it leaves the
    // row holding a FUTURE scheduled time while the delivery is still marked
    // running. Honouring the recovery's own two seconds would fire that alarm an
    // hour early.
    const first = await harness();
    const later = first.timer.now() + 3_600_000;
    first.actor.holds.set(0, NEVER);
    await fire(first);
    first.scheduler.setAlarm("a", later);

    const second = await restart(first);
    expect(second.timer.delays()).toEqual([3_600_000]);
    expect(second.scheduler.getAlarm("a")).toBe(later);
  });

  test("previousRetryCountedAgainstLimit survives, so the backoff does not reset spuriously", async () => {
    // Without it every restart looks like "the last retry was an internal
    // error", and the first counted failure after one resets the backoff to zero
    // — the persisted ladder would climb and then be thrown away
    // (`alarm-scheduler.c++:257-265`).
    const first = await harness();
    first.actor.results = [USER_FAILURE];
    await fire(first);
    await ladder(first, 1);
    expect(first.state()[0]?.previous_retry_counted).toBe(1);

    const second = await restart(first);
    second.actor.results = [USER_FAILURE];
    expect(await ladder(second, 2)).toEqual([4_000, 8_000]);
  });

  test("a new alarm time carries a fresh retry budget, in the row as well as in memory", async () => {
    const first = await harness();
    const scheduledTime = first.timer.now();
    first.actor.results = [USER_FAILURE];
    await fire(first);
    expect(first.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime,
        retry_time: scheduledTime + 2_000,
        backoff: 1,
        counted_retry: 1,
        previous_retry_counted: 1,
        running: 0,
      },
    ]);

    // The entry is FINISHED while it waits for its retry, so this queues in
    // memory — but the row already describes the queued alarm, which is what a
    // restart resumes, and it resumes it unpenalised.
    first.scheduler.setAlarm("a", scheduledTime + 50_000);
    expect(first.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime + 50_000,
        retry_time: null,
        backoff: 0,
        counted_retry: 0,
        previous_retry_counted: 0,
        running: 0,
      },
    ]);

    const second = await restart(first);
    expect(second.timer.delays()).toEqual([50_000]);
    second.actor.results = [USER_FAILURE];
    expect(await ladder(second, 2)).toEqual([50_000, 2_000]);
    expect(second.actor.deliveries[0]?.retryCount).toBe(0);
  });

  test("a queued alarm clears the running mark when the delivery it queued behind ends", async () => {
    const context = await harness();
    const scheduledTime = context.timer.now();
    const { promise, resolve } = Promise.withResolvers<void>();
    context.actor.holds.set(0, promise);
    await fire(context);
    context.scheduler.setAlarm("a", scheduledTime + 40_000);
    expect(context.state()[0]?.running).toBe(1);

    resolve();
    await settle();

    expect(context.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime + 40_000,
        retry_time: null,
        backoff: 0,
        counted_retry: 0,
        previous_retry_counted: 0,
        running: 0,
      },
    ]);
  });

  test("a successful delivery leaves no row to recover", async () => {
    const first = await harness();
    await fire(first);
    expect(first.state()).toEqual([]);

    const second = await restart(first);
    expect(second.timer.delays()).toEqual([]);
    expect(second.actor.deliveries).toEqual([]);
  });

  test("a delivery that cannot record that it started does not start", async () => {
    // Running one anyway would make an interruption undetectable, which is the
    // one thing the mark exists to prevent. The row is untouched, so the alarm
    // is still due and a later scheduler picks it up unchanged.
    const db = await newDatabase();
    const context = await harness({ db: refusing(db, /SET running = 1/) });
    const scheduledTime = context.timer.now();
    await fire(context);

    expect(context.actor.deliveries).toEqual([]);
    expect(String(context.scheduler.taskFailure())).toContain("metadata write refused");
    expect(context.state()).toEqual([
      {
        actor_id: "a",
        scheduled_time: scheduledTime,
        retry_time: null,
        backoff: 0,
        counted_retry: 0,
        previous_retry_counted: 0,
        running: 0,
      },
    ]);

    const second = await harness({ db, now: context.timer.now() });
    await second.timer.fireDue();
    expect(second.actor.deliveries).toHaveLength(1);
  });

  test("a retry that cannot be persisted leaves the alarm recoverable rather than armed", async () => {
    // The write carries both the ladder and the end of the delivery, so its
    // failure has to leave the mark set: the in-memory retry is about to be lost
    // with the process, and the row is the only thing that outlives it.
    const db = await newDatabase();
    const context = await harness({ db: refusing(db, /SET retry_time/) });
    context.actor.results = [USER_FAILURE];
    await fire(context);

    expect(String(context.scheduler.taskFailure())).toContain("metadata write refused");
    expect(context.timer.delays()).toEqual([]);
    expect(context.state()[0]?.running).toBe(1);

    const second = await harness({ db, now: context.timer.now() });
    expect(second.timer.delays()).toEqual([2_000]);
  });
});

describe("_cf_ALARM's retry state fails closed", () => {
  async function corrupt(column: string, value: number): Promise<SqlDatabase> {
    const db = await newDatabase();
    const first = await harness({ db });
    first.scheduler.setAlarm("a", 2_000_000);
    db.exec(`UPDATE _cf_ALARM SET ${column} = ?`, [value]);
    return db;
  }

  test("a backoff no ladder could have produced is refused", async () => {
    const db = await corrupt("backoff", RETRY_BACKOFF_MAX + 2);
    await expect(harness({ db })).rejects.toThrow(/backoff 11 for actor a is outside \[0, 10\]/);
  });

  test("the backoff the clamp can legitimately reach is not refused", async () => {
    // `backoff` is clamped BEFORE the shift and incremented after it, so
    // RETRY_BACKOFF_MAX + 1 is a value this scheduler really writes.
    const db = await corrupt("backoff", RETRY_BACKOFF_MAX + 1);
    await expect(harness({ db })).resolves.toBeDefined();
  });

  test("a counted retry past the abandon limit is refused", async () => {
    const db = await corrupt("counted_retry", ALARM_RETRY_MAX_TRIES + 1);
    await expect(harness({ db })).rejects.toThrow(/counted_retry 7/);
  });

  test("a negative counter is refused", async () => {
    const db = await corrupt("counted_retry", -1);
    await expect(harness({ db })).rejects.toThrow(/counted_retry -1/);
  });

  test("a running mark that is neither 0 nor 1 is refused", async () => {
    const db = await corrupt("running", 2);
    await expect(harness({ db })).rejects.toThrow(/running 2 for actor a is outside \[0, 1\]/);
  });

  test("a previous-retry flag that is neither 0 nor 1 is refused", async () => {
    const db = await corrupt("previous_retry_counted", 5);
    await expect(harness({ db })).rejects.toThrow(/previous_retry_counted 5/);
  });

  test("a row with no retry state cannot be written in the first place", async () => {
    // Upstream's whole row, refused by the table rather than by the reader.
    // There is no migration and no reader for the old two-column shape — nothing
    // is installed anywhere — so the constraint is where that is enforced, and a
    // counter can never arrive NULL for `requireRange` to have an opinion about.
    const db = await newDatabase();
    await harness({ db });
    expect(() =>
      db.exec("INSERT INTO _cf_ALARM (actor_id, scheduled_time) VALUES (?, ?)", ["a", 2_000_000]),
    ).toThrow(/NOT NULL/);
  });
});
