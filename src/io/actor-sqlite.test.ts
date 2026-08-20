/**
 * ← workerd `src/workerd/io/actor-sqlite-test.c++`.
 *
 * 97 `KJ_TEST` cases, 96 of them distinct — "check put multiple wraps operations
 * in a transaction" appears twice, byte for byte, and is ported once. Every one
 * of the 96 is ported, and each keeps upstream's title so a failure names the
 * upstream case to read.
 *
 * Seven translations, all forced and all mechanical:
 *
 *  1. **`expectSync` disappears.** Upstream returns `kj::OneOf<T, Promise<T>>`
 *     from every read and write so a cache miss can go to the network; §1.4
 *     measures that a SQLite-backed actor never does, so `actor-cache.ts` drops
 *     the arm nobody reaches and the calls return values.
 *  2. **`ws.poll()` becomes `await quiesce()`.** kj's wait scope runs the event
 *     loop until nothing is ready; JS has no such primitive, so a fixed number
 *     of macrotask turns replaces it. `setImmediate` and not `setTimeout`
 *     because `setTimeout(0)` costs a millisecond a turn and this file polls
 *     several hundred times; a `MessageChannel` hand-off — which is what both
 *     the gate release and the implicit-transaction commit ride — is delivered
 *     before a `setImmediate` queued after it, measured.
 *  3. **Every kj destructor becomes an explicit call**, Section 1's rule:
 *     `kj::Own<void> deferredDelete` going out of scope is
 *     `deferredDelete.drop()`, and a transaction going out of scope without
 *     `commit()` is `txn.drop()`.
 *  4. **`gate.onBroken()` may be called once**, upstream's own `KJ_REQUIRE`, so
 *     the harness calls it and exposes `gateBroken` rather than each test
 *     calling it. `monitorOutputGate` keeps its meaning: with it on, `finish()`
 *     fails the test if the gate broke and nothing said so.
 *  5. **`SQLITE_NOMEM` via `PRAGMA hard_heap_limit` becomes `SQLITE_FULL` via
 *     `PRAGMA max_page_count`**, the technique Section 3's critical-error tests
 *     already use, because a heap limit is process-wide in `node:sqlite` and a
 *     page cap is per database.
 *  6. **`db.afterReset` is absent**, so the harness cannot assert
 *     `isCommitScheduled()` from inside a reset. The assertion it stands for —
 *     that `deleteAll()` always leaves a commit scheduled — is made directly in
 *     the `deleteAll` cases instead.
 *
 * Two groups at the end have no upstream counterpart and are the reason this
 * section exists: the §1.7.1 discrimination, which is the only place the
 * implicit-transaction boundary and the input-gate boundary are shown to be one
 * line, and the write classifier that stands in for `sqlite3_stmt_readonly`.
 */

import { expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SQLITE_LENGTH_LIMIT, SqliteCriticalError, SqliteDatabase } from "../util/sqlite";
import { InputGate, OutputGate } from "./io-gate";
import { type Actor, IoContext, type Timer } from "./io-context";
import type {
  ActorCacheTransaction,
  ArmAlarmResult,
  CancelAlarmHandler,
  KeyValuePair,
  ReadOptions,
  RunAlarmHandler,
  WriteOptions,
} from "./actor-cache";
import { ActorSqlite } from "./actor-sqlite";

const oneMs = 1;
const twoMs = 2;
const threeMs = 3;
const fourMs = 4;
const fiveMs = 5;
const sixMs = 6;
const tenMs = 10;

/**
 * Used as the "current time" parameter for armAlarmHandler in tests. Set to the
 * epoch (before all test alarm times) so existing tests aren't affected by the
 * overdue alarm check.
 */
const testCurrentTime = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array | undefined): string | undefined =>
  value === undefined ? undefined : decoder.decode(value);

/** ← `WaitScope::poll()`. See translation 2 in the header. */
const POLL_TURNS = 8;

async function quiesce(turns = POLL_TURNS): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

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
  await quiesce(turns);
  return settled;
}

// =======================================================================================
// ActorSqliteTest

type Call = {
  readonly desc: string;
  readonly fulfill: () => void;
  readonly reject: (exception: unknown) => void;
};

type ActorSqliteTestOptions = {
  monitorOutputGate?: boolean;
  /**
   * Leave `gate.onBroken()` for someone else to take. Upstream's own
   * `KJ_REQUIRE` allows exactly one caller, and an `IoContext` built on this
   * gate takes it in its constructor.
   */
  outputGateBrokenTakenElsewhere?: boolean;
  /** Caps the database so a large write raises SQLITE_FULL and SQLite auto-rolls-back. */
  maxPageCount?: number;
};

class ActorSqliteTest {
  readonly gate = new OutputGate();
  readonly db: SqliteDatabase;
  readonly actor: ActorSqlite;
  readonly calls: Call[] = [];

  /** ← the harness's `gateBrokenPromise`, taken once because `onBroken()` may be called once. */
  readonly gateBroken: Promise<never>;
  brokenException: unknown | undefined;

  scheduleRunHandler: ((scheduledTime: number | null) => Promise<void>) | undefined;
  scheduleRunWithPriorHandler:
    | ((scheduledTime: number | null, priorTask: Promise<void>) => Promise<void>)
    | undefined;

  readonly #monitorOutputGate: boolean;

  constructor(db: SqliteDatabase, options: ActorSqliteTestOptions) {
    this.db = db;
    this.#monitorOutputGate = options.monitorOutputGate ?? true;
    this.actor = new ActorSqlite(
      db,
      this.gate,
      () => this.#commitCallback(),
      {
        scheduleRun: (scheduledTime, priorTask) => this.#scheduleRun(scheduledTime, priorTask),
      },
    );
    this.gateBroken =
      options.outputGateBrokenTakenElsewhere === true
        ? new Promise<never>(() => {})
        : this.gate.onBroken();
    void this.gateBroken.catch((exception: unknown) => {
      this.brokenException = exception;
    });
  }

  #commitCallback(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    void promise.catch(() => {});
    this.calls.push({ desc: "commit", fulfill: resolve, reject });
    return promise;
  }

  #scheduleRun(scheduledTime: number | null, priorTask: Promise<void>): Promise<void> {
    const withPrior = this.scheduleRunWithPriorHandler;
    if (withPrior !== undefined) return withPrior(scheduledTime, priorTask);
    const handler = this.scheduleRunHandler;
    if (handler !== undefined) return handler(scheduledTime);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    void promise.catch(() => {});
    this.calls.push({ desc: describeScheduleRun(scheduledTime), fulfill: resolve, reject });
    return promise;
  }

  /**
   * Polls the event loop, then asserts that the description of calls up to this
   * point match the expectation and returns their fulfillers. Also clears the
   * call log.
   */
  async pollAndExpectCalls(expected: readonly string[], message?: string): Promise<Call[]> {
    await quiesce();
    expect(
      this.calls.map((call) => call.desc),
      message,
    ).toEqual([...expected]);
    const taken = [...this.calls];
    this.calls.length = 0;
    return taken;
  }

  /** ← `~ActorSqliteTest`. */
  async finish(): Promise<void> {
    // Make sure there's no outstanding async work we haven't considered:
    await this.pollAndExpectCalls([], "unexpected calls at end of test");
    if (this.#monitorOutputGate) {
      // Make sure if the output gate has been broken, the exception was reported.
      expect(this.brokenException, "the output gate broke and the test did not report it").toBe(
        undefined,
      );
    }
  }

  // A few driver methods for convenience.
  get(key: string, options: ReadOptions = {}): Uint8Array | undefined {
    return this.actor.get(key, options);
  }
  getAlarm(options: ReadOptions = {}): number | null {
    return this.actor.getAlarm(options);
  }
  put(key: string, value: string, options: WriteOptions = {}): void {
    this.actor.put(key, bytes(value), options);
  }
  putMultiple(pairs: readonly KeyValuePair[], options: WriteOptions = {}): void {
    this.actor.putMultiple(pairs, options);
  }
  putMultipleExplicitTxn(pairs: readonly KeyValuePair[], options: WriteOptions = {}): void {
    const txn = this.actor.startTransaction();
    txn.putMultiple(pairs, options);
    txn.commit();
    txn.drop();
  }
  deleteMultiple(keys: readonly string[], options: WriteOptions = {}): number {
    return this.actor.deleteMultiple(keys, options);
  }
  setAlarm(newTime: number | null, options: WriteOptions = {}): void {
    this.actor.setAlarm(newTime, options);
  }
  sync(): Promise<void> {
    return this.actor.onNoPendingFlush();
  }
}

function describeScheduleRun(scheduledTime: number | null): string {
  return scheduledTime === null ? "scheduleRun(none)" : `scheduleRun(${scheduledTime}ms)`;
}

async function newActorSqliteTest(options: ActorSqliteTestOptions = {}): Promise<ActorSqliteTest> {
  const raw = await createNodeSqlProvider().open("foo");
  if (options.maxPageCount !== undefined) {
    raw.exec(`PRAGMA max_page_count = ${options.maxPageCount}`, []);
  }
  return new ActorSqliteTest(new SqliteDatabase(raw), options);
}

/** Every case constructs a harness and finishes it, as upstream's destructor does. */
function actorTest(
  name: string,
  body: (test: ActorSqliteTest) => Promise<void>,
  options: ActorSqliteTestOptions = {},
): void {
  test(name, async () => {
    const harness = await newActorSqliteTest(options);
    await body(harness);
    await harness.finish();
  });
}

function expectRun(result: ArmAlarmResult): RunAlarmHandler {
  if (result.kind !== "run") throw new Error("expected armAlarmHandler to return RunAlarmHandler");
  return result.run;
}

function expectCancel(result: ArmAlarmResult): CancelAlarmHandler {
  if (result.kind !== "cancel") {
    throw new Error("expected armAlarmHandler to return CancelAlarmHandler");
  }
  return result.cancel;
}

// =======================================================================================

actorTest("initial alarm value is unset", async (test) => {
  expect(test.getAlarm()).toBe(null);
});

