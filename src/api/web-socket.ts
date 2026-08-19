/**
 * ← workerd `src/workerd/api/web-socket.{h,c++}` — the gating, and nothing else.
 *
 * A socket is the one primitive that is neither of the other two, and §1.8 says
 * why in three lines: incoming frames "each take a fresh input lock via
 * `context.run(...)`", the read loop "captures the critical section at
 * `accept()` time", and outbound messages "each carry their own output-gate
 * promise captured at `send()` time". Upstream states the first outright, on the
 * line that does it (`web-socket.c++:1056-1059`):
 *
 * > "Re-enter the context with context.run(). This is arguably a bit unusual
 * > compared to other I/O which is delivered by return from context.awaitIo(),
 * > but the difference here is that we have a long stream of events over time.
 * > It makes sense to use context.run() each time a new event arrives."
 *
 * So a socket cannot be `awaitIo`: there is no single result to resume from.
 * `accept()` starts a loop, and the loop is the gate's caller.
 *
 * **What is ported and what is not.** The frame protocol, the hibernation
 * states, auto-response, `WebSocketPair` and the byte accounting are all
 * absent — the substrate ships a `WebSocket`, and hibernation is a recorded
 * substrate boundary with no Chrome lifecycle to be faithful to. What is here is
 * `WebSocket::Accepted`: the three gate properties above, over whatever socket
 * the host hands in. That is the same division `api/http.ts` makes and for the
 * same reason.
 *
 * **The accept contract, and the hole it leaves.** After `acceptWebSocket`, the
 * gated view owns the raw socket's events. A consumer that keeps a reference to
 * the raw socket and registers a listener on it directly gets that listener
 * called ungated, and nothing here can prevent it — upstream cannot be reached
 * that way because `accept()` moves the `kj::WebSocket` into `Accepted` and the
 * JS object never had it. The refusal below covers the case that is detectable
 * (accepting the same socket twice); the rest is the accept contract, stated.
 *
 * Spec: §1.1, §1.8 and decision 5 in
 * docs/decisions.md.
 */

import type { IoContext } from "../io/io-context";
import type { CriticalSection } from "../io/io-gate";

/**
 * The socket beneath. Deliberately structural and minimal: a real `WebSocket`,
 * the extension's `WebSocketFacade` over capnweb, and a test double all satisfy
 * it, and none of them is a type this package should name.
 */
export interface RawWebSocket {
  addEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
}

/** ← the `JSG_REQUIRE(!native.state.is<Accepted>(), ...)` at the head of `accept()`. */
export const ALREADY_ACCEPTED_MESSAGE =
  "acceptWebSocket(): this socket has already been accepted by an actor. A socket's frames are " +
  "delivered by exactly one read loop, and a second accept would deliver them under two gates.";

/** Sockets this runtime has accepted, so the refusal above is answerable. */
const accepted = new WeakSet<RawWebSocket>();

/** The four events a `WebSocket` dispatches, which `readLoop` and its `.then` cover upstream. */
const SOCKET_EVENTS = ["open", "message", "close", "error"] as const;
type SocketEvent = (typeof SOCKET_EVENTS)[number];

/**
 * ← `WebSocket::Accepted` (`web-socket.h:~300-360`), reached through
 * `accept()` → `internalAccept(js, IoContext::current().getCriticalSection())`
 * → `startReadLoop` (`web-socket.c++:133`, `:426`, `:429-433`, `:507`).
 *
 * An `EventTarget`, so a consumer registers listeners the way it would on a real
 * socket — but on THIS object rather than on the raw one, because this is what
 * runs them inside a gated slice.
 */
export class AcceptedWebSocket extends EventTarget {
  readonly #ctx: IoContext;
  readonly #socket: RawWebSocket;
  /**
   * ← `readLoop`'s `cs` parameter, captured at accept and replayed for every
   * frame via `mapAddRef(cs)` (`web-socket.c++:1110`). A socket accepted inside
   * `blockConcurrencyWhile` therefore delivers its messages inside that critical
   * section — §1.8's second bullet, and the reason this is captured here rather
   * than read when a frame arrives.
   */
  readonly #criticalSection: CriticalSection | undefined;

  /**
   * ← `OutgoingMessagesMap outgoingMessages` plus `ensurePumping`
   * (`web-socket.h:582-590`, `web-socket.c++:948-975`), as a chain.
   *
   * The table is insertion-ordered and the pump awaits each entry's own
   * `outputLock` before sending it, so messages leave in order and message N
   * waits only for the writes outstanding when IT was enqueued. A promise chain
   * is the same two properties with nothing to schedule.
   */
  #pump: Promise<void> = Promise.resolve();

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(ctx: IoContext, socket: RawWebSocket) {
    super();
    this.#ctx = ctx;
    this.#socket = socket;
    this.#criticalSection = ctx.getCriticalSection();

    // ← `startReadLoop`. One listener per event type on the raw socket, forever; each delivery is
    // one gated run. Upstream's loop is a coroutine over `ws.receive()`, which is the same shape
    // an event listener already is here.
    for (const type of SOCKET_EVENTS) {
      socket.addEventListener(type, (event: Event) => {
        this.#deliver(type, event);
      });
    }
  }

