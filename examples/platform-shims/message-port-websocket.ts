export type SocketWireMessage =
  | { type: "open"; id: string; url: string }
  | { type: "message"; id: string; data: unknown }
  | { type: "close"; id: string; code: number; reason: string }
  | { type: "error"; id: string; message: string };

type PortSocket = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  accept(): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
};

/** A browser WebSocket constructor backed by one multiplexed MessagePort. */
export function createMessagePortWebSocket(port: MessagePort): typeof WebSocket {
  const sockets = new Map<string, MessagePortWebSocket>();

  class MessagePortWebSocket extends EventTarget {
    static readonly CONNECTING = WebSocket.CONNECTING;
    static readonly OPEN = WebSocket.OPEN;
    static readonly CLOSING = WebSocket.CLOSING;
    static readonly CLOSED = WebSocket.CLOSED;

    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly bufferedAmount = 0;
    readonly extensions = "";
    readonly protocol = "";
    binaryType: BinaryType = "blob";
    readyState: number = WebSocket.CONNECTING;
    readonly url: string;
    readonly #id = crypto.randomUUID();

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      sockets.set(this.#id, this);
      port.postMessage({ type: "open", id: this.#id, url: this.url } satisfies SocketWireMessage);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== WebSocket.OPEN) throw new DOMException("WebSocket is not open.");
      port.postMessage({ type: "message", id: this.#id, data } satisfies SocketWireMessage);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState >= WebSocket.CLOSING) return;
      this.readyState = WebSocket.CLOSING;
      port.postMessage({ type: "close", id: this.#id, code, reason } satisfies SocketWireMessage);
    }

    receive(message: SocketWireMessage): void {
      if (message.type === "open") {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      } else if (message.type === "message") {
        this.dispatchEvent(new MessageEvent("message", { data: message.data }));
      } else if (message.type === "close") {
        this.readyState = WebSocket.CLOSED;
        sockets.delete(this.#id);
        this.dispatchEvent(
          new CloseEvent("close", { code: message.code, reason: message.reason, wasClean: true }),
        );
      } else {
        this.dispatchEvent(new ErrorEvent("error", { message: message.message }));
      }
    }
  }

  port.addEventListener("message", (event: MessageEvent<SocketWireMessage>) => {
    sockets.get(event.data.id)?.receive(event.data);
  });
  port.start();
  return MessagePortWebSocket as unknown as typeof WebSocket;
}

/** Serve MessagePort-backed browser sockets from real in-worker socket endpoints. */
export function serveMessagePortWebSockets(
  port: MessagePort,
  connect: (url: string) => Promise<PortSocket>,
): () => void {
  const sockets = new Map<string, PortSocket>();
  const post = (message: SocketWireMessage): void => port.postMessage(message);

  port.addEventListener("message", (event: MessageEvent<SocketWireMessage>) => {
    const message = event.data;
    if (message.type === "open") {
      void connect(message.url).then(
        (socket) => {
          sockets.set(message.id, socket);
          let opened = false;
          const open = () => {
            if (opened) return;
            opened = true;
            post(message);
          };
          socket.addEventListener("open", open);
          socket.addEventListener("message", (incoming: Event) => {
            post({
              type: "message",
              id: message.id,
              data: (incoming as MessageEvent).data,
            });
          });
          socket.addEventListener("close", (closed: Event) => {
            const close = closed as CloseEvent;
            sockets.delete(message.id);
            post({ type: "close", id: message.id, code: close.code, reason: close.reason });
          });
          socket.addEventListener("error", () => {
            post({ type: "error", id: message.id, message: "agent socket failed" });
          });
          socket.accept();
          if (socket.readyState === WebSocket.OPEN) open();
        },
        (error: unknown) => {
          post({ type: "error", id: message.id, message: String(error) });
          post({ type: "close", id: message.id, code: 1011, reason: "upgrade failed" });
        },
      );
      return;
    }

    const socket = sockets.get(message.id);
    if (socket === undefined) return;
    if (message.type === "message") socket.send(message.data);
    else if (message.type === "close") socket.close(message.code, message.reason);
  });
  port.start();

  return () => {
    for (const socket of sockets.values()) socket.close(1001, "host stopped");
    sockets.clear();
    port.close();
  };
}
