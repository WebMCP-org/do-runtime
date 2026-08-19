/**
 * ← workerd `src/workerd/server/actor-id-impl-test.c++`, both `KJ_TEST`s.
 *
 * `computeProperTestMac` is upstream's own helper (`:58-73`), which builds a
 * valid id for a namespace by hand so `idFromString` has something to accept.
 * Ours does not recompute it — it asserts the value `node:crypto` produces for
 * the same construction, which is the point of writing the digest out: the bytes
 * are BoringSSL's bytes, so these are the hex strings workerd itself would mint.
 * An implementation that re-derived them would be checking itself.
 */

import { describe, expect, test } from "vitest";
import {
  ActorIdFactoryImpl,
  ActorIdImpl,
  FOREIGN_ACTOR_ID_MESSAGE,
  INVALID_ACTOR_ID_MESSAGE,
  JURISDICTION_UNIMPLEMENTED_MESSAGE,
  WRONG_NAMESPACE_ACTOR_ID_MESSAGE,
} from "./actor-id-impl";

/** ← `constexpr kj::byte zero32[SHA256_DIGEST_LENGTH]`, generalised to any fill. */
function filled(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

const deadbeef64 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/**
 * ← `computeProperTestMac(strId, strKey)`, precomputed. Each value is
 * `strId[0..16]` followed by the first 16 bytes of
 * `HMAC-SHA256(SHA256(strKey), strId[0..16])`.
 */
const PROPER_MAC = {
  "deadbeef64/deadbeef64": "deadbeefdeadbeefdeadbeefdeadbeefc335032d41fad7e866a20ac74f98d442",
  "deadbeef64/hello": "deadbeefdeadbeefdeadbeefdeadbeef4856b1497cddde6d4034fb93c3660ed9",
} as const;

describe("ActorIdImpl equals test", () => {
  // ← the `Test testCases[]` table (`actor-id-impl-test.c++:44-51`). The names
  // are present precisely to show that they are not compared.
  test.each([
    [0, undefined, 0, undefined, true],
    [0, undefined, 1, undefined, false],
    [0, "hello", 0, "goodbye", true],
    [0, "hello", 1, "goodbye", false],
    [0, "hello", 0, undefined, true],
    [0, "hello", 1, undefined, false],
  ])(
    "fill %i/%s equals fill %i/%s is %s",
    (leftFill, leftName, rightFill, rightName, expected) => {
      const left = new ActorIdImpl(filled(leftFill), leftName);
      const right = new ActorIdImpl(filled(rightFill), rightName);
      expect(left.equals(right)).toBe(expected);
    },
  );
});

describe("ActorIdImplFactory idFromString test", () => {
  // ← the `Test testCases[]` table (`actor-id-impl-test.c++:93-98`).
  test("a random string of the wrong length", () => {
    const factory = new ActorIdFactoryImpl("hello");
    expect(() => factory.idFromString("goodbye")).toThrow(INVALID_ACTOR_ID_MESSAGE);
  });

  test("gets past the first assert", () => {
    const factory = new ActorIdFactoryImpl("hello");
    expect(() => factory.idFromString(deadbeef64)).toThrow(WRONG_NAMESPACE_ACTOR_ID_MESSAGE);
  });

  test("gets past the second assert", () => {
    const factory = new ActorIdFactoryImpl(deadbeef64);
    const result = factory.idFromString(PROPER_MAC["deadbeef64/deadbeef64"]);
    expect(result.getName()).toBeUndefined();
  });
});

describe("ActorIdFactoryImpl", () => {
  test("idFromName is the same 64 hex digits workerd would mint", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");

    // Computed by node:crypto over the construction actor-id-impl.c++ performs,
    // which is BoringSSL's. If these drift, ids minted here have stopped naming
    // the same actors workerd names — which is the whole point of porting the
    // real digest rather than a cheaper keyed function.
    expect(factory.idFromName("counter").toString()).toBe(
      "b92a1de9591d59293d9f4c2bbec2e937af40891a4e8edcb2965e00f251616881",
    );
    expect(factory.idFromName("").toString()).toBe(
      "b9724b681bce7a32c115e2a48e41945c9f779d558c7c9af0aa2acb3959ba450f",
    );
    // A name is hashed as UTF-8, as a kj::String already is.
    expect(factory.idFromName("é").toString()).toBe(
      "fc6e83b56d54c23f18bca1a3e3c4a0d4c826b5d4aa2a33b4c84b9de75b8de332",
    );
  });

  test("idFromName is stable across factories and keyed by the unique key", () => {
    // Stability is the load-bearing property: the id names the actor's storage,
    // so a name that hashed differently after a restart would lose its data.
    expect(new ActorIdFactoryImpl("test-unique-key").idFromName("counter").toString()).toBe(
      new ActorIdFactoryImpl("test-unique-key").idFromName("counter").toString(),
    );
    expect(new ActorIdFactoryImpl("other-unique-key").idFromName("counter").toString()).toBe(
      "a28202520767cc87e4299b3a9d82b06ca8cf03b81f4c3bb0a5697fb254608a95",
    );
  });

  test("idFromName keeps the name; every other route has none", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");
    expect(factory.idFromName("counter").getName()).toBe("counter");
    expect(factory.newUniqueId(undefined).getName()).toBeUndefined();
    expect(factory.idFromString(factory.idFromName("counter").toString()).getName()).toBeUndefined();
  });

  test("an id round-trips through idFromString and compares equal", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");

    for (const id of [factory.idFromName("counter"), factory.newUniqueId(undefined)]) {
      const restored = factory.idFromString(id.toString());
      expect(restored.toString()).toBe(id.toString());
      expect(restored.equals(id)).toBe(true);
      expect(id.equals(restored)).toBe(true);
    }
  });

  test("an id from another namespace is refused", () => {
    // The MAC half is what makes this answerable at all, and it is the reason
    // the keyed construction is kept even though nothing here forges ids.
    const mine = new ActorIdFactoryImpl("test-unique-key");
    const theirs = new ActorIdFactoryImpl("other-unique-key");

    const id = theirs.idFromName("counter").toString();
    expect(() => mine.idFromString(id)).toThrow(WRONG_NAMESPACE_ACTOR_ID_MESSAGE);
    expect(mine.idFromString(mine.idFromName("counter").toString()).toString()).toBe(
      mine.idFromName("counter").toString(),
    );

    // Same first half, different namespace: only the MAC half can tell them
    // apart, so this is the case a length check alone would let through.
    expect(() => new ActorIdFactoryImpl("hello").idFromString(deadbeef64)).toThrow(
      WRONG_NAMESPACE_ACTOR_ID_MESSAGE,
    );
    expect(
      new ActorIdFactoryImpl("hello").idFromString(PROPER_MAC["deadbeef64/hello"]).toString(),
    ).toBe(PROPER_MAC["deadbeef64/hello"]);
  });

  test("a single flipped byte anywhere in the id is refused", () => {
    // The MAC half is 16 bytes and upstream compares all of them
    // (`actor-id-impl.c++:96`). Checking fewer would leave a namespace boundary
    // an attacker-free system still relies on for "did this id come from here".
    const factory = new ActorIdFactoryImpl("test-unique-key");
    const valid = factory.idFromName("counter").toString();

    for (let byte = 0; byte < 32; byte++) {
      const offset = byte * 2;
      const flipped =
        valid.slice(0, offset) +
        (Number.parseInt(valid.slice(offset, offset + 2), 16) ^ 0xff).toString(16).padStart(2, "0") +
        valid.slice(offset + 2);

      expect(flipped).not.toBe(valid);
      // A flip in the first 16 bytes changes the base the MAC is recomputed
      // over; a flip in the last 16 changes the MAC it is compared against.
      expect(() => factory.idFromString(flipped)).toThrow(WRONG_NAMESPACE_ACTOR_ID_MESSAGE);
    }
  });

  test("the key is copied, so a later write to the caller's buffer is not seen", () => {
    // ← `memcpy(key, keyParam, sizeof(key))` (`actor-id-impl.c++:45`).
    const key = new Uint8Array(32).fill(0xab);
    const factory = new ActorIdFactoryImpl(key);
    const before = factory.idFromName("counter").toString();

    key.fill(0x00);
    expect(factory.idFromName("counter").toString()).toBe(before);
  });

  test.each([
    ["the empty string", ""],
    ["63 hex digits", deadbeef64.slice(1)],
    ["65 hex digits", `${deadbeef64}0`],
    ["64 characters, one of them not hex", `${deadbeef64.slice(0, 63)}z`],
    ["64 characters with a space", `${deadbeef64.slice(0, 63)} `],
    ["the hex of a 32-byte value with a 0x prefix", `0x${deadbeef64.slice(2)}`],
  ])("idFromString refuses %s", (_label, value) => {
    expect(() => new ActorIdFactoryImpl("test-unique-key").idFromString(value)).toThrow(
      INVALID_ACTOR_ID_MESSAGE,
    );
  });

  test("idFromString accepts uppercase hex, and answers in lowercase", () => {
    // `kj::decodeHex` is case-insensitive, so upstream accepts this; `toString`
    // is `kj::encodeHex`, which is lowercase only. This is the one behaviour in
    // this file not pinned against a running workerd — kj is a Bazel external
    // and is not in the vendored checkout — so treat a disagreement here as an
    // open question rather than a porting error.
    const factory = new ActorIdFactoryImpl("test-unique-key");
    const lower = factory.idFromName("counter").toString();
    expect(factory.idFromString(lower.toUpperCase()).toString()).toBe(lower);
  });

  test("newUniqueId is unpredictable and carries its own MAC", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");
    const ids = new Set(Array.from({ length: 32 }, () => factory.newUniqueId(undefined).toString()));

    expect(ids.size).toBe(32);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      // Minted ids validate in the namespace that minted them, which is what
      // says newUniqueId and idFromString compute the same MAC.
      expect(factory.idFromString(id).toString()).toBe(id);
    }
  });

  test("a jurisdiction is refused wherever it can be named", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");

    expect(() => factory.newUniqueId("eu")).toThrow(JURISDICTION_UNIMPLEMENTED_MESSAGE);
    expect(() => factory.cloneWithJurisdiction("eu")).toThrow(JURISDICTION_UNIMPLEMENTED_MESSAGE);

    // And every id reports none, whichever route made it.
    expect(factory.idFromName("counter").getJurisdiction()).toBeUndefined();
    expect(factory.newUniqueId(undefined).getJurisdiction()).toBeUndefined();
    expect(factory.matchesJurisdiction(factory.idFromName("counter"))).toBe(true);
  });

  test("cloneWithJurisdiction(none) keeps the key", () => {
    const factory = new ActorIdFactoryImpl("test-unique-key");
    const clone = factory.cloneWithJurisdiction(undefined);

    expect(clone).not.toBe(factory);
    expect(clone.idFromName("counter").toString()).toBe(factory.idFromName("counter").toString());
    // Which is the whole of what "keeps the key" means: the clone accepts the
    // original's ids.
    expect(clone.idFromString(factory.idFromName("counter").toString()).toString()).toBe(
      factory.idFromName("counter").toString(),
    );
  });
});

