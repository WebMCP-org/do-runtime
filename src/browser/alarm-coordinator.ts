import {
  ALARM_RETRY_MAX_TRIES,
  alarmRetryDelayMs,
} from "../server/alarm-scheduler";

type LooseRecord = Record<string, unknown>;

export type BrowserAlarmProjection = {
  readonly generation: number;
  readonly when: number | null;
} & LooseRecord;

export type BrowserAlarmDelivery = {
  readonly generation: number;
  readonly retryCount: number;
  readonly wake: number;
} & LooseRecord;

export type BrowserAlarmTransportJournal = {
  readonly delivery: BrowserAlarmDelivery | null;
  readonly projection: BrowserAlarmProjection;
} & LooseRecord;

export interface BrowserAlarmTransportStore {
  load(): Promise<BrowserAlarmTransportJournal | null>;
  save(journal: BrowserAlarmTransportJournal): Promise<void>;
}

export interface BrowserPhysicalAlarm {
  clear(): Promise<void>;
  create(when: number): Promise<void>;
}

export type BrowserAlarmCoordinatorOptions = {
  deliver(scheduledTime: number): Promise<BrowserAlarmProjection>;
  now?: () => number;
  physical: BrowserPhysicalAlarm;
  store: BrowserAlarmTransportStore;
};

/**
 * Projects a logical namespace alarm onto one crash-prone browser alarm.
 *
 * `AlarmScheduler` remains authoritative for actor delivery and retries. This
 * coordinator journals the physical hop so a browser background worker can be
 * stopped between any two awaited operations without losing the next wake.
 */
export class BrowserAlarmCoordinator {
  readonly #activeDeliveries = new Set<number>();
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserAlarmCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
  }

  project(projection: BrowserAlarmProjection): Promise<void> {
    const parsed = requireProjection(projection);
    return this.#mutate(async () => {
      const current = await this.options.store.load();
      if (current && parsed.generation < current.projection.generation) return;
      if (current?.delivery) {
        // A projection describes logical state, not completion of the transport
        // call carrying this delivery. Keep its recovery wake until fire()
        // receives the scheduler's final acknowledgement.
        if (
          parsed.generation !== current.projection.generation ||
          parsed.when !== current.projection.when
        ) {
          await this.options.store.save({ delivery: current.delivery, projection: parsed });
        }
        return;
      }
      const next = {
        delivery: null,
        projection: parsed,
      } satisfies BrowserAlarmTransportJournal;
      // Journal first: startup reconciliation can finish the physical operation
      // if the background worker is stopped between these two writes.
      await this.options.store.save(next);
      await this.#apply(parsed.when);
    });
  }

  /** Repairs an acknowledged physical operation interrupted by browser suspension. */
  reconcile(): Promise<void> {
    return this.#mutate(async () => {
      const current = await this.options.store.load();
      if (!current) return;
      if (current.delivery) {
        await this.options.physical.create(Math.max(current.delivery.wake, this.#now()));
        return;
      }
      await this.#apply(current.projection.when);
    });
  }

  async fire(scheduledTime: number): Promise<BrowserAlarmProjection | null> {
    const attempt = await this.#mutate(async () => {
      const stored = await this.options.store.load();
      const current =
        stored ??
        ({
          delivery: null,
          projection: { generation: 0, when: scheduledTime },
        } satisfies BrowserAlarmTransportJournal);
      const expectedWake = current.delivery?.wake ?? current.projection.when;
      if (expectedWake === null) return null;
      if (scheduledTime < expectedWake) {
        // A consumed, slightly early watchdog must not erase the journaled wake.
        await this.options.physical.create(expectedWake);
        return null;
      }
      const retryCount =
        current.delivery?.generation === current.projection.generation
          ? current.delivery.retryCount
          : 0;
      const delay = alarmRetryDelayMs(Math.min(retryCount, ALARM_RETRY_MAX_TRIES - 1));
      const delivery = {
        generation: current.projection.generation,
        retryCount: Math.min(retryCount + 1, ALARM_RETRY_MAX_TRIES),
        wake: this.#now() + delay,
      };
      // Arm first so a stop between these operations leaves a wake capable of
      // repairing the stale journal rather than losing a consumed one-shot alarm.
      await this.options.physical.create(delivery.wake);
      await this.options.store.save({ ...current, delivery });
      if (this.#activeDeliveries.has(delivery.generation)) return null;
      this.#activeDeliveries.add(delivery.generation);
      return delivery;
    });
    if (!attempt) return null;

    try {
      const projection = requireProjection(await this.options.deliver(scheduledTime));
      await this.#mutate(async () => {
        const current = await this.options.store.load();
        if (current && projection.generation < current.projection.generation) return;
        await this.options.store.save({ delivery: null, projection });
        await this.#apply(projection.when);
      });
      return projection;
    } finally {
      this.#activeDeliveries.delete(attempt.generation);
    }
  }

  #apply(when: number | null): Promise<void> {
    return when === null ? this.options.physical.clear() : this.options.physical.create(when);
  }

  #mutate<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseBrowserAlarmProjection(value: unknown): BrowserAlarmProjection | null {
  if (!isRecord(value)) return null;
  if (!isNonnegativeInteger(value.generation)) return null;
  if (value.when !== null && !isFiniteNumber(value.when)) return null;
  return { ...value, generation: value.generation, when: value.when };
}

export function parseBrowserAlarmTransportJournal(
  value: unknown,
): BrowserAlarmTransportJournal | null {
  if (!isRecord(value)) return null;
  const delivery = value.delivery === null ? null : parseBrowserAlarmDelivery(value.delivery);
  if (delivery === null && value.delivery !== null) return null;
  const projection = parseBrowserAlarmProjection(value.projection);
  if (projection === null) return null;
  return { ...value, delivery, projection };
}

function requireProjection(value: unknown): BrowserAlarmProjection {
  const parsed = parseBrowserAlarmProjection(value);
  if (parsed === null) throw new TypeError("invalid browser alarm projection");
  return parsed;
}

function parseBrowserAlarmDelivery(value: unknown): BrowserAlarmDelivery | null {
  if (!isRecord(value)) return null;
  if (!isNonnegativeInteger(value.generation)) return null;
  if (!isNonnegativeInteger(value.retryCount)) return null;
  if (!isFiniteNumber(value.wake)) return null;
  return {
    ...value,
    generation: value.generation,
    retryCount: value.retryCount,
    wake: value.wake,
  };
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
