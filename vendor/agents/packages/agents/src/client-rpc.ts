import type { PartySocket } from "partysocket";
import type { RPCRequest } from "./";
import type { CapnWebSocket } from "./websockets/capnweb-socket";
import { MessageType } from "./types";

/** A call lost its connection before receiving a result. It may have executed. */
export class AgentConnectionClosedError extends Error {
  constructor() {
    super("Connection closed");
    this.name = "AgentConnectionClosedError";
  }
}

/** A call exhausted its deadline. A timeout does not imply server cancellation. */
export class AgentCallTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeout: number
  ) {
    super(`RPC call to ${method} timed out after ${timeout}ms`);
    this.name = "AgentCallTimeoutError";
  }
}

/**
 * Default timeout (in milliseconds) applied to non-streaming RPC calls
 * that don't pass an explicit `timeout`. Acts as a backstop so calls
 * whose response is lost (e.g. the connection drops mid-flight) reject
 * instead of hanging forever. Override per client via
 * `defaultCallTimeout`, or per call via `timeout` (0 disables).
 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Options for streaming RPC calls
 */
export type StreamOptions = {
  /** Called when a chunk of data is received */
  onChunk?: (chunk: unknown) => void;
  /** Called when the stream ends */
  onDone?: (finalChunk: unknown) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
};

/**
 * Options for RPC calls
 */
export type CallOptions = {
  /** Timeout in milliseconds. If the call doesn't complete within this time, it will be rejected. */
  timeout?: number;
  /** Streaming options for handling streaming responses */
  stream?: StreamOptions;
  /** W3C parent context for a JSON WebSocket call. The host decides whether to use it. */
  traceparent?: string;
};

/** @internal Serialize before either client queues the request for reconnect. */
export function serializeRpcRequest(
  id: string,
  method: string,
  args: unknown[],
  options?: CallOptions
): string {
  const traceparent = options?.traceparent;
  const request: RPCRequest = {
    args,
    id,
    method,
    type: MessageType.RPC,
    ...(traceparent ? { traceparent } : {})
  };
  return JSON.stringify(request);
}

/**
 * One native call on the Cap'n Web transport, with the timeout and
 * stream-callback contract `call()` has on the JSON wire. The timeout
 * covers the whole call, draining included: on expiry the stream reader is
 * cancelled and the promise rejects once. A `ReadableStream` result is
 * drained into the stream callbacks when they are given; any other value,
 * live stubs included, passes straight through.
 */
export async function nativeCall<T>(
  socket: CapnWebSocket,
  method: string,
  args: unknown[],
  options: CallOptions | undefined,
  defaultTimeout: number
): Promise<T> {
  const { stream, timeout } = options ?? {};
  const effectiveTimeout =
    timeout !== undefined ? timeout : stream ? undefined : defaultTimeout;
  let expired = false;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = (async () => {
    const result = await socket.invoke(method, args);
    if (expired) throw new AgentCallTimeoutError(method, effectiveTimeout!);
    if (stream && result instanceof ReadableStream) {
      reader = (result as ReadableStream<unknown>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (expired) throw new AgentCallTimeoutError(method, effectiveTimeout!);
        if (done) break;
        stream.onChunk?.(value);
      }
      stream.onDone?.(undefined);
      return undefined as T;
    }
    return result as T;
  })();

  const expiry = effectiveTimeout
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void reader?.cancel().catch(() => {});
          reject(new AgentCallTimeoutError(method, effectiveTimeout));
        }, effectiveTimeout);
      })
    : undefined;

  try {
    return await (expiry ? Promise.race([work, expiry]) : work);
  } catch (error) {
    // Keep the rejection observed on the losing side of the race.
    void work.catch(() => {});
    stream?.onError?.(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Native calls issued while the Cap'n Web socket is still connecting or
 * between reconnects. They must not fall back to JSON frames — that would
 * change which methods are reachable and lose return-by-reference — so
 * they wait here and run on the next open socket, or reject when the
 * connection ends for good. Their timeout starts when they are issued.
 */
export class NativeCallQueue {
  #pending: Array<{
    run: (socket: CapnWebSocket) => void;
    reject: (error: Error) => void;
  }> = [];

  enqueue<T>(
    method: string,
    args: unknown[],
    options: CallOptions | undefined,
    defaultTimeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const { stream, timeout } = options ?? {};
      const effectiveTimeout =
        timeout !== undefined ? timeout : stream ? undefined : defaultTimeout;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        run: (socket: CapnWebSocket) => {
          if (timer !== undefined) clearTimeout(timer);
          if (effectiveTimeout && Date.now() - startedAt >= effectiveTimeout) {
            entry.reject(new AgentCallTimeoutError(method, effectiveTimeout));
            return;
          }
          // Spend the remaining budget, not a fresh one.
          const remaining = !effectiveTimeout
            ? effectiveTimeout
            : Math.max(1, effectiveTimeout - (Date.now() - startedAt));
          const opts =
            remaining === undefined ? options : { stream, timeout: remaining };
          nativeCall<T>(socket, method, args, opts, defaultTimeout).then(
            resolve,
            reject
          );
        },
        reject: (error: Error) => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
          stream?.onError?.(error.message);
        }
      };
      this.#pending.push(entry);
      if (effectiveTimeout) {
        timer = setTimeout(() => {
          const index = this.#pending.indexOf(entry);
          if (index === -1) return;
          this.#pending.splice(index, 1);
          entry.reject(new AgentCallTimeoutError(method, effectiveTimeout));
        }, effectiveTimeout);
      }
    });
  }

  /** Run everything queued on a socket that just opened. */
  flush(socket: CapnWebSocket): void {
    while (this.#pending.length && socket.readyState === socket.OPEN) {
      this.#pending.shift()!.run(socket);
    }
  }

  /** Reject everything queued; the connection will not come back. */
  rejectAll(error: Error): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const entry of pending) entry.reject(error);
  }
}