actorTest("can set and get alarm", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("check put multiple wraps operations in a transaction", async (test) => {
  const putKVs: KeyValuePair[] = [{ key: "foo", value: bytes("bar") }];

  // NoTxn test
  {
    expect(test.actor.isCommitScheduled()).toBe(false);
    test.putMultiple(putKVs);
    // During write, all NoTxn operations are wrapped in an ImplicitTxn.
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    expect(text(test.get("foo"))).toBe("bar");
  }

  // ExplicitTxn test
  {
    putKVs.push({ key: "foo2", value: bytes("bar2") });
    expect(test.actor.isCommitScheduled()).toBe(false);
    test.putMultipleExplicitTxn(putKVs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    expect(text(test.get("foo2"))).toBe("bar2");
  }

  // ImplicitTxn test
  {
    // A single put will create an ImplicitTxn that we can use to wrap our putMultiple into.
    expect(test.actor.isCommitScheduled()).toBe(false);
    test.put("baz", "bat");

    // By now, we should check there's a commit scheduled in an ImplicitTxn.
    expect(test.actor.isCommitScheduled()).toBe(true);
    putKVs.push({ key: "foo3", value: bytes("bar3") });
    test.putMultiple(putKVs);

    const commit = (await test.pollAndExpectCalls(["commit"]))[0];
    expect(text(test.get("baz"))).toBe("bat");
    expect(text(test.get("foo3"))).toBe("bar3");
    commit?.fulfill();
  }
});

actorTest(
  "check put multiple wraps operations in a transaction and rollback on error",
  async (test) => {
    // We expect that putMultiple is all or nothing, rolling back if a single put fails.
    const putKVs: KeyValuePair[] = [
      { key: "foo", value: bytes("bar") },
      { key: "foo2", value: bytes("bar2") },
      { key: "foo3", value: bytes("bar3") },
      { key: "x".repeat(SQLITE_LENGTH_LIMIT + 1), value: bytes("bar") },
    ];

    // NoTxn test
    {
      expect(test.actor.isCommitScheduled()).toBe(false);
      expect(() => {
        test.putMultiple(putKVs);
      }).toThrow("string or blob too big: SQLITE_TOOBIG");
      expect(test.get("foo")).toBeUndefined();
      expect(test.get("foo2")).toBeUndefined();
      expect(test.get("foo3")).toBeUndefined();
    }

    // Reset the transaction state by going async, which will cause the ImplicitTxn to commit.
    {
      (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    }

    // ExplicitTxn test
    {
      expect(test.actor.isCommitScheduled()).toBe(false);
      const txn = test.actor.startTransaction();
      expect(() => {
        txn.putMultiple(putKVs, {});
      }).toThrow("string or blob too big: SQLITE_TOOBIG");
      txn.commit();
      txn.drop();
      (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
      expect(test.get("foo")).toBeUndefined();
      expect(test.get("foo2")).toBeUndefined();
      expect(test.get("foo3")).toBeUndefined();
    }

    // ImplicitTxn test
    {
      expect(test.actor.isCommitScheduled()).toBe(false);
      test.put("baz", "bat");

      expect(test.actor.isCommitScheduled()).toBe(true);
      expect(() => {
        test.putMultiple(putKVs);
      }).toThrow("string or blob too big: SQLITE_TOOBIG");

      const commit = (await test.pollAndExpectCalls(["commit"]))[0];
      // The single put succeeded, but the putMultiple did not.
      expect(text(test.get("baz"))).toBe("bat");
      expect(test.get("foo")).toBeUndefined();
      expect(test.get("foo2")).toBeUndefined();
      expect(test.get("foo3")).toBeUndefined();
      commit?.fulfill();
    }
  },
);

actorTest("alarm write happens transactionally with storage ops", async (test) => {
  test.setAlarm(oneMs);
  test.put("foo", "bar");
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(oneMs);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("storage op without alarm change does not wait on scheduler", async (test) => {
  test.put("foo", "bar");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(text(test.get("foo"))).toBe("bar");
  expect(test.getAlarm()).toBe(null);
});

actorTest(
  "alarm scheduling starts synchronously before implicit local db commit",
  async (test) => {
    // There is no remote storage here, so there is no work done in commitCallback(); the local db
    // is considered durably stored after the synchronous sqlite commit() call returns. If a commit
    // includes an alarm state change that requires scheduling before the commit call, it needs to
    // happen synchronously, so we just need to ensure that the database is in a pre-commit state
    // when scheduleRun() is called.

    // Initialize alarm state to 2ms.
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    let startedScheduleRun = false;
    test.scheduleRunHandler = async (): Promise<void> => {
      startedScheduleRun = true;
      expect(() => test.db.run("BEGIN TRANSACTION")).toThrow(/transaction within a transaction/);
    };

    test.setAlarm(oneMs);
    expect(startedScheduleRun).toBe(false);
    await quiesce();
    expect(startedScheduleRun).toBe(true);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(test.getAlarm()).toBe(oneMs);
  },
);

actorTest("alarm scheduling starts synchronously before explicit local db commit", async (test) => {
  // Initialize alarm state to 2ms.
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);

  let startedScheduleRun = false;
  test.scheduleRunHandler = async (): Promise<void> => {
    startedScheduleRun = true;

    // Not sure if there is a good way to detect savepoint presence without mutating the db state,
    // but this is sufficient to verify the test properties:

    // Verify that we are not within a nested savepoint.
    expect(() => test.db.run("RELEASE _cf_savepoint_1")).toThrow("no such savepoint");

    // Verify that we are within the root savepoint.
    test.db.run("RELEASE _cf_savepoint_0");
    expect(() => test.db.run("RELEASE _cf_savepoint_0")).toThrow("no such savepoint");

    // We don't actually care what happens in the test after this point, but it's slightly simpler
    // to re-add the savepoint to allow the test to complete cleanly:
    test.db.run("SAVEPOINT _cf_savepoint_0");
  };

  {
    const txn = test.actor.startTransaction();
    txn.setAlarm(oneMs, {});

    expect(startedScheduleRun).toBe(false);
    txn.commit();
    expect(startedScheduleRun).toBe(true);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    txn.drop();
  }

  expect(test.getAlarm()).toBe(oneMs);
});

actorTest(
  "alarm scheduling does not start synchronously before nested explicit local db commit",
  async (test) => {
    // Initialize alarm state to 2ms.
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    let startedScheduleRun = false;
    test.scheduleRunHandler = async (): Promise<void> => {
      startedScheduleRun = true;
    };

    {
      const txn1 = test.actor.startTransaction();

      {
        const txn2 = test.actor.startTransaction();
        txn2.setAlarm(oneMs, {});

        txn2.commit();
        expect(startedScheduleRun).toBe(false);
        txn2.drop();
      }

      txn1.commit();
      expect(startedScheduleRun).toBe(true);

      (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
      txn1.drop();
    }

    expect(test.getAlarm()).toBe(oneMs);
  },
);

actorTest(
  "synchronous alarm scheduling failure causes local db commit to throw synchronously",
  async (test) => {
    const getLocalAlarm = (): number | null => {
      const row = test.db.run("SELECT value FROM _cf_METADATA WHERE key = 1").rawRows[0];
      const value = row?.[0];
      return typeof value === "number" ? value : null;
    };

    // Initialize alarm state to 2ms.
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    // Override scheduleRun handler with one that throws synchronously.
    let startedScheduleRun = false;
    test.scheduleRunHandler = (): Promise<void> => {
      startedScheduleRun = true;
      // Must throw synchronously; returning a rejected promise is insufficient.
      throw new Error("a_sync_fail");
    };

    expect(await poll(test.gateBroken)).toBe(false);
    test.setAlarm(oneMs);

    // Expect that polling will attempt to commit the implicit transaction, which should
    // synchronously fail when attempting to call scheduleRun() before the db commit, and roll back
    // the local db state to the 2ms alarm.
    expect(startedScheduleRun).toBe(false);
    expect(getLocalAlarm()).toBe(oneMs);
    await quiesce();
    expect(startedScheduleRun).toBe(true);
    expect(getLocalAlarm()).toBe(twoMs);

    await expect(test.gateBroken).rejects.toThrow("a_sync_fail");
  },
  { monitorOutputGate: false },
);

actorTest("can clear alarm", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  test.setAlarm(null);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(null);
});

actorTest("can set alarm twice", async (test) => {
  test.setAlarm(oneMs);
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(twoMs);
});

actorTest("setting duplicate alarm is no-op", async (test) => {
  test.setAlarm(null);
  await test.pollAndExpectCalls([]);

  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  test.setAlarm(oneMs);
  await test.pollAndExpectCalls([]);
});

actorTest("tells alarm handler to cancel when committed alarm is empty", async (test) => {
  const cancel = expectCancel(test.actor.armAlarmHandler(oneMs, testCurrentTime));

  // We also expect the alarm cancellation to contain a scheduling request to delete the alarm, to
  // handle cases where alarm deletion was durably committed to the database, but a failure occurred
  // before the alarm deletion was conveyed to the alarm scheduler.
  const waitPromise = cancel.waitBeforeCancel;
  expect(await poll(waitPromise)).toBe(false);
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  expect(await poll(waitPromise)).toBe(true);
  await waitPromise;
});

actorTest(
  "tells alarm handler to reschedule when handler alarm is later than committed alarm",
  async (test) => {
    // Initialize alarm state to 1ms.
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    // Request handler run at 2ms. Expect cancellation with rescheduling.
    const cancel = expectCancel(test.actor.armAlarmHandler(twoMs, testCurrentTime));

    const waitBeforeCancel = cancel.waitBeforeCancel;
    const reschedule = (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0];
    expect(await poll(waitBeforeCancel)).toBe(false);
    reschedule?.fulfill();
    expect(await poll(waitBeforeCancel)).toBe(true);
    await waitBeforeCancel;
  },
);

actorTest(
  "tells alarm handler to reschedule when handler alarm is earlier than committed alarm",
  async (test) => {
    // Initialize alarm state to 2ms.
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    const cancel = expectCancel(test.actor.armAlarmHandler(oneMs, testCurrentTime));

    const waitBeforeCancel = cancel.waitBeforeCancel;
    const reschedule = (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0];
    expect(await poll(waitBeforeCancel)).toBe(false);
    reschedule?.fulfill();
    expect(await poll(waitBeforeCancel)).toBe(true);
    await waitBeforeCancel;
  },
);

actorTest("runs overdue alarm immediately when local alarm time is in the past", async (test) => {
  // Initialize alarm state to 2ms.
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(twoMs);

  // The local state says the alarm is due to fire at 2ms, but we're saying the scheduler has 1ms.
  // Usually this would result in a rescheduling of the alarm, but since our currentTime is 5ms, we
  // will just run the alarm now since it's already overdue.
  {
    const overdueCurrentTime = fiveMs;
    const run = expectRun(test.actor.armAlarmHandler(oneMs, overdueCurrentTime));
    run.deferredDelete.drop();
  }

  // commit and delete the alarm after we drop the alarm handler (this is a deferred delete).
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
});

actorTest(
  "does not cancel handler when local db alarm state is later than scheduled alarm",
  async (test) => {
    // Initialize alarm state to 1ms.
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    test.setAlarm(twoMs);
    {
      const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
      run.deferredDelete.drop();
    }
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  },
);

actorTest(
  "does not cancel handler when local db alarm state is earlier than scheduled alarm",
  async (test) => {
    // Initialize alarm state to 2ms.
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    test.setAlarm(oneMs);
    {
      const run = expectRun(test.actor.armAlarmHandler(twoMs, testCurrentTime));
      run.deferredDelete.drop();
    }
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  },
);

actorTest("getAlarm() returns null during handler", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
    await test.pollAndExpectCalls([]);

    expect(test.getAlarm()).toBe(null);
    run.deferredDelete.drop();
  }
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
});

actorTest("alarm handler handle clears alarm when dropped with no writes", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime)).deferredDelete.drop();

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  expect(test.getAlarm()).toBe(null);
});

