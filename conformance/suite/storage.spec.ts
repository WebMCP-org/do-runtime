/**
 * §2.4 — the storage value codec.
 *
 * The only row in the suite that asserts a deliberate SEMANTIC divergence rather
 * than a translation. Everything else here says "workerd does X and so do we";
 * this one says "workerd does X, we refuse it, and here is the message". It is
 * asserted rather than omitted for the same reason the substrate boundaries are:
 * a divergence the suite is silent about is one that gets rediscovered later as a
 * bug, by someone reading the same design record that says values are JSON.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";
// `conformance:host` is aliased per lane and exports only that lane's `host`; the shared helper
// lives beside the interface it reads.
import { substrate } from "../host";

it("§2.4 synchronous KV shares values and ordering with async storage", async () => {
  const probe = await host.spawn("sync-kv");
  expect(await probe.call("syncKvInterop")).toEqual({
    asyncRead: { from: "sync" },
    syncRead: { from: "async" },
    listed: ["ordered:a", "ordered:b"],
    deleted: true,
    missing: "undefined",
  });
});

it("§2.4 deleteAll removes ordinary values and the stored alarm", async () => {
  const probe = await host.spawn("delete-all");
  expect(await probe.call("deleteAllState")).toEqual({ value: null, alarm: null });
});

it("§2.4 workerd round-trips rich values; this runtime refuses them (decision 16)", async () => {
  await substrate(host, "v8-value-codec", {
    native: async () => {
      const probe = await host.spawn("codec-native");
      expect(await probe.call("richValueRoundTrip")).toEqual({
        when: "Date",
        map: "Map",
        set: "Set",
        bytes: "ArrayBuffer",
        re: "RegExp",
        err: "Error",
      });
    },
    absent: async () => {
      const probe = await host.spawn("codec-absent");
      // Refused at the write, naming the key and the type — not returned wrong.
      await expect(probe.call("richValueRoundTrip")).rejects.toThrow(
        "Durable Object storage cannot round-trip a Date",
      );
    },
  });
});
