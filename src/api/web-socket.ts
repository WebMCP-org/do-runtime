/**
 * ← workerd `src/workerd/api/web-socket.{h,c++}` — classic and hibernatable
 * socket delivery over the actor's input/output gates.
 *
 * The runtime owns the WebSocket object produced by `WebSocketPair`; embedders
 * still own network transports supplied as `RawWebSocket`s. Hibernation state is
 * per container and can be mirrored through `HibernationHost` for reconstruction.
 */

import type { IoContext } from "../io/io-context";
import type { CriticalSection } from "../io/io-gate";
import { deserializeValue, serializeValue } from "./actor-state";

export interface RawWebSocket {
  addEventListener(type: string, listener: (event: Event) => void): void;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  readonly readyState?: number;
  binaryType?: string;
}

export interface HibernationHost {
  /** Retained auto-response configuration, restored before actor construction. */
  readonly autoResponsePair?: { request: string; response: string } | null;
  accepted(socket: RawWebSocket, tags: readonly string[]): void;
  attachment(socket: RawWebSocket, bytes: Uint8Array | null): void;
  autoResponse(pair: { request: string; response: string } | null): void;
  autoResponseTimestamp?(socket: RawWebSocket, timestamp: number): void;
  closed(socket: RawWebSocket): void;
}

export type RehydratedWebSocket = {
  socket: RawWebSocket;
  tags?: readonly string[];
  attachment?: Uint8Array;
  autoResponseTimestamp?: number;
};

type WebSocketPairConstructor = typeof WebSocketPair;

class WebSocketRequestResponsePairImpl implements WebSocketRequestResponsePair {
  readonly #request: string;
  readonly #response: string;

  constructor(request: string, response: string) {
    this.#request = String(request);
    this.#response = String(response);
  }

  get request(): string {
    return this.#request;
  }

  get response(): string {
    return this.#response;
  }
}

const RuntimeWebSocketRequestResponsePair: typeof WebSocketRequestResponsePair =
  new Proxy(WebSocketRequestResponsePairImpl, {
    apply(): never {
      throw new TypeError(
        "Failed to construct 'WebSocketRequestResponsePair': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
      );
    },
  });

export { RuntimeWebSocketRequestResponsePair as WebSocketRequestResponsePair };

type RuntimeWebSocketPair = {
  0: AcceptedWebSocket;
  1: AcceptedWebSocket;
};

/** ← the `JSG_REQUIRE(!native.state.is<Accepted>(), ...)` at the head of `accept()`. */
export const ALREADY_ACCEPTED_MESSAGE =
  "acceptWebSocket(): this socket has already been accepted by an actor. A socket's frames are " +
  "delivered by exactly one read loop, and a second accept would deliver them under two gates.";

export const HIBERNATION_ALREADY_ACCEPTED_MESSAGE =
  "Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`";
export const HIBERNATION_AFTER_ACCEPT_MESSAGE =
  "Can't accept() WebSocket after enabling hibernation.";
export const HIBERNATION_PAIR_USED_MESSAGE =
  "Cannot call `acceptWebSocket()` on this WebSocket because its pair has already been accepted or used in a Response.";

const MAX_HIBERNATABLE_SOCKETS = 32_768;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 256;
const MAX_ATTACHMENT_BYTES = 16_384;
const MAX_AUTO_RESPONSE_BYTES = 2_048;
const MAX_EVENT_TIMEOUT = 604_800_000;
const MAX_CLOSE_REASON_BYTES = 123;