actorTest("alarm deleter does not clear alarm when dropped with writes", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
    test.setAlarm(twoMs);
    run.deferredDelete.drop();
  }
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(twoMs);
});

actorTest("can cancel deferred alarm deletion during handler", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
    test.actor.cancelDeferredAlarmDeletion();
    run.deferredDelete.drop();
  }

  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("canceling deferred alarm deletion outside handler has no effect", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime)).deferredDelete.drop();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();

  test.actor.cancelDeferredAlarmDeletion();

  expect(test.getAlarm()).toBe(null);
});

actorTest("canceling deferred alarm deletion outside handler edge case", async (test) => {
  // Presumably harmless to cancel deletion if the client requests it after the handler ends but
  // before the event loop runs the commit code? Trying to cancel deletion outside the handler is a
  // bit of a contract violation anyway.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime)).deferredDelete.drop();
  test.actor.cancelDeferredAlarmDeletion();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(null);
});

actorTest("canceling deferred alarm deletion is idempotent", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
    test.actor.cancelDeferredAlarmDeletion();
    test.actor.cancelDeferredAlarmDeletion();
    run.deferredDelete.drop();
  }

  expect(test.getAlarm()).toBe(oneMs);
});

test("alarm handler cleanup succeeds when output gate is broken", async () => {
  const runWithSetup = async (
    testFunc: (test: ActorSqliteTest, deferredDelete: RunAlarmHandler) => void,
  ): Promise<void> => {
    const harness = await newActorSqliteTest({ monitorOutputGate: false });

    // Initialize alarm state to 1ms.
    harness.setAlarm(oneMs);
    (await harness.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await harness.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await harness.pollAndExpectCalls([]);
    expect(harness.getAlarm()).toBe(oneMs);

    const run = expectRun(harness.actor.armAlarmHandler(oneMs, testCurrentTime));

    // Break gate
    harness.put("foo", "bar");
    (await harness.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("a_rejected_commit"));
    await expect(harness.gateBroken).rejects.toThrow("a_rejected_commit");
    // Ensure the task failure handler runs and notices brokenness:
    await quiesce();

    testFunc(harness, run);
    await harness.finish();
  };

  // Here, we test that the deferred deleter drop doesn't throw, both in the case when the caller
  // cancels deletion and when it does not cancel it:

  await runWithSetup((harness, run) => {
    // In the case where the handler fails, we assume the caller will explicitly cancel deferred
    // alarm deletion:
    harness.actor.cancelDeferredAlarmDeletion();
    run.deferredDelete.drop();
  });

  await runWithSetup((_harness, run) => {
    // In the case where the handler succeeds, the caller will not cancel deferred deletion before
    // dropping the deleter. Dropping it should still succeed, even if the output gate happens to
    // already be broken:
    run.deferredDelete.drop();
  });
});

actorTest(
  "handler alarm is not deleted when commit fails",
  async (test) => {
    // Initialize alarm state to 1ms.
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    {
      const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
      expect(test.getAlarm()).toBe(null);
      run.deferredDelete.drop();
    }
    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("a_rejected_commit"));

    await expect(test.gateBroken).rejects.toThrow("a_rejected_commit");
  },
  { monitorOutputGate: false },
);

actorTest("setting earlier alarm persists alarm scheduling before db", async (test) => {
  // Initialize alarm state to 2ms.
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(twoMs);

  // Update alarm to be earlier. We expect the alarm scheduling to be persisted before the db.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("setting later alarm persists db before alarm scheduling", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // Update alarm to be later. We expect the db to be persisted before the alarm scheduling.
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();

  expect(test.getAlarm()).toBe(twoMs);
});

