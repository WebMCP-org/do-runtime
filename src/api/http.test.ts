/**
 * ← workerd `src/workerd/api/http-test.c++`, which tests WHATWG Fetch semantics
 * — none of which is ported, because the substrate ships them.
 *
 * So these are this section's own, and they are all one claim: **reading a
 * response body is a second await, and it has to resume gated too.** `fetch`
 * being `awaitIo` is the obvious half and `api/global-scope.test.ts` covers it;
 * this file covers the half that looks like it only parses JSON.
 */

import { describe, expect, test } from "vitest";
import type { Actor, Timer } from "../io/io-context";
import { IoContext } from "../io/io-context";
import { InputGate, OutputGate } from "../io/io-gate";
import {
  BYOB_READER_UNGATABLE_MESSAGE,
  gateReadableStream,
  gateRequestBody,
  gateResponseBody,
} from "./http";

class TestActor implements Actor {
  readonly inputGate = new InputGate();
  readonly outputGate = new OutputGate();
  getInputGate(): InputGate {
    return this.inputGate;
  }
  getOutputGate(): OutputGate {
    return this.outputGate;
  }
  shutdownActorCache(): void {}
  assertCanSetAlarm(): void {}
}

const NEVER_FIRES: Timer = { now: () => 0, afterDelay: () => new Promise<void>(() => {}) };

function newContext(): IoContext {
  return new IoContext(new TestActor(), NEVER_FIRES);
}

type AsyncIterableStream<T> = ReadableStream<T> &
  AsyncIterable<T> & {
    values(options?: { preventCancel?: boolean }): AsyncIterableIterator<T>;
  };

/** A body that only settles on the next macrotask, so an ungated read is visibly ungated. */
function slowBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (index >= chunks.length) controller.close();
          else controller.enqueue(encoder.encode(chunks[index++]));
          resolve();
        }, 0);
      });
    },
  });
}

function slowBlob(contents: string): Blob {
  const blob = new Blob([contents]);
  const arrayBuffer = blob.arrayBuffer.bind(blob);
  const bytes = blob.bytes.bind(blob);
  const text = blob.text.bind(blob);
  const nextTask = <T>(read: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      setTimeout(() => void read().then(resolve, reject), 0);
    });

  Object.defineProperties(blob, {
    arrayBuffer: { configurable: true, value: () => nextTask(arrayBuffer) },
    bytes: { configurable: true, value: () => nextTask(bytes) },
    stream: { configurable: true, value: () => slowBody([contents]) },
    text: { configurable: true, value: () => nextTask(text) },
  });
  return blob;
}

