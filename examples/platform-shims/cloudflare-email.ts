/** `agents` imports this eagerly; email delivery is outside these browser demos. */
export class EmailMessage {
  constructor() {
    throw new Error("cloudflare:email is not available in this browser host.");
  }
}