describe("ActorIdImpl", () => {
  test("toString is 64 lowercase hex digits, low bytes padded", () => {
    const id = new ActorIdImpl(new Uint8Array([0x00, 0x0f, 0xa0, 0xff, ...new Uint8Array(28)]), undefined);
    expect(id.toString()).toBe(`000fa0ff${"00".repeat(28)}`);
  });

  test("only the first 32 bytes of the working buffer become the id", () => {
    // The factory hands over a 48-byte buffer — 16 bytes of base plus a whole
    // 32-byte HMAC — and upstream's constructor memcpy's exactly 32 of them
    // (`actor-id-impl.c++:14-18`), so the last 16 bytes of the HMAC are dropped.
    const working = new Uint8Array(48).fill(0xab);
    working.fill(0xcd, 32);
    expect(new ActorIdImpl(working, undefined).toString()).toBe("ab".repeat(32));
  });

  test("equals compares every byte, not just the first", () => {
    // Upstream's table only ever fills an id with one repeated byte, so a
    // comparison that stopped after the first byte would pass all six of its
    // cases.
    const left = new Uint8Array(32).fill(9);
    const right = new Uint8Array(32).fill(9);
    right[31] = 8;

    expect(new ActorIdImpl(left, undefined).equals(new ActorIdImpl(right, undefined))).toBe(false);
    right[31] = 9;
    expect(new ActorIdImpl(left, undefined).equals(new ActorIdImpl(right, undefined))).toBe(true);
  });

  test("a buffer shorter than the digest is refused", () => {
    expect(() => new ActorIdImpl(new Uint8Array(31), undefined)).toThrow();
  });

  test("the id is copied, so a later write to the caller's buffer is not seen", () => {
    const working = new Uint8Array(48).fill(0xab);
    const id = new ActorIdImpl(working, undefined);
    working.fill(0x00);
    expect(id.toString()).toBe("ab".repeat(32));
  });

  test("clearName drops the name and leaves the id alone", () => {
    // ← `ActorIdImpl::clearName()` (`actor-id-impl.h:23-25`).
    const id = new ActorIdImpl(filled(7), "counter");
    expect(id.getName()).toBe("counter");
    id.clearName();
    expect(id.getName()).toBeUndefined();
    expect(id.toString()).toBe("07".repeat(32));
  });

  test("equals refuses an id this factory did not make", () => {
    // Upstream `kj::downcast`s, which asserts in a debug build and is undefined
    // in a release one. There is one implementation here, so this is
    // unreachable from a correct caller; it fails closed rather than comparing
    // something meaningless.
    const foreign = {
      toString: () => "0".repeat(64),
      getName: () => undefined,
      getJurisdiction: () => undefined,
      equals: () => true,
    };
    expect(() => new ActorIdImpl(filled(0), undefined).equals(foreign)).toThrow(
      FOREIGN_ACTOR_ID_MESSAGE,
    );
  });
});
