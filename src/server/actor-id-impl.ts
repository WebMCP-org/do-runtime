/**
 * ← workerd `src/workerd/server/actor-id-impl.{h,c++}`
 *
 * The implementation behind `io/actor-id.ts`'s two interfaces, which that file's
 * header names as Section 6's problem: "upstream's is a keyed SHA-256
 * construction … a faithful port of it needs a synchronous digest, which the
 * browser does not expose."
 *
 * **What upstream computes.** The factory's key is `SHA256(uniqueKey)`, where
 * `uniqueKey` is the namespace's configured string (`workerd-api.c++:675`).
 * An id is 32 bytes in two halves: a 16-byte base and the first 16 bytes of
 * `HMAC-SHA256(key, base)` — `computeMac` (`actor-id-impl.c++:115-125`), which
 * writes a full 32-byte HMAC into a 48-byte working buffer of which only the
 * first 32 bytes ever become the id. `idFromName` derives the base from
 * `HMAC-SHA256(key, name)` (`:71-83`); `newUniqueId` draws it from the entropy
 * source (`:48-69`); `idFromString` takes it from the supplied hex and refuses
 * the string unless the MAC it recomputes matches the half that came with it
 * (`:85-100`). `toString` is `kj::encodeHex` of the 32 bytes.
 *
 * **The digest is written out; the bytes are unchanged.** Every method on
 * `ActorIdFactory` is synchronous (`io/actor-id.h:66-71`) and no browser API
 * offers a synchronous digest, so `server/sha256.ts` supplies SHA-256 and
 * HMAC-SHA-256 in place of BoringSSL. It computes what FIPS 180-4 and RFC 2104
 * specify, so this is decision 16's **substrate** divergence and not a semantic
 * one: `idFromName` here produces the identical 64 hex digits workerd produces
 * from the same unique key, which keeps workerd usable as an oracle for ids.
 *
 * That equality is why the construction is ported whole rather than narrowed.
 * The reduced threat model would have tolerated much less — ids never cross the
 * host boundary, there is no colo, no jurisdiction routing and no second worker
 * re-deriving an id from the same key, so nothing here forges an id — but only
 * two of the contract's properties are cheap to satisfy any other way. The other
 * two are not: `idFromName` must be **stable forever**, because the id names the
 * actor's storage and a name that hashed differently after a restart loses its
 * data; and `idFromString` must **refuse a string this namespace did not mint**,
 * which is a decision only the keyed MAC half can make. A narrower construction
 * would have satisfied both and cost the oracle, turning every future question
 * about an id into original research on a bespoke artifact — the failure the
 * "Porting philosophy" section describes.
 *
 * **`isPredictableModeForTest()` is absent** (`actor-id-impl.c++:59-62`). It is a
 * `util/thread-scopes.h` process-global test hack with no port here, it makes
 * `newUniqueId` return a counter, and `actor-id-impl-test.c++` does not use it.
 * Its body is also wrong upstream: `kj::arrayPtr(id).slice(counter)` slices by
 * the counter's *value*, which is a no-op for every counter it can legitimately
 * reach and out of bounds once the counter passes the buffer's 48 bytes.
 *
 * Spec: §1.10 in docs/decisions.md.
 */

import type { ActorId, ActorIdFactory } from "../io/actor-id";
import { hmacSha256, sha256, SHA256_DIGEST_LENGTH } from "./sha256";

// =======================================================================================
// Constants

/**
 * ← `JSG_REQUIRE(jurisdiction == kj::none, Error, …)` (`actor-id-impl.c++:50-51`,
 * `:108`).
 *
 * Verbatim, "in workerd" and all: the conformance suite runs one assertion
 * against both runtimes, so a reworded message would be a difference where there
 * is none.
 */
export const JURISDICTION_UNIMPLEMENTED_MESSAGE =
  "Jurisdiction restrictions are not implemented in workerd.";

/** ← the first `JSG_REQUIRE` in `idFromString` (`actor-id-impl.c++:87-89`). */
export const INVALID_ACTOR_ID_MESSAGE = "Invalid Durable Object ID: must be 64 hex digits";

/** ← the second `JSG_REQUIRE` in `idFromString` (`actor-id-impl.c++:96-97`). */
export const WRONG_NAMESPACE_ACTOR_ID_MESSAGE =
  "Durable Object ID is not valid for this namespace.";

