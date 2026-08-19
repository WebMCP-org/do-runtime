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
});

it("§1.5 a nested blockConcurrencyWhile nests rather than deadlocking", async () => {
  const probe = await host.spawn("cs-nested");
  expect(await probe.call("nestedBlockConcurrency")).toBe("nested-ok");
});
