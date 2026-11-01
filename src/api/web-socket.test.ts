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
import {
  ALREADY_ACCEPTED_MESSAGE,
  AcceptedWebSocket,
  HibernatableWebSocketRegistry,
  WebSocketRequestResponsePair,
  acceptWebSocket,
  type RawWebSocket,
} from "./web-socket";

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
  test("queued writes stop if the actor aborts before their output lock releases", async () => {
    const { ctx, socket } = newFixture();
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    await ctx.run(() => {
      accepted.send("pending");
      accepted.close(1000);
    });

    ctx.abort(new Error("actor stopped"));
    write.resolve();
    await quiesce();
    expect(socket.sent).toEqual([]);
    // The queued close(1000) never reaches the transport; only the abort's drop does.
    expect(socket.closed).toEqual([undefined]);
    expect(ctx.waitUntilStatus()).toBeUndefined();
  });

  test("an aborted actor drops its accepted socket instead of leaving it OPEN", async () => {
    // ← a classic socket is owned by its IoContext; destroying the context drops the
    // connection. A caller that kept the socket must see it closed, not write into it forever.
    const { ctx, socket } = newFixture();
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    expect(accepted.readyState).toBe(AcceptedWebSocket.OPEN);

    ctx.abort(new Error("actor stopped"));
    await quiesce();
    expect(accepted.readyState).toBe(AcceptedWebSocket.CLOSED);
    expect(socket.closed).toEqual([undefined]);

    accepted.send("after");
    accepted.close(1000);
    socket.dispatchEvent(new CloseEvent("close", { code: 1005, wasClean: true }));
    await quiesce();
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([undefined]);
    expect(ctx.waitUntilStatus()).toBeUndefined();
  });

  test("an aborted actor's pair half drops the connection the host holds", async () => {
    const { ctx } = newFixture();
    const registry = new HibernatableWebSocketRegistry(ctx, {
      message: () => {},
      close: () => {},
      error: () => {},
    });
    const { 0: client, 1: server } = new registry.WebSocketPair();
    // What returning the client half in a 101 response does: the host takes it out of the actor.
    const host = (client as AcceptedWebSocket).coupleToHost();
    host.accept();
    const closes: string[] = [];
    host.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      closes.push(`${close.code}:${close.wasClean}`);
    });
    await ctx.run(() => server.accept());

    ctx.abort(new Error("actor stopped"));
    await quiesce();
    expect(server.readyState).toBe(AcceptedWebSocket.CLOSED);
    expect(closes).toEqual(["1006:false"]);
  });

  test("auto-responses bypass output locks but remain behind earlier sends", async () => {
    // ← workerd hibernation-manager-test.c++: active replies bypass the output gate.
    const { ctx } = newFixture();
    const registry = new HibernatableWebSocketRegistry(ctx, {
      message: () => {},
      close: () => {},
      error: () => {},
    });
    const pair = new registry.WebSocketPair();
    const client = pair[0];
    const server = pair[1] as AcceptedWebSocket;
    const messages: string[] = [];
    await ctx.run(() => {
      registry.acceptWebSocket(server);
      client.accept();
      client.addEventListener("message", (event) => messages.push(String(event.data)));
      registry.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    });
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);

    registry.receive(server, "message", new MessageEvent("message", { data: "ping" }));
    await quiesce();
    expect(messages).toEqual(["pong"]);

    await ctx.run(() => server.send("app"));
    registry.receive(server, "message", new MessageEvent("message", { data: "ping" }));
    await quiesce();
    expect(messages).toEqual(["pong"]);

    write.resolve();
    await quiesce();
    expect(messages).toEqual(["pong", "app", "pong"]);
  });

  test("auto-responses after close are consumed without sending or failing", async () => {
    // ← workerd a451899: close() suppresses automatic replies immediately.
    const { ctx } = newFixture();
    const messages: (string | ArrayBuffer)[] = [];
    const registry = new HibernatableWebSocketRegistry(ctx, {
      message: (_socket, message) => messages.push(message),
      close: () => {},
      error: () => {},
    });
    const socket = new registry.WebSocketPair()[1] as AcceptedWebSocket;
    registry.acceptWebSocket(socket);
    registry.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

    await ctx.run(() => {
      socket.close(4000, "done");
      expect(() =>
        registry.receive(socket, "message", new MessageEvent("message", { data: "ping" })),
      ).not.toThrow();
    });
    await quiesce();
    expect(messages).toEqual([]);
    expect(registry.getWebSocketAutoResponseTimestamp(socket)?.getTime()).toBe(0);
    expect(ctx.waitUntilStatus()).toBeUndefined();
  });

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

  test("binary sends snapshot bytes before the caller mutates or detaches the buffer", async () => {
    // ← workerd 8457bac: queued sends own their bytes before leaving the isolate lock.
    const { ctx, socket } = newFixture();
    const write = Promise.withResolvers<void>();
    void ctx.lockOutputWhile(write.promise);
    const sent: number[][] = [];
    socket.send = (data) => {
      if (data instanceof ArrayBuffer) sent.push([...new Uint8Array(data)]);
      else if (ArrayBuffer.isView(data)) {
        sent.push([...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)]);
      }
    };
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await ctx.run(() => {
      accepted.send(bytes.buffer);
      accepted.send(bytes.subarray(1, 3));
      accepted.send(new DataView(bytes.buffer, 2, 1));
      bytes.fill(9);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    });
    expect(sent).toEqual([]);

    write.resolve();
    await quiesce();
    expect(sent).toEqual([[1, 2, 3, 4], [2, 3], [3]]);
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

  test("a send that throws mutes the socket, as upstream's pump does", async () => {
    // ← `LegacyWebSocketAdapter::pump`'s `KJ_DEFER` (`web-socket.c++:1187-1207`): an unwind
    // that is not a clean completion clears `outgoingMessages` and sets
    // `native.outgoingAborted`, after which `send()` (`:816`) and `close()` (`:916`) return
    // silently. So the frame after a failed send is dropped and so is a queued close —
    // permanently, on one failure. Here that falls out of `.then(onFulfilled)` skipping its
    // callback on a rejected chain, which is why this test exists: it pins the
    // upstream-matching outcome against a refactor that would "repair" the chain into resuming.
    const { ctx, socket } = newFixture();
    const accepted = await ctx.run(() => acceptWebSocket(ctx, socket));
    const realSend = socket.send.bind(socket);
    // Only the FIRST send throws: a chain wrongly repaired into resuming delivery would then
    // surface as a delivered "after" rather than as another throw.
    let failNext = true;
    socket.send = (data) => {
      if (failNext) {
        failNext = false;
        throw new Error("peer already closed");
      }
      realSend(data);
    };

    await ctx.run(() => {
      accepted.send("throws");
      accepted.send("after");
      accepted.close(1000);
    });
    await quiesce();

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([]);
    // Upstream surfaces the abort as an error event; here it reaches the actor's failure channel.
    expect((ctx.waitUntilStatus() as Error | undefined)?.message).toBe("peer already closed");
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

/**
 * When a closed hibernatable socket leaves `getWebSockets()` and when `getTags()`
 * stops answering. Each expectation was measured against raw `workerd serve`
 * 1.20261031.1 (docs/workerd-sync.md, "getTags() and listing during
 * webSocketClose"); the conformance suite's D5-D7 rows replay the pair cases.
 */
describe("hibernatable close settlement", () => {
  const NOT_ACCEPTED =
    "you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.";

  function observe(registry: () => HibernatableWebSocketRegistry, socket: unknown) {
    const target = socket as RawWebSocket;
    let tags: unknown;
    try {
      tags = registry().getTags(target);
    } catch (error) {
      tags = (error as Error).message;
    }
    return { tags, listed: registry().getWebSockets().includes(target as WebSocket) };
  }

  function recordingRegistry(ctx: IoContext, onClose?: (socket: RawWebSocket) => void) {
    const seen: { event: string; sync: unknown; microtask?: unknown }[] = [];
    const registry: HibernatableWebSocketRegistry = new HibernatableWebSocketRegistry(ctx, {
      message: (socket, message) => {
        seen.push({ event: `message:${String(message)}`, sync: observe(() => registry, socket) });
      },
      close: async (socket, code) => {
        const entry: (typeof seen)[number] = {
          event: `close:${code}`,
          sync: observe(() => registry, socket),
        };
        seen.push(entry);
        onClose?.(socket);
        await Promise.resolve();
        entry.microtask = observe(() => registry, socket);
      },
      error: () => {},
    });
    return { registry, seen };
  }

  test("a pair's own close then echo: listed with tags in the handler, released a turn later", async () => {
    const { ctx } = newFixture();
    const { registry, seen } = recordingRegistry(ctx);
    const { 0: client, 1: server } = new registry.WebSocketPair();
    await ctx.run(() => {
      registry.acceptWebSocket(server, ["t"]);
      client.accept();
      server.close(4002, "server out");
    });
    await quiesce();
    const during = { tags: ["t"], listed: true };
    expect(seen).toEqual([{ event: "close:4002", sync: during, microtask: during }]);
    expect(observe(() => registry, server)).toEqual({ tags: NOT_ACCEPTED, listed: false });
  });

  test("a network transport's own close then echo never releases: the write completed first", async () => {
    const { ctx, socket } = newFixture();
    const { registry, seen } = recordingRegistry(ctx);
    await ctx.run(() => registry.acceptWebSocket(socket, ["t"]));
    const wrapper = registry.getWebSockets()[0]!;
    await ctx.run(() => wrapper.close(4002, "server out"));
    await quiesce();
    expect(socket.closed).toEqual([4002]);

    socket.dispatchEvent(new CloseEvent("close", { code: 4002, reason: "server out", wasClean: true }));
    await quiesce();
    expect(seen).toEqual([
      {
        event: "close:4002",
        sync: { tags: ["t"], listed: true },
        microtask: { tags: ["t"], listed: true },
      },
    ]);
    expect(observe(() => registry, wrapper)).toEqual({ tags: ["t"], listed: false });
    expect(observe(() => registry, socket)).toEqual({ tags: ["t"], listed: false });
  });

  test("a pair coupled to the host closes like a network transport: own close then echo keeps the tags", async () => {
    const { ctx } = newFixture();
    const { registry, seen } = recordingRegistry(ctx);
    const { 0: client, 1: server } = new registry.WebSocketPair();
    await ctx.run(() => registry.acceptWebSocket(server, ["t"]));
    // What returning the client half in a 101 response does: its peer is now the network.
    const host = (client as AcceptedWebSocket).coupleToHost();
    host.accept();
    const echoes: number[] = [];
    host.addEventListener("close", (event) => echoes.push((event as CloseEvent).code));
    await ctx.run(() => server.close(4002, "server out"));
    await quiesce();
    expect(echoes).toEqual([4002]);
    const during = { tags: ["t"], listed: true };
    expect(seen).toEqual([{ event: "close:4002", sync: during, microtask: during }]);
    expect(observe(() => registry, server)).toEqual({ tags: ["t"], listed: false });
  });

  test("a message ahead of a pair's echo takes the completion, so nothing releases", async () => {
    const { ctx } = newFixture();
    const { registry, seen } = recordingRegistry(ctx);
    const { 0: client, 1: server } = new registry.WebSocketPair();
    await ctx.run(() => {
      registry.acceptWebSocket(server, ["t"]);
      client.accept();
      server.close(4002, "server out");
      client.send("late");
    });
    await quiesce();
    expect(seen).toEqual([
      { event: "message:late", sync: { tags: ["t"], listed: true } },
      {
        event: "close:4002",
        sync: { tags: ["t"], listed: true },
        microtask: { tags: ["t"], listed: true },
      },
    ]);
    expect(observe(() => registry, server)).toEqual({ tags: ["t"], listed: false });
  });

  test("a close sent from webSocketClose completes after the dispatch and releases", async () => {
    const { ctx } = newFixture();
    const { registry, seen } = recordingRegistry(ctx, (socket) => socket.close(4001, "bye"));
    const { 0: client, 1: server } = new registry.WebSocketPair();
    await ctx.run(() => {
      registry.acceptWebSocket(server, ["t"]);
      client.accept();
      client.close(4001, "bye");
    });
    await quiesce();
    const during = { tags: ["t"], listed: true };
    expect(seen).toEqual([{ event: "close:4001", sync: during, microtask: during }]);
    expect(observe(() => registry, server)).toEqual({ tags: NOT_ACCEPTED, listed: false });
  });

  test("a released socket woken from hibernation is accepted again", async () => {
    const { ctx } = newFixture();
    const { registry } = recordingRegistry(ctx);
    const { 0: client, 1: server } = new registry.WebSocketPair();
    await ctx.run(() => {
      registry.acceptWebSocket(server, ["t"]);
      client.accept();
      server.close(4002, "server out");
    });
    await quiesce();
    expect(observe(() => registry, server).tags).toBe(NOT_ACCEPTED);

    const woken = new HibernatableWebSocketRegistry(
      ctx,
      { message: () => {}, close: () => {}, error: () => {} },
      undefined,
      [{ socket: server, tags: ["t"] }],
    );
    expect(woken.getTags(server)).toEqual(["t"]);
  });

  test("a close that never reaches a handler still leaves the list", async () => {
    const { ctx, socket } = newFixture();
    const { registry, seen } = recordingRegistry(ctx);
    await ctx.run(() => registry.acceptWebSocket(socket, ["t"]));
    ctx.abort(new Error("actor stopped"));
    socket.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
    await quiesce();
    expect(seen).toEqual([]);
    expect(registry.getWebSockets()).toEqual([]);
  });
});
