import type { RawWebSocket } from "../api/web-socket";

export type MessagePortWebSocketData = string | ArrayBuffer | ArrayBufferView;

export type MessagePortWebSocketWireMessage =
  | { readonly type: "message"; readonly data: MessagePortWebSocketData }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

type MessagePortWebSocketReadyMessage = { readonly type: "open" };

export type AcceptingWebSocket = EventTarget &
  RawWebSocket & {
    accept(): void;
    readonly readyState: number;
  };

/** One WebSocket-shaped endpoint backed by one dedicated MessagePort. */
export class MessagePortWebSocket extends EventTarget implements RawWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MessagePortWebSocket.CONNECTING;
  readonly OPEN = MessagePortWebSocket.OPEN;
  readonly CLOSING = MessagePortWebSocket.CLOSING;
  readonly CLOSED = MessagePortWebSocket.CLOSED;

  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState: number = MessagePortWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<MessagePortWebSocketData>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  readonly #queuedWireMessages: MessagePortWebSocketWireMessage[] = [];
  #queuedWireFlushPending = false;

  constructor(
    readonly url: string,
    private readonly port: MessagePort,
    autoOpen = true,
  ) {
    super();
    this.port.addEventListener(
      "message",
      (event: MessageEvent<
        MessagePortWebSocketWireMessage | MessagePortWebSocketReadyMessage
      >) => {
        this.#handleWireMessage(event.data);
      },
    );
    this.port.start();
    if (autoOpen) queueMicrotask(() => this.open());
  }

  send(data: MessagePortWebSocketData): void {
    if (this.readyState !== MessagePortWebSocket.OPEN) {
      throw new TypeError("WebSocket send() after close");
    }
    this.port.postMessage({ type: "message", data } satisfies MessagePortWebSocketWireMessage);
  }

  close(code = 1000, reason = ""): void {
    if (!this.#beginClose()) return;
    this.port.postMessage({ type: "close", code, reason } satisfies MessagePortWebSocketWireMessage);
    this.#finishClose(code, reason, true);
  }

  accept(_options?: { allowHalfOpen?: boolean }): void {
    this.open();
  }

  open(): void {
    if (!this.#markOpen()) return;
    // Native sockets do not deliver a frame synchronously from accept(). Give
    // the accept path the rest of this turn to attach its message listener.
    this.#queuedWireFlushPending = true;
    queueMicrotask(() => {
      for (const message of this.#queuedWireMessages.splice(0)) {
        if (this.readyState !== MessagePortWebSocket.OPEN) break;
        this.#dispatchWireMessage(message);
      }
      this.#queuedWireFlushPending = false;
    });
  }

  /** End a socket whose physical host disappeared without notifying that host. */
  protected disconnect(code = 1006, reason = ""): void {
    this.#finishClose(code, reason, false);
  }

  #handleWireMessage(
    message: MessagePortWebSocketWireMessage | MessagePortWebSocketReadyMessage,
  ): void {
    if (message.type === "open") {
      this.open();
      return;
    }
    if (message.type === "close") {
      this.#dispatchWireMessage(message);
      return;
    }
    if (this.readyState === MessagePortWebSocket.CONNECTING || this.#queuedWireFlushPending) {
      this.#queuedWireMessages.push(message);
      return;
    }
    this.#dispatchWireMessage(message);
  }

  #dispatchWireMessage(message: MessagePortWebSocketWireMessage): void {
    if (message.type === "close") {
      this.#finishClose(message.code, message.reason, true);
      return;
    }
    if (this.readyState !== MessagePortWebSocket.OPEN) return;
    this.#emit(
      new MessageEvent<MessagePortWebSocketData>("message", { data: message.data }),
      this.onmessage,
    );
  }

  #markOpen(): boolean {
    if (this.readyState !== MessagePortWebSocket.CONNECTING) return false;
    this.readyState = MessagePortWebSocket.OPEN;
    this.#emit(new Event("open"), this.onopen);
    return true;
  }

  #beginClose(): boolean {
    if (
      this.readyState === MessagePortWebSocket.CLOSING ||
      this.readyState === MessagePortWebSocket.CLOSED
    ) {
      return false;
    }
    this.readyState = MessagePortWebSocket.CLOSING;
    return true;
  }

  #finishClose(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === MessagePortWebSocket.CLOSED) return;
    this.readyState = MessagePortWebSocket.CLOSED;
    this.port.close();
    this.#emit(new CloseEvent("close", { code, reason, wasClean }), this.onclose);
  }

  #emit<E extends Event>(event: E, handler: ((event: E) => void) | null): void {
    handler?.(event);
    this.dispatchEvent(event);
  }
}

