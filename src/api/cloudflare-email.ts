/**
 * ← workerd `src/cloudflare/email.ts` — the built-in `cloudflare:email` module, which
 * re-exports `EmailMessage` from the embedder's `cloudflare-internal:email`.
 *
 * A data constructor and nothing more: sending belongs to the `send_email` binding and to
 * `ForwardableEmailMessage.reply()`, which the host supplies. The Agents SDK imports this module
 * eagerly and constructs one in `reply()`. The fields are what the oracle's module holds
 * (workerd 1.20260911.1 under Miniflare): `from` and `to` as given, unchecked, and the body under
 * the key its `send_email` binding reads.
 */
export class EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly "EmailMessage::raw": ReadableStream | string;

  constructor(from: string, to: string, raw: ReadableStream | string) {
    this.from = from;
    this.to = to;
    this["EmailMessage::raw"] = raw;
  }
}