/**
 * Upstream `kj::downcast`s the argument of `equals` (`actor-id-impl.c++:33`),
 * which asserts in a debug build and is undefined in a release one. There is one
 * `ActorId` implementation here, so a correct caller cannot reach this; it fails
 * closed rather than comparing something meaningless.
 */
export const FOREIGN_ACTOR_ID_MESSAGE =
  "This actor id was not created by this runtime, so it cannot be compared with one that was.";

/** ← `ActorIdFactoryImpl::BASE_LENGTH` — `SHA256_DIGEST_LENGTH / 2` (`actor-id-impl.h:44`). */
const BASE_LENGTH = SHA256_DIGEST_LENGTH / 2;

/**
 * The working buffer `newUniqueId`, `idFromName` and `idFromString` all build.
 * Upstream's comment (`actor-id-impl.c++:53-56`): "We want to randomly-generate
 * the first 16 bytes, then HMAC those to produce the latter 16 bytes. But the
 * HMAC will produce 32 bytes, so we're only taking a prefix of it. We'll allocate
 * a single array big enough to output the HMAC as a suffix, which will then get
 * truncated."
 */
const WORKING_LENGTH = BASE_LENGTH + SHA256_DIGEST_LENGTH;

/** What `kj::decodeHex` accepts, at the length the first `JSG_REQUIRE` demands. */
const ACTOR_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

const encoder = new TextEncoder();

// =======================================================================================
// ActorIdImpl

/** ← `ActorIdFactoryImpl::ActorIdImpl` (`actor-id-impl.h:13-30`). */
export class ActorIdImpl implements ActorId {
  readonly #id: Uint8Array;
  #name: string | undefined;

  /**
   * ← the constructor (`actor-id-impl.c++:14-18`). Its parameter is declared
   * `const kj::byte idParam[SHA256_DIGEST_LENGTH]` and its body `memcpy`s
   * exactly `sizeof(id)` bytes, so a caller may hand over the longer working
   * buffer and only its first 32 bytes become the id. The copy is upstream's
   * too — a later write to the caller's buffer is not seen here.
   */
  constructor(id: Uint8Array, name: string | undefined) {
    if (id.length < SHA256_DIGEST_LENGTH) {
      throw new Error(`an actor id is ${SHA256_DIGEST_LENGTH} bytes, and this buffer holds ${id.length}`);
    }
    this.#id = id.slice(0, SHA256_DIGEST_LENGTH);
    this.#name = name;
  }

  /** ← `toString()` — `kj::encodeHex`, which is lowercase (`actor-id-impl.c++:20-22`). */
  toString(): string {
    let out = "";
    for (const byte of this.#id) out += byte.toString(16).padStart(2, "0");
    return out;
  }

  /** ← `getName()` (`actor-id-impl.c++:24-26`). */
  getName(): string | undefined {
    return this.#name;
  }

  /** ← `getJurisdiction()`, which is unconditionally none (`actor-id-impl.c++:28-30`). */
  getJurisdiction(): string | undefined {
    return undefined;
  }

  /**
   * ← `equals()` (`actor-id-impl.c++:32-34`). The id bytes only — the name is
   * deliberately not part of identity, which is what upstream's own table
   * asserts by giving two equal ids different names.
   */
  equals(other: ActorId): boolean {
    if (!(other instanceof ActorIdImpl)) throw new Error(FOREIGN_ACTOR_ID_MESSAGE);
    const mine = this.#id;
    const theirs = other.#id;
    for (let i = 0; i < SHA256_DIGEST_LENGTH; i++) {
      if (mine[i] !== theirs[i]) return false;
    }
    return true;
  }

  /** ← `clearName()` (`actor-id-impl.h:23-25`). Not JS-visible; `server/` calls it. */
  clearName(): void {
    this.#name = undefined;
  }
}

// =======================================================================================
// ActorIdFactoryImpl

/** ← `ActorIdFactoryImpl` (`actor-id-impl.h:8-46`). */
export class ActorIdFactoryImpl implements ActorIdFactory {
  readonly #key: Uint8Array;