actorTest(
  "multiple set-earlier in-flight alarms wait for earliest before committing db",
  async (test) => {
    // Initialize alarm state to 5ms.
    test.setAlarm(fiveMs);
    (await test.pollAndExpectCalls(["scheduleRun(5ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(fiveMs);

    // Gate is not blocked.
    expect(await poll(test.gate.wait())).toBe(true);

    // Update alarm to be earlier (4ms). We expect the alarm scheduling to start.
    test.setAlarm(fourMs);
    const fulfiller4Ms = (await test.pollAndExpectCalls(["scheduleRun(4ms)"]))[0];
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(fourMs);

    // Gate as-of 4ms update is blocked.
    const gateWait4ms = test.gate.wait();
    expect(await poll(gateWait4ms)).toBe(false);

    // While the 4ms scheduling request is in-flight, update alarm to be even earlier (3ms). We
    // expect the 4ms request to block the 3ms scheduling request.
    test.setAlarm(threeMs);
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(threeMs);

    const gateWait3ms = test.gate.wait();
    expect(await poll(gateWait3ms)).toBe(false);

    // Update alarm to be even earlier (2ms). We expect scheduling requests to still be blocked.
    test.setAlarm(twoMs);
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    const gateWait2ms = test.gate.wait();
    expect(await poll(gateWait2ms)).toBe(false);

    // Fulfill the 4ms request. We expect the 2ms scheduling to start, because that is the current
    // alarm value.
    fulfiller4Ms?.fulfill();
    const fulfiller2Ms = (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0];
    await test.pollAndExpectCalls([]);

    // While waiting for the 2ms request, update alarm time to 1ms. Expect scheduling to be blocked.
    test.setAlarm(oneMs);
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    const gateWait1ms = test.gate.wait();
    expect(await poll(gateWait1ms)).toBe(false);

    // Fulfill the 2ms request. We expect the 1ms scheduling to start.
    fulfiller2Ms?.fulfill();
    const fulfiller1Ms = (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0];
    await test.pollAndExpectCalls([]);

    // Fulfill the 1ms request. We expect a single db commit to start (coalescing all previous db
    // commits together).
    fulfiller1Ms?.fulfill();
    const commit = (await test.pollAndExpectCalls(["commit"]))[0];
    await test.pollAndExpectCalls([]);

    // We expect all earlier gates to be blocked until commit completes.
    expect(await poll(gateWait4ms)).toBe(false);
    expect(await poll(gateWait3ms)).toBe(false);
    expect(await poll(gateWait2ms)).toBe(false);
    expect(await poll(gateWait1ms)).toBe(false);
    commit?.fulfill();
    expect(await poll(gateWait4ms)).toBe(true);
    expect(await poll(gateWait3ms)).toBe(true);
    expect(await poll(gateWait2ms)).toBe(true);
    expect(await poll(gateWait1ms)).toBe(true);

    expect(test.getAlarm()).toBe(oneMs);
  },
);

actorTest("setting later alarm times does scheduling after db commit", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expect(await poll(test.gate.wait())).toBe(true);

  // Set alarm to 2ms. Expect 2ms db commit to start.
  test.setAlarm(twoMs);
  const commit2Ms = (await test.pollAndExpectCalls(["commit"]))[0];
  await test.pollAndExpectCalls([]);

  const gateWait2Ms = test.gate.wait();
  expect(await poll(gateWait2Ms)).toBe(false);

  // Set alarm to 3ms. Expect 3ms db commit to start. The 2ms scheduleRun will never happen now that
  // we've overwritten it while it was persisting to SQLite.
  test.setAlarm(threeMs);
  const commit3Ms = (await test.pollAndExpectCalls(["commit"]))[0];
  await test.pollAndExpectCalls([]);

  const gateWait3Ms = test.gate.wait();
  expect(await poll(gateWait3Ms)).toBe(false);

  // Expect the 2ms gate to unblock once the commit finishes, but don't expect a scheduleRun(2ms).
  expect(await poll(gateWait2Ms)).toBe(false);
  commit2Ms?.fulfill();
  expect(await poll(gateWait2Ms)).toBe(true);
  await test.pollAndExpectCalls([]);

  // Fulfill 3ms db commit. Expect 3ms alarm to be scheduled and 3ms gate to be unblocked.
  expect(await poll(gateWait3Ms)).toBe(false);

  commit3Ms?.fulfill();
  expect(await poll(gateWait3Ms)).toBe(true);

  const fulfiller3Ms = (await test.pollAndExpectCalls(["scheduleRun(3ms)"]))[0];
  await test.pollAndExpectCalls([]);

  fulfiller3Ms?.fulfill();
});

actorTest(
  "rejected move-earlier alarm scheduling request breaks gate",
  async (test) => {
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.reject(
      new Error("a_rejected_scheduleRun"),
    );

    await expect(test.gateBroken).rejects.toThrow("a_rejected_scheduleRun");
  },
  { monitorOutputGate: false },
);

actorTest("rejected move-later alarm scheduling request does not break gate", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // Update alarm to be later. We expect the db to be persisted before the alarm scheduling. We
  // simulate a failure during the alarm rescheduling, but expect it to not break the output gate.
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.reject(
    new Error("a_rejected_scheduleRun"),
  );

  // Subsequent kv put succeeds. In an earlier version of the code, this failed, due to capturing
  // the scheduling failure as if it had broken the output gate, without actually breaking it.
  test.put("foo", "bar");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
});

actorTest("rapid move-later alarm changes coalesce into bounded scheduleRun calls", async (test) => {
  // When many commits each move the alarm time later while a scheduleRun is already in-flight, the
  // scheduleLaterAlarm mechanism should coalesce them into at most one pending request, rather than
  // chaining N promises (one per commit).

  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // Move alarm to 2ms. The db commit completes, triggering a post-commit scheduleRun(2ms).
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  expect(test.getAlarm()).toBe(twoMs);
  const fulfiller2Ms = (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0];

  // While 2ms scheduleRun is in-flight, move alarm to 3ms, 4ms, 5ms in rapid succession. Only the
  // final value (5ms) should be scheduled after the 2ms scheduleRun completes.
  test.setAlarm(threeMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]); // No new scheduleRun -- coalesced into pending.
  expect(test.getAlarm()).toBe(threeMs);

  test.setAlarm(fourMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(fourMs);

  test.setAlarm(fiveMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(fiveMs);

  // Now fulfill the 2ms scheduleRun. The coalesced pending time (5ms) should be scheduled next.
  fulfiller2Ms?.fulfill();
  const fulfiller5Ms = (await test.pollAndExpectCalls(["scheduleRun(5ms)"]))[0];
  // Importantly, there is exactly one scheduleRun(5ms), not three separate calls.

  fulfiller5Ms?.fulfill();
  await test.pollAndExpectCalls([]);

  expect(test.getAlarm()).toBe(fiveMs);
});

actorTest(
  "armAlarmHandler with coalesced pending alarms schedules reschedule exactly once",
  async (test) => {
    // Verifies two properties:
    // 1. No duplicate scheduleRun(6ms): armAlarmHandler clears pendingLaterAlarmTime so the
    //    completion handler of the in-flight request does not re-issue it.
    // 2. Future commits (10ms) that arrive after armAlarmHandler fires are correctly handled.

    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    // Move alarm to 3ms -- scheduleRun(3ms) goes in-flight via scheduleLaterAlarm.
    test.setAlarm(threeMs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    const fulfiller3Ms = (await test.pollAndExpectCalls(["scheduleRun(3ms)"]))[0];

    // While the 3ms scheduleRun is in-flight, rapidly move to 4ms then 6ms. Both coalesce into
    // pendingLaterAlarmTime = 6ms; no new scheduleRun issued.
    test.setAlarm(fourMs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    test.setAlarm(sixMs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(sixMs);

    // The 1ms alarm fires. armAlarmHandler sees scheduledTime = 1ms, localAlarmState = 6ms, so it
    // takes the reschedule-later path and clears pendingLaterAlarmTime.
    const cancel = expectCancel(test.actor.armAlarmHandler(oneMs, testCurrentTime));

    // scheduleRun(6ms) issued exactly once -- synchronously inside armAlarmHandler.
    const fulfiller6Ms = (await test.pollAndExpectCalls(["scheduleRun(6ms)"]))[0];

    // Commit for 10ms arrives while scheduleRun(3ms) is still in-flight, so it is queued.
    test.setAlarm(tenMs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]); // No scheduleRun yet -- coalesced into pending.

    // Fulfill scheduleRun(3ms). Its completion handler drains the pending 10ms.
    // Importantly: scheduleRun(6ms) is NOT issued again here.
    fulfiller3Ms?.fulfill();
    const fulfiller10Ms = (await test.pollAndExpectCalls(["scheduleRun(10ms)"]))[0];

    // Fulfill scheduleRun(6ms). No new scheduleRun here.
    fulfiller6Ms?.fulfill();
    expect(await poll(cancel.waitBeforeCancel)).toBe(true);
    await test.pollAndExpectCalls([]);

    // Fulfill scheduleRun(10ms). Done.
    fulfiller10Ms?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(tenMs);
  },
);

actorTest("coalesced move-later followed by move-earlier does not race", async (test) => {
  // Regression test for a race condition where a coalesced pendingLaterAlarmTime could be drained
  // concurrently with a move-earlier scheduleRun. The fix is that startPrecommitAlarmScheduling()
  // clears pendingLaterAlarmTime when setting up a move-earlier.

  let activeRpcs = 0;
  let maxConcurrentRpcs = 0;

  // Custom handler that respects priorTask ordering like the real alarm scheduler.
  test.scheduleRunWithPriorHandler = async (scheduledTime, priorTask): Promise<void> => {
    await priorTask;
    activeRpcs += 1;
    maxConcurrentRpcs = Math.max(maxConcurrentRpcs, activeRpcs);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    void promise.catch(() => {});
    test.calls.push({ desc: describeScheduleRun(scheduledTime), fulfill: resolve, reject });
    await promise;
    activeRpcs -= 1;
  };

  // Poll until at least `expected.length` calls accumulate. With the priorTask-respecting handler,
  // calls take extra event-loop turns to appear.
  const drainCalls = async (expected: readonly string[], message?: string): Promise<Call[]> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await quiesce(2);
      if (expected.length === 0 && attempt >= 10) break;
      if (expected.length > 0 && test.calls.length >= expected.length) break;
    }
    expect(
      test.calls.map((call) => call.desc),
      message,
    ).toEqual([...expected]);
    const taken = [...test.calls];
    test.calls.length = 0;
    return taken;
  };

  // 1. Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await drainCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await drainCalls(["commit"]))[0]?.fulfill();
  await drainCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // 2. Move alarm to 5ms (later). The db commit completes, then scheduleRun(5ms) fires post-commit.
  test.setAlarm(fiveMs);
  (await drainCalls(["commit"]))[0]?.fulfill();
  const fulfiller5Ms = (await drainCalls(["scheduleRun(5ms)"]))[0];

  // 3. While scheduleRun(5ms) is in-flight, move alarm to 10ms (later) -- coalesced.
  test.setAlarm(tenMs);
  (await drainCalls(["commit"]))[0]?.fulfill();
  await drainCalls([]);

  // 4. Move alarm earlier to 2ms. startPrecommitAlarmScheduling() clears pendingLaterAlarmTime.
  test.setAlarm(twoMs);
  await drainCalls([]); // scheduleRun(2ms) blocked on priorTask.

  // 5. Fulfill scheduleRun(5ms): the completion handler finds nothing to drain, and the
  //    move-earlier priorTask resolves so scheduleRun(2ms) fires.
  fulfiller5Ms?.fulfill();
  const fulfiller2Ms = (
    await drainCalls(
      ["scheduleRun(2ms)"],
      "expected only scheduleRun(2ms), no concurrent scheduleRun(10ms)",
    )
  )[0];

  expect(
    maxConcurrentRpcs,
    "scheduleRun RPCs were sent concurrently -- the coalesced move-later raced with the " +
      "move-earlier",
  ).toBeLessThanOrEqual(1);

  // 6. Complete the move-earlier and its commit.
  fulfiller2Ms?.fulfill();
  (await drainCalls(["commit"]))[0]?.fulfill();

  await drainCalls([]);

  expect(test.getAlarm()).toBe(twoMs);
});

actorTest(
  "an exception thrown during merged commits does not hang",
  async (test) => {
    // Initialize alarm state to 5ms.
    test.setAlarm(fiveMs);
    (await test.pollAndExpectCalls(["scheduleRun(5ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(fiveMs);

    // Update alarm to be earlier (4ms). We expect the alarm scheduling to start.
    test.setAlarm(fourMs);
    const fulfiller4Ms = (await test.pollAndExpectCalls(["scheduleRun(4ms)"]))[0];
    const gateWait4ms = test.gate.wait();

    // While the 4ms scheduling request is in-flight, update alarm to be earlier (3ms). We expect
    // the two commit requests to merge and be blocked on the alarm scheduling request.
    test.setAlarm(threeMs);
    await test.pollAndExpectCalls([]);
    const gateWait3ms = test.gate.wait();

    // Reject the 4ms request. We expect both gate waiting promises to unblock with exceptions.
    expect(await poll(gateWait4ms)).toBe(false);
    expect(await poll(gateWait3ms)).toBe(false);
    fulfiller4Ms?.reject(new Error("a_rejected_scheduleRun"));
    expect(await poll(gateWait4ms)).toBe(true);
    expect(await poll(gateWait3ms)).toBe(true);

    await expect(gateWait4ms).rejects.toThrow("a_rejected_scheduleRun");
    await expect(gateWait3ms).rejects.toThrow("a_rejected_scheduleRun");
    await expect(test.gateBroken).rejects.toThrow("a_rejected_scheduleRun");
  },
  { monitorOutputGate: false },
);

actorTest(
  "getAlarm/setAlarm check for brokenness",
  async (test) => {
    // Break gate
    test.put("foo", "bar");
    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("a_rejected_commit"));

    await expect(test.gateBroken).rejects.toThrow("a_rejected_commit");

    // Ensure the task failure handler runs and notices brokenness:
    await quiesce();

    expect(() => test.getAlarm()).toThrow("a_rejected_commit");
    expect(() => {
      test.setAlarm(null);
    }).toThrow("a_rejected_commit");
    await test.pollAndExpectCalls([]);
  },
  { monitorOutputGate: false },
);

actorTest("calling deleteAll() preserves alarm state if alarm is set", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    expect(test.actor.isCommitScheduled()).toBe(false);
    const results = test.actor.deleteAll({});
    expect(test.actor.isCommitScheduled()).toBe(true);
    expect(results.backpressure).toBeUndefined();
    expect(results.count).toBe(0);
    expect(test.getAlarm()).toBe(oneMs);

    const commit = (await test.pollAndExpectCalls(["commit"]))[0];
    expect(test.getAlarm()).toBe(oneMs);

    commit?.fulfill();
    expect(test.getAlarm()).toBe(oneMs);

    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);
  }

  {
    // Should be fine to call deleteAll() a few times in succession, too:
    expect(test.actor.isCommitScheduled()).toBe(false);
    const results1 = test.actor.deleteAll({});
    const results2 = test.actor.deleteAll({});
    expect(test.actor.isCommitScheduled()).toBe(true);
    expect(results1.backpressure).toBeUndefined();
    expect(results2.backpressure).toBeUndefined();
    expect(results1.count).toBe(0);
    expect(results2.count).toBe(0);
    expect(test.getAlarm()).toBe(oneMs);

    // Presumably fine to be performing the alarm state restoration after each db reset:
    const commits = await test.pollAndExpectCalls(["commit", "commit"]);
    expect(test.getAlarm()).toBe(oneMs);

    commits[0]?.fulfill();
    expect(test.getAlarm()).toBe(oneMs);
    commits[1]?.fulfill();
    expect(test.getAlarm()).toBe(oneMs);

    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);
  }
});

actorTest("calling deleteAll() preserves alarm state if alarm is not set", async (test) => {
  // Initialize alarm state to an empty value in the metadata table.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);
  test.setAlarm(null);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(null);

  {
    expect(test.actor.isCommitScheduled()).toBe(false);
    const results = test.actor.deleteAll({});
    expect(test.actor.isCommitScheduled()).toBe(true);
    expect(results.backpressure).toBeUndefined();
    expect(test.getAlarm()).toBe(null);

    const commit = (await test.pollAndExpectCalls(["commit"]))[0];
    expect(results.count).toBe(0);
    expect(test.getAlarm()).toBe(null);

    commit?.fulfill();
    expect(test.getAlarm()).toBe(null);

    expect(
      test.db.run("SELECT name FROM sqlite_master WHERE name = '_cf_METADATA'").rawRows,
    ).toEqual([]);
  }

  {
    // Should be fine to call deleteAll() a few times in succession, too:
    expect(test.actor.isCommitScheduled()).toBe(false);
    const results1 = test.actor.deleteAll({});
    const results2 = test.actor.deleteAll({});
    expect(test.actor.isCommitScheduled()).toBe(true);
    expect(results1.backpressure).toBeUndefined();
    expect(results2.backpressure).toBeUndefined();
    expect(test.getAlarm()).toBe(null);

    // With no alarm to restore, successive deletion commits coalesce.
    const commits = await test.pollAndExpectCalls(["commit"]);
    expect(results1.count).toBe(0);
    expect(results2.count).toBe(0);
    expect(test.getAlarm()).toBe(null);

    commits[0]?.fulfill();
    expect(test.getAlarm()).toBe(null);

    expect(
      test.db.run("SELECT name FROM sqlite_master WHERE name = '_cf_METADATA'").rawRows,
    ).toEqual([]);
  }
});

