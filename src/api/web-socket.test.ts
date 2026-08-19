/**
 * ← workerd `src/workerd/api/web-socket-test.c++`, which tests the frame
 * protocol and the hibernation state machine — neither of which is ported, for
 * the reasons `web-socket.ts`'s header gives.
 *
 * So these are this section's own, and every one of them is a claim from §1.8's
 * three-line description of how a socket meets the gates: frames each take a
 * fresh input lock, the read loop captures the critical section at `accept()`
 * time, and outbound messages each carry their own output-gate promise captured
 * at `send()` time.
 */

import { describe, expect, test } from "vitest";
import type { Actor, Timer } from "../io/io-context";
import { IoContext } from "../io/io-context";
import { InputGate, type Lock, OutputGate } from "../io/io-gate";
import { ALREADY_ACCEPTED_MESSAGE, acceptWebSocket, type RawWebSocket } from "./web-socket";

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

async function quiesce(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The socket beneath — an `EventTarget` with `send`/`close`, which is what a real
 * `WebSocket`, the extension's `WebSocketFacade` over capnweb, and this are.
 */
class FakeSocket extends EventTarget implements RawWebSocket {
  readonly sent: string[] = [];
  readonly closed: (number | undefined)[] = [];

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.sent.push(String(data));
  }
  close(code?: number): void {
    this.closed.push(code);
  }
  deliver(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function newFixture(): { ctx: IoContext; socket: FakeSocket } {
  return { ctx: new IoContext(new TestActor(), NEVER_FIRES), socket: new FakeSocket() };
}

describe("incoming frames", () => {
  test("§1.8 each frame is delivered inside its own gated slice", async () => {
    // ← "Re-enter the context with context.run(). This is arguably a bit unusual compared
    // to other I/O which is delivered by return from context.awaitIo(), but the difference
    // here is that we have a long stream of events over time."
    const { ctx, socket } = newFixture();
    const seen: string[] = [];

    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    accepted.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as string;
      seen.push(`${data}:${ctx.hasCurrent() ? "gated" : "UNGATED"}`);
    });

    socket.deliver("one");
    socket.deliver("two");
    await quiesce();
    expect(seen).toEqual(["one:gated", "two:gated"]);
  });

  test("both the listener and the on* handler see the frame", async () => {
    // The reason `WebSocketFacade` does the same: a client library sets handlers, a
    // server library listens, and both are consumers of one socket.
    const { ctx, socket } = newFixture();
    const seen: string[] = [];

    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    accepted.addEventListener("message", () => seen.push("listener"));
    accepted.onmessage = () => seen.push("handler");

    socket.deliver("x");
    await quiesce();
    expect(seen.sort()).toEqual(["handler", "listener"]);
  });

  test("§1.8 a socket accepted inside a critical section delivers inside it", async () => {
    // ← `internalAccept(js, IoContext::current().getCriticalSection())`
    // (`web-socket.c++:133`, `:426`), replayed per frame at `:1110`. Captured at ACCEPT
    // and not when a frame arrives: reading it later would give a new external event the
    // running section, and `blockConcurrencyWhile` would silently block nothing.
    const { ctx, socket } = newFixture();
    const seen: string[] = [];
    const release = Promise.withResolvers<void>();

    const section = ctx.run(() =>
      ctx.blockConcurrencyWhile(async (lock: Lock) => {
        const accepted = acceptWebSocket(ctx, socket);
        accepted.addEventListener("message", () => seen.push("frame"));
        void lock;
        await release.promise;
        seen.push("section-end");
        return "done";
      }),
    );

    await quiesce();
    socket.deliver("mid-section");
    await quiesce();

    // It arrived while the section was still open, which only the captured section allows:
    // a frame queued on the root gate could not run until the section ended.
    expect(seen).toEqual(["frame"]);
    release.resolve();
    expect(await section).toBe("done");
    expect(seen).toEqual(["frame", "section-end"]);
  });

  test("a listener that throws is reported rather than becoming an unhandled rejection", async () => {
    // The delivery rides `addWaitUntil`, as upstream's read loop does, so a throw lands in
    // the context's existing failure channel.
    const { ctx, socket } = newFixture();
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    accepted.onmessage = () => {
      throw new Error("listener exploded");
    };

    socket.deliver("x");
    await quiesce();
    expect((ctx.waitUntilStatus() as Error).message).toBe("listener exploded");
  });

  test("close and error events are delivered gated too", async () => {
    const { ctx, socket } = newFixture();
    const seen: string[] = [];
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    accepted.onclose = (event) => seen.push(`close:${event.code}:${String(ctx.hasCurrent())}`);
    accepted.onerror = () => seen.push(`error:${String(ctx.hasCurrent())}`);

    socket.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "gone", wasClean: false }));
    socket.dispatchEvent(new Event("error"));
    await quiesce();
    expect(seen).toEqual(["close:1006:true", "error:true"]);
  });
});

