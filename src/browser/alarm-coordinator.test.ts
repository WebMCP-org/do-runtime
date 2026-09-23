import { describe, expect, it, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import type { Timer } from "../io/io-context";
import {
  ALARM_RETRY_MAX_TRIES,
  AlarmScheduler,
  alarmRetryDelayMs,
  type AlarmResult,
} from "../server/alarm-scheduler";
import type { SqlDatabase } from "../util/sqlite";
import {
  BrowserAlarmCoordinator,
  createBrowserAlarmProjector,
  parseBrowserAlarmProjection,
  parseBrowserAlarmTransportJournal,
  type BrowserAlarmProjection,
  type BrowserPhysicalAlarm,
  type BrowserAlarmTransportJournal,
  type BrowserAlarmTransportStore,
} from "./alarm-coordinator";

class MemoryTransportStore implements BrowserAlarmTransportStore {
  journal: BrowserAlarmTransportJournal | null = null;

  async load(): Promise<BrowserAlarmTransportJournal | null> {
    return this.journal === null ? null : structuredClone(this.journal);
  }

  async save(journal: BrowserAlarmTransportJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }
}

class MemoryPhysicalAlarm implements BrowserPhysicalAlarm {
  readonly creates: number[] = [];
  clears = 0;
  createGate: Promise<void> | null = null;
  readonly createStarted = Promise.withResolvers<void>();

  async clear(): Promise<void> {
    this.clears++;
  }

  async create(when: number): Promise<void> {
    this.creates.push(when);
    this.createStarted.resolve();
    await this.createGate;
  }
}

const START = 1_000_000;
const OK: AlarmResult = { outcome: "ok", retry: false, retryCountsAgainstLimit: false };
const USER_FAILURE: AlarmResult = { outcome: "exception", retry: true, retryCountsAgainstLimit: true };
const PARKED = Symbol("parked");

/** A scheduler clock that moves only when a test advances it. */
class ManualTimer implements Timer {
  #now = START;
  #pending: { readonly at: number; readonly resolve: () => void }[] = [];

  now(): number {
    return this.#now;
  }

  afterDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const entry = { at: this.#now + ms, resolve };
      this.#pending.push(entry);
      signal?.addEventListener("abort", () => {
        this.#pending = this.#pending.filter((pending) => pending !== entry);
      });
    });
  }

  async advance(ms: number): Promise<void> {
    this.#now += ms;
    const due = this.#pending.filter((entry) => entry.at <= this.#now);
    this.#pending = this.#pending.filter((entry) => entry.at > this.#now);
    for (const entry of due) entry.resolve();
    await settle();
  }
}

/** Every alarm hop here is a promise continuation, so one task drains them all. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function afterQueuedWork<T>(promise: Promise<T>): Promise<T | typeof PARKED> {
  return Promise.race([promise, settle().then((): typeof PARKED => PARKED)]);
}

/** A durable generation in a host table beside `_cf_ALARM`, as a browser host keeps it. */
function nextDurableGeneration(db: SqlDatabase): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS alarm_projection " +
      "(id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL)",
    [],
  );
  const row = db.exec(
    "INSERT INTO alarm_projection VALUES (1, 1) " +
      "ON CONFLICT (id) DO UPDATE SET generation = generation + 1 RETURNING generation",
    [],
  ).rawRows[0];
  return Number(row?.[0]);
}

type HostBoundary = {
  deliver?(scheduledTime: number, retryCount: number): Promise<AlarmResult>;
  abandon?(): Promise<number | null>;
  project?(projection: BrowserAlarmProjection): Promise<void>;
};

/**
 * One Worker lifetime: a scheduler over `db` projecting through
 * `createBrowserAlarmProjector` into a service-worker coordinator. Pass the
 * same database, store and physical alarm to model a Worker restart.
 */