/** One owner for JSON call issuance, socket ownership, deadlines and settlement. */
export class JsonRpcClient {
  #pending = new Map<
    string,
    {
      request: string;
      sentOn: PartySocket | null;
      expiresAt: number | undefined;
      expire(): void;
      resolve(value: unknown): void;
      reject(error: Error): void;
      stream?: StreamOptions;
    }
  >();

  call<T>(
    socket: PartySocket | null,
    method: string,
    args: unknown[],
    options: CallOptions | undefined,
    defaultTimeout: number
  ): Promise<T> {
    const id = crypto.randomUUID();
    const request = serializeRpcRequest(id, method, args, options);
    const { stream, timeout } = options ?? {};
    const duration = timeout ?? (stream ? undefined : defaultTimeout);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        this.#pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
      };
      const entry = {
        request,
        sentOn: null as PartySocket | null,
        expiresAt: duration ? Date.now() + duration : undefined,
        stream,
        expire: () =>
          entry.reject(new AgentCallTimeoutError(method, duration!)),
        resolve: (value: unknown) => {
          finish();
          // The public typed call overload owns the server result contract.
          resolve(value as T);
        },
        reject: (error: Error) => {
          finish();
          reject(error);
          stream?.onError?.(error.message);
        }
      };
      this.#pending.set(id, entry);
      if (duration) timer = setTimeout(entry.expire, duration);
      if (socket) this.flush(socket);
    });
  }

  flush(socket: PartySocket): void {
    for (const entry of this.#pending.values()) {
      if (socket.readyState !== socket.OPEN) break;
      if (entry.sentOn !== null) continue;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        entry.expire();
        continue;
      }
      // A send can close synchronously; its close must already own this call.
      entry.sentOn = socket;
      try {
        socket.send(entry.request);
      } catch (cause) {
        entry.reject(
          cause instanceof Error
            ? cause
            : new Error("RPC send failed", { cause })
        );
      }
    }
  }

  receive(socket: PartySocket | null, response: Record<string, unknown>): void {
    if (typeof response.id !== "string") return;
    const pending = this.#pending.get(response.id);
    if (!pending || pending.sentOn !== socket) {
      console.warn(
        `[agents] Discarded an RPC response with no matching pending call (id "${response.id}"). The call may have timed out or its connection closed.`
      );
      return;
    }
    if (
      typeof response.success !== "boolean" ||
      (response.success === false && typeof response.error !== "string") ||
      ("done" in response && typeof response.done !== "boolean")
    ) {
      pending.reject(new Error("Malformed RPC response"));
      return;
    }
    if (response.success === false) {
      pending.reject(new Error(response.error as string));
    } else if (response.done === false) {
      pending.stream?.onChunk?.(response.result);
    } else {
      pending.resolve(response.result);
      if (response.done === true) pending.stream?.onDone?.(response.result);
    }
  }

  close(socket: PartySocket): void {
    this.#rejectWhere(
      (sentOn) => sentOn === socket,
      new AgentConnectionClosedError()
    );
  }

  discardQueued(error: Error): void {
    this.#rejectWhere((sentOn) => sentOn === null, error);
  }

  dispose(): void {
    this.#rejectWhere(() => true, new AgentConnectionClosedError());
  }

  #rejectWhere(
    matches: (socket: PartySocket | null) => boolean,
    error: Error
  ): void {
    // A user callback cannot leave later calls and their deadlines stranded.
    const failures: unknown[] = [];
    for (const pending of this.#pending.values()) {
      if (!matches(pending.sentOn)) continue;
      try {
        pending.reject(error);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "RPC error callbacks failed");
  }
}