describe("outgoing messages", () => {
  test("§1.1 a send waits for the output locks outstanding when it was enqueued", async () => {
    // ← `outgoingMessages->insert(GatedMessage{IoContext::current()
    // .waitForOutputLocksIfNecessary(), …})` (`web-socket.c++:689`). A frame is an outgoing
    // message that "would allow the rest of the world to observe the actor's state".
    const { ctx, socket } = newFixture();
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);

    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    await ctx.run(() => accepted.send("first"));
    await quiesce();
    expect(socket.sent).toEqual([]);

    write.resolve();
    await quiesce();
    expect(socket.sent).toEqual(["first"]);
  });

  test("message N waits only for the writes outstanding when IT was enqueued", async () => {
    // The other half of upstream's per-message lock: a send made after a write confirmed
    // does not inherit that write's wait. Ordering still holds, because the pump is a chain.
    const { ctx, socket } = newFixture();
    const slow = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(slow.promise);

    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    await ctx.run(() => accepted.send("behind-the-write"));
    slow.resolve();
    await quiesce();

    await ctx.run(() => accepted.send("after-the-write"));
    await quiesce();
    expect(socket.sent).toEqual(["behind-the-write", "after-the-write"]);
  });

  test("sends leave in the order they were made", async () => {
    const { ctx, socket } = newFixture();
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    await ctx.run(() => {
      accepted.send("a");
      accepted.send("b");
      accepted.send("c");
    });
    await quiesce();
    expect(socket.sent).toEqual(["a", "b", "c"]);
  });

  test("close is queued through the same gate as a send", async () => {
    const { ctx, socket } = newFixture();
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);

    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    await ctx.run(() => {
      accepted.send("last");
      accepted.close(1001, "going away");
    });
    await quiesce();
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([]);

    write.resolve();
    await quiesce();
    expect(socket.sent).toEqual(["last"]);
    expect(socket.closed).toEqual([1001]);
  });
});

describe("accept", () => {
  test("accepting the same socket twice refuses by name", async () => {
    // ← the `JSG_REQUIRE(!native.state.is<Accepted>(), …)` at the head of `accept()`. Two
    // read loops on one socket would deliver its frames under two gates, and each would
    // see half of them.
    const { ctx, socket } = newFixture();
    await ctx.run(() => acceptWebSocket(ctx, socket));
    expect(() => acceptWebSocket(ctx, socket)).toThrow(ALREADY_ACCEPTED_MESSAGE);
  });

  test("a rebuilt event carries the accepted socket as its target", async () => {
    // An `Event` may be dispatched by one target at a time, so the raw socket's object
    // cannot be re-dispatched — and one that has finished dispatching names the RAW socket
    // as `target`, which is not what a listener on the accepted one expects.
    const { ctx, socket } = newFixture();
    const targets: unknown[] = [];
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    accepted.addEventListener("message", (event) => targets.push((event as Event).target));
    // The handler beside it gets the SAME rebuilt event, not the raw one — two consumers of one
    // frame must not disagree about its target.
    accepted.onmessage = (event) => targets.push(event.target);

    socket.deliver("x");
    await quiesce();
    expect(targets).toEqual([accepted, accepted]);
  });
});
