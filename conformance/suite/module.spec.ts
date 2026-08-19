/**
 * §1.12 — the `cloudflare:workers` module's own exports.
 *
 * Every other row here reaches the runtime through `host.spawn()`, because every
 * other row is about an actor. This one is about the built-in MODULE, which each
 * lane supplies by the same route it supplies the actor: the oracle lane gets
 * workerd's, and the node and browser lanes alias the specifier to this package's
 * port (see each lane's `vitest.config.ts`). So the import below is the subject.
 */

import { tracing } from "cloudflare:workers";
import { expect, it } from "vitest";

/**
 * The port had this as a throwing boundary on the grounds that nothing threads
 * `SpanParent`/`SpanBuilder` — reasoning from the port's insides rather than from
 * workerd. workerd runs the callback and hands over an untraced span, and
 * "untraced" is its ordinary state whenever nothing is collecting.
 *
 * It matters because feature detection is how a consumer is meant to cope with a
 * runtime that predates the export: `tracing ?? noop` keeps a present-but-throwing
 * object, so the throw surfaces at the first span rather than degrading.
 */
it("§1.12 tracing runs the callback with an untraced span", () => {
  const seen = tracing.startActiveSpan("probe", (span) => {
    span.setAttribute("attribute", 1);
    span.end();
    return {
      isTraced: span.isTraced,
      nested: tracing.startActiveSpan("inner", (inner) => inner.isTraced),
    };
  });
  expect(seen).toEqual({ isTraced: false, nested: false });
});
