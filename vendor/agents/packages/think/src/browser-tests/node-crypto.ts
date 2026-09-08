import * as browserCrypto from "node:crypto";

// crypto-browserify lacks this Node API used by Slack's forwarded-token check.
// Visit every byte; as with other JS implementations, JIT timing is not a
// constant-time guarantee. The host still controls this internal ingress.
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    throw new RangeError("Input buffers must have the same byte length");
  }
  let difference = 0;
  for (let i = 0; i < a.byteLength; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export default { ...browserCrypto, timingSafeEqual };
