/**
 * §2.4 — the storage value codec.
 *
 * Values use the same structured-clone-shaped surface as workerd; the bytes on
 * disk remain an implementation detail of each lane.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";
// `conformance:host` is aliased per lane and exports only that lane's `host`; the shared helper
// lives beside the interface it reads.

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

it("§2.4 rich values round-trip with their workerd types", async () => {
  const probe = await host.spawn("codec");
  expect(await probe.call("richValueRoundTrip")).toEqual({
    when: "Date",
    map: "Map",
    set: "Set",
    bytes: "ArrayBuffer",
    re: "RegExp",
    err: "Error",
  });
});