describe("gateResponseBody", () => {
  test("§1.3 the continuation after text() holds a fresh input lock", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = gateResponseBody(ctx, new Response(slowBody(["hel", "lo"])));
      const body = await response.text();
      seen.push(body, ctx.hasCurrent() ? "gated" : "UNGATED");
    });
    expect(seen).toEqual(["hello", "gated"]);
  });

  test("json, arrayBuffer, bytes and blob resume gated too", async () => {
    // A subset here would be a hole with no error, which is the one direction this layer
    // may not be wrong in — so every `Body` consumer is covered rather than the two the
    // consumer happens to call.
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const json = gateResponseBody(ctx, new Response(slowBody(['{"a":1}'])));
      expect(await json.json()).toEqual({ a: 1 });
      seen.push(ctx.hasCurrent() ? "json:gated" : "json:UNGATED");

      const buffer = gateResponseBody(ctx, new Response(slowBody(["abc"])));
      expect((await buffer.arrayBuffer()).byteLength).toBe(3);
      seen.push(ctx.hasCurrent() ? "arrayBuffer:gated" : "arrayBuffer:UNGATED");

      const bytes = gateResponseBody(ctx, new Response(slowBody(["abc"])));
      expect((await bytes.bytes()).length).toBe(3);
      seen.push(ctx.hasCurrent() ? "bytes:gated" : "bytes:UNGATED");

      const blob = gateResponseBody(ctx, new Response(slowBody(["abc"])));
      expect((await blob.blob()).size).toBe(3);
      seen.push(ctx.hasCurrent() ? "blob:gated" : "blob:UNGATED");
    });

    expect(seen).toEqual(["json:gated", "arrayBuffer:gated", "bytes:gated", "blob:gated"]);
  });

  test("a consumed Blob's reads, stream and slices resume gated", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = new Response();
      Object.defineProperty(response, "blob", {
        configurable: true,
        value: () => Promise.resolve(slowBlob("abc")),
      });
      const blob = await gateResponseBody(ctx, response).blob();

      expect(await blob.text()).toBe("abc");
      seen.push(ctx.hasCurrent() ? "text:gated" : "text:UNGATED");
      expect((await blob.arrayBuffer()).byteLength).toBe(3);
      seen.push(ctx.hasCurrent() ? "arrayBuffer:gated" : "arrayBuffer:UNGATED");
      expect((await blob.bytes()).length).toBe(3);
      seen.push(ctx.hasCurrent() ? "bytes:gated" : "bytes:UNGATED");

      await blob.stream().getReader().read();
      seen.push(ctx.hasCurrent() ? "stream:gated" : "stream:UNGATED");
      expect(await blob.slice(1).text()).toBe("bc");
      seen.push(ctx.hasCurrent() ? "slice:gated" : "slice:UNGATED");
    });

    expect(seen).toEqual([
      "text:gated",
      "arrayBuffer:gated",
      "bytes:gated",
      "stream:gated",
      "slice:gated",
    ]);
  });

  test("an ungated response is what this exists to prevent", async () => {
    // The negative control. Without the wrapper the same read resumes with an empty
    // invocation stack, which is divergence 147 arriving from a line that looks like it
    // only parses text.
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      await new Response(slowBody(["hello"])).text();
      seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
    });
    expect(seen).toEqual(["UNGATED"]);
  });

  test("status, headers and the rest read through to the real response", async () => {
    // The trap forwards with the real object as the receiver: `status` and `headers` are
    // prototype accessors over internal slots and would throw on the proxy.
    const ctx = newContext();
    const response = gateResponseBody(
      ctx,
      new Response("x", { status: 418, statusText: "teapot", headers: { "x-probe": "1" } }),
    );

    expect(response.status).toBe(418);
    expect(response.statusText).toBe("teapot");
    expect(response.ok).toBe(false);
    expect(response.headers.get("x-probe")).toBe("1");
    expect(response.bodyUsed).toBe(false);
  });

  test("clone() is gated too, so the hole does not move one call further out", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = gateResponseBody(ctx, new Response(slowBody(["hello"])));
      const copy = response.clone();
      expect(await copy.text()).toBe("hello");
      seen.push(ctx.hasCurrent() ? "clone:gated" : "clone:UNGATED");
      expect(await response.text()).toBe("hello");
      seen.push(ctx.hasCurrent() ? "original:gated" : "original:UNGATED");
    });
    expect(seen).toEqual(["clone:gated", "original:gated"]);
  });

  test("a null body stays null", async () => {
    const ctx = newContext();
    expect(gateResponseBody(ctx, new Response(null, { status: 204 })).body).toBeNull();
  });
});

describe("gateRequestBody", () => {
  test("a host-provided request body and its clones resume gated", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const request = gateRequestBody(
        ctx,
        new Request("http://example.invalid", {
          method: "POST",
          body: slowBody(["hel", "lo"]),
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      );
      const copy = request.clone();
      expect(await copy.text()).toBe("hello");
      seen.push(ctx.hasCurrent() ? "clone:gated" : "clone:UNGATED");
      expect(await request.text()).toBe("hello");
      seen.push(ctx.hasCurrent() ? "original:gated" : "original:UNGATED");
    });

    expect(seen).toEqual(["clone:gated", "original:gated"]);
  });
});

