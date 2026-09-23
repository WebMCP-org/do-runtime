/**
 * NO upstream test file. workerd's `cloudflare:email` (`src/cloudflare/email.ts`) re-exports
 * `EmailMessage` from `cloudflare-internal:email`, which the embedder supplies — Miniflare on
 * the oracle lane. These are that module's answers, measured on workerd 1.20260911.1.
 */

import { expect, test } from "vitest";
import { EmailMessage } from "./cloudflare-email";

test("EmailMessage holds its arguments the way workerd's does, unchecked", () => {
  expect(JSON.stringify(new EmailMessage("a@example.com", "b@example.com", "raw text"))).toBe(
    '{"from":"a@example.com","to":"b@example.com","EmailMessage::raw":"raw text"}',
  );
  const unchecked = new EmailMessage(1 as never, 2 as never, "raw text");
  expect([unchecked.from, unchecked.to]).toEqual([1, 2]);
});
