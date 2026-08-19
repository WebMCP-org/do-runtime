/**
 * ← workerd `NO upstream correspondence`
 *
 * The substrate replacement for the two includes `server/actor-id-impl.{h,c++}`
 * makes — `<openssl/sha.h>` and `<openssl/hmac.h>` — and nothing else. Only
 * `actor-id-impl.ts` consumes it, which is why it sits here rather than in
 * `util/`: `src/util/` corresponds 1:1 to `src/workerd/util/`, and workerd has no
 * digest there. `server/facet-deletion.ts` sets the precedent for a file in this
 * directory with no upstream twin.
 *
 * **Why this exists at all.** Every method on `ActorIdFactory` is synchronous
 * (`io/actor-id.h:66-71`), and the browser exposes no synchronous digest:
 * `crypto.subtle.digest` returns a promise, and `node:crypto` is one lane only.
 * So the algorithm is written out. It is a **substrate** divergence in decision
 * 16's sense and not a semantic one — the bytes are the bytes FIPS 180-4 and RFC
 * 2104 specify, which is exactly what BoringSSL computes, so an id minted here is
 * the same 64 hex digits workerd mints from the same unique key. That equality is
 * the whole reason for writing the real digest rather than a cheaper keyed
 * function the reduced threat model would have tolerated: it keeps workerd
 * available as an oracle for ids, where an invented construction would have made
 * every future id question original research.
 *
 * No dependency was added. Nothing in the workspace ships a synchronous SHA-256,
 * and the catalog's `crypto-browserify` is a CommonJS bundler shim for the
 * extension that would not typecheck under this package's `WebWorker`-only lib.
 */

/** ← `SHA256_DIGEST_LENGTH`. */
export const SHA256_DIGEST_LENGTH = 32;

/** SHA-256's block size, and therefore HMAC's — RFC 2104's `B`. */
const BLOCK_LENGTH = 64;

/** FIPS 180-4 §4.2.2: the first 32 bits of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** FIPS 180-4 §5.3.3: the first 32 bits of the square roots of the first 8 primes. */
// prettier-ignore
const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * `noUncheckedIndexedAccess` types every element read as possibly undefined.
 * Every index below is in range by construction, and this package does not
 * substitute a value for one that should not be missing.
 */
function at(array: Uint8Array | Uint32Array, index: number): number {
  const value = array[index];
  if (value === undefined) throw new Error(`sha256: index ${index} is outside its array`);
  return value;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** ← `SHA256(data, length, out)`. FIPS 180-4 §6.2. */
export function sha256(message: Uint8Array): Uint8Array {
  // §5.1.1: append 0x80, then zeroes, then the 64-bit big-endian bit length,
  // padding to a whole number of blocks. The +9 is that one byte plus the eight
  // the length occupies, which is why a 56-byte message needs a second block.
  const paddedLength = (Math.ceil((message.length + 9) / BLOCK_LENGTH) | 0) * BLOCK_LENGTH;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  // A BigInt because a bit count above 2^53 is not exactly representable as a
  // number, and a message that large is a caller's business rather than ours.
  view.setBigUint64(paddedLength - 8, BigInt(message.length) * 8n, false);

  const hash = INITIAL_HASH.slice();
  const w = new Uint32Array(64);

  for (let block = 0; block < paddedLength; block += BLOCK_LENGTH) {
    // §6.2.2 step 1: the message schedule.
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = at(w, i - 15);
      const w2 = at(w, i - 2);
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0;
    }

    // §6.2.2 step 2.
    let a = at(hash, 0);
    let b = at(hash, 1);
    let c = at(hash, 2);
    let d = at(hash, 3);
    let e = at(hash, 4);
    let f = at(hash, 5);
    let g = at(hash, 6);
    let h = at(hash, 7);

    // §6.2.2 step 3.
    for (let i = 0; i < 64; i++) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choice + at(K, i) + at(w, i)) >>> 0;
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    // §6.2.2 step 4.
    hash[0] = (at(hash, 0) + a) >>> 0;
    hash[1] = (at(hash, 1) + b) >>> 0;
    hash[2] = (at(hash, 2) + c) >>> 0;
    hash[3] = (at(hash, 3) + d) >>> 0;
    hash[4] = (at(hash, 4) + e) >>> 0;
    hash[5] = (at(hash, 5) + f) >>> 0;
    hash[6] = (at(hash, 6) + g) >>> 0;
    hash[7] = (at(hash, 7) + h) >>> 0;
  }

  const digest = new Uint8Array(SHA256_DIGEST_LENGTH);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) digestView.setUint32(i * 4, at(hash, i), false);
  return digest;
}

/**
 * ← `HMAC(EVP_sha256(), key, keyLength, data, dataLength, out, &outLength)`.
 * RFC 2104.
 *
 * Upstream's comment on why a MAC is used for something that is not
 * authentication: "We're using HMAC as a keyed hash here, not actually for
 * authentication, but it works" (`actor-id-impl.c++:74-75`).
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  // RFC 2104 §2: a key longer than one block is replaced by its own digest, and
  // a shorter one is zero-padded. Exactly one block is used as it stands, which
  // is why the comparison is `>` and not `>=`.
  const block = new Uint8Array(BLOCK_LENGTH);
  block.set(key.length > BLOCK_LENGTH ? sha256(key) : key);

  const inner = new Uint8Array(BLOCK_LENGTH + message.length);
  const outer = new Uint8Array(BLOCK_LENGTH + SHA256_DIGEST_LENGTH);
  for (let i = 0; i < BLOCK_LENGTH; i++) {
    inner[i] = at(block, i) ^ 0x36;
    outer[i] = at(block, i) ^ 0x5c;
  }
  inner.set(message, BLOCK_LENGTH);
  outer.set(sha256(inner), BLOCK_LENGTH);
  return sha256(outer);
}
