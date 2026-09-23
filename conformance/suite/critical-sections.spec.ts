/**
 * §1.5 — blockConcurrencyWhile is a real CriticalSection.
 *
 * Our shim serialises only against itself and blocks no events, so every row
 * here is a behaviour change the cutover introduces on purpose.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

it("§1.5 blockConcurrencyWhile blocks a concurrent event", async () => {
  const probe = await host.spawn("cs-blocks");
  const blocking = probe.post("blockConcurrency");
  const other = probe.post("setFlag");
  await other.settled;
  expect(await blocking.settled).toBe("A");
  // The two posts are separate requests on the workerd lane, so `setFlag` may land first; what
  // must never happen is `setFlag` running between the section's entry and its exit.
  expect([
    ["section:enter", "section:exit", "setFlag"],
    ["setFlag", "section:enter", "section:exit"],
  ]).toContainEqual(await probe.call("readTrace"));
});

it("§1.5 a throwing blockConcurrencyWhile rejects its caller and resets the object over committed storage", async () => {
  const probe = await host.spawn("cs-throws");
  // The message only: the name differs by lane (`BrokenActorError` on this runtime, documented).
  // Settled with both handlers because `expect().rejects` leaves workerd's reset RPC unhandled.
  const call = await probe.call("failSection").then(
    (value) => `fulfilled: ${String(value)}`,
    (error: unknown) => String(error),
  );
  expect(call).toContain("conformance: section failed");
  // By identity, as a later event would: workerd breaks the old stub, and `respawn` would replace
  // the instance itself on the other lanes, hiding a runtime that never reset it.
  const after = await host.spawn(probe.name);
  expect(await after.call("readSectionFailure")).toEqual({ marker: "init", before: 1, inside: null });
});

it("§1.5 a nested blockConcurrencyWhile nests rather than deadlocking", async () => {
  const probe = await host.spawn("cs-nested");
  expect(await probe.call("nestedBlockConcurrency")).toBe("nested-ok");
});