const WEB_SOCKET_READY_STATES = {
  READY_STATE_CONNECTING: 0,
  READY_STATE_OPEN: 1,
  READY_STATE_CLOSING: 2,
  READY_STATE_CLOSED: 3,
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

const textEncoder = new TextEncoder();

const SOCKET_EVENTS = ["open", "message", "close", "error"] as const;
type SocketEvent = (typeof SOCKET_EVENTS)[number];

type PairState = {
  used: boolean;
  hibernationAccepted: boolean;
};

type SocketAcceptance =
  | { mode: "classic" }
  | { mode: "hibernatable"; registry: HibernatableWebSocketRegistry };

type SocketDelivery =
  | { mode: "pending" }
  | { mode: "classic"; criticalSection: CriticalSection | undefined }
  | { mode: "hibernatable"; registry: HibernatableWebSocketRegistry };

type SocketMetadata = {
  accepted?: SocketAcceptance;
  attachment?: Uint8Array;
  rawListenersInstalled?: true;
};

const metadata = new WeakMap<object, SocketMetadata>();

function socketMetadata(socket: object): SocketMetadata {
  let value = metadata.get(socket);
  if (value === undefined) {
    value = {};
    metadata.set(socket, value);
  }
  return value;
}

function isRawWebSocket(value: unknown): value is RawWebSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "send" in value &&
    typeof value.send === "function" &&
    "close" in value &&
    typeof value.close === "function"
  );
}

function requireWebSocket(value: unknown, operation: string): RawWebSocket {
  if (!isRawWebSocket(value)) {
    throw new TypeError(
      `Failed to execute '${operation}' on 'WebSocket': parameter 1 is not of type 'WebSocket'.`,
    );
  }
  return value;
}

function serializeAttachment(socket: RawWebSocket, value: unknown): void {
  try {
    structuredClone(value);
  } catch (error) {
    if (error instanceof DOMException && error.name === "DataCloneError") {
      throw new DOMException(
        error.message.replace(/^Failed to execute 'structuredClone' on '[^']+': /, ""),
        "DataCloneError",
      );
    }
    throw error;
  }
  const bytes = serializeValue(value);
  // ponytail: the local codec's string envelope is seven bytes wider than V8's;
  // replace this size adapter if the package adopts V8 wire bytes.
  const measuredBytes =
    typeof value === "string" ? textEncoder.encode(value).byteLength + 5 : bytes.byteLength;
  if (measuredBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `A WebSocket 'attachment' cannot be larger than ${MAX_ATTACHMENT_BYTES} bytes.'attachment' was ${measuredBytes} bytes.`,
    );
  }
  const state = socketMetadata(socket);
  state.attachment = bytes;
  if (state.accepted?.mode === "hibernatable") {
    state.accepted.registry.attachmentChanged(socket, bytes);
  }
}

function deserializeAttachment(socket: RawWebSocket): unknown {
  const attachment = socketMetadata(socket).attachment;
  if (attachment === undefined) return null;
  return deserializeValue("WebSocket attachment", attachment);
}

function serializeAttachmentMethod(this: unknown, value?: unknown): void {
  if (arguments.length === 0) {
    throw new TypeError(
      "Failed to execute 'serializeAttachment' on 'WebSocket': parameter 1 is not of type 'Value'.",
    );
  }
  serializeAttachment(requireWebSocket(this, "serializeAttachment"), value);
}

function deserializeAttachmentMethod(this: unknown): unknown {
  return deserializeAttachment(requireWebSocket(this, "deserializeAttachment"));
}