async function startWorker(
  options: HostBoundary & {
    db?: SqlDatabase;
    nextGeneration?: () => number | Promise<number>;
    physical?: MemoryPhysicalAlarm;
    store?: MemoryTransportStore;
  } = {},
) {
  const db = options.db ?? (await createNodeSqlProvider().open("alarms"));
  const physical = options.physical ?? new MemoryPhysicalAlarm();
  const store = options.store ?? new MemoryTransportStore();
  const timer = new ManualTimer();
  const projections: BrowserAlarmProjection[] = [];
  const wakes = createBrowserAlarmProjector({
    nextGeneration: options.nextGeneration ?? (() => nextDurableGeneration(db)),
    project: async (projection) => {
      projections.push(projection);
      await options.project?.(projection);
      await coordinator.project(projection);
    },
  });
  const coordinator = new BrowserAlarmCoordinator({
    deliver: wakes.acknowledge,
    now: () => timer.now(),
    physical,
    store,
  });
  const scheduler = new AlarmScheduler({
    timer,
    db,
    random: () => 0,
    getActor: () => ({
      deliverAlarm: async (scheduledTime, retryCount) =>
        (await options.deliver?.(scheduledTime, retryCount)) ?? OK,
      abandonAlarm: async () => (await options.abandon?.()) ?? null,
    }),
    projectWake: wakes.projectWake,
  });
  // Land the constructor's projection before a test controls later ones.
  await settle();
  return {
    acknowledge: wakes.acknowledge,
    coordinator,
    db,
    physical,
    projections,
    store,
    timer,
    schedule: (actorId: string, when: number | null) =>
      scheduler.hooks(actorId).scheduleRun(when, Promise.resolve()),
  };
}

