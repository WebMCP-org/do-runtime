/**
 * There is no upstream test file: upstream's digest is BoringSSL's, tested by
 * BoringSSL. These are the published known-answer vectors instead — FIPS 180-2
 * appendix B for SHA-256 and RFC 4231 section 4 for HMAC-SHA-256 — because the
 * whole value of writing the digest out rather than inventing a construction is
 * that its answers are the answers a standard already fixed.
 */

import { describe, expect, test } from "vitest";
import { hmacSha256, sha256 } from "./sha256";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function repeated(byte: number, count: number): Uint8Array {
  return new Uint8Array(count).fill(byte);
}

describe("sha256", () => {
  // FIPS 180-2 appendix B.
  test.each([
    ["the empty message", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["one block", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "two blocks",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("%s", (_label, message, expected) => {
    expect(hex(sha256(encoder.encode(message)))).toBe(expected);
  });

  test("a million repetitions of 'a'", () => {
    expect(hex(sha256(repeated(0x61, 1_000_000)))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  // The padding rule is where a hand-written digest goes wrong: a message whose
  // length leaves fewer than nine bytes in the final block needs a whole extra
  // block, and 55/56/57 bytes straddle that boundary.
  test.each([
    [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
    [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
    [57, "f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6"],
    [63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"],
    [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
    [65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"],
  ])("a %i-byte message pads correctly", (length, expected) => {
    expect(hex(sha256(repeated(0x61, length)))).toBe(expected);
  });
});

describe("hmacSha256", () => {
  // RFC 4231 section 4, cases 1-7. Case 5's value is the full digest rather than
  // the 128-bit truncation the RFC prints.
  test.each([
    ["case 1", repeated(0x0b, 20), encoder.encode("Hi There"),
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
    ["case 2", encoder.encode("Jefe"), encoder.encode("what do ya want for nothing?"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    ["case 3", repeated(0xaa, 20), repeated(0xdd, 50),
      "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
    ["case 4", new Uint8Array(Array.from({ length: 25 }, (_value, index) => index + 1)), repeated(0xcd, 50),
      "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"],
    ["case 5", repeated(0x0c, 20), encoder.encode("Test With Truncation"),
      "a3b6167473100ee06e0c796c2955552bfa6f7c0a6a8aef8b93f860aab0cd20c5"],
    ["case 6 — a key longer than the block, which is hashed first", repeated(0xaa, 131),
      encoder.encode("Test Using Larger Than Block-Size Key - Hash Key First"),
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
    ["case 7 — a longer-than-block key and a longer-than-block message", repeated(0xaa, 131),
      encoder.encode(
        "This is a test using a larger than block-size key and a larger than block-size data. " +
          "The key needs to be hashed before being used by the HMAC algorithm.",
      ),
      "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"],
  ])("%s", (_label, key, message, expected) => {
    expect(hex(hmacSha256(key, message))).toBe(expected);
  });

  test("a key of exactly the block size is used as-is, and one byte more is hashed", () => {
    // 64 bytes is the boundary: one more and RFC 2104 replaces the key with its
    // own digest, so a `>=` here would silently change every id.
    expect(hex(hmacSha256(repeated(0xaa, 64), encoder.encode("boundary")))).toBe(
      "75eb5ffe3a1f602eab7e09004e78064769aa0eed261e4a3888dfe62d6a945b4e",
    );
    expect(hex(hmacSha256(repeated(0xaa, 65), encoder.encode("boundary")))).toBe(
      "8667c9376a80b4946a91a671f539eb3769a0928f3ccbf5c819a0b5af61f86d10",
    );
  });

  test("neither argument is modified", () => {
    const key = repeated(0xaa, 131);
    const message = encoder.encode("Hi There");
    hmacSha256(key, message);
    expect(key).toEqual(repeated(0xaa, 131));
    expect(message).toEqual(encoder.encode("Hi There"));
  });
});