actorTest("calling deleteAll() during an implicit transaction preserves alarm state", async (test) => {
  expect(test.actor.isCommitScheduled()).toBe(false);

  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);

  const results = test.actor.deleteAll({});
  expect(test.actor.isCommitScheduled()).toBe(true);
  expect(results.backpressure).toBeUndefined();
  expect(test.getAlarm()).toBe(oneMs);

  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();

  const commit = (await test.pollAndExpectCalls(["commit"]))[0];
  expect(results.count).toBe(0);
  expect(test.getAlarm()).toBe(oneMs);

  commit?.fulfill();
  expect(test.getAlarm()).toBe(oneMs);

  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("deleteAll with deleteAlarm option deletes alarm", async (test) => {
  // Initialize alarm state to 1ms.
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  const results = test.actor.deleteAll({}, { deleteAlarm: true });

  // The alarm should now be deleted.
  expect(test.getAlarm()).toBe(null);

  // Commit should include scheduling the alarm cancellation.
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);

  expect(results.count).toBe(0);
  expect(test.getAlarm()).toBe(null);
});

actorTest("deleteAll without deleteAlarm option preserves alarm", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  const results = test.actor.deleteAll({});

  // The alarm should be preserved.
  expect(test.getAlarm()).toBe(oneMs);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);

  expect(results.count).toBe(0);
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("deleteAll with deleteAlarm during alarm handler cancels deferred delete", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));

    // During the handler, getAlarm() should return null (deferred delete is active).
    expect(test.getAlarm()).toBe(null);

    // Call deleteAll() with deleteAlarm=true while the handler is running.
    test.actor.deleteAll({}, { deleteAlarm: true });

    expect(test.getAlarm()).toBe(null);

    // Drop the deleter (simulating handler success). Since deleteAll already cleared
    // haveDeferredDelete, this should NOT write to the metadata table.
    run.deferredDelete.drop();
  }

  // The deleteAll commit goes through commitImpl(), which detects the alarm moved to null and
  // schedules the cancellation.
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);

  expect(test.getAlarm()).toBe(null);
});

actorTest(
  "deleteAll without deleteAlarm during alarm handler still has deferred delete",
  async (test) => {
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    {
      const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));

      expect(test.getAlarm()).toBe(null);

      // This restores the alarm in metadata, but haveDeferredDelete is still true.
      test.actor.deleteAll({});

      expect(test.getAlarm()).toBe(null);

      // Drop the deleter (simulating handler success). This triggers the deferred deletion of the
      // restored alarm.
      run.deferredDelete.drop();
    }

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    expect(test.getAlarm()).toBe(null);
  },
);

actorTest(
  "deleteAll deleteAlarm does not schedule alarm cancellation if setAlarm interleaves",
  async (test) => {
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    // Start deleteAll with deleteAlarm=true and hold the commit.
    test.actor.deleteAll({}, { deleteAlarm: true });
    const deleteAllCommit = (await test.pollAndExpectCalls(["commit"]))[0];

    // While the deleteAll commit is in-flight, set a later alarm.
    test.setAlarm(twoMs);
    const setAlarmCommit = (await test.pollAndExpectCalls(["commit"]))[0];
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    // Completing the deleteAll commit should NOT schedule a cancel because setAlarm interleaved.
    deleteAllCommit?.fulfill();
    await test.pollAndExpectCalls([]);

    // Completing the setAlarm commit should schedule the new alarm time.
    setAlarmCommit?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);

    expect(test.getAlarm()).toBe(twoMs);
  },
);

actorTest("rolling back transaction leaves alarm in expected state", async (test) => {
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(twoMs);

  {
    const txn = test.actor.startTransaction();
    expect(txn.getAlarm({})).toBe(twoMs);
    txn.setAlarm(oneMs, {});
    expect(txn.getAlarm({})).toBe(oneMs);
    // Dropping transaction without committing; should roll back.
    txn.drop();
  }
  expect(test.getAlarm()).toBe(twoMs);
});

actorTest(
  "rolling back transaction leaves deferred alarm deletion in expected state",
  async (test) => {
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    {
      const run = expectRun(test.actor.armAlarmHandler(twoMs, testCurrentTime));

      const txn = test.actor.startTransaction();
      expect(test.getAlarm()).toBe(null);
      test.setAlarm(oneMs);
      expect(test.getAlarm()).toBe(oneMs);
      txn.rollback();

      // After rollback, getAlarm() still returns the deferred deletion result.
      expect(test.getAlarm()).toBe(null);

      // After rollback, no changes committed, no change in scheduled alarm.
      await test.pollAndExpectCalls([]);
      txn.drop();
      run.deferredDelete.drop();
    }

    // After the handler, the 2ms alarm is deleted.
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
    expect(test.getAlarm()).toBe(null);
  },
);

actorTest("committing transaction leaves deferred alarm deletion in expected state", async (test) => {
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(twoMs);

  {
    const run = expectRun(test.actor.armAlarmHandler(twoMs, testCurrentTime));

    const txn = test.actor.startTransaction();
    expect(test.getAlarm()).toBe(null);
    test.setAlarm(oneMs);
    expect(test.getAlarm()).toBe(oneMs);
    txn.commit();

    // After commit, getAlarm() returns the committed value.
    expect(test.getAlarm()).toBe(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    txn.drop();
    run.deferredDelete.drop();
  }

  // Alarm not deleted
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest(
  "rolling back nested transaction leaves deferred alarm deletion in expected state",
  async (test) => {
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    {
      const run = expectRun(test.actor.armAlarmHandler(twoMs, testCurrentTime));

      const txn1 = test.actor.startTransaction();
      expect(test.getAlarm()).toBe(null);
      {
        // Rolling back a nested transaction change leaves the deferred deletion in place.
        const txn2 = test.actor.startTransaction();
        expect(test.getAlarm()).toBe(null);
        test.setAlarm(oneMs);
        expect(test.getAlarm()).toBe(oneMs);
        txn2.rollback();
        expect(test.getAlarm()).toBe(null);
        txn2.drop();
      }
      expect(test.getAlarm()).toBe(null);
      {
        // Committing a nested transaction changes the parent transaction state to dirty.
        const txn3 = test.actor.startTransaction();
        expect(test.getAlarm()).toBe(null);
        test.setAlarm(oneMs);
        expect(test.getAlarm()).toBe(oneMs);
        txn3.commit();
        expect(test.getAlarm()).toBe(oneMs);
        txn3.drop();
      }
      expect(test.getAlarm()).toBe(oneMs);
      {
        // A nested transaction of a dirty transaction is dirty; rollback has no effect.
        const txn4 = test.actor.startTransaction();
        expect(test.getAlarm()).toBe(oneMs);
        txn4.rollback();
        expect(test.getAlarm()).toBe(oneMs);
        txn4.drop();
      }
      expect(test.getAlarm()).toBe(oneMs);
      txn1.rollback();

      // After the root transaction rollback, getAlarm() still returns the deferred deletion result.
      expect(test.getAlarm()).toBe(null);

      await test.pollAndExpectCalls([]);
      txn1.drop();
      run.deferredDelete.drop();
    }

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
    expect(test.getAlarm()).toBe(null);
  },
);

actorTest(
  "database write operations check for brokenness",
  async (test) => {
    // Break gate
    test.put("foo", "bar");
    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("a_rejected_commit"));

    await expect(test.gateBroken).rejects.toThrow("a_rejected_commit");

    // We don't actually set brokenness until the task failure handler runs...
    await quiesce();

    // Try making a write operation to the database, expecting it to throw the broken message via
    // the onWrite handler:
    expect(() => test.db.run("CREATE TABLE IF NOT EXISTS counter (count INTEGER)")).toThrow(
      "a_rejected_commit",
    );
    await test.pollAndExpectCalls([]);
  },
  { monitorOutputGate: false },
);

actorTest("allowUnconfirmed put does not block output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.put("foo", "bar", { allowUnconfirmed: true });

  // Gate still isn't blocked, because we set `allowUnconfirmed`.
  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("confirmed put blocks output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.put("foo", "bar", { allowUnconfirmed: false });

  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("mixed confirmed and unconfirmed writes in same transaction use output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.put("foo", "bar", { allowUnconfirmed: true });
  test.put("baz", "quux", { allowUnconfirmed: false });

  // Since any write in the batch needs confirmation, the entire batch should use the output gate.
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("quux");
});

actorTest("allowUnconfirmed delete does not block output gate", async (test) => {
  test.put("foo", "bar");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);

  expect(test.actor.delete("foo", { allowUnconfirmed: true })).toBe(true);

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.get("foo")).toBeUndefined();
});

actorTest("allowUnconfirmed putMultiple does not block output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.putMultiple(
    [
      { key: "foo", value: bytes("bar") },
      { key: "baz", value: bytes("qux") },
      { key: "key3", value: bytes("value3") },
    ],
    { allowUnconfirmed: true },
  );

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("qux");
  expect(text(test.get("key3"))).toBe("value3");
});

actorTest("allowUnconfirmed deleteMultiple does not block output gate", async (test) => {
  test.putMultiple([
    { key: "foo", value: bytes("bar") },
    { key: "baz", value: bytes("qux") },
    { key: "key3", value: bytes("value3") },
  ]);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);

  expect(test.deleteMultiple(["foo", "baz", "key3"], { allowUnconfirmed: true })).toBe(3);

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.get("foo")).toBeUndefined();
  expect(test.get("baz")).toBeUndefined();
  expect(test.get("key3")).toBeUndefined();
});

actorTest(
  "unconfirmed write failure still breaks output gate",
  async (test) => {
    test.put("foo", "bar", { allowUnconfirmed: true });

    // The output gate is not applied initially.
    expect(await poll(test.gate.wait())).toBe(true);
    expect(await poll(test.gateBroken)).toBe(false);

    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("flush failed hard"));

    await expect(test.gateBroken).rejects.toThrow("flush failed hard");
  },
  { monitorOutputGate: false },
);

actorTest("Direct SQL queries are confirmed writes", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const db = test.actor.getSqliteDatabase();

  db.run("CREATE TABLE myTable (i INTEGER PRIMARY KEY, s TEXT)");
  db.run("INSERT INTO myTable VALUES (1, 'a')");

  // Now the gate should be blocked.
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);

  // Make sure that the write actually succeeded.
  const rows = db.run("SELECT * FROM myTable").rawRows;
  expect(rows.length).toBe(1);
  expect(rows[0]?.[0]).toBe(1);
  expect(rows[0]?.[1]).toBe("a");
});

