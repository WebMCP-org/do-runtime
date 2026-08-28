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

it("§2.4 put() reads what jsg::Dict refuses as a coerced key, not as empty entries", async () => {
  // The overloads are `kj::OneOf<kj::String, jsg::Dict<...>>`: a plain object is entries, an
  // Array is refused by Dict and falls to the string alternative, and every primitive is a key
  // that JSG stringifies. Reading a primitive as entries instead makes `Object.entries` return
  // `[]`, so the call resolves having written nothing — a silently dropped write. The second
  // argument after an entries object is the all-optional options STRUCT, which `null` unwraps
  // to; only a non-null primitive there is the overload error.
  const probe = await host.spawn("put-key-coercion");
  expect(await probe.call("putKeyCoercion")).toEqual({
    keys: ["10", "123", "a,1", "null", "nulled", "true", "undefined"],
    symbol: "Cannot convert a Symbol value to a string",
    overload:
      "put() may only be called with a single key-value pair and optional options as " +
      "put(key, value, options) or with multiple key-value pairs and optional options as " +
      "put(entries, options)",
  });
});
