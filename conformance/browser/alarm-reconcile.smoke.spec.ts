/**
 * An alarm whose schedule request is lost after the actor's commit, repaired
 * when the actor is placed again.
 *
 * This lane's alarm outlet reaches the scheduler over two capnweb hops, so it
 * cannot fail before `COMMIT` the way an in-process outlet does: the alarm is
 * durable in the actor's database whether or not the scheduler recorded it.
 * The page here supervises the lane's own actor and scheduler workers, fails
 * one request in transit, places the actor again, and waits for the alarm to
 * fire as a first attempt. Only `AlarmOutlet.reconcile` can make it fire.
 */

import { expect, test } from "vitest";
import { newRpcSession, type AlarmResult } from "../../src/index";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import type { ActorBoot, ActorRpc, AlarmsBoot, AlarmsRpc, SupervisorRpc } from "./protocol";
import { poolName, reportWorkerErrors } from "./protocol";

type Session<T> = ReturnType<typeof newRpcSession<T>>;

const RUN = Math.random().toString(36).slice(2, 10);
const ACTOR = "reconcile";

/** Every worker the test started, terminated however it ends. */
const workers: Worker[] = [];
let actor: Session<ActorRpc> | undefined;
let alarms: Session<AlarmsRpc> | undefined;
/** While set, a schedule request fails between the actor and the scheduler. */
let losing = false;

function up<T>(session: T | undefined): T {
  if (session === undefined) throw new Error("alarm-reconcile smoke: a worker is not up");
  return session;
}

/** `host.ts`'s supervisor, cut down to one actor and one scheduler. */
class Supervisor extends RpcTarget implements SupervisorRpc {
  callActor(): Promise<unknown> {
    return Promise.reject(new Error("alarm-reconcile smoke: there is one actor"));
  }

  async scheduleRun(actorName: string, scheduledTime: number | null): Promise<void> {
    if (losing) throw new Error("alarm-reconcile smoke: schedule request lost");
    await up(alarms).scheduleRun(actorName, scheduledTime);
  }

  async reconcile(actorName: string, stored: number): Promise<void> {
    await up(alarms).reconcile(actorName, stored);
  }

  async deliverAlarm(
    _actorName: string,
    scheduledTime: number,
    retryCount: number,
  ): Promise<AlarmResult> {
    return (await up(actor).deliverAlarm(scheduledTime, retryCount)) as AlarmResult;
  }

  async abandonAlarm(_actorName: string, scheduledTime: number): Promise<number | null> {
    return await up(actor).abandonAlarm(scheduledTime);
  }

  report(description: string): void {
    console.error(`[alarm-reconcile smoke] ${description}`);
  }
}

const supervisor = new Supervisor();

function start<T>(script: URL, boot: (port: MessagePort) => ActorBoot | AlarmsBoot): Session<T> {
  const worker = new Worker(script, { type: "module" });
  workers.push(worker);
  reportWorkerErrors(worker, script.pathname);
  const channel = new MessageChannel();
  worker.postMessage(boot(channel.port2), [channel.port2]);
  return newRpcSession<T>(channel.port1, supervisor);
}

test(
  "an alarm whose schedule request was lost after the commit fires once the actor is placed again",
  async () => {
    try {
      alarms = start<AlarmsRpc>(new URL("./alarms.worker.ts", import.meta.url), (port) => ({
        port,
        poolName: poolName("do-runtime-reconcile", RUN, "alarms"),
      }));
      const probe = (actor = start<ActorRpc>(
        new URL("./actor.worker.ts", import.meta.url),
        (port) => ({ port, actorName: ACTOR, poolName: poolName("do-runtime-reconcile", RUN, ACTOR) }),
      ));
      await probe.ready();

      // `armFailingAlarm(0)` records its first delivery and succeeds. Its schedule request fails
      // after the commit, which breaks the container the way any failed commit does.
      losing = true;
      await expect(probe.call("armFailingAlarm", [0])).rejects.toThrow();
      losing = false;

      await probe.respawn();
      let delivered: unknown = null;
      const deadline = Date.now() + 10_000;
      while (delivered === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        delivered = await probe.call("readAlarmRetry", []);
      }
      expect(delivered).toEqual({ retryCount: 0, isRetry: false });
      expect(await probe.call("readAlarm", [])).toBeNull();
    } finally {
      for (const worker of workers.splice(0)) worker.terminate();
    }
  },
  30_000,
);