actorTest(
  "An unconfirmed put followed by a direct SQL queries requires the output gate",
  async (test) => {
    expect(await poll(test.gate.wait())).toBe(true);

    test.put("foo", "bar", { allowUnconfirmed: true });
    const db = test.actor.getSqliteDatabase();
    db.run("CREATE TABLE myTable (i INTEGER PRIMARY KEY, s TEXT)");
    db.run("INSERT INTO myTable VALUES (1, 'a')");

    expect(await poll(test.gate.wait())).toBe(false);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);

    expect(text(test.get("foo"))).toBe("bar");
    const rows = db.run("SELECT * FROM myTable").rawRows;
    expect(rows.length).toBe(1);
    expect(rows[0]?.[0]).toBe(1);
  },
);

actorTest("sync() returns immediately when no writes are pending", async (test) => {
  expect(await poll(test.sync())).toBe(true);
});

actorTest("sync() waits for confirmed writes to complete", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: false });

  const syncPromise = test.sync();
  expect(await poll(syncPromise)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise)).toBe(true);
  await syncPromise;

  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("sync() waits for unconfirmed writes to complete", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: true });

  const syncPromise = test.sync();
  expect(await poll(syncPromise)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise)).toBe(true);
  await syncPromise;

  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("sync() waits for multiple unconfirmed writes in a row", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: true });
  test.put("baz", "qux", { allowUnconfirmed: true });
  test.put("key3", "value3", { allowUnconfirmed: true });

  const syncPromise = test.sync();
  expect(await poll(syncPromise)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise)).toBe(true);
  await syncPromise;

  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("qux");
  expect(text(test.get("key3"))).toBe("value3");
});

actorTest("sync() only waits for writes before it was called", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: true });

  const syncPromise = test.sync();

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise)).toBe(true);
  await syncPromise;

  // Second write after sync was called.
  test.put("baz", "qux", { allowUnconfirmed: true });

  const syncPromise2 = test.sync();
  expect(await poll(syncPromise2)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise2)).toBe(true);
  await syncPromise2;
});

actorTest(
  "sync() propagates commit errors",
  async (test) => {
    test.put("foo", "bar", { allowUnconfirmed: true });

    const syncPromise = test.sync();
    expect(await poll(syncPromise)).toBe(false);

    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("commit failed"));

    expect(await poll(syncPromise)).toBe(true);
    await expect(syncPromise).rejects.toThrow("commit failed");

    await expect(test.gateBroken).rejects.toThrow("commit failed");
  },
  { monitorOutputGate: false },
);

actorTest("sync() with mixed confirmed and unconfirmed writes", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: true });
  test.put("baz", "qux", { allowUnconfirmed: false });

  const syncPromise = test.sync();
  expect(await poll(syncPromise)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise)).toBe(true);
  await syncPromise;

  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("qux");
});

actorTest("multiple sync() calls for same commit", async (test) => {
  test.put("foo", "bar", { allowUnconfirmed: true });

  const syncPromise1 = test.sync();
  const syncPromise2 = test.sync();
  const syncPromise3 = test.sync();

  expect(await poll(syncPromise1)).toBe(false);
  expect(await poll(syncPromise2)).toBe(false);
  expect(await poll(syncPromise3)).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(syncPromise1)).toBe(true);
  expect(await poll(syncPromise2)).toBe(true);
  expect(await poll(syncPromise3)).toBe(true);

  await syncPromise1;
  await syncPromise2;
  await syncPromise3;
});

actorTest("allowUnconfirmed setAlarm does not block output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(oneMs, { allowUnconfirmed: true });

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("confirmed setAlarm blocks output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(oneMs, { allowUnconfirmed: false });

  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("allowUnconfirmed setAlarm then confirmed put uses output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(oneMs, { allowUnconfirmed: true });
  test.put("foo", "bar", { allowUnconfirmed: false });

  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(oneMs);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("allowUnconfirmed setAlarm with storage ops", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(oneMs, { allowUnconfirmed: true });
  test.put("foo", "bar", { allowUnconfirmed: true });

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(oneMs);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("allowUnconfirmed setAlarm updating existing alarm", async (test) => {
  test.setAlarm(twoMs);
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(twoMs);

  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(oneMs, { allowUnconfirmed: true });

  expect(await poll(test.gate.wait())).toBe(true);

  // When moving the alarm earlier, scheduling happens first.
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(oneMs);
});

actorTest("allowUnconfirmed setAlarm to later time", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(twoMs, { allowUnconfirmed: true });

  expect(await poll(test.gate.wait())).toBe(true);

  // When moving the alarm later, the commit happens first.
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(twoMs);
});

actorTest("allowUnconfirmed setAlarm to clear alarm", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  expect(await poll(test.gate.wait())).toBe(true);

  test.setAlarm(null, { allowUnconfirmed: true });

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.getAlarm()).toBe(null);
});

actorTest(
  "unconfirmed setAlarm failure still breaks output gate",
  async (test) => {
    test.setAlarm(oneMs, { allowUnconfirmed: true });

    expect(await poll(test.gate.wait())).toBe(true);
    expect(await poll(test.gateBroken)).toBe(false);

    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("alarm commit failed"));

    await expect(test.gateBroken).rejects.toThrow("alarm commit failed");
  },
  { monitorOutputGate: false },
);

actorTest(
  "sync() throws after critical error in explicit transaction",
  async (test) => {
    // Start an explicit transaction
    const txn = test.actor.startTransaction();

    // Do a write within the transaction
    txn.put("foo", bytes("bar"), {});

    // Trigger a critical error using SQLITE_FULL against the capped page count, which makes SQLite
    // auto-rollback the transaction and fires the critical error handler.
    expect(() => {
      for (let index = 0; index < 20_000; index += 1) {
        txn.put(`large_key_${index}`, bytes("X".repeat(400)), {});
      }
    }).toThrow(SqliteCriticalError);

    // sync() should also throw an exception because the storage is now broken
    await expect(test.sync()).rejects.toThrow("broken");

    // The transaction is now in a broken state due to the critical error. Attempting to commit
    // should fail.
    expect(() => {
      txn.commit();
    }).toThrow("broken");
    txn.drop();
  },
  { monitorOutputGate: false, maxPageCount: 32 },
);

actorTest("allowUnconfirmed put in explicit transaction does not block output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const txn = test.actor.startTransaction();
  txn.put("foo", bytes("bar"), { allowUnconfirmed: true });

  // Gate still isn't blocked during the transaction, because we set `allowUnconfirmed`.
  expect(await poll(test.gate.wait())).toBe(true);

  txn.commit();
  txn.drop();

  // Gate should still not be blocked during commit because all writes were unconfirmed.
  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("confirmed put in explicit transaction blocks output gate on commit", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const txn = test.actor.startTransaction();
  txn.put("foo", bytes("bar"), { allowUnconfirmed: false });

  // Gate should still not be blocked during the transaction -- explicit txns only lock on commit.
  expect(await poll(test.gate.wait())).toBe(true);

  txn.commit();
  txn.drop();

  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
});

actorTest("mixed confirmed and unconfirmed puts in explicit transaction use output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const txn = test.actor.startTransaction();
  txn.put("foo", bytes("bar"), { allowUnconfirmed: true });
  txn.put("baz", bytes("quux"), { allowUnconfirmed: false });

  expect(await poll(test.gate.wait())).toBe(true);

  txn.commit();
  txn.drop();

  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("quux");
});

actorTest("allowUnconfirmed delete in explicit transaction does not block output gate", async (test) => {
  test.put("foo", "bar");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);

  const txn = test.actor.startTransaction();
  expect(txn.delete("foo", { allowUnconfirmed: true })).toBe(true);

  expect(await poll(test.gate.wait())).toBe(true);

  txn.commit();
  txn.drop();

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(test.get("foo")).toBeUndefined();
});

actorTest(
  "allowUnconfirmed putMultiple in explicit transaction does not block output gate",
  async (test) => {
    expect(await poll(test.gate.wait())).toBe(true);

    const txn = test.actor.startTransaction();
    txn.putMultiple(
      [
        { key: "foo", value: bytes("bar") },
        { key: "baz", value: bytes("quux") },
      ],
      { allowUnconfirmed: true },
    );

    expect(await poll(test.gate.wait())).toBe(true);

    txn.commit();
    txn.drop();

    expect(await poll(test.gate.wait())).toBe(true);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);
    expect(text(test.get("foo"))).toBe("bar");
    expect(text(test.get("baz"))).toBe("quux");
  },
);

actorTest(
  "allowUnconfirmed deleteMultiple in explicit transaction does not block output gate",
  async (test) => {
    test.put("foo", "bar");
    test.put("baz", "quux");
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);

    const txn = test.actor.startTransaction();
    expect(txn.deleteMultiple(["foo", "baz"], { allowUnconfirmed: true })).toBe(2);

    expect(await poll(test.gate.wait())).toBe(true);

    txn.commit();
    txn.drop();

    expect(await poll(test.gate.wait())).toBe(true);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);
    expect(test.get("foo")).toBeUndefined();
    expect(test.get("baz")).toBeUndefined();
  },
);

actorTest(
  "allowUnconfirmed setAlarm in explicit transaction does not block output gate",
  async (test) => {
    expect(await poll(test.gate.wait())).toBe(true);

    const txn = test.actor.startTransaction();
    txn.setAlarm(oneMs, { allowUnconfirmed: true });

    expect(await poll(test.gate.wait())).toBe(true);

    txn.commit();
    txn.drop();

    expect(await poll(test.gate.wait())).toBe(true);

    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);
    expect(test.getAlarm()).toBe(oneMs);
  },
);

actorTest("nested transaction: unconfirmed child commit does not block output gate", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const parentTxn = test.actor.startTransaction();
  parentTxn.put("parent", bytes("data"), { allowUnconfirmed: true });

  {
    const childTxn = test.actor.startTransaction();
    childTxn.put("child", bytes("data"), { allowUnconfirmed: true });

    expect(await poll(test.gate.wait())).toBe(true);

    childTxn.commit();
    childTxn.drop();
  }

  expect(await poll(test.gate.wait())).toBe(true);

  parentTxn.commit();
  parentTxn.drop();

  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("parent"))).toBe("data");
  expect(text(test.get("child"))).toBe("data");
});

actorTest("nested transaction: confirmed child propagates to parent commit", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const parentTxn = test.actor.startTransaction();
  parentTxn.put("parent", bytes("data"), { allowUnconfirmed: true });

  {
    const childTxn = test.actor.startTransaction();
    childTxn.put("child", bytes("data"), { allowUnconfirmed: false });

    expect(await poll(test.gate.wait())).toBe(true);

    // Committing the child should propagate someWriteConfirmed to the parent.
    childTxn.commit();
    childTxn.drop();
  }

  expect(await poll(test.gate.wait())).toBe(true);

  parentTxn.commit();
  parentTxn.drop();

  // Now the gate should be blocked because the child had a confirmed write.
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("parent"))).toBe("data");
  expect(text(test.get("child"))).toBe("data");
});