function cloneMessageData(data: unknown): string | ArrayBuffer | Blob {
  if (typeof data === "string" || data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return String(data);
}

class MemoryWebSocketEndpoint extends EventTarget implements RawWebSocket {
  peer!: MemoryWebSocketEndpoint;
  #sentClose = false;

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.peer.dispatchEvent(new MessageEvent("message", { data: cloneMessageData(data) }));
  }

  close(code = 1000, reason = ""): void {
    if (this.#sentClose) return;
    this.#sentClose = true;
    this.peer.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
  }
}

/** One public socket identity, in classic or hibernatable mode after acceptance. */
export class AcceptedWebSocket extends EventTarget implements RawWebSocket, WebSocket {
  static readonly READY_STATE_CONNECTING = WEB_SOCKET_READY_STATES.READY_STATE_CONNECTING;
  static readonly READY_STATE_OPEN = WEB_SOCKET_READY_STATES.READY_STATE_OPEN;
  static readonly READY_STATE_CLOSING = WEB_SOCKET_READY_STATES.READY_STATE_CLOSING;
  static readonly READY_STATE_CLOSED = WEB_SOCKET_READY_STATES.READY_STATE_CLOSED;
  static readonly CONNECTING = WEB_SOCKET_READY_STATES.CONNECTING;
  static readonly OPEN = WEB_SOCKET_READY_STATES.OPEN;
  static readonly CLOSING = WEB_SOCKET_READY_STATES.CLOSING;
  static readonly CLOSED = WEB_SOCKET_READY_STATES.CLOSED;

  declare readonly READY_STATE_CONNECTING: 0;
  declare readonly READY_STATE_OPEN: 1;
  declare readonly READY_STATE_CLOSING: 2;
  declare readonly READY_STATE_CLOSED: 3;
  declare readonly CONNECTING: 0;
  declare readonly OPEN: 1;
  declare readonly CLOSING: 2;
  declare readonly CLOSED: 3;
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";
  readonly url = "";

  #ctx: IoContext;
  readonly #socket: RawWebSocket;
  readonly #pairState: PairState | undefined;
  #delivery: SocketDelivery = { mode: "pending" };
  #pump: Promise<void> = Promise.resolve();
  #pending: { type: SocketEvent; event: Event }[] = [];
  #readyState: number = AcceptedWebSocket.OPEN;
  #ownClose = false;
  #peerClose = false;
  #binaryType: "blob" | "arraybuffer" = "blob";

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(ctx: IoContext, socket: RawWebSocket, pairState?: PairState) {
    super();
    this.#ctx = ctx;
    this.#socket = socket;
    this.#pairState = pairState;
    if (pairState === undefined) this.#enableClassic();
    for (const type of SOCKET_EVENTS) {
      socket.addEventListener(type, (event: Event) => {
        this.#receive(type, event);
      });
    }
  }

  get readyState(): number {
    return this.#readyState;
  }

  get binaryType(): "blob" | "arraybuffer" {
    return this.#binaryType;
  }

  set binaryType(value: "blob" | "arraybuffer") {
    this.#binaryType = value;
  }

  accept(): void {
    if (this.#delivery.mode === "hibernatable") {
      throw new TypeError(HIBERNATION_AFTER_ACCEPT_MESSAGE);
    }
    if (this.#delivery.mode === "classic") throw new Error(ALREADY_ACCEPTED_MESSAGE);
    if (this.#pairState !== undefined) this.#pairState.used = true;
    this.#enableClassic();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.#delivery.mode === "hibernatable" && this.#ownClose) {
      throw new TypeError("Can't call WebSocket send() after close().");
    }
    if (this.#peerClose || this.#readyState === AcceptedWebSocket.CLOSED) return;
    this.#markPairUsed();
    this.#enqueue(() => this.#socket.send(data));
  }

  close(code?: number, reason = ""): void {
    if (this.#readyState === AcceptedWebSocket.CLOSED || this.#ownClose) return;
    if (this.#delivery.mode === "hibernatable" || this.#pairState !== undefined) {
      validateClose(code, reason);
    }
    this.#markPairUsed();
    this.#ownClose = true;
    this.#readyState = this.#peerClose ? AcceptedWebSocket.CLOSED : AcceptedWebSocket.CLOSING;
    this.#enqueue(() => this.#socket.close(code, reason));
  }

  serializeAttachment(value: unknown): void {
    if (arguments.length === 0) serializeAttachmentMethod.call(this);
    else serializeAttachment(this, value);
  }

  deserializeAttachment(): unknown {
    return deserializeAttachment(this);
  }

  acceptHibernation(registry: HibernatableWebSocketRegistry): void {
    if (this.#delivery.mode !== "pending") {
      throw new Error(HIBERNATION_ALREADY_ACCEPTED_MESSAGE);
    }
    if (this.#pairState?.used === true && !this.#pairState.hibernationAccepted) {
      throw new Error(HIBERNATION_PAIR_USED_MESSAGE);
    }
    if (this.#pairState !== undefined) {
      this.#pairState.used = true;
      this.#pairState.hibernationAccepted = true;
    }
    this.#activateHibernation(registry, this.#ctx);
  }

  rehydrateHibernation(registry: HibernatableWebSocketRegistry, ctx: IoContext): void {
    this.#activateHibernation(registry, ctx);
  }

  #activateHibernation(registry: HibernatableWebSocketRegistry, ctx: IoContext): void {
    this.#ctx = ctx;
    this.#delivery = { mode: "hibernatable", registry };
    this.#pending = [];
  }

  markPairUsed(): void {
    this.#markPairUsed();
  }

  #markPairUsed(): void {
    if (this.#pairState !== undefined) this.#pairState.used = true;
  }

  #enableClassic(): void {
    const delivery: SocketDelivery = {
      mode: "classic",
      criticalSection: this.#ctx.getCriticalSection(),
    };
    this.#delivery = delivery;
    socketMetadata(this).accepted = { mode: "classic" };
    const pending = this.#pending;
    this.#pending = [];
    for (const item of pending) {
      this.#deliverClassic(item.type, item.event, delivery.criticalSection);
    }
  }

  #receive(type: SocketEvent, event: Event): void {
    if (type === "close") {
      this.#receiveClose(event as CloseEvent);
      return;
    }
    const delivery = this.#delivery;
    if (delivery.mode === "pending") this.#pending.push({ type, event });
    else if (delivery.mode === "classic") {
      this.#deliverClassic(type, event, delivery.criticalSection);
    } else delivery.registry.receive(this, type, event);
  }

  #receiveClose(event: CloseEvent): void {
    if (this.#ownClose) {
      this.#readyState = AcceptedWebSocket.CLOSED;
    } else {
      this.#peerClose = true;
      this.#readyState = AcceptedWebSocket.CLOSING;
      if (this.#delivery.mode === "classic" && this.#pairState !== undefined) {
        // Pair halves perform the WebSocket close handshake in-memory. An
        // embedder-supplied raw socket owns its own protocol and only reports.
        if (event.code === 1005 || event.code === 1006 || event.code === 1015) {
          this.#readyState = AcceptedWebSocket.CLOSED;
        } else {
          this.close(event.code, event.reason);
        }
      }
    }
    const delivery = this.#delivery;
    if (delivery.mode === "pending") this.#pending.push({ type: "close", event });
    else if (delivery.mode === "classic") {
      this.#deliverClassic("close", event, delivery.criticalSection);
    } else delivery.registry.receive(this, "close", event);
  }

  #deliverClassic(
    type: SocketEvent,
    event: Event,
    criticalSection: CriticalSection | undefined,
  ): void {
    this.#ctx.addWaitUntil(
      this.#ctx.run(() => {
        const delivered = cloneEventFor(type, event);
        this.dispatchEvent(delivered);
        const handler = this[`on${type}`] as ((event: Event) => void) | null;
        handler?.(delivered);
      }, { input: criticalSection }),
    );
  }

  #enqueue(write: () => void): void {
    const outputLock = this.#ctx.waitForOutputLocks();
    this.#pump = this.#pump.then(async () => {
      await outputLock;
      write();
    });
    this.#ctx.addWaitUntil(this.#pump);
  }
}

