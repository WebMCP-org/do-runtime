/**
 * ← workerd `src/workerd/api/http.{h,c++}` — the gating, and nothing else.
 *
 * `http.c++` is 2,400 lines of `Request`, `Response`, `Headers`, `Body`,
 * `Fetcher` and the redirect machine. None of it is ported: the substrate ships
 * all of it, to the same specification, and re-implementing WHATWG Fetch over
 * `fetch` would be the feature-subset failure the porting philosophy describes,
 * with a much larger surface than the eighty lines it saves.
 *
 * What the substrate's copy cannot have is the half that is not in the spec at
 * all: **every asynchronous step of a fetch is an io-context operation**, so on
 * workerd the code after `await res.json()` resumes holding an input lock the
 * same way the code after `await fetch(…)` does. §1.3 is the whole of it —
 * `api/http.c++` contains ten `awaitIo(` calls and zero
 * `awaitIoWithInputLock`, so an outbound request releases the input gate and its
 * continuation re-takes one.
 *
 * A `Response` is where that matters and where it is easiest to miss. `fetch`
 * itself is one `awaitIo` in `api/global-scope.ts`, which is obvious; the body
 * is a SECOND await, arbitrarily later, and a raw `Response` would resolve it
 * from a promise this package does not own. The continuation would come back
 * with an empty invocation stack and the next `ctx.storage` call would throw —
 * divergence 147, arriving from a line that looks like it only parses JSON.
 *
 * Upstream reaches the same place by construction rather than by wrapping: a
 * `Response`'s body is an `IoOwn<ReadableStream>`, and `IoOwn` is precisely "a
 * thing that may only be touched from inside its IoContext"
 * (`io-context.h`'s `IoOwn`/`IoPtr`/`DeleteQueue` block). There is no such
 * ownership here — GC makes a cross-context dereference impossible in the way
 * that block guards against, which is why the package does not port it — so the
 * property it produced has to be produced by the wrapper below.
 *
 * Spec: §1.3 and decision 1 in
 * docs/decisions.md.
 */

import type { IoContext } from "../io/io-context";

/**
 * The `Body` mixin's consuming methods (`http.h`'s `Body` resource type). Each
 * one reads the whole stream, so each one is an await that has to resume gated.
 *
 * `formData` is included even though nothing in this package's consumer calls
 * it: a subset here is a hole with no error, which is the one direction this
 * layer may not be wrong in.
 */
const BODY_CONSUMERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

/**
 * Wrap a `Response` so every asynchronous step of reading it resumes inside a
 * gated slice.
 *
 * A `Proxy` rather than a subclass, for a reason that is the substrate's rather
 * than a preference: `Response`'s internals are exotic, `new Response(res.body)`
 * would lose `status`, `url`, `redirected` and the header casing, and a class
 * that delegated every member by hand would silently stop covering whatever the
 * platform adds next. The trap covers what has to be covered and forwards the
 * rest to the real object, bound to it, so a member this file has never heard of
 * behaves exactly as the substrate's does.
 *
 * `clone()` is wrapped too. It returns a second `Response` over a tee of the
 * same stream, and an unwrapped one would be the same hole one call further out.
 */
export function gateResponseBody(ctx: IoContext, response: Response): Response {
  const bound = new Map<string | symbol, unknown>();

  return new Proxy(response, {
    get(subject, property): unknown {
      const cached = bound.get(property);
      if (cached !== undefined) return cached;

      if (property === "body") {
        const body = subject.body;
        if (body === null) return null;
        const gated = gateReadableStream(ctx, body);
        bound.set(property, gated);
        return gated;
      }

      if (property === "clone") {
        const clone = (): Response => gateResponseBody(ctx, subject.clone());
        bound.set(property, clone);
        return clone;
      }

      if ((BODY_CONSUMERS as readonly (string | symbol)[]).includes(property)) {
        const consume = (...args: unknown[]): Promise<unknown> =>
          ctx.awaitIo(
            (subject[property as (typeof BODY_CONSUMERS)[number]] as (...a: unknown[]) => Promise<unknown>).apply(
              subject,
              args,
            ),
          );
        bound.set(property, consume);
        return consume;
      }

      // `headers`, `status`, `ok` and friends are accessors on the prototype that read internal
      // slots, so they have to be read with the real object as the receiver rather than the proxy.
      // A method reached this way is bound for the same reason.
      const value: unknown = Reflect.get(subject, property, subject);
      if (typeof value === "function") {
        const method = (value as (...a: unknown[]) => unknown).bind(subject);
        bound.set(property, method);
        return method;
      }
      return value;
    },
  });
}

/**
 * ← the same property one layer down: a body read through `getReader()` is a
 * sequence of awaits, so each `read()` is one.
 *
 * Only the default reader is covered. A BYOB reader is refused rather than
 * passed through ungated — see `BYOB_READER_UNGATABLE_MESSAGE`.
 */
export const BYOB_READER_UNGATABLE_MESSAGE =
  "getReader({ mode: 'byob' }): a BYOB reader cannot be gated by this runtime, because " +
  "`ReadableStream.getReader` is the only seam it has and a byte stream's `read(view)` " +
  "returns the caller's own buffer. Read the body through `arrayBuffer()` or a default reader.";

export function gateReadableStream<T>(ctx: IoContext, stream: ReadableStream<T>): ReadableStream<T> {
  const bound = new Map<string | symbol, unknown>();

  return new Proxy(stream, {
    get(subject, property): unknown {
      const cached = bound.get(property);
      if (cached !== undefined) return cached;

      if (property === "getReader") {
        const getReader = (options?: { mode?: string }): unknown => {
          // Fail closed. A byte reader whose `read(view)` this layer cannot intercept would hand
          // its continuation back ungated, which is the exact failure this module exists to
          // prevent, and it would do it silently.
          if (options?.mode === "byob") throw new Error(BYOB_READER_UNGATABLE_MESSAGE);
          return gateReader(ctx, subject.getReader());
        };
        bound.set(property, getReader);
        return getReader;
      }

      // `tee()` splits into two streams; both are bodies and both get the same treatment.
      if (property === "tee") {
        const tee = (): [ReadableStream<T>, ReadableStream<T>] => {
          const [a, b] = subject.tee();
          return [gateReadableStream(ctx, a), gateReadableStream(ctx, b)];
        };
        bound.set(property, tee);
        return tee;
      }

      const value: unknown = Reflect.get(subject, property, subject);
      if (typeof value === "function") {
        const method = (value as (...a: unknown[]) => unknown).bind(subject);
        bound.set(property, method);
        return method;
      }
      return value;
    },
  });
}

function gateReader<T>(
  ctx: IoContext,
  reader: ReadableStreamDefaultReader<T>,
): ReadableStreamDefaultReader<T> {
  return new Proxy(reader, {
    get(subject, property): unknown {
      if (property === "read") {
        return (): Promise<ReadableStreamReadResult<T>> => ctx.awaitIo(subject.read());
      }
      const value: unknown = Reflect.get(subject, property, subject);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(subject)
        : value;
    },
  });
}