describe("BrowserAlarmCoordinator", () => {
  it("parses a loose durable journal and rejects invalid storage", () => {
    const journal = {
      delivery: {
        generation: 2,
        retryCount: 1,
        wake: 12_345,
        retainedMetadata: "delivery",
      },
      projection: { generation: 3, when: 67_890, retainedMetadata: "projection" },
      retainedMetadata: "journal",
    };

    expect(parseBrowserAlarmTransportJournal(journal)).toEqual(journal);
    expect(parseBrowserAlarmTransportJournal(undefined)).toBeNull();
    expect(parseBrowserAlarmTransportJournal(null)).toBeNull();
    expect(parseBrowserAlarmTransportJournal({ version: 1 })).toBeNull();
    expect(
      parseBrowserAlarmTransportJournal({
        delivery: null,
        projection: { generation: -1, when: 1 },
      }),
    ).toBeNull();
    expect(
      parseBrowserAlarmTransportJournal({
        delivery: { generation: 1, retryCount: 0, wake: Number.NaN },
        projection: { generation: 1, when: 1 },
      }),
    ).toBeNull();
    expect(parseBrowserAlarmProjection({ generation: 2, when: null })).toEqual({
      generation: 2,
      when: null,
    });
    expect(parseBrowserAlarmProjection({ generation: 2 })).toBeNull();
  });

  it("acknowledges a projection only after the physical alarm operation finishes", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const physicalAcknowledgement = Promise.withResolvers<void>();
    physical.createGate = physicalAcknowledgement.promise;
    const coordinator = new BrowserAlarmCoordinator({
      deliver: vi.fn(),
      physical,
      store,
    });

    let acknowledged = false;
    const projecting = coordinator.project({ generation: 1, when: 12_345 });
    void projecting.then(() => {
      acknowledged = true;
    });
    await physical.createStarted.promise;

    expect(store.journal).toEqual({
      delivery: null,
      projection: { generation: 1, when: 12_345 },
    });
    expect(physical.creates).toEqual([12_345]);
    expect(acknowledged).toBe(false);

    physicalAcknowledgement.resolve();
    await projecting;
    expect(acknowledged).toBe(true);
  });

  it("ignores stale projections after a newer generation is acknowledged", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const coordinator = new BrowserAlarmCoordinator({
      deliver: vi.fn(),
      physical,
      store,
    });

    await coordinator.project({ generation: 4, when: 40_000 });
    await coordinator.project({ generation: 3, when: 30_000 });

    expect(store.journal).toEqual({
      delivery: null,
      projection: { generation: 4, when: 40_000 },
    });
    expect(physical.creates).toEqual([40_000]);
  });

  it("rearms a journaled future wake after an early one-shot alarm is consumed", async () => {
    const store = new MemoryTransportStore();
    store.journal = {
      delivery: null,
      projection: { generation: 4, when: 40_010 },
    };
    const physical = new MemoryPhysicalAlarm();
    const deliver = vi.fn();
    const coordinator = new BrowserAlarmCoordinator({ deliver, physical, store });

    await expect(coordinator.fire(40_000)).resolves.toBeNull();

    expect(deliver).not.toHaveBeenCalled();
    expect(physical.creates).toEqual([40_010]);
  });

  it("allows delivery to re-project without deadlocking", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const deliveryMayFinish = Promise.withResolvers<void>();
    const reentrantProjectionFinished = Promise.withResolvers<void>();
    let coordinator!: BrowserAlarmCoordinator;
    const deliver = vi.fn(async () => {
      const projection = { generation: 2, when: 20_000 };
      await coordinator.project(projection);
      reentrantProjectionFinished.resolve();
      await deliveryMayFinish.promise;
      return projection;
    });
    coordinator = new BrowserAlarmCoordinator({ deliver, physical, store });
    await coordinator.project({ generation: 1, when: 10_000 });

    const firing = coordinator.fire(10_000);
    await reentrantProjectionFinished.promise;

    expect(store.journal?.projection).toEqual({ generation: 2, when: 20_000 });
    expect(store.journal?.delivery).toMatchObject({ generation: 1, retryCount: 1 });
    expect(physical.creates.at(-1)).toBe(store.journal?.delivery?.wake);

    deliveryMayFinish.resolve();
    await expect(firing).resolves.toEqual({ generation: 2, when: 20_000 });
    expect(physical.creates.at(-1)).toBe(20_000);
  });

  it("preserves a cold-start delivery when initialization re-projects its generation", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    let coordinator!: BrowserAlarmCoordinator;
    coordinator = new BrowserAlarmCoordinator({
      deliver: async () => {
        await coordinator.project({ generation: 1, when: 10_000 });
        throw new Error("worker failed after initialization");
      },
      now: () => 20_000,
      physical,
      store,
    });
    await coordinator.project({ generation: 1, when: 10_000 });

    await expect(coordinator.fire(10_000)).rejects.toThrow("worker failed after initialization");

    expect(store.journal?.delivery).toEqual({
      generation: 1,
      retryCount: 1,
      wake: 22_000,
    });
    expect(physical.creates).toEqual([10_000, 22_000]);
  });

  it("keeps a self-waking watchdog without exhausting the logical alarm", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    let now = 1_000;
    const deliver = vi.fn(async () => {
      throw new Error("offscreen transport unavailable");
    });
    const coordinator = new BrowserAlarmCoordinator({
      deliver,
      now: () => now,
      physical,
      store,
    });
    await coordinator.project({ generation: 1, when: now });

    let scheduledTime = now;
    const watchdogDelays = Array.from({ length: ALARM_RETRY_MAX_TRIES + 2 }, (_, index) =>
      alarmRetryDelayMs(Math.min(index, ALARM_RETRY_MAX_TRIES - 1)),
    );
    for (const [index, delay] of watchdogDelays.entries()) {
      await expect(coordinator.fire(scheduledTime)).rejects.toThrow(
        "offscreen transport unavailable",
      );
      const expectedWake = now + delay;
      expect(store.journal?.delivery).toEqual({
        generation: 1,
        retryCount: Math.min(index + 1, ALARM_RETRY_MAX_TRIES),
        wake: expectedWake,
      });
      scheduledTime = expectedWake;
      now = expectedWake;
    }

    expect(deliver).toHaveBeenCalledTimes(watchdogDelays.length);
    expect(physical.clears).toBe(0);
  });

  it("retains recovery until a newer projection is acknowledged", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const deliveryStarted = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<BrowserAlarmProjection>();
    const coordinator = new BrowserAlarmCoordinator({
      deliver: async () => {
        deliveryStarted.resolve();
        return delivery.promise;
      },
      now: () => 1_000,
      physical,
      store,
    });
    await coordinator.project({ generation: 1, when: 100 });

    const firing = coordinator.fire(100);
    const failure = expect(firing).rejects.toThrow("old transport attempt failed");
    await deliveryStarted.promise;
    await coordinator.project({ generation: 2, when: 2_000 });
    delivery.reject(new Error("old transport attempt failed"));

    await failure;
    expect(store.journal).toEqual({
      delivery: { generation: 1, retryCount: 1, wake: 3_000 },
      projection: { generation: 2, when: 2_000 },
    });
  });

  it("reconciles a persisted retry after a background restart", async () => {
    const store = new MemoryTransportStore();
    const firstCoordinator = new BrowserAlarmCoordinator({
      deliver: async () => {
        throw new Error("background stopped before delivery");
      },
      now: () => 1_000,
      physical: new MemoryPhysicalAlarm(),
      store,
    });
    await firstCoordinator.project({ generation: 7, when: 500 });
    await expect(firstCoordinator.fire(500)).rejects.toThrow(
      "background stopped before delivery",
    );

    const restartedPhysical = new MemoryPhysicalAlarm();
    const restartedCoordinator = new BrowserAlarmCoordinator({
      deliver: vi.fn(),
      now: () => 4_000,
      physical: restartedPhysical,
      store,
    });
    await restartedCoordinator.reconcile();

    expect(restartedPhysical.creates).toEqual([4_000]);
    expect(store.journal?.delivery).toEqual({
      generation: 7,
      retryCount: 1,
      wake: 3_000,
    });
  });

  it("coalesces watchdog wakes while the same delivery is live", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const deliveryStarted = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<BrowserAlarmProjection>();
    let now = 1_000;
    const deliver = vi.fn(() => {
      deliveryStarted.resolve();
      return delivery.promise;
    });
    const coordinator = new BrowserAlarmCoordinator({
      deliver,
      now: () => now,
      physical,
      store,
    });
    await coordinator.project({ generation: 7, when: 500 });

    const firing = coordinator.fire(500);
    await deliveryStarted.promise;
    now = 3_000;
    await expect(coordinator.fire(3_000)).resolves.toBeNull();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.journal?.delivery).toEqual({
      generation: 7,
      retryCount: 2,
      wake: 7_000,
    });

    delivery.resolve({ generation: 8, when: null });
    await expect(firing).resolves.toEqual({ generation: 8, when: null });
    expect(store.journal).toEqual({
      delivery: null,
      projection: { generation: 8, when: null },
    });
  });
});