for (const [name, value] of Object.entries(WEB_SOCKET_READY_STATES)) {
  Object.defineProperty(AcceptedWebSocket.prototype, name, { value, enumerable: true });
}

type HandlerDispatch = {
  message(socket: RawWebSocket, message: string | ArrayBuffer): unknown;
  close(socket: RawWebSocket, code: number, reason: string, wasClean: boolean): unknown;
  error(socket: RawWebSocket, error: unknown): unknown;
};

type RegistryEntry = {
  readonly socket: RawWebSocket;
  readonly tags: string[];
  autoResponseTimestamp?: number;
};

export class HibernatableWebSocketRegistry {
  readonly #ctx: IoContext;
  readonly #dispatch: HandlerDispatch;
  readonly #host: HibernationHost | undefined;
  readonly #entries: RegistryEntry[] = [];
  #autoResponse: WebSocketRequestResponsePair | null = null;
  #eventTimeout: number | null = null;
  #pairConstructor: WebSocketPairConstructor | undefined;

  constructor(
    ctx: IoContext,
    dispatch: HandlerDispatch,
    host?: HibernationHost,
    rehydrated: readonly RehydratedWebSocket[] = [],
  ) {
    this.#ctx = ctx;
    this.#dispatch = dispatch;
    this.#host = host;
    const pair = host?.autoResponsePair;
    if (pair != null) {
      this.setWebSocketAutoResponse(new RuntimeWebSocketRequestResponsePair(pair.request, pair.response));
    }
    for (const value of rehydrated) this.#rehydrate(value);
  }