actorTest(
  "nested transaction: confirmed parent with unconfirmed child blocks output gate",
  async (test) => {
    expect(await poll(test.gate.wait())).toBe(true);

    const parentTxn = test.actor.startTransaction();
    parentTxn.put("parent", bytes("data"), { allowUnconfirmed: false });

    {
      const childTxn = test.actor.startTransaction();
      childTxn.put("child", bytes("data"), { allowUnconfirmed: true });

      expect(await poll(test.gate.wait())).toBe(true);

      childTxn.commit();
      childTxn.drop();
    }

    expect(await poll(test.gate.wait())).toBe(true);

    parentTxn.commit();
    parentTxn.drop();

    expect(await poll(test.gate.wait())).toBe(false);

    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

    expect(await poll(test.gate.wait())).toBe(true);
    expect(text(test.get("parent"))).toBe("data");
    expect(text(test.get("child"))).toBe("data");
  },
);

actorTest("nested transaction: deeply nested confirmed write propagates to root", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const txn1 = test.actor.startTransaction();
  txn1.put("level1", bytes("data"), { allowUnconfirmed: true });

  {
    const txn2 = test.actor.startTransaction();
    txn2.put("level2", bytes("data"), { allowUnconfirmed: true });

    {
      const txn3 = test.actor.startTransaction();
      txn3.put("level3", bytes("data"), { allowUnconfirmed: false });

      expect(await poll(test.gate.wait())).toBe(true);

      txn3.commit();
      txn3.drop();
    }

    expect(await poll(test.gate.wait())).toBe(true);

    txn2.commit();
    txn2.drop();
  }

  expect(await poll(test.gate.wait())).toBe(true);

  txn1.commit();
  txn1.drop();

  // Now the gate should be blocked because level 3 had a confirmed write.
  expect(await poll(test.gate.wait())).toBe(false);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("level1"))).toBe("data");
  expect(text(test.get("level2"))).toBe("data");
  expect(text(test.get("level3"))).toBe("data");
});

actorTest("nested transaction: rollback resets someWriteConfirmed flag", async (test) => {
  expect(await poll(test.gate.wait())).toBe(true);

  const parentTxn = test.actor.startTransaction();
  parentTxn.put("parent", bytes("data"), { allowUnconfirmed: true });

  {
    const childTxn = test.actor.startTransaction();
    childTxn.put("child", bytes("data"), { allowUnconfirmed: false });

    expect(await poll(test.gate.wait())).toBe(true);

    childTxn.rollback();
    childTxn.drop();
  }

  expect(await poll(test.gate.wait())).toBe(true);

  parentTxn.commit();
  parentTxn.drop();

  // Gate should still not be blocked because the child was rolled back.
  expect(await poll(test.gate.wait())).toBe(true);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(await poll(test.gate.wait())).toBe(true);
  expect(text(test.get("parent"))).toBe("data");
  expect(test.get("child")).toBeUndefined();
});

actorTest(
  "explicit transaction: commit failure breaks output gate even for unconfirmed writes",
  async (test) => {
    expect(await poll(test.gate.wait())).toBe(true);

    const txn = test.actor.startTransaction();
    txn.put("foo", bytes("bar"), { allowUnconfirmed: true });

    txn.commit();
    txn.drop();

    // Gate should not be blocked yet because the write was unconfirmed.
    expect(await poll(test.gate.wait())).toBe(true);

    (await test.pollAndExpectCalls(["commit"]))[0]?.reject(new Error("commit failed"));

    await expect(test.gateBroken).rejects.toThrow("commit failed");
  },
  { monitorOutputGate: false },
);

actorTest("ActorSqlite alarm cleared by abandonAlarm", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // abandonAlarm() clears the alarm from SQLite:
  // setAlarm(null) -> commit -> scheduleRun(none) (move-later path).
  const result = await test.actor.abandonAlarm(oneMs);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["scheduleRun(none)"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);

  // Returns null: alarm was cleared, the scheduler should not re-register.
  expect(result).toBe(null);

  expect(test.getAlarm()).toBe(null);
});

actorTest(
  "ActorSqlite alarm preserved after ALARM_RETRY_MAX_TRIES uncounted (internal) failures",
  async (test) => {
    // When all retry failures are uncounted (infrastructure errors), abandonAlarm is NEVER called.
    // The alarm must remain set in SQLite throughout so that the scheduler can keep retrying.
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    for (let index = 0; index < 100; index += 1) {
      const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));
      test.actor.cancelDeferredAlarmDeletion();
      run.deferredDelete.drop();
      await test.pollAndExpectCalls([]);

      // Check at the retry-limit boundary and at the end.
      if (index === 5 || index === 99) {
        expect(test.getAlarm()).toBe(oneMs);
      }
    }
  },
);

actorTest(
  "ActorSqlite abandonAlarm is a no-op when a newer alarm has replaced the abandoned one",
  async (test) => {
    test.setAlarm(oneMs);
    (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(oneMs);

    // User sets a new alarm (twoMs). The commit fires first; then the post-commit "move-later"
    // logic fires scheduleRun(2ms).
    test.setAlarm(twoMs);
    (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
    (await test.pollAndExpectCalls(["scheduleRun(2ms)"]))[0]?.fulfill();
    await test.pollAndExpectCalls([]);
    expect(test.getAlarm()).toBe(twoMs);

    // abandonAlarm() for the original oneMs alarm must be a no-op.
    const result = await test.actor.abandonAlarm(oneMs);
    await test.pollAndExpectCalls([]); // No commit or scheduleRun -- correct no-op.

    expect(result).toBe(twoMs);
    expect(test.getAlarm()).toBe(twoMs);
  },
);

actorTest("ActorSqlite abandonAlarm returns kj::none when no alarm is stored", async (test) => {
  // No alarm ever set. abandonAlarm should be a pure no-op, returning null.
  const result = await test.actor.abandonAlarm(oneMs);
  await test.pollAndExpectCalls([]);

  expect(result).toBe(null);
});

actorTest("ActorSqlite abandonAlarm returns kj::none when inAlarmHandler", async (test) => {
  test.setAlarm(oneMs);
  (await test.pollAndExpectCalls(["scheduleRun(1ms)"]))[0]?.fulfill();
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  await test.pollAndExpectCalls([]);
  expect(test.getAlarm()).toBe(oneMs);

  // Arm the handler -- inAlarmHandler is now true.
  const run = expectRun(test.actor.armAlarmHandler(oneMs, testCurrentTime));

  // abandonAlarm while the handler is running: returns null (handler owns the alarm).
  const result = await test.actor.abandonAlarm(oneMs);
  await test.pollAndExpectCalls([]);

  expect(result).toBe(null);

  // null because haveDeferredDelete hides the alarm during the handler.
  expect(test.getAlarm()).toBe(null);

  // Cancel the deferred delete so cleanup doesn't trigger a commit.
  test.actor.cancelDeferredAlarmDeletion();

  // After cancellation, getAlarm() reads SQLite again -- oneMs is still there since abandonAlarm
  // was a no-op while the handler was running.
  expect(test.getAlarm()).toBe(oneMs);
  run.deferredDelete.drop();
});

// =======================================================================================
// No upstream counterpart: the write classifier that stands in for sqlite3_stmt_readonly

actorTest("SQLite onWrite callback", async (test) => {
  // ← `KJ_TEST("SQLite onWrite callback")` in `sqlite-test.c++`, which became ours the moment the
  // classification moved out of the authorizer and into the statement text. Upstream's third block
  // — a multi-statement string — is absent because Section 3 refuses those outright.
  const db = test.actor.getSqliteDatabase();

  expect(test.actor.isCommitScheduled()).toBe(false);

  db.run("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
  expect(test.actor.isCommitScheduled()).toBe(true);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  // Reads do not open a transaction.
  db.run("SELECT * FROM people");
  db.run("  /* lead */ SELECT count(*) FROM people");
  db.run("-- lead\nEXPLAIN SELECT * FROM people");
  expect(test.actor.isCommitScheduled()).toBe(false);
  await test.pollAndExpectCalls([]);

  db.run("INSERT INTO people (id, name, email) VALUES (12321, 'Eve', 'eve@example.com')");
  expect(test.actor.isCommitScheduled()).toBe(true);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
});

actorTest("a statement is a write unless it is provably a read", async (test) => {
  // The conservative direction is the whole point: a `WITH` that only selects opens a transaction
  // it does not need, and that costs a commit. Misclassifying the other way costs atomicity.
  const db = test.actor.getSqliteDatabase();
  db.run("CREATE TABLE things (id INTEGER PRIMARY KEY)");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.actor.isCommitScheduled()).toBe(false);
  db.run("WITH x AS (SELECT 1 AS n) SELECT n FROM x");
  expect(test.actor.isCommitScheduled()).toBe(true);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
});

actorTest("the implicit transaction's own BEGIN and COMMIT are not writes", async (test) => {
  // If either were classified as a write, `onWrite` would re-enter `startImplicitTxn` forever.
  test.put("foo", "bar");
  expect(test.actor.isCommitScheduled()).toBe(true);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
  expect(test.actor.isCommitScheduled()).toBe(false);
  expect(text(test.get("foo"))).toBe("bar");
});

// =======================================================================================
// No upstream counterpart: §1.7.1, the transaction boundary IS the gate boundary

/** ← the `Worker::Actor` surface `io-context.c++` reaches for. */
class TestActor implements Actor {
  readonly inputGate = new InputGate();
  constructor(readonly outputGate: OutputGate) {}
  getInputGate(): InputGate {
    return this.inputGate;
  }
  getOutputGate(): OutputGate {
    return this.outputGate;
  }
  shutdownActorCache(): void {}
  assertCanSetAlarm(): void {}
}

const idleTimer: Timer = {
  now: () => 0,
  afterDelay: () => new Promise<void>(() => {}),
};

/**
 * The three rows of §1.7.1's table, run against the real gate rather than
 * against an argument. Each drives `ActorSqlite` from inside an `IoContext`
 * invocation and counts how many commits the sequence produces, which is the
 * only observable form of "was this one transaction".
 */
async function countCommits(
  test: ActorSqliteTest,
  ctx: IoContext,
  body: () => Promise<void>,
): Promise<number> {
  let commits = 0;
  const drain = async (): Promise<void> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await quiesce(2);
      for (const call of test.calls.splice(0)) {
        if (call.desc === "commit") commits += 1;
        call.fulfill();
      }
    }
  };
  const invocation = ctx.run(() => body());
  await drain();
  await invocation;
  await drain();
  return commits;
}

