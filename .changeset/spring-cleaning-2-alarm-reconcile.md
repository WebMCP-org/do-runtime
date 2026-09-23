---
"@mcp-b/do-runtime": minor
---

A root container now repairs, when it is next placed, an alarm its scheduler lost. An alarm outlet
that reaches its scheduler over RPC cannot fail before the actor's local commit, so a failed
request, or a worker killed at the wrong moment, could leave an alarm stored in the actor that
never fires. The new optional `AlarmOutlet.reconcile(stored)` hook fixes this: `createActorContainer`
calls it once, before construction, with the alarm the actor stored, and a rejection fails creation.
Until the actor is placed again, a lost alarm that was its only wake source stays dormant, so a
host that wants a prompt repair re-places a root whose container broke on a failed commit.

`AlarmScheduler.hooks(id)` implements it, now typed `Required<AlarmOutlet>`: it sets the alarm only
when the scheduler has none for the actor, or has a later one. Opening a container therefore never
resets the ladder of, or queues a second delivery for, an alarm the scheduler already holds at or
before the stored time. Alarms stay at-least-once: an alarm whose success was reported but whose
deletion never committed runs again. Hosts that forward `scheduleRun` to a scheduler in another
worker should forward `AlarmOutlet.reconcile` the same way and drop any re-push of `getAlarm()`
after placement. That re-push reset the retry ladder and redelivered a failing alarm immediately,
at retry count 0, on every alarm-triggered placement.