  get WebSocketPair(): WebSocketPairConstructor {
    this.#pairConstructor ??= new Proxy(
      class WebSocketPair {
        declare readonly 0: WebSocket;
        declare readonly 1: WebSocket;
      },
      { construct: () => this.#createPair() },
    );
    return this.#pairConstructor;
  }

  acceptWebSocket(socket: RawWebSocket, tags?: string[]): void {
    if (!isRawWebSocket(socket)) {
      throw new TypeError(
        "Failed to execute 'acceptWebSocket' on 'DurableObjectState': parameter 1 is not of type 'WebSocket'.",
      );
    }
    const state = socketMetadata(socket);
    if (state.accepted !== undefined) throw new Error(HIBERNATION_ALREADY_ACCEPTED_MESSAGE);
    if (this.#entries.length >= MAX_HIBERNATABLE_SOCKETS) {
      throw new Error(
        `only ${MAX_HIBERNATABLE_SOCKETS} websockets can be accepted on a single Durable Object instance`,
      );
    }
    const normalizedTags = normalizeTags(tags);
    if (socket instanceof AcceptedWebSocket) socket.acceptHibernation(this);
    else this.#listenRaw(socket);
    state.accepted = { mode: "hibernatable", registry: this };
    this.#entries.push({ socket, tags: normalizedTags });
    this.#host?.accepted(socket, normalizedTags);
  }

  getWebSockets(tag?: string): WebSocket[] {
    if (arguments.length > 0) {
      if (typeof tag !== "string") return [];
      return this.#entries
        .filter((entry) => entry.tags.includes(tag))
        .map((entry) => entry.socket as WebSocket);
    }
    return this.#entries.map((entry) => entry.socket as WebSocket).reverse();
  }