test("§1.7.1 a storage await does not end the implicit transaction", async () => {
  const harness = await newActorSqliteTest({ outputGateBrokenTakenElsewhere: true });
  const ctx = new IoContext(new TestActor(harness.gate), idleTimer);

  const commits = await countCommits(harness, ctx, async () => {
    harness.put("p1", "1");
    // The four async storage calls take this form; the gate is held across it.
    await ctx.awaitIoWithInputLock(Promise.resolve(harness.get("p1")));
    harness.put("p2", "2");
  });

  expect(commits, "the two puts should be one transaction").toBe(1);
  await harness.finish();
});

test("§1.7.1 a timer or outbound await commits and begins a new transaction", async () => {
  const harness = await newActorSqliteTest({ outputGateBrokenTakenElsewhere: true });
  const ctx = new IoContext(new TestActor(harness.gate), idleTimer);

  const commits = await countCommits(harness, ctx, async () => {
    harness.put("t1", "1");
    // Everything that is not one of the four storage calls takes this form, which releases the
    // gate — and therefore ends the transaction.
    await ctx.awaitIo(Promise.resolve(undefined));
    harness.put("t2", "2");
  });

  expect(commits, "the two puts should be two transactions").toBe(2);
  await harness.finish();
});

test("§1.7.1 a storage await between a put and a setAlarm keeps them in one transaction", async () => {
  const harness = await newActorSqliteTest({ outputGateBrokenTakenElsewhere: true });
  const ctx = new IoContext(new TestActor(harness.gate), idleTimer);

  const commits = await countCommits(harness, ctx, async () => {
    harness.put("row", "1");
    await ctx.awaitIoWithInputLock(Promise.resolve(harness.get("row")));
    harness.setAlarm(oneMs);
  });

  expect(commits, "the row and the alarm should be one transaction").toBe(1);
  expect(harness.getAlarm()).toBe(oneMs);
  await harness.finish();
});

/**
 * Decision 4's boot path: partyserver wraps the whole of `onStart` — fifteen framework phases,
 * several doing unbounded network I/O — in one `blockConcurrencyWhile`. So a critical section
 * spanning many hand-offs is the shape this runtime will actually see first, and the two ways of
 * getting the commit boundary wrong are both invisible without these two cases.
 *
 * Hanging the commit on the root gate's `inputGateReleased` hook — the only edge `io-context.ts`
 * offered before this section — makes the whole section one transaction, because the section holds
 * a parent lock for its entire duration and `lockCount` never reaches zero. Fifteen boot phases in
 * one transaction is a boundary nobody chose, and nothing else in this file would notice.
 */
test("decision 4 a critical section spanning hand-offs commits per hand-off, not per section", async () => {
  const harness = await newActorSqliteTest({ outputGateBrokenTakenElsewhere: true });
  const ctx = new IoContext(new TestActor(harness.gate), idleTimer);

  let sectionEnded = false;
  let outsiderRanBeforeSectionEnded = false;
  let outsider: Promise<void> | undefined;

  const commits = await countCommits(harness, ctx, async () => {
    await ctx.blockConcurrencyWhile(async () => {
      harness.put("phase1", "1");

      // A concurrent event arrives mid-section. The section must block it, and — the part this
      // case exists for — its write must not land in a transaction the section opened.
      outsider = ctx.run(() => {
        if (!sectionEnded) outsiderRanBeforeSectionEnded = true;
        harness.put("outsider", "1");
      });

      // One hand-off inside the section: `awaitIo` re-enters through `cs.wait()`, which cannot
      // resolve until this slice's nested lock is released.
      await ctx.awaitIo(Promise.resolve(undefined));
      harness.put("phase2", "2");
      sectionEnded = true;
    });
  });

  expect(outsiderRanBeforeSectionEnded, "the critical section did not block a concurrent event").toBe(
    false,
  );
  expect(commits, "each hand-off is its own transaction, and the outsider gets a third").toBe(3);
  await outsider;
  expect(text(harness.get("phase1"))).toBe("1");
  expect(text(harness.get("phase2"))).toBe("2");
  expect(text(harness.get("outsider"))).toBe("1");
  await harness.finish();
});

test("decision 4 a storage await inside a critical section keeps its writes in one transaction", async () => {
  // The §1.7.1 discrimination has to survive being nested, or every boot phase that reads its own
  // state back loses atomicity exactly where it is least observable.
  const harness = await newActorSqliteTest({ outputGateBrokenTakenElsewhere: true });
  const ctx = new IoContext(new TestActor(harness.gate), idleTimer);

  const commits = await countCommits(harness, ctx, async () => {
    await ctx.blockConcurrencyWhile(async () => {
      harness.put("a", "1");
      await ctx.awaitIoWithInputLock(Promise.resolve(harness.get("a")));
      harness.put("b", "2");
    });
  });

  expect(commits, "a held storage await must not split the transaction").toBe(1);
  await harness.finish();
});

// =======================================================================================
// No upstream counterpart: transactionSync (§2.4)

actorTest("transactionSync commits on return and rolls back on throw", async (test) => {
  const db = test.actor.getSqliteDatabase();
  db.run("CREATE TABLE things (id INTEGER PRIMARY KEY)");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(
    test.actor.transactionSync(() => {
      db.run("INSERT INTO things VALUES (1)");
      return "kept";
    }),
  ).toBe("kept");

  expect(() => {
    test.actor.transactionSync(() => {
      db.run("INSERT INTO things VALUES (2)");
      // Including DDL, which SQLite rolls back with everything else.
      db.run("CREATE TABLE more (id INTEGER PRIMARY KEY)");
      throw new Error("a_transaction_failure");
    });
  }).toThrow("a_transaction_failure");

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(db.run("SELECT id FROM things ORDER BY id").rawRows.map((row) => row[0])).toEqual([1]);
  expect(
    db.run("SELECT name FROM sqlite_master WHERE type='table' AND name='more'").rawRows.length,
  ).toBe(0);
});

actorTest("transactionSync nests, which a second BEGIN IMMEDIATE could not", async (test) => {
  // §2.4: two live call sites wrap a constructor that can itself reach transactionSync.
  const db = test.actor.getSqliteDatabase();
  db.run("CREATE TABLE things (id INTEGER PRIMARY KEY)");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  test.actor.transactionSync(() => {
    db.run("INSERT INTO things VALUES (1)");
    test.actor.transactionSync(() => {
      db.run("INSERT INTO things VALUES (2)");
    });
    expect(() => {
      test.actor.transactionSync(() => {
        db.run("INSERT INTO things VALUES (3)");
        throw new Error("inner_failure");
      });
    }).toThrow("inner_failure");
  });

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(db.run("SELECT id FROM things ORDER BY id").rawRows.map((row) => row[0])).toEqual([1, 2]);
});

actorTest("transactionSync refuses an async callback rather than committing early", async (test) => {
  const db = test.actor.getSqliteDatabase();
  db.run("CREATE TABLE things (id INTEGER PRIMARY KEY)");
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(() =>
    test.actor.transactionSync(async () => {
      db.run("INSERT INTO things VALUES (1)");
      await Promise.resolve();
    }),
  ).toThrow("returned a promise");

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  // The insert the callback managed before returning is rolled back with the savepoint.
  expect(db.run("SELECT count(*) FROM things").rawRows[0]?.[0]).toBe(0);
});

// =======================================================================================
// No upstream counterpart: the ExplicitTxn contract JS has to state explicitly

actorTest("a transaction refuses to commit while a nested one is outstanding", async (test) => {
  const parent = test.actor.startTransaction();
  const child = test.actor.startTransaction();

  expect(() => {
    parent.commit();
  }).toThrow("nested txn is outstanding");
  expect(() => {
    parent.rollback();
  }).toThrow("Cannot roll back an outer transaction while a nested transaction is still running.");

  child.rollback();
  child.drop();
  parent.rollback();
  parent.drop();
});

actorTest("shutdown refuses every later operation", async (test) => {
  test.actor.shutdown();

  expect(() => test.get("foo")).toThrow("no longer accessible");
  expect(() => {
    test.put("foo", "bar");
  }).toThrow("no longer accessible");
  expect(() => test.actor.getSqliteKv()).toThrow("no longer accessible");
});

/** The two contract types `ActorSqlite` inherits rather than implements. */
actorTest("the point-in-time-recovery and replication surfaces refuse", async (test) => {
  await expect(test.actor.getBookmarkForTime(0)).rejects.toThrow(
    "does not implement point-in-time recovery",
  );
  await expect(test.actor.onNextSessionRestoreBookmark("x")).rejects.toThrow(
    "does not implement point-in-time recovery",
  );
  expect(() => {
    test.actor.ensureReplicas();
  }).toThrow("does not support replication");
  expect(() => {
    test.actor.disableReplicas();
  }).toThrow("does not support replication");
  await expect(test.actor.configureReadReplication(true)).rejects.toThrow(
    "does not support replication",
  );
});

actorTest("the local-development bookmark increments and sorts", async (test) => {
  const first = await test.actor.getCurrentBookmark();
  const second = await test.actor.getCurrentBookmark();

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-0{32}$/);
  expect(second > first).toBe(true);
  await test.actor.waitForBookmark(second);

  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();
});

actorTest("evictStale never applies backpressure", async (test) => {
  expect(test.actor.evictStale(0)).toBeUndefined();
});

actorTest("list and listReverse read a range", async (test) => {
  test.putMultiple([
    { key: "a", value: bytes("1") },
    { key: "b", value: bytes("2") },
    { key: "c", value: bytes("3") },
  ]);
  (await test.pollAndExpectCalls(["commit"]))[0]?.fulfill();

  expect(test.actor.list("a", undefined, undefined, {}).map((pair) => pair.key)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(test.actor.listReverse("a", undefined, 2, {}).map((pair) => pair.key)).toEqual(["c", "b"]);
  expect(test.actor.getMultiple(["c", "a", "zzz"], {}).map((pair) => pair.key)).toEqual(["a", "c"]);
});

/** `startTransaction` on an open implicit transaction commits it first (upstream's comment). */
actorTest("starting an explicit transaction commits an open implicit one", async (test) => {
  test.put("foo", "bar");
  expect(test.actor.isCommitScheduled()).toBe(true);

  const txn: ActorCacheTransaction = test.actor.startTransaction();
  txn.put("baz", bytes("quux"), {});
  txn.commit();
  txn.drop();

  // Two commit callbacks, and this is upstream's shape rather than a merge that failed: the
  // explicit commit runs `commitImpl` synchronously inside `commit()` and clears `pendingCommit`
  // before awaiting the callback, so the implicit transaction's own scheduled commit — which the
  // constructor turned into a no-op `COMMIT TRANSACTION` — still starts one of its own.
  const commits = await test.pollAndExpectCalls(["commit", "commit"]);
  commits[0]?.fulfill();
  commits[1]?.fulfill();
  await test.pollAndExpectCalls([]);

  expect(text(test.get("foo"))).toBe("bar");
  expect(text(test.get("baz"))).toBe("quux");
});