export interface MessagePortWebSocket {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<MessagePortWebSocketData>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: CloseEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: "error" | "open",
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** Connect two accepted socket endpoints and open the MessagePort side. */
export function bridgeWebSocket(socket: AcceptingWebSocket, bridge: MessagePortWebSocket): void {
  if (bridge.readyState >= MessagePortWebSocket.CLOSING) {
    socket.close(1001, "MessagePort transport closed");
    return;
  }
  socket.addEventListener("message", (event) => {
    if (bridge.readyState >= MessagePortWebSocket.CLOSING) return;
    bridge.send(messageData(event));
  });
  socket.addEventListener("close", (event) => {
    const close = closeEvent(event);
    bridge.close(close.code, close.reason);
  });
  socket.addEventListener("error", () => {
    bridge.close(1011, "WebSocket failed");
  });
  bridge.addEventListener("message", (event) => {
    socket.send(event.data);
  });
  bridge.addEventListener("close", (event) => {
    socket.close(event.code, event.reason);
  });
  socket.accept();
  bridge.open();
}

type SocketRequest = {
  readonly type: "connect";
  readonly url: string;
  readonly port: MessagePort;
};

/** A browser WebSocket constructor whose sockets cross one broker MessagePort. */
export function createMessagePortWebSocket(port: MessagePort): typeof WebSocket {
  return class BrokeredMessagePortWebSocket extends MessagePortWebSocket {
    constructor(url: string | URL, _protocols?: string | string[]) {
      const channel = new MessageChannel();
      super(String(url), channel.port1, false);
      port.postMessage(
        { type: "connect", url: String(url), port: channel.port2 } satisfies SocketRequest,
        [channel.port2],
      );
    }
  } as unknown as typeof WebSocket;
}

/** Serve brokered MessagePort sockets from real in-worker socket endpoints. */
export function serveMessagePortWebSockets(
  port: MessagePort,
  connect: (url: string) => Promise<AcceptingWebSocket>,
): () => void {
  const bridges = new Set<MessagePortWebSocket>();
  const listener = (event: MessageEvent<SocketRequest>): void => {
    const request = event.data;
    if (request?.type !== "connect" || typeof request.url !== "string") return;
    const bridge = new MessagePortWebSocket(request.url, request.port, false);
    bridges.add(bridge);
    bridge.addEventListener("close", () => bridges.delete(bridge), { once: true });
    void connect(request.url).then(
      (socket) => {
        if (!bridges.has(bridge)) {
          socket.close(1001, "host stopped");
          return;
        }
        bridgeWebSocket(socket, bridge);
        request.port.postMessage({ type: "open" } satisfies MessagePortWebSocketReadyMessage);
      },
      () => bridge.close(1011, "WebSocket connection failed"),
    );
  };
  port.addEventListener("message", listener);
  port.start();

  return () => {
    port.removeEventListener("message", listener);
    for (const bridge of bridges) bridge.close(1001, "host stopped");
    bridges.clear();
    port.close();
  };
}

function messageData(event: Event): MessagePortWebSocketData {
  return (event as MessageEvent<MessagePortWebSocketData>).data;
}

function closeEvent(event: Event): CloseEvent {
  return event as CloseEvent;
}
