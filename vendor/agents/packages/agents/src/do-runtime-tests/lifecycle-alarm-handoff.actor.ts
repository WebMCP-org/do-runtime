import { DurableObject } from "cloudflare:workers";
import {
  Lifecycle,
  LifecycleCapability,
  type MemoryLimitContext
} from "../lifecycle";

/** The job driver's durable strike counter key (#1825). */
const STRIKES_KEY = "cf_agents:oom_alarm_strikes";

/** When the handed-off work rejects, after its dispatch has returned. */
const HANDOFF_REJECT_DELAY_MS = 5;

class HandoffProbe extends LifecycleCapability {
  tracked: boolean | undefined;
  readonly memoryLimit = Promise.withResolvers<MemoryLimitContext>();

  constructor() {
    super("alarm-handoff-probe");
  }

  /**
   * Hand off work that a memory-limit reset rejects after this dispatch has
   * returned, so only the handoff's settle can record the strike. The reset
   * arrives from a bare timer callback, outside any actor continuation, the
   * way a platform reset surfaces through I/O: a settle that does not carry
   * the dispatching alarm's continuation reaches strike storage with no input
   * lock. Rejecting from a transformed actor continuation instead would let a
   * detached `.then(...)` run in that continuation's checkpoint and pass.
   */
  async onJob(): Promise<void> {
    const work = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Durable Object has exceeded its memory limit and was reset"
            )
          ),
        HANDOFF_REJECT_DELAY_MS
      )
    );
    this.tracked = this.lifecycle.trackAlarmWork(work);
  }

  onMemoryLimit(context: MemoryLimitContext): void {
    this.memoryLimit.resolve(context);
  }

  pushDue() {
    return this.lifecycle.jobs.push({
      id: "handoff",
      fn: "handoff",
      time: Date.now()
    });
  }
}

export class AlarmHandoffObject extends DurableObject {
  readonly probe = new HandoffProbe();
  readonly lifecycle = Lifecycle.install(this).use(this.probe);
  readonly resets: string[] = [];

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // The strike path resets the isolate on a timer; record the reset instead
    // so the test can read the strike back from a live object.
    ctx.abort = (reason?: string) => {
      this.resets.push(String(reason));
    };
  }

  /** Start the lifecycle, queue one due handoff job, and report the alarm. */
  async queueHandoff(): Promise<number | null> {
    await this.lifecycle.start();
    await this.probe.pushDue();
    return this.ctx.storage.getAlarm();
  }

  /** Wait for the handoff's strike to reach memory-limit policy. */
  async strike() {
    const context = await this.probe.memoryLimit.promise;
    return {
      tracked: this.probe.tracked,
      sealed: context.sealed,
      executing: context.executing?.id,
      strikes: await this.ctx.storage.get<number>(STRIKES_KEY)
    };
  }
}