describe("gateReadableStream", () => {
  test("for await resumes gated for every chunk", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const body = gateReadableStream(ctx, slowBody(["a", "b"])) as AsyncIterableStream<
        Uint8Array
      >;
      for await (const chunk of body) {
        seen.push(`${new TextDecoder().decode(chunk)}:${ctx.hasCurrent() ? "gated" : "UNGATED"}`);
      }
    });
    expect(seen).toEqual(["a:gated", "b:gated"]);
  });

  test("early return cancels unless values() prevents it and always releases the lock", async () => {
    const ctx = newContext();
    let cancels = 0;
    const stream = (): AsyncIterableStream<string> =>
      gateReadableStream(
        ctx,
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue("a");
          },
          cancel() {
            cancels += 1;
          },
        }),
      ) as AsyncIterableStream<string>;

    await ctx.run(async () => {
      const canceled = stream();
      for await (const _chunk of canceled) break;
      expect(canceled.locked).toBe(false);

      const preserved = stream();
      for await (const _chunk of preserved.values({ preventCancel: true })) break;
      expect(preserved.locked).toBe(false);
    });
    expect(cancels).toBe(1);
  });

  test("every read() through the default reader resumes gated", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = gateResponseBody(ctx, new Response(slowBody(["a", "b"])));
      const body = response.body;
      if (body === null) throw new Error("expected a body");
      const reader = body.getReader();
      for (;;) {
        const { done } = await reader.read();
        seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
        if (done) break;
      }
    });
    expect(seen).toEqual(["gated", "gated", "gated"]);
  });

  test("tee() gates both halves", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const [left, right] = gateReadableStream(ctx, slowBody(["a"])).tee();
      await left.getReader().read();
      seen.push(ctx.hasCurrent() ? "left:gated" : "left:UNGATED");
      await right.getReader().read();
      seen.push(ctx.hasCurrent() ? "right:gated" : "right:UNGATED");
    });
    expect(seen).toEqual(["left:gated", "right:gated"]);
  });

  test("pipeThrough hands back a gated stream, not a laundered raw one", async () => {
    // The MCP SDK's SSE path in miniature:
    // `res.body.pipeThrough(new TextDecoderStream()).pipeThrough(parser).getReader()`.
    // Native pipeThrough reads the source through internal spec operations and returns the
    // transform's readable — a brand-new stream — so without the override every read() on it
    // resumes foreign, and the storage call in the message handler throws. The second pipe
    // also proves the re-gating recurses through a chain.
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const response = gateResponseBody(ctx, new Response(slowBody(["a", "b"])));
      const body = response.body;
      if (body === null) throw new Error("expected a body");
      const upper = new TransformStream<string, string>({
        transform(chunk, controller) {
          controller.enqueue(chunk.toUpperCase());
        },
      });
      const reader = body.pipeThrough(new TextDecoderStream()).pipeThrough(upper).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        seen.push(`${value ?? "done"}:${ctx.hasCurrent() ? "gated" : "UNGATED"}`);
        if (done) break;
      }
    });
    expect(seen).toEqual(["A:gated", "B:gated", "done:gated"]);
  });

  test("the promise pipeTo returns resumes gated", async () => {
    const ctx = newContext();
    const seen: string[] = [];

    await ctx.run(async () => {
      const sink: string[] = [];
      const decoder = new TextDecoder();
      await gateReadableStream(ctx, slowBody(["a", "b"])).pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            sink.push(decoder.decode(chunk));
          },
        }),
      );
      expect(sink).toEqual(["a", "b"]);
      seen.push(ctx.hasCurrent() ? "gated" : "UNGATED");
    });
    expect(seen).toEqual(["gated"]);
  });

  test("a BYOB reader is refused rather than handed back ungated", async () => {
    // Fail closed. A byte reader's `read(view)` returns the caller's own buffer and
    // `getReader` is the only seam this layer has, so it cannot be intercepted — and one
    // that worked ungated is exactly the failure this module exists to prevent.
    const ctx = newContext();
    const stream = gateReadableStream(ctx, slowBody(["a"]));
    expect(() => stream.getReader({ mode: "byob" } as never)).toThrow(
      BYOB_READER_UNGATABLE_MESSAGE,
    );
  });

  test("cancel and the other reader members still reach the real stream", async () => {
    const ctx = newContext();
    const stream = gateReadableStream(ctx, slowBody(["a"]));
    const reader = stream.getReader();
    await reader.cancel("done with it");
    expect(stream.locked).toBe(true);
  });
});
