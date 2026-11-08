/**
 * §1.2 — detached promise reactions run inside the actor.
 *
 * workerd runs every reaction inside the IoContext that drains it, so a
 * `.then(...)` registered by an event and left unawaited can touch storage
 * after that event returned. The reading request is a separate event; what it
 * sees shows where the gate opened.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

it("§1.2 a detached reaction chain on storage promises runs before the next event", async () => {
  const probe = await host.spawn("reaction-storage");
  const first = probe.post("detachedStorageReaction");
  const read = probe.post("readReactions", ["r1", "r2", "r3"]);
  expect(await first.settled).toBe("returned");
  expect(await read.settled).toEqual({ values: ["a", "b", "c"], errors: [] });
});

it("§1.2 a detached reaction that awaits a timer releases the gate and resumes gated", async () => {
  const probe = await host.spawn("reaction-timer");
  const first = probe.post("detachedTimerReaction");
  const read = probe.post("readReactions", ["t1", "t2"]);
  await first.settled;
  expect(await read.settled).toEqual({ values: ["a", null], errors: [] });
  await settle();
  expect(await probe.call("readReactions", ["t1", "t2"])).toEqual({ values: ["a", "b"], errors: [] });
});

it("§1.2 a reaction on a setTimeout promise runs gated", async () => {
  const probe = await host.spawn("reaction-set-timeout");
  await probe.call("detachedSetTimeoutReaction");
  await settle();
  expect(await probe.call("readReactions", ["s1"])).toEqual({ values: ["a"], errors: [] });
});

it("§1.2 catch and finally reactions on a rejected promise run before the next event", async () => {
  const probe = await host.spawn("reaction-rejection");
  const first = probe.post("detachedRejectionReaction");
  const read = probe.post("readReactions", ["j1", "j2"]);
  await first.settled;
  expect(await read.settled).toEqual({ values: ["a", "b"], errors: [] });
});

it("§1.2 a reaction registered by one event and resolved by another runs in the resolving event", async () => {
  const probe = await host.spawn("reaction-deferred");
  await probe.call("armDeferredReaction");
  const fire = probe.post("fireDeferredReaction", "v");
  const read = probe.post("readReactions", ["d1", "d2"]);
  await fire.settled;
  expect(await read.settled).toEqual({ values: ["v", null], errors: [] });
  await settle();
  expect(await probe.call("readReactions", ["d1", "d2"])).toEqual({ values: ["v", "v"], errors: [] });
});
