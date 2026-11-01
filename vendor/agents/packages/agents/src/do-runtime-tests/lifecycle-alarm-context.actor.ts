import { DurableObject } from "cloudflare:workers";
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobPushOptions
} from "../lifecycle";

const HOUR_MS = 3_600_000;

/** Long enough that a held write outlasts a whole failed startup. */
// An event-loop stall over 10 ms can let broken code pass; it can never fail fixed code.
const ALARM_WRITE_DELAY_MS = 10;

/**
 * Hold every alarm write on a timer before it reaches storage, the way an
 * async storage wrapper compiled with the await transform would (this file
 * is in the lane's transform include; an untransformed wrapper loses the
 * lock on either shape). do-runtime's own setAlarm/deleteAlarm settle
 * inside the caller's microtask checkpoint, which hides a write that runs in
 * the wrong continuation. A held write outlives the checkpoint, so it reaches
 * storage only with a lock its continuation re-acquired.
 *
 * Not `setTimeout(0)`: a zero timer can fire ahead of do-runtime's pending
 * lock release (see `portHop` in src/server/actor-container.test.ts).
 */
function delayAlarmWrites(storage: DurableObjectStorage): void {
  const setAlarm = storage.setAlarm.bind(storage);
  const deleteAlarm = storage.deleteAlarm.bind(storage);
  const macrotask = () =>
    new Promise((resolve) => setTimeout(resolve, ALARM_WRITE_DELAY_MS));
  storage.setAlarm = async (time, options) => {
    await macrotask();
    return setAlarm(time, options);
  };
  storage.deleteAlarm = async (options) => {
    await macrotask();
    return deleteAlarm(options);
  };
}

class StartFailureProbe extends LifecycleCapability {
  failStart = false;

  constructor() {
    super("alarm-context-probe");
  }

  async onStart(): Promise<void> {
    if (!this.failStart) return;
    await this.push({
      id: "pushed-during-start",
      fn: "tick",
      time: Date.now()
    });
    throw new Error("intentional startup failure");
  }

  async onJob(): Promise<void> {}

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function rejections(promises: Promise<unknown>[]): Promise<string[]> {
  const settled = await Promise.allSettled(promises);
  return settled.flatMap((result) =>
    result.status === "rejected" ? [message(result.reason)] : []
  );
}

export class AlarmContextObject extends DurableObject {
  readonly probe = new StartFailureProbe();
  readonly lifecycle = Lifecycle.install(this).use(this.probe);

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    delayAlarmWrites(ctx.storage);
  }

  async startLifecycle(): Promise<void> {
    await this.lifecycle.start();
  }

  /**
   * Push two jobs from the invocation's synchronous body with no await
   * between them, then await both.
   */
  async queueTwoWithoutAwait() {
    const time = Date.now() + HOUR_MS;
    const first = this.probe.push({ id: "a", fn: "tick", time });
    const second = this.probe.push({ id: "b", fn: "tick", time: time + 1 });
    return {
      errors: await rejections([first, second]),
      alarm: await this.ctx.storage.getAlarm(),
      time
    };
  }

  /**
   * Push a job before startup, so its re-arm is still in flight when a
   * startup that pushes a due job and then throws arms the fallback.
   */
  async failStartupBehindPendingRearm() {
    this.probe.failStart = true;
    const before = Date.now();
    const pushed = this.probe.push({
      id: "before-start",
      fn: "tick",
      time: before + HOUR_MS
    });
    // Read through allSettled below; mark it handled now so a regression that
    // rejects it while start() is awaited fails on the assertion alone.
    pushed.catch(() => {});
    let startError: string | undefined;
    try {
      await this.lifecycle.start();
    } catch (error) {
      startError = message(error);
    }
    return {
      startError,
      pushErrors: await rejections([pushed]),
      before,
      alarm: await this.ctx.storage.getAlarm()
    };
  }
}
