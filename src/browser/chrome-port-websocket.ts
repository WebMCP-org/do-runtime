import {
  MessagePortWebSocket,
  type MessagePortWebSocketConstructor,
  type MessagePortWebSocketPort,
  type MessagePortWebSocketWireMessage
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

type Close = {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
};
type BinaryEnvelope = { readonly encoding: "base64"; readonly value: string };
type ChromePortFrame =
  | { readonly type: "message"; readonly data: string | BinaryEnvelope }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "ping" | "pong" };

export interface ChromePortWebSocketPeer {
  send(message: MessagePortWebSocketWireMessage): void;
  close(): void;
}

/**
 * Decode a JSON-only runtime.Port into the runtime's socket wire contract.
 * Pings terminate here: another listening extension context can keep a Chrome
 * port apparently connected after its accepting document has died.
 */
export function bindChromePortWebSocket(
  port: ChromeRuntimePort,
  options: {
    onMessage(message: MessagePortWebSocketWireMessage): void;
    onClose(event: Close): void;
    readLastError?(): string | undefined;
    /** Disable in service workers: periodic port traffic prevents their suspension. */
    probeLiveness?: boolean;
  }
): ChromePortWebSocketPeer {
  let closed = false;
  let lastAnswer = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
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
    if (code === 1002) {
      try {
        port.postMessage({
          type: "close",
          code,
          reason
        } satisfies ChromePortFrame);
      } catch {
        // A broken port cannot receive the protocol failure either.
      }
    }
    detach();
    options.onClose({ code, reason, wasClean });
  };
  const receive = (value: unknown): void => {
    if (closed) return;
    const frame = parseFrame(value);
    if (frame === null) {
      finish(1002, "invalid runtime port message", false);
      return;
    }
    lastAnswer = Date.now();
    switch (frame.type) {
      case "ping":
        try {
          port.postMessage({ type: "pong" } satisfies ChromePortFrame);
        } catch {
          finish(1006, "the runtime port is gone", false);
        }
        return;
      case "pong":
        return;
      case "close":
        finish(frame.code, frame.reason, true);
        return;
      case "message":
        options.onMessage({
          type: "message",
          data:
            typeof frame.data === "string"
              ? frame.data
              : decodeBinary(frame.data)
        });
    }
  };
  const disconnected = (): void => {
    finish(
      1006,
      options.readLastError?.() ?? "runtime port disconnected",
      false
    );
  };
  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(disconnected);
  if (options.probeLiveness) {
    heartbeat = setInterval(() => {
      if (Date.now() - lastAnswer > 6_000) {
        finish(1006, "the runtime port stopped answering", false);
        return;
      }
      try {
        port.postMessage({ type: "ping" } satisfies ChromePortFrame);
      } catch {
        finish(1006, "the runtime port is gone", false);
      }
    }, 2_000);
  }
  return {
    send(message) {
      if (closed) return;
      try {
        port.postMessage(
          message.type === "message" && typeof message.data !== "string"
            ? ({
                type: "message",
                data: encodeBinary(message.data)
              } satisfies ChromePortFrame)
            : message
        );
      } catch {
        finish(1006, "the runtime port is gone", false);
      }
    },
    close: detach
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
  probeLiveness?: boolean;
}): MessagePortWebSocketConstructor {
  let retryAt = 0;
  return class ChromePortWebSocket extends MessagePortWebSocket {
    readonly #bridge: ChromeSocketPort;

    constructor(url: string | URL, _protocols?: string | string[]) {
      const bridge = new ChromeSocketPort();
      super(String(url), bridge, false);
      this.#bridge = bridge;
      void this.#connect();
    }

    async #connect(): Promise<void> {
      try {
        for (;;) {
          while (retryAt > Date.now()) {
            await new Promise((resolve) =>
              setTimeout(resolve, retryAt - Date.now())
            );
          }
          if (this.readyState !== MessagePortWebSocket.CONNECTING) return;
          const deadline = await options.beforeConnect?.();
          if (deadline === undefined) break;
          retryAt = deadline;
        }
        if (this.readyState !== MessagePortWebSocket.CONNECTING) return;
        this.#bridge.peer = bindChromePortWebSocket(options.connect(this.url), {
          onMessage: (message) => this.#bridge.receive(message),
          onClose: ({ code, reason, wasClean }) => {
            if (wasClean) this.#bridge.receive({ type: "close", code, reason });
            else {
              if (code === 1002) this.#reportError();
              this.disconnect(code, reason);
            }
          },
          ...(options.readLastError && {
            readLastError: options.readLastError
          }),
          probeLiveness: options.probeLiveness ?? true
        });
        this.open();
      } catch (error) {
        this.#reportError();
        this.disconnect(
          1011,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    #reportError(): void {
      const event = new Event("error");
      try {
        this.onerror?.(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
      this.dispatchEvent(event);
    }
  };
}

/** Direct delivery preserves send/close ordering without an extra queued MessageChannel hop. */
class ChromeSocketPort extends EventTarget implements MessagePortWebSocketPort {
  peer: ChromePortWebSocketPeer | undefined;

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

interface ChromeSocketPort {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void;
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
  return Uint8Array.from(atob(data.value), (character) =>
    character.charCodeAt(0)
  ).buffer;
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
    Number.isFinite(frame.code) &&
    typeof frame.reason === "string"
  ) {
    return { type: "close", code: frame.code, reason: frame.reason };
  }
  if (frame.type !== "message" || keys !== 2) return null;
  if (typeof frame.data === "string")
    return { type: "message", data: frame.data };
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
    if (btoa(atob(data.value)) !== data.value) return null;
    return { type: "message", data: { encoding: "base64", value: data.value } };
  } catch {
    return null;
  }
}