  /**
   * ← `co_await context.run([...](auto& wLock) { dispatchEventImpl(...) }, mapAddRef(cs))`
   * (`web-socket.c++:1065-1110`).
   *
   * The run rides `addWaitUntil`, as upstream's read loop does ("We put the read
   * loop in a `waitUntil`, since there would otherwise be a race condition
   * between delivering the final close message and the request being canceled",
   * `web-socket.c++:537-541`). That is also what stops a listener's throw
   * becoming an unhandled rejection: it lands in `waitUntilStatus()`.
   */
  #deliver(type: SocketEvent, event: Event): void {
    this.#ctx.addWaitUntil(
      this.#ctx.run(() => {
        // One rebuilt event for both forms: handing the handler the raw one would give it a
        // different `target` from the listener beside it, for the same frame.
        const delivered = cloneEventFor(type, event);
        this.dispatchEvent(delivered);
        // Consumers use both forms — a client library sets handlers, a server library listens —
        // so both are called, exactly as `WebSocketFacade` does for the same reason.
        const handler = this[`on${type}`] as ((event: Event) => void) | null;
        handler?.(delivered);
      }, this.#criticalSection),
    );
  }

  /**
   * ← `WebSocket::send` (`web-socket.c++:~640`), which inserts a
   * `GatedMessage{IoContext::current().waitForOutputLocksIfNecessary(), …}`.
   *
   * Synchronous, as upstream's is: the wait is the pump's, not the caller's. The
   * output gate is what "blocks all outgoing messages from an actor that would
   * allow the rest of the world to observe the actor's state" (§1.1), and a
   * socket frame is exactly such a message.
   *
   * `waitForOutputLocksIfNecessary()` collapses to `waitForOutputLocks()` here
   * for the reason the whole file collapses `kj::Maybe<Worker::Actor&>`: its
   * body is `actor.map(…)` (`io-context.c++:383-386`) and every context in this
   * runtime is an actor context.
   */
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.#enqueue(() => {
      this.#socket.send(data);
    });
  }

  /** ← `WebSocket::close`, which enqueues a `Close` through the same gate. */
  close(code?: number, reason?: string): void {
    this.#enqueue(() => {
      this.#socket.close(code, reason);
    });
  }

  #enqueue(write: () => void): void {
    // Captured HERE, at the call, so message N waits for the writes outstanding when it was
    // enqueued and not for whatever is outstanding when the pump reaches it.
    const outputLock = this.#ctx.waitForOutputLocks();
    this.#pump = this.#pump.then(async () => {
      await outputLock;
      write();
    });
    // The chain is the actor's work, so a broken output gate reports where every other background
    // failure reports rather than as an unhandled rejection.
    this.#ctx.addWaitUntil(this.#pump);
  }
}

/**
 * ← `accept()` / `state.acceptWebSocket()`, as the one verb.
 *
 * Named for what upstream names it, because the critical-section capture is a
 * property of accepting rather than of constructing: "a socket accepted inside a
 * `blockConcurrencyWhile` delivers its messages inside that critical section"
 * (§1.8).
 */
export function acceptWebSocket(ctx: IoContext, socket: RawWebSocket): AcceptedWebSocket {
  if (accepted.has(socket)) throw new Error(ALREADY_ACCEPTED_MESSAGE);
  accepted.add(socket);
  return new AcceptedWebSocket(ctx, socket);
}

/**
 * An `Event` may be dispatched by exactly one target at a time, so the raw
 * socket's event object cannot be re-dispatched: `dispatchEvent` on an event
 * that is already dispatched throws `InvalidStateError`, and one that has
 * finished carries the raw socket as its `target`. Rebuilding it is what makes
 * `event.target` the accepted socket, which is what a listener expects.
 */
function cloneEventFor(type: SocketEvent, event: Event): Event {
  if (type === "message") {
    const source = event as MessageEvent;
    return new MessageEvent("message", {
      data: source.data,
      origin: source.origin,
      lastEventId: source.lastEventId,
    });
  }
  if (type === "close") {
    const source = event as CloseEvent;
    return new CloseEvent("close", {
      code: source.code,
      reason: source.reason,
      wasClean: source.wasClean,
    });
  }
  return new Event(type);
}
