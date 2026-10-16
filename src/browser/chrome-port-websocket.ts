import {
  MessagePortWebSocket,
  type MessagePortWebSocketConstructor,
  type MessagePortWebSocketPeer,
  type MessagePortWebSocketPort,
  type MessagePortWebSocketWireMessage,
} from "./message-port-websocket";

/** Structural Chrome/WebExtension runtime.Port; importing this entry needs no Chrome globals. */
export interface ChromeRuntimePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

type PortClose = { readonly code: number; readonly reason: string; readonly wasClean: boolean };
type BinaryEnvelope = { readonly encoding: "base64"; readonly value: string };
type ChromePortFrame =
  | { readonly type: "message"; readonly data: string | BinaryEnvelope }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "ping" | "pong" };

const PROBE_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 6_000;
const PORT_GONE = "the runtime port is gone";

/**
 * Decode a JSON-only runtime.Port into the runtime's socket wire contract.
 * Pings terminate here: another listening extension context can keep a Chrome
 * port apparently connected after its accepting document has died.
 */
export function bindChromePortWebSocket(
  port: ChromeRuntimePort,
  options: {
    onMessage(message: MessagePortWebSocketWireMessage): void;
    onClose(event: PortClose): void;
    readLastError?(): string | undefined;
    /** Ping the peer and close when it stops answering. Off unless set. */
    probeLiveness?: boolean;
  },
): MessagePortWebSocketPeer {
  let closed = false;
  // A failed send() closes the port a microtask later; until then, drop further sends.
  let lost = false;
  let lastFrameAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const post = (frame: ChromePortFrame): boolean => {
    try {
      port.postMessage(frame);
      return true;
    } catch {
      return false;
    }
  };
  const detach = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    port.onMessage.removeListener(receive);
    port.onDisconnect.removeListener(disconnected);
    try {
      port.disconnect();
    } catch {
      // The peer may have disconnected first.
    }
  };
  const finish = (code: number, reason: string, wasClean: boolean): void => {
    if (closed) return;
    detach();
    options.onClose({ code, reason, wasClean });
  };
  const receive = (value: unknown): void => {
    if (closed) return;
    const frame = parseFrame(value);
    if (frame === null) {
      const reason = "invalid runtime port message";
      // Best effort: a port too broken to post cannot receive the protocol failure either.
      post({ type: "close", code: 1002, reason });
      finish(1002, reason, false);
      return;
    }
    lastFrameAt = Date.now();
    switch (frame.type) {
      case "ping":
        if (!post({ type: "pong" })) finish(1006, PORT_GONE, false);
        return;
      case "pong":
        return;
      case "close":
        finish(frame.code, frame.reason, true);
        return;
      case "message":
        options.onMessage({
          type: "message",
          data: typeof frame.data === "string" ? frame.data : decodeBinary(frame.data),
        });
    }
  };
  const disconnected = (): void => {
    finish(1006, options.readLastError?.() ?? "runtime port disconnected", false);
  };

  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(disconnected);
  if (options.probeLiveness) {
    heartbeat = setInterval(() => {
      if (Date.now() - lastFrameAt > PROBE_TIMEOUT_MS) {
        finish(1006, "the runtime port stopped answering", false);
      } else if (!post({ type: "ping" })) {
        finish(1006, PORT_GONE, false);
      }
    }, PROBE_INTERVAL_MS);
  }
  return {
    send(message) {
      if (closed || lost) return;
      try {
        port.postMessage(encodeFrame(message));
      } catch {
        // Like a native socket, report the loss after send() returns, so a
        // caller records what it sent before it observes the close.
        lost = true;
        queueMicrotask(() => finish(1006, PORT_GONE, false));
      }
    },
    close: detach,
  };
}

/**
 * A reconnecting-client-compatible WebSocket constructor over Chrome runtime.Port.
 * Host readiness and port naming stay with the application. A returned deadline
 * defers readiness probes across every replacement socket from this constructor.
 */
