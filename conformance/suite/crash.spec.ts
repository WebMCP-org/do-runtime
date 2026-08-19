/**
 * §1.6 — a real crash discards the running instance, not its committed storage.
 *
 * Workerd is the oracle for shared runtime semantics, but its test host cannot
 * kill an object from outside the isolate. The capability's absent arm pins
 * that boundary; Node and the browser drive the same observable crash/reopen
 * contract through their host implementations.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";
import { substrate } from "../host";

it("§1.6 a real crash drops volatile instance state and preserves committed storage", async () => {
  await substrate(host, "real-crash", {
    native: async () => {
      if (host.crash === undefined) {
        throw new Error('The host declares "real-crash" without implementing crash().');
      }

      const probe = await host.spawn("crash-reopen");
      expect(await probe.call("unawaitedPut")).toBe("returned-without-await");
      expect(await probe.call("setMarker")).toBe("set");
      expect(await probe.call("readTrace")).toEqual(["setMarker"]);

      await host.crash(probe);

      // The next event must reopen the crashed identity on demand. Calling
      // respawn() here would mask a no-op crash by resetting it for the test.
      expect(await probe.call("readUnawaited")).toBe("landed");
      expect(await probe.call("readTrace")).toEqual([]);
    },
    absent: async () => {
      expect(host.crash).toBeUndefined();
    },
  });
});
