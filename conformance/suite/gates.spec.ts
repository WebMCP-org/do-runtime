/**
 * §1.2, §1.3 — where the input gate releases, and where it does not.
 *
 * Each title carries its design-record section so the suite stays navigable as
 * the second oracle the porting philosophy promises.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

it("harness: a posted event preserves its rejection", async () => {
  const probe = await host.spawn("post-rejection");
  const outcome = await probe.post("failPostedEvent").settled.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );

  expect(outcome.status).toBe("rejected");
  if (outcome.status === "rejected") {
    expect(String(outcome.error)).toContain("conformance: posted event failed");
  }
});

it("§1.2 an outbound facet RPC releases the input gate", async () => {
  const probe = await host.spawn("gate-facet");
  const slow = probe.post("gateViaFacet");
  const fast = probe.post("setMarker");
  await fast.settled;
  expect(await slow.settled).toBe("B");
  expect(await probe.call("readTrace")).toEqual(["facet:enter", "setMarker", "facet:exit"]);
});

it("§1.2 a bare timer releases the input gate", async () => {
  const probe = await host.spawn("gate-timer");
  const slow = probe.post("gateViaTimer");
  const fast = probe.post("setMarker");
  await fast.settled;
  expect(await slow.settled).toBe("B");
});

it("§1.2 fetch releases the input gate and its continuations resume gated", async () => {
  const probe = await host.spawn("gate-fetch");
  const slow = probe.post("gateViaFetch");
  const fast = probe.post("setMarker");
  await fast.settled;
  expect(await slow.settled).toEqual({ marker: "B", status: 200, body: "fetched" });
  expect(await probe.call("readTrace")).toEqual(["fetch:enter", "setMarker", "fetch:exit"]);
});

it("§1.2 a local storage await HOLDS the input gate", async () => {
  // The asymmetry that shrinks the whole hazard surface: most awaits in agent
  // code are storage, and none of them is an interleaving point.
  const probe = await host.spawn("gate-storage");
  const slow = probe.post("gateViaStorage");
  const fast = probe.post("setMarker");
  await fast.settled;
  expect(await slow.settled).toBe("A");
});

/**
 * §1.2 — the host-provided async primitives, one row each.
 *
 * Upstream every one of these is an io-context primitive, so the property is
 * structural there and these rows are free. Here each primitive has to gate
 * itself: a continuation that resumes from a promise the runtime does not own
 * comes back with an empty invocation stack and its next `ctx.storage` call
 * throws `no input lock available in this context`.
 */
it("§1.2 a continuation after scheduler.wait can still touch storage", async () => {
  const probe = await host.spawn("gate-after-wait");
  expect(await probe.call("storageAfterSchedulerWait")).toBe("ok");
});

/**
 * The row that found the gap, and the one that decides how many more there are.
 *
 * `crypto.subtle` is an `IoContext` promise upstream like everything else, so
 * workerd answers this without being asked. It is here because `globalThis.crypto`
 * is the PLATFORM's in a Web Worker unless the actor's scope replaces it, and the
 * vendored `agents` package hashes inside a method that then writes — so until the
 * scope covered it, every routine mutation in the product threw at its own
 * `setState`, three frames below the await that lost the lock.
 */
it("§1.2 a continuation after crypto.subtle.digest can still touch storage", async () => {
  const probe = await host.spawn("gate-after-digest");
  expect(await probe.call("storageAfterDigest")).toBe("32");
});

it("§1.2 a setTimeout callback runs gated and can touch storage", async () => {
  const probe = await host.spawn("gate-timer-callback");
  expect(await probe.call("armTimer")).toBe("armed");

  const deadline = Date.now() + 5_000;
  let mark = "MISSING";
  while (mark === "MISSING" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    mark = await probe.call("readTimerMark");
  }
  expect(mark).toBe("written-from-timer");
});

/**
 * The critical section travels with the timer, captured at the call
 * (`io-context.c++:759`). A timer armed inside `blockConcurrencyWhile` runs
 * inside that section rather than queueing behind it on the root gate.
 */
it("§1.5 a setTimeout armed inside blockConcurrencyWhile runs inside that section", async () => {
  const probe = await host.spawn("gate-timer-cs");
  expect(await probe.call("timerInsideCriticalSection")).toEqual(["timer", "section-end"]);
});

it("§1.2 setInterval repeats under the gate and clearInterval stops it", async () => {
  const probe = await host.spawn("gate-interval");
  expect(await probe.call("armInterval")).toBe("armed");

  const deadline = Date.now() + 5_000;
  let ticks = 0;
  while (ticks < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    ticks = await probe.call("readTicks");
  }
  expect(ticks).toBe(3);

  // Cleared from inside the third tick, so no fourth arrives.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await probe.call("readTicks")).toBe(3);
});

it("§1.1 the output gate holds a reply until an un-awaited put confirms", async () => {
  const probe = await host.spawn("out-gate");
  expect(await probe.call("unawaitedPut")).toBe("returned-without-await");
  expect(await probe.call("readUnawaited")).toBe("landed");
});
