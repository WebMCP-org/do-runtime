/**
 * The namespace's one `AlarmScheduler`, in a worker of its own.
 *
 * **Why a worker at all, and why exactly one.** The scheduler keeps `_cf_ALARM`
 * in a database (upstream's `metadata.sqlite`, one per namespace beside the
 * per-actor files, `server.c++:2336-2346`), and a database on this substrate
 * needs OPFS sync access handles, which exist only in a dedicated worker. So it
 * cannot live on the page. And it is per-NAMESPACE rather than per-actor —
 * upstream builds one and gives each actor a three-line hooks adapter over it
 * (`server.c++:2325-2350`, `:3199-3219`) — so it cannot live in an actor's
 * worker either, since this lane places one actor TREE per worker. A worker of its own
 * is what is left, and it is also what the shape means: the scheduler is the
 * namespace, and the actors are its members.
 *
 * **`getActor` reaches an actor it may have to place first**, which is upstream's
 * `getActorContainer(id)`: an alarm is a reason to wake a Durable Object, not
 * something that requires one to be awake already. Here that means a call back to
 * the page, which owns the registry and the worker for each actor. Two hops
 * rather than the node lane's function call, and both are ordinary capnweb.
 *
 * The scheduler is the runtime's own class, not the lane's. What the lane
 * supplies is the database, the timer, and the function that resolves an actor id
 * to something with `deliverAlarm`/`abandonAlarm`.
 */

import { AlarmScheduler, newRpcSession } from "../../src/index";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import type { AlarmsBoot, AlarmsRpc, SupervisorRpc } from "./protocol";
import { installPool, LaneStorage, timer } from "./substrate";

type Session<T> = ReturnType<typeof newRpcSession<T>>;

let scheduler: Promise<AlarmScheduler> | undefined;
let supervisor: Session<SupervisorRpc> | undefined;
let reportedFailure = false;

class AlarmsTarget extends RpcTarget implements AlarmsRpc {
  /** ← `ActorSqliteHooks::scheduleRun`, arriving from the actor's own worker via the page. */
  async scheduleRun(actorName: string, scheduledTime: number | null): Promise<void> {
    if (scheduler === undefined) throw new Error("Browser lane: the alarm scheduler is not up.");
    const live = await scheduler;
    // `void`, and it discards nothing: this `scheduleRun` does its work synchronously and
    // returns an already-resolved promise, exactly as upstream's does.
    void live.hooks(actorName).scheduleRun(scheduledTime, Promise.resolve());

    // ← `taskFailure()`, which is where this package keeps what upstream logs. A background
    // failure that is neither logged nor read is one nothing can notice, and on this lane nothing
    // else would.
    //
    // **Reported, not thrown, and an earlier version of this did throw.** The field is
    // namespace-wide and sticky, while this method is the head of ONE actor's commit path:
    // `alarmOutlet` → `ActorSqlite.#requestScheduledAlarm` → the `await
    // precommitAlarmState.schedulingPromise` inside the commit. Throwing here therefore fails
    // whichever actor happens to be committing next, which is not the actor whose task failed —
    // not fail-closed but a wrong diagnosis attached to an innocent row. Reported once, because
    // the field is sticky and a stale failure repeated on every later commit is noise.
    const failure = live.taskFailure();
    if (failure !== undefined && !reportedFailure) {
      reportedFailure = true;
      void requireSupervisor().report(`alarm scheduler background task failed: ${String(failure)}`);
    }
  }
}

function requireSupervisor(): Session<SupervisorRpc> {
  if (supervisor === undefined) throw new Error("Browser lane: the alarm worker has no session.");
  return supervisor;
}

self.addEventListener("message", (event: MessageEvent<AlarmsBoot>) => {
  const boot = event.data;
  supervisor = newRpcSession<SupervisorRpc>(boot.port, new AlarmsTarget());
  scheduler = (async (): Promise<AlarmScheduler> => {
    const storage = new LaneStorage(await installPool(boot.poolName), "/namespace");
    return new AlarmScheduler({
      timer,
      db: await storage.open("alarms"),
      getActor: (actorId) => ({
        deliverAlarm: async (scheduledTime, retryCount) =>
          await requireSupervisor().deliverAlarm(actorId, scheduledTime, retryCount),
        abandonAlarm: async (scheduledTime) =>
          await requireSupervisor().abandonAlarm(actorId, scheduledTime),
      }),
    });
  })();
});