describe("createBrowserAlarmProjector", () => {
  it("acknowledges an early wake that the projected future wake already covers", async () => {
    const worker = await startWorker();
    const future = START + 60_000;
    await worker.schedule("future", future);

    await expect(worker.acknowledge(START)).resolves.toEqual(worker.projections.at(-1));
    expect(worker.projections.at(-1)?.when).toBe(future);
  });

  it("acknowledges a cancelled wake without waiting for a delivery", async () => {
    const worker = await startWorker();
    const scheduledTime = START + 60_000;
    await worker.schedule("cancelled", scheduledTime);
    const acknowledged = worker.acknowledge(scheduledTime);
    expect(await afterQueuedWork(acknowledged)).toBe(PARKED);

    await worker.schedule("cancelled", null);

    await expect(acknowledged).resolves.toEqual(worker.projections.at(-1));
    expect(worker.projections.at(-1)?.when).toBeNull();
  });

  it("completes a coordinator delivery once a failed attempt's retry is projected", async () => {
    const release = Promise.withResolvers<void>();
    const worker = await startWorker({
      deliver: async () => {
        await release.promise;
        return USER_FAILURE;
      },
    });
    await worker.schedule("retry", START);
    await worker.timer.advance(0);

    const firing = worker.coordinator.fire(START);
    expect(await afterQueuedWork(firing)).toBe(PARKED);
    release.resolve();

    const retry = START + alarmRetryDelayMs(0);
    const projection = await firing;
    expect(projection).toEqual(worker.projections.at(-1));
    expect(projection?.when).toBe(retry);
    expect(worker.store.journal).toEqual({
      delivery: null,
      projection: worker.projections.at(-1),
    });
    expect(worker.physical.creates.at(-1)).toBe(retry);
  });

  it("keeps a running delivery unacknowledged through an unrelated projection", async () => {
    const release = Promise.withResolvers<void>();
    const worker = await startWorker({
      deliver: async () => {
        await release.promise;
        return OK;
      },
    });
    await worker.schedule("held", START);
    await worker.timer.advance(0);
    const delivery = worker.acknowledge(START);
    const earlierWake = worker.acknowledge(START - 1);
    const nextWake = START + 60_000;

    await worker.schedule("unrelated", nextWake);

    // The active alarm stays due for crash recovery even with a later wake.
    expect(worker.projections.at(-1)?.when).toBe(START);
    expect(await afterQueuedWork(delivery)).toBe(PARKED);
    expect(await afterQueuedWork(earlierWake)).toBe(PARKED);
    release.resolve();
    await expect(delivery).resolves.toMatchObject({ when: nextWake });
    await expect(earlierWake).resolves.toMatchObject({ when: nextWake });
  });

  it("sends a failed projection again before acknowledging a consumed wake", async () => {
    let unreachable = false;
    const worker = await startWorker({
      project: async () => {
        if (unreachable) throw new Error("the service worker was unreachable");
      },
    });
    await worker.schedule("due", START + 10_000);
    unreachable = true;
    await expect(worker.schedule("due", null)).rejects.toThrow("the service worker was unreachable");
    await expect(worker.acknowledge(START + 10_000)).rejects.toThrow(
      "the service worker was unreachable",
    );
    unreachable = false;

    // The idle scheduler will never project again, so the wake must resend it.
    const projection = await worker.coordinator.fire(START + 10_000);

    expect(projection).toEqual(worker.projections.at(-1));
    expect(worker.store.journal).toEqual({
      delivery: null,
      projection: { generation: projection?.generation, when: null },
    });
  });

  it("does not let an older projection's acceptance acknowledge a newer refusal", async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scheduledTime = START + 60_000;
    let refuseCancellation = false;
    const worker = await startWorker({
      project: async (projection) => {
        if (projection.when === scheduledTime) {
          held.resolve();
          await release.promise;
        } else if (refuseCancellation && projection.when === null) {
          throw new Error("Chrome refused the newer projection");
        }
      },
    });
    const scheduled = worker.schedule("held-projection", scheduledTime);
    await held.promise;
    const delivery = worker.acknowledge(scheduledTime);
    refuseCancellation = true;
    const cancelled = worker.schedule("held-projection", null);

    release.resolve();

    await scheduled;
    await expect(delivery).rejects.toThrow("Chrome refused the newer projection");
    await expect(cancelled).rejects.toThrow("Chrome refused the newer projection");
  });

  it("does not let an older projection's refusal reject a newer one's acknowledgement", async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const worker = await startWorker({
      project: async (projection) => {
        if (projection.when !== START + 10_000) return;
        held.resolve();
        await release.promise;
        throw new Error("Chrome refused the older projection");
      },
    });
    const older = worker.schedule("moved", START + 10_000);
    await held.promise;
    const newer = worker.schedule("moved", START + 20_000);
    const acknowledged = worker.acknowledge(START);
    expect(await afterQueuedWork(acknowledged)).toBe(PARKED);

    release.resolve();

    await expect(older).rejects.toThrow("Chrome refused the older projection");
    await newer;
    await expect(acknowledged).resolves.toEqual(worker.projections.at(-1));
    expect(worker.projections.at(-1)?.when).toBe(START + 20_000);
  });

  it("parks acknowledgement behind a refused abandonment until its cleanup retry lands", async () => {
    const retryCounts: number[] = [];
    let abandonments = 0;
    const worker = await startWorker({
      deliver: async (_scheduledTime, retryCount) => {
        retryCounts.push(retryCount);
        return USER_FAILURE;
      },
      abandon: async () => {
        abandonments += 1;
        if (abandonments === 1) throw new Error("The actor refused the abandonment");
        return null;
      },
    });
    await worker.schedule("abandoned", START);
    for (let second = 0; abandonments === 0 && second < 1_000; second += 1) {
      await worker.timer.advance(1_000);
    }
    expect(retryCounts.at(-1)).toBe(ALARM_RETRY_MAX_TRIES);
    const delivered = retryCounts.length;

    // The failed cleanup keeps the alarm projected at its own time: the work
    // is unfinished, so acknowledging its wake would drop the last recovery.
    const acknowledged = worker.acknowledge(START);
    expect(worker.projections.at(-1)?.when).toBe(START);
    expect(await afterQueuedWork(acknowledged)).toBe(PARKED);

    // One bookkeeping backoff later the scheduler retries the abandonment.
    await worker.timer.advance(alarmRetryDelayMs(0));
    await expect(acknowledged).resolves.toMatchObject({ when: null });
    expect(abandonments).toBe(2);
    expect(retryCounts).toHaveLength(delivered);
  });

  it("sends projections one at a time and acknowledges the latest of a churning queue", async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdNext = false;
    const worker = await startWorker({
      project: async () => {
        if (!holdNext) return;
        holdNext = false;
        held.resolve();
        await release.promise;
      },
    });
    holdNext = true;
    const earliest = worker.schedule("churn-a", START + 10_000);
    await held.promise;
    const churn = [
      worker.schedule("churn-b", START + 20_000),
      worker.schedule("churn-c", START + 30_000),
      worker.schedule("churn-d", START + 40_000),
    ];
    const acknowledged = worker.acknowledge(START);

    expect(await afterQueuedWork(acknowledged)).toBe(PARKED);
    expect(worker.projections.map(({ when }) => when)).toEqual([null, START + 10_000]);
    release.resolve();
    await Promise.all([earliest, ...churn]);

    await expect(acknowledged).resolves.toMatchObject({ when: START + 10_000 });
    expect(worker.projections.map(({ generation }) => generation)).toEqual([1, 2, 3, 4, 5]);
  });

  it("re-arms the physical alarm after a Worker restart with a durable generation", async () => {
    const first = await startWorker();
    await first.schedule("before-restart", START + 10_000);
    await first.schedule("before-restart", null);
    const journaled = first.store.journal?.projection.generation ?? 0;

    const durableAtSend: number[] = [];
    const restarted = await startWorker({
      db: first.db,
      physical: first.physical,
      store: first.store,
      project: async () => {
        const row = first.db.exec("SELECT generation FROM alarm_projection", []).rawRows[0];
        durableAtSend.push(Number(row?.[0]));
      },
    });
    await restarted.schedule("after-restart", START + 20_000);

    expect(restarted.projections[0]?.generation).toBe(journaled + 1);
    expect(durableAtSend).toEqual(restarted.projections.map(({ generation }) => generation));
    expect(first.store.journal).toEqual({
      delivery: null,
      projection: { generation: journaled + 2, when: START + 20_000 },
    });
    expect(first.physical.creates.at(-1)).toBe(START + 20_000);
  });

  it("draws an asynchronous generation only after the previous projection is sent", async () => {
    // This counter numbers a draw when its write lands, so overlapping draws
    // could number a newer wake below an older one and have it dropped.
    const draws: PromiseWithResolvers<void>[] = [];
    let landed = 0;
    const worker = await startWorker({
      nextGeneration: async () => {
        const draw = Promise.withResolvers<void>();
        draws.push(draw);
        await draw.promise;
        return (landed += 1);
      },
    });
    const older = worker.schedule("moved", START + 10_000);
    const newer = worker.schedule("moved", START + 20_000);

    // Land the newest pending draw first.
    while (draws.length > 0) {
      draws.pop()?.resolve();
      await settle();
    }

    await Promise.all([older, newer]);
    expect(worker.store.journal?.projection).toEqual({ generation: 3, when: START + 20_000 });
  });
});