  getTags(socket: RawWebSocket): string[] {
    const state = isRawWebSocket(socket) ? metadata.get(socket) : undefined;
    if (state?.accepted === undefined) {
      throw new Error(
        "you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.",
      );
    }
    if (state.accepted.mode !== "hibernatable") {
      throw new Error("only hibernatable websockets can have tags.");
    }
    const entry = this.#entries.find((candidate) => candidate.socket === socket);
    if (entry === undefined) {
      throw new Error(
        "you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.",
      );
    }
    return [...entry.tags];
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void {
    if (pair === undefined) {
      this.#autoResponse = null;
      this.#host?.autoResponse(null);
      return;
    }
    if (!(pair instanceof WebSocketRequestResponsePairImpl)) {
      throw new TypeError(
        "Failed to execute 'setWebSocketAutoResponse' on 'DurableObjectState': parameter 1 is not of type 'WebSocketRequestResponsePair'.",
      );
    }
    validateAutoResponseSize("Request", pair.request);
    validateAutoResponseSize("Response", pair.response);
    this.#autoResponse = pair;
    this.#host?.autoResponse({ request: pair.request, response: pair.response });
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    const pair = this.#autoResponse;
    return pair === null
      ? null
      : new RuntimeWebSocketRequestResponsePair(pair.request, pair.response);
  }

  getWebSocketAutoResponseTimestamp(socket: RawWebSocket): Date | null {
    if (!isRawWebSocket(socket)) {
      throw new TypeError(
        "Failed to execute 'getWebSocketAutoResponseTimestamp' on 'DurableObjectState': parameter 1 is not of type 'WebSocket'.",
      );
    }
    const timestamp = this.#entries.find((entry) => entry.socket === socket)?.autoResponseTimestamp;
    return timestamp === undefined ? null : new Date(timestamp);
  }

  setHibernatableWebSocketEventTimeout(value?: number): void {
    if (value === undefined || Number(value) === 0) {
      this.#eventTimeout = null;
      return;
    }
    const number = Number(value);
    if (Number.isNaN(number)) {
      throw new TypeError("The value cannot be converted because it is not an integer.");
    }
    if (number < 0) {
      throw new TypeError(
        "The value cannot be converted because it is negative and this API expects a positive number.",
      );
    }
    if (number > 0xffff_ffff) {
      throw new TypeError("Value out of range. Must be less than or equal to 4294967295.");
    }
    const timeout = Math.trunc(number);
    if (timeout > MAX_EVENT_TIMEOUT) {
      throw new Error(`Event timeout should not exceed ${MAX_EVENT_TIMEOUT} ms.`);
    }
    this.#eventTimeout = timeout;
  }

  getHibernatableWebSocketEventTimeout(): number | null {
    return this.#eventTimeout;
  }

  attachmentChanged(socket: RawWebSocket, bytes: Uint8Array): void {
    if (this.#entries.some((entry) => entry.socket === socket)) {
      this.#host?.attachment(socket, bytes);
    }
  }

  receive(socket: RawWebSocket, type: SocketEvent, event: Event): void {
    const entry = this.#entries.find((candidate) => candidate.socket === socket);
    if (entry === undefined) return;
    if (type === "message") {
      const data = (event as MessageEvent).data as unknown;
      if (typeof data === "string" && data === this.#autoResponse?.request) {
        entry.autoResponseTimestamp = this.#ctx.now();
        this.#host?.autoResponseTimestamp?.(socket, entry.autoResponseTimestamp);
        socket.send(this.#autoResponse.response);
        return;
      }
      const message = cloneMessageData(data);
      if (message instanceof Blob) {
        this.#ctx.addWaitUntil(
          message.arrayBuffer().then((buffer) => {
            this.#schedule(() => this.#dispatch.message(socket, buffer));
          }),
        );
        return;
      }
      this.#schedule(() => this.#dispatch.message(socket, message));
      return;
    }
    if (type === "close") {
      this.#remove(entry);
      const close = event as CloseEvent;
      this.#schedule(() =>
        this.#dispatch.close(socket, close.code, close.reason, close.wasClean),
      );
      return;
    }
    if (type === "error") this.#schedule(() => this.#dispatch.error(socket, event));
  }