export function createChromePortWebSocketConstructor(options: {
  connect(url: string): ChromeRuntimePort;
  beforeConnect?(): Promise<number | void>;
  readLastError?(): string | undefined;
  /** On unless false. Disable in service workers: port traffic prevents their suspension. */
  probeLiveness?: boolean;
}): MessagePortWebSocketConstructor {
  let retryAt = 0;
  return class ChromePortWebSocket extends MessagePortWebSocket {
    readonly #port: PeerPort;

    constructor(url: string | URL, _protocols?: string | string[]) {
      const port = new PeerPort();
      super(String(url), port, false);
      this.#port = port;
      void this.#connect();
    }

    async #connect(): Promise<void> {
      try {
        for (;;) {
          while (retryAt > Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, retryAt - Date.now()));
          }
          if (this.readyState !== MessagePortWebSocket.CONNECTING) return;
          const deadline = await options.beforeConnect?.();
          if (deadline === undefined) break;
          retryAt = deadline;
        }
        if (this.readyState !== MessagePortWebSocket.CONNECTING) return;
        this.#port.peer = bindChromePortWebSocket(options.connect(this.url), {
          onMessage: (message) => this.#port.receive(message),
          onClose: ({ code, reason, wasClean }) => {
            if (wasClean) this.#port.receive({ type: "close", code, reason });
            else if (code === 1002) this.fail(code, reason);
            else this.disconnect(code, reason);
          },
          readLastError: () => options.readLastError?.(),
          probeLiveness: options.probeLiveness ?? true,
        });
        this.open();
      } catch (error) {
        // A socket the application already closed has nothing left to report.
        if (this.readyState === MessagePortWebSocket.CLOSED) return;
        this.fail(1011, error instanceof Error ? error.message : String(error));
      }
    }
  };
}

/**
 * The socket's port onto a bound peer. Delivery is direct: a MessageChannel hop
 * would queue each frame and could reorder a send against the close behind it.
 */
class PeerPort extends EventTarget implements MessagePortWebSocketPort {
  peer: MessagePortWebSocketPeer | undefined;

  postMessage(message: MessagePortWebSocketWireMessage): void {
    this.peer?.send(message);
  }

  receive(message: MessagePortWebSocketWireMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  start(): void {}

  close(): void {
    this.peer?.close();
    this.peer = undefined;
  }
}

// EventTarget types its listener for any Event; this port only ever dispatches MessageEvents.
interface PeerPort {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

function encodeFrame(message: MessagePortWebSocketWireMessage): ChromePortFrame {
  if (message.type === "close") return message;
  const { data } = message;
  return { type: "message", data: typeof data === "string" ? data : encodeBinary(data) };
}

function encodeBinary(data: ArrayBuffer | ArrayBufferView): BinaryEnvelope {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { encoding: "base64", value: btoa(binary) };
}

function decodeBinary(data: BinaryEnvelope): ArrayBuffer {
  return Uint8Array.from(atob(data.value), (character) => character.charCodeAt(0)).buffer;
}

function parseFrame(value: unknown): ChromePortFrame | null {
  if (value === null || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).length;
  if ((frame.type === "ping" || frame.type === "pong") && keys === 1) {
    return { type: frame.type };
  }
  if (
    frame.type === "close" &&
    keys === 3 &&
    typeof frame.code === "number" &&
    Number.isInteger(frame.code) &&
    frame.code >= 0 &&
    frame.code <= 0xffff &&
    typeof frame.reason === "string"
  ) {
    return { type: "close", code: frame.code, reason: frame.reason };
  }
  if (frame.type !== "message" || keys !== 2) return null;
  if (typeof frame.data === "string") return { type: "message", data: frame.data };
  if (frame.data === null || typeof frame.data !== "object") return null;
  const data = frame.data as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    data.encoding !== "base64" ||
    typeof data.value !== "string"
  ) {
    return null;
  }
  try {
    // Only canonical base64 round-trips, so each byte sequence has one wire form.
    if (btoa(atob(data.value)) !== data.value) return null;
    return { type: "message", data: { encoding: "base64", value: data.value } };
  } catch {
    return null;
  }
}
