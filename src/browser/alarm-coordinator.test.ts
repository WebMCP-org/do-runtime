import { describe, expect, it, vi } from "vitest";
import { ALARM_RETRY_MAX_TRIES, alarmRetryDelayMs } from "../server/alarm-scheduler";
import {
  BrowserAlarmCoordinator,
  parseBrowserAlarmTransportJournal,
  type BrowserAlarmProjection,
  type BrowserAlarmTransportJournal,
  type BrowserAlarmTransportStore,
  type PhysicalAlarm,
} from "./alarm-coordinator";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class MemoryTransportStore implements BrowserAlarmTransportStore {
  journal: BrowserAlarmTransportJournal | null = null;

  async load(): Promise<BrowserAlarmTransportJournal | null> {
    return this.journal === null ? null : structuredClone(this.journal);
  }

  async save(journal: BrowserAlarmTransportJournal): Promise<void> {
    this.journal = structuredClone(journal);
  }
}

class MemoryPhysicalAlarm implements PhysicalAlarm {
  readonly creates: number[] = [];
  clears = 0;
  createGate: Promise<void> | null = null;
  readonly createStarted = new Deferred<void>();

  async clear(): Promise<void> {
    this.clears++;
  }

  async create(when: number): Promise<void> {
    this.creates.push(when);
    this.createStarted.resolve();
    await this.createGate;
  }
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

    expect(parseBrowserAlarmTransportJournal(journal)).toBe(journal);
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
  });

  it("acknowledges a projection only after the physical alarm operation finishes", async () => {
    const store = new MemoryTransportStore();
    const physical = new MemoryPhysicalAlarm();
    const physicalAcknowledgement = new Deferred<void>();
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
    const deliveryMayFinish = new Deferred<void>();
    const reentrantProjectionFinished = new Deferred<void>();
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
    const deliveryStarted = new Deferred<void>();
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

    const firing = coordinator.fire(100).catch((error: unknown) => error);
    await deliveryStarted.promise;
    await coordinator.project({ generation: 2, when: 2_000 });
    delivery.reject(new Error("old transport attempt failed"));

    await expect(firing).resolves.toEqual(expect.any(Error));
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
    const deliveryStarted = new Deferred<void>();
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