  #schedule(handler: () => unknown): void {
    this.#ctx.addWaitUntil(this.#ctx.run(handler).then(() => {}));
  }

  #remove(entry: RegistryEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index === -1) return;
    this.#entries.splice(index, 1);
    this.#host?.closed(entry.socket);
  }

  #listenRaw(socket: RawWebSocket): void {
    const state = socketMetadata(socket);
    if (state.rawListenersInstalled === true) return;
    state.rawListenersInstalled = true;
    for (const type of ["message", "close", "error"] as const) {
      socket.addEventListener(type, (event) => {
        const accepted = socketMetadata(socket).accepted;
        if (accepted?.mode === "hibernatable") {
          accepted.registry.receive(socket, type, event);
        }
      });
    }
  }

  #rehydrate(value: RehydratedWebSocket): void {
    const socket = value.socket;
    if (!isRawWebSocket(socket)) {
      throw new TypeError("ActorContainerOptions.webSockets contains a non-WebSocket value.");
    }
    const tags = normalizeTags(value.tags);
    const state = socketMetadata(socket);
    state.accepted = { mode: "hibernatable", registry: this };
    if (value.attachment !== undefined) {
      state.attachment = value.attachment.slice();
    }
    if (socket instanceof AcceptedWebSocket) socket.rehydrateHibernation(this, this.#ctx);
    else this.#listenRaw(socket);
    const entry: RegistryEntry = { socket, tags };
    if (value.autoResponseTimestamp !== undefined) {
      entry.autoResponseTimestamp = value.autoResponseTimestamp;
    }
    this.#entries.push(entry);
  }

  #createPair(): RuntimeWebSocketPair {
    const pairState: PairState = { used: false, hibernationAccepted: false };
    const left = new MemoryWebSocketEndpoint();
    const right = new MemoryWebSocketEndpoint();
    left.peer = right;
    right.peer = left;
    return {
      0: new AcceptedWebSocket(this.#ctx, left, pairState),
      1: new AcceptedWebSocket(this.#ctx, right, pairState),
    };
  }
}

export function acceptWebSocket(ctx: IoContext, socket: RawWebSocket): AcceptedWebSocket {
  const state = socketMetadata(socket);
  if (state.accepted !== undefined) throw new Error(ALREADY_ACCEPTED_MESSAGE);
  if (socket instanceof AcceptedWebSocket) {
    socket.accept();
    return socket;
  }
  state.accepted = { mode: "classic" };
  const accepted = new AcceptedWebSocket(ctx, socket);
  return accepted;
}

export function markWebSocketUsed(socket: RawWebSocket): void {
  if (socket instanceof AcceptedWebSocket) socket.markPairUsed();
}

export function installWebSocketGlobals(
  target: object,
  pairConstructor: WebSocketPairConstructor,
): void {
  const constructor = globalThis.WebSocket;
  for (const [name, value] of Object.entries(WEB_SOCKET_READY_STATES)) {
    defineValue(constructor, name, value);
    defineValue(constructor.prototype, name, value);
  }
  defineValue(constructor.prototype, "serializeAttachment", serializeAttachmentMethod);
  defineValue(constructor.prototype, "deserializeAttachment", deserializeAttachmentMethod);
  defineValue(target, "WebSocket", constructor);
  defineValue(target, "WebSocketPair", pairConstructor);
  defineValue(target, "WebSocketRequestResponsePair", RuntimeWebSocketRequestResponsePair);
}

function defineValue(target: object, name: string, value: unknown): void {
  const current = Object.getOwnPropertyDescriptor(target, name);
  if (current?.configurable === false) return;
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) {
    throw new TypeError(
      "Failed to execute 'acceptWebSocket' on 'DurableObjectState': parameter 2 is not of type 'Array'.",
    );
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`a Hibernatable WebSocket cannot have more than ${MAX_TAGS} tags`);
  }
  const normalized = [...new Set(tags.map(String))];
  for (const tag of normalized) {
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(
        `"${tag}" is longer than the max tag length (${MAX_TAG_LENGTH} characters).`,
      );
    }
  }
  return normalized;
}

function validateAutoResponseSize(side: "Request" | "Response", value: string): void {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > MAX_AUTO_RESPONSE_BYTES) {
    throw new RangeError(
      `${side} cannot be larger than ${MAX_AUTO_RESPONSE_BYTES} bytes. A ${side.toLowerCase()} of size ${bytes} was provided.`,
    );
  }
}

function validateClose(code: number | undefined, reason: string): void {
  if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
    throw new DOMException(`Invalid WebSocket close code: ${code}.`, "InvalidAccessError");
  }
  if (textEncoder.encode(reason).byteLength > MAX_CLOSE_REASON_BYTES) {
    throw new DOMException(
      `WebSocket close reason must not be longer than ${MAX_CLOSE_REASON_BYTES} bytes when UTF-8 encoded.`,
      "SyntaxError",
    );
  }
}

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