  /**
   * ← both constructors (`actor-id-impl.c++:40-46`). C++ overloads on the
   * parameter type; one constructor branching on it is the same two behaviours.
   * The string form is the namespace's configured `uniqueKey`
   * (`workerd-api.c++:675`, `:680`); the byte form exists for
   * `cloneWithJurisdiction`, which passes the already-derived key.
   */
  constructor(uniqueKey: string | Uint8Array) {
    if (typeof uniqueKey === "string") {
      this.#key = sha256(encoder.encode(uniqueKey));
      return;
    }
    if (uniqueKey.length !== SHA256_DIGEST_LENGTH) {
      throw new Error(`an actor id factory key is ${SHA256_DIGEST_LENGTH} bytes`);
    }
    this.#key = uniqueKey.slice();
  }

  /** ← `newUniqueId()` (`actor-id-impl.c++:48-69`). */
  newUniqueId(jurisdiction: string | undefined): ActorId {
    if (jurisdiction !== undefined) throw new Error(JURISDICTION_UNIMPLEMENTED_MESSAGE);

    const id = new Uint8Array(WORKING_LENGTH);
    // ← `getEntropy(kj::arrayPtr(id, BASE_LENGTH))` (`util/entropy.h`): "Fills
    // `output` with cryptographically-random bytes."
    crypto.getRandomValues(id.subarray(0, BASE_LENGTH));
    this.#computeMac(id);
    return new ActorIdImpl(id, undefined);
  }

  /** ← `idFromName()` (`actor-id-impl.c++:71-83`). */
  idFromName(name: string): ActorId {
    const id = new Uint8Array(WORKING_LENGTH);

    // Compute the first half of the ID by HMACing the name itself. We're using HMAC as a keyed
    // hash here, not actually for authentication, but it works.
    id.set(hmacSha256(this.#key, encoder.encode(name)));

    this.#computeMac(id);
    return new ActorIdImpl(id, name);
  }

  /** ← `idFromString()` (`actor-id-impl.c++:85-100`). */
  idFromString(str: string): ActorId {
    // Upstream's three conditions — 64 characters, `kj::decodeHex` reported no
    // errors, 32 bytes out — are one test here, because a 64-character match on
    // this pattern decodes to 32 bytes and cannot report an error.
    if (!ACTOR_ID_PATTERN.test(str)) throw new TypeError(INVALID_ACTOR_ID_MESSAGE);
    const decoded = new Uint8Array(SHA256_DIGEST_LENGTH);
    for (let i = 0; i < SHA256_DIGEST_LENGTH; i++) {
      decoded[i] = Number.parseInt(str.slice(i * 2, i * 2 + 2), 16);
    }

    const id = new Uint8Array(WORKING_LENGTH);
    id.set(decoded.subarray(0, BASE_LENGTH));
    this.#computeMac(id);

    // Verify that the computed mac matches the input.
    for (let i = 0; i < SHA256_DIGEST_LENGTH - BASE_LENGTH; i++) {
      if (id[BASE_LENGTH + i] !== decoded[BASE_LENGTH + i]) {
        throw new TypeError(WRONG_NAMESPACE_ACTOR_ID_MESSAGE);
      }
    }

    return new ActorIdImpl(id, undefined);
  }

  /** ← `cloneWithJurisdiction()` (`actor-id-impl.c++:102-109`). */
  cloneWithJurisdiction(maybeJurisdiction: string | undefined): ActorIdFactory {
    if (maybeJurisdiction === undefined) return new ActorIdFactoryImpl(this.#key);
    throw new Error(JURISDICTION_UNIMPLEMENTED_MESSAGE);
  }

  /** ← `matchesJurisdiction()`, which is unconditionally true (`actor-id-impl.c++:111-113`). */
  matchesJurisdiction(_id: ActorId): boolean {
    return true;
  }

  /**
   * ← `computeMac()` (`actor-id-impl.c++:115-125`). "Given that the first
   * `BASE_LENGTH` bytes of `id` are filled in, compute the second half of the ID
   * by HMACing the first half. The id must be in a buffer large enough to store
   * the first half of the ID plus a full HMAC, even though only a prefix of the
   * HMAC becomes part of the final ID."
   */
  #computeMac(id: Uint8Array): void {
    id.set(hmacSha256(this.#key, id.subarray(0, BASE_LENGTH)), BASE_LENGTH);
  }
}
