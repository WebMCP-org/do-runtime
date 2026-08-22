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

/**
 * The `Body` mixin's consuming methods (`http.h`'s `Body` resource type). Each
 * one reads the whole stream, so each one is an await that has to resume gated.
 *
 * `formData` is included even though nothing in this package's consumer calls
 * it: a subset here is a hole with no error, which is the one direction this
 * layer may not be wrong in.
 */
const BODY_CONSUMERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

type IoAwaiter = {
  awaitIo<T>(promise: Promise<T>): Promise<T>;
};

/**
 * Wrap a `Request` or `Response` so every asynchronous step of reading it
 * resumes inside a gated slice.
 *
 * A `Proxy` rather than a subclass, for a reason that is the substrate's rather
 * than a preference: `Response`'s internals are exotic, `new Response(res.body)`
 * would lose `status`, `url`, `redirected` and the header casing, and a class
 * that delegated every member by hand would silently stop covering whatever the
 * platform adds next. The trap covers what has to be covered and forwards the
 * rest to the real object, bound to it, so a member this file has never heard of
 * behaves exactly as the substrate's does.
 *
 * `clone()` is wrapped too. It returns a second body owner over a tee of the
 * same stream, and an unwrapped one would be the same hole one call further out.
 */
function gateBody<T extends Request | Response>(ctx: IoAwaiter, value: T): T {
  const bound = new Map<string | symbol, unknown>();

  return new Proxy(value, {
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
        const clone = (): T => gateBody(ctx, subject.clone() as T);
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

/** Wrap a host-provided request so consuming or streaming its body resumes gated. */
export function gateRequestBody(ctx: IoAwaiter, request: Request): Request {
  return gateBody(ctx, request);
}

/** Wrap an outbound response so consuming or streaming its body resumes gated. */
export function gateResponseBody(ctx: IoAwaiter, response: Response): Response {
  return gateBody(ctx, response);
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

// Instrument the native object itself. Chromium's `Response` constructor does not recognise a
// `Proxy` around a `ReadableStream` as `BodyInit`; it stringifies the proxy instead.
export function gateReadableStream<T>(ctx: IoAwaiter, stream: ReadableStream<T>): ReadableStream<T> {
  const getReader = stream.getReader.bind(stream);
  const tee = stream.tee.bind(stream);
  const pipeThrough = stream.pipeThrough.bind(stream);
  const pipeTo = stream.pipeTo.bind(stream);
  const values = async function* (options?: {
    preventCancel?: boolean;
  }): AsyncGenerator<T, void, unknown> {
    const reader = gateReader(ctx, getReader());
    let finished = false;
    try {
      for (;;) {
        let result: ReadableStreamReadResult<T>;
        try {
          result = await reader.read();
        } catch (exception) {
          finished = true;
          throw exception;
        }
        if (result.done) {
          finished = true;
          return;
        }
        yield result.value;
      }
    } finally {
      try {
        if (!finished && options?.preventCancel !== true) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  };

  Object.defineProperties(stream, {
    getReader: {
      configurable: true,
      writable: true,
      value(options?: { mode?: string }): unknown {
        // Fail closed. A byte reader whose `read(view)` this layer cannot intercept would hand
        // its continuation back ungated, which is the exact failure this module exists to
        // prevent, and it would do it silently.
        if (options?.mode === "byob") throw new Error(BYOB_READER_UNGATABLE_MESSAGE);
        return gateReader(ctx, getReader());
      },
    },
    // `tee()` splits into two streams; both are bodies and both get the same treatment.
    tee: {
      configurable: true,
      writable: true,
      value(): [ReadableStream<T>, ReadableStream<T>] {
        const [a, b] = tee();
        return [gateReadableStream(ctx, a), gateReadableStream(ctx, b)];
      },
    },
    // The pipe operations launder the gating: the native machinery reads the source through
    // internal spec operations (not the `getReader` property above), and `pipeThrough` hands
    // back the transform's readable — a brand-new stream with none of this instrumentation.
    // `res.body.pipeThrough(new TextDecoderStream()).getReader().read()` would resume foreign
    // on every chunk. The pipe's own internals never surface a user continuation, so the two
    // seams that do are the ones gated: the returned readable, and `pipeTo`'s settlement.
    pipeThrough: {
      configurable: true,
      writable: true,
      value<U>(
        transform: ReadableWritablePair<U, T>,
        options?: StreamPipeOptions,
      ): ReadableStream<U> {
        return gateReadableStream(ctx, pipeThrough(transform, options));
      },
    },
    pipeTo: {
      configurable: true,
      writable: true,
      value(destination: WritableStream<T>, options?: StreamPipeOptions): Promise<void> {
        return ctx.awaitIo(pipeTo(destination, options));
      },
    },
    // Async iteration launders the gating exactly like pipeThrough: the native iterator takes
    // its reader through an internal spec operation rather than the getReader property above.
    // Iterating through the gated reader keeps every chunk inside an input-gated slice.
    values: { configurable: true, writable: true, value: values },
    [Symbol.asyncIterator]: { configurable: true, writable: true, value: values },
  });

  return stream;
}

function gateReader<T>(
  ctx: IoAwaiter,
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
