import {
  ClientReadiness,
  socketDestinationKey,
  parseClientFrame
} from "./client-connection";
import {
  JsonRpcClient,
  NativeCallQueue,
  nativeCall,
  DEFAULT_CALL_TIMEOUT_MS,
  AgentConnectionClosedError,
  type CallOptions
} from "./client-rpc";
export {
  DEFAULT_CALL_TIMEOUT_MS,
  AgentConnectionClosedError,
  AgentCallTimeoutError,
  type CallOptions,
  type StreamOptions
} from "./client-rpc";
import {
  type PartyFetchOptions,
  PartySocket,
  type PartySocketOptions
} from "partysocket";
import type { Agent } from "./";
import type {
  ClientParameters,
  Method,
  RPCMethod,
  SerializableReturnValue,
  SerializableValue
} from "./serializable";
import { MessageType } from "./types";
import { camelCaseToKebabCase, isInternalJsStubProp } from "./utils";
import {
  boundCapnWebSocket,
  type CapnWebSocket
} from "./websockets/capnweb-socket";
import type { AgentTransport } from "./websockets/transport-protocol";

export type { AgentTransport } from "./websockets/transport-protocol";

export class AgentConnectionError extends Error {
  code: number;
  reason: string;
  wasClean: boolean;

  constructor(event: CloseEvent) {
    const reason = event.reason || `WebSocket closed with code ${event.code}`;
    super(`Agent connection closed: ${reason}`);
    this.name = "AgentConnectionError";
    this.code = event.code;
    this.reason = event.reason;
    this.wasClean = event.wasClean;
  }
}

export function isTerminalCloseEvent(event: CloseEvent): boolean {
  return event.code === 1008 || (event.code >= 4000 && event.code <= 4999);
}

type ReconnectingSocket = { shouldReconnect: boolean; retryCount: number };

/**
 * PartySocket's `shouldReconnectOnClose`, plus a record of whether that
 * decision ended reconnection so the close can surface a connection error.
 *
 * Reconnection ends on a terminal close code, when the caller's
 * `shouldReconnectOnClose` declines, or when `maxRetries` is spent (a
 * failed handshake never reaches the server's close codes, so it only
 * stops this way). An explicit `close()` has already cleared
 * `shouldReconnect` by the time PartySocket asks, and is not an error.
 * PartySocket asks before it schedules the next attempt, so `retryCount`
 * still counts the attempt that just closed.
 * @internal
 */
export function createCloseClassifier(options: {
  socket: () => ReconnectingSocket | null | undefined;
  shouldReconnectOnClose: () => ((event: CloseEvent) => boolean) | undefined;
  maxRetries: () => number | undefined;
}): {
  shouldReconnectOnClose: (event: CloseEvent) => boolean;
  takeFinalClose: () => boolean;
} {
  let finalClose = false;
  return {
    shouldReconnectOnClose(event) {
      const reconnect =
        (options.shouldReconnectOnClose()?.(event) ?? true) &&
        !isTerminalCloseEvent(event);
      const socket = options.socket();
      if (socket?.shouldReconnect === false) {
        finalClose = false;
      } else if (!reconnect) {
        finalClose = true;
      } else {
        const maxRetries = options.maxRetries() ?? Number.POSITIVE_INFINITY;
        finalClose = (socket?.retryCount ?? 0) >= maxRetries;
      }
      return reconnect;
    },
    takeFinalClose() {
      const final = finalClose;
      finalClose = false;
      return final;
    }
  };
}

type TerminalReconnectOptions = {
  shouldReconnectOnClose?: (event: CloseEvent) => boolean;
};

/**
 * Options for creating an AgentClient
 */
export type AgentClientOptions<State = unknown> = Omit<
  PartySocketOptions,
  "party" | "room"
> &
  TerminalReconnectOptions & {
    /**
     * Wire the connection travels on. `"cf-websocket"` (default) is a
     * hibernating WebSocket where `call()` sends JSON `rpc` frames.
     * `"capnweb"` carries protocol frames over a Cap'n Web session whose
     * root also serves the host's `callables` natively, so `call()` and
     * `stub` invoke them directly and an `RpcTarget` result is a live stub.
     * The Durable Object stays in memory while a capnweb connection is open.
     * @experimental The `"capnweb"` transport is experimental.
     */
    transport?: AgentTransport;
    /** Name of the agent to connect to (ignored if basePath is set) */
    agent: string;
    /** Name of the specific Agent instance (ignored if basePath is set) */
    name?: string;
    /**
     * Full URL path - bypasses agent/name URL construction.
     * When set, the client connects to this path directly.
     * Server must handle routing manually (e.g., with getAgentByName + fetch).
     * @example
     * // Client connects to /user, server routes based on session
     * useAgent({ agent: "UserAgent", basePath: "user" })
     */
    basePath?: string;
    /** Called when the Agent's state is updated */
    onStateUpdate?: (state: State, source: "server" | "client") => void;
    /** Called when a state update fails (e.g., connection is readonly) */
    onStateUpdateError?: (error: string) => void;
    /**
     * Called when the server sends the agent's identity on connect.
     * Useful when using basePath, as the actual instance name is determined server-side.
     * @param name The actual agent instance name
     * @param agent The agent class name (kebab-case)
     */
    onIdentity?: (name: string, agent: string) => void;
    /**
     * Called when identity changes on reconnect (different instance than before).
     * If not provided and identity changes, a warning will be logged.
     * @param oldName Previous instance name
     * @param newName New instance name
     * @param oldAgent Previous agent class name
     * @param newAgent New agent class name
     */
    onIdentityChange?: (
      oldName: string,
      newName: string,
      oldAgent: string,
      newAgent: string
    ) => void;
    /**
     * Additional path to append to the URL.
     * Works with both standard routing and basePath.
     * @example
     * // With basePath: /user/settings
     * { basePath: "user", path: "settings" }
     * // Standard: /agents/my-agent/room/settings
     * { agent: "MyAgent", name: "room", path: "settings" }
     */
    path?: string;
    /**
     * Default timeout (in milliseconds) applied to non-streaming `call()`s
     * that don't pass an explicit `timeout`. Defaults to 30 000 ms.
     * Set to `0` to disable. Streaming calls never get a default timeout.
     */
    defaultCallTimeout?: number;
    /**
     * Called when the connection closes and will not reconnect on its own: a
     * terminal close code (1008 or 4000-4999), `shouldReconnectOnClose`
     * returning false, or `maxRetries` spent.
     */
    onConnectionError?: (error: AgentConnectionError) => void;
  };

/**
 * Options for the agentFetch function
 */
export type AgentClientFetchOptions = Omit<
  PartyFetchOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to (ignored if basePath is set) */
  agent: string;
  /** Name of the specific Agent instance (ignored if basePath is set) */
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the request is made to this path directly.
   */
  basePath?: string;
};

// ---- Shared RPC Type Utilities ----

type AllOptional<T> = T extends [infer A, ...infer R]
  ? undefined extends A
    ? AllOptional<R>
    : false
  : true;

export type RPCMethods<T> = {
  [K in keyof T as T[K] extends RPCMethod<T[K]> ? K : never]: RPCMethod<T[K]>;
};

type OptionalParametersMethod<T extends RPCMethod> =
  AllOptional<ClientParameters<T>> extends true ? T : never;

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic agent type constraint
export type AgentMethods<T> = Omit<RPCMethods<T>, keyof Agent<any, any>>;

export type OptionalAgentMethods<T> = {
  [
    K in keyof AgentMethods<T> as AgentMethods<T>[K] extends OptionalParametersMethod<
      AgentMethods<T>[K]
    >
      ? K
      : never
  ]: OptionalParametersMethod<AgentMethods<T>[K]>;
};

export type RequiredAgentMethods<T> = Omit<
  AgentMethods<T>,
  keyof OptionalAgentMethods<T>
>;

export type AgentPromiseReturnType<T, K extends keyof AgentMethods<T>> =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic promise return type
  ReturnType<AgentMethods<T>[K]> extends Promise<any>
    ? ReturnType<AgentMethods<T>[K]>
    : Promise<ReturnType<AgentMethods<T>[K]>>;

export type AgentStub<T> = {
  [K in keyof AgentMethods<T>]: (
    ...args: ClientParameters<AgentMethods<T>[K]>
  ) => AgentPromiseReturnType<AgentMethods<T>, K>;
};

export type UntypedAgentStub = Record<string, Method>;

type AgentClientStub<AgentT> = keyof AgentMethods<AgentT> extends never
  ? UntypedAgentStub
  : AgentStub<AgentT>;

type OptionalArgsAgentClientCall<AgentT> = <
  K extends keyof OptionalAgentMethods<AgentT>
>(
  method: K,
  args?: ClientParameters<OptionalAgentMethods<AgentT>[K]>,
  options?: CallOptions
) => AgentPromiseReturnType<AgentT, K>;

type RequiredArgsAgentClientCall<AgentT> = <
  K extends keyof RequiredAgentMethods<AgentT>
>(
  method: K,
  args: ClientParameters<RequiredAgentMethods<AgentT>[K]>,
  options?: CallOptions
) => AgentPromiseReturnType<AgentT, K>;

export type AgentMethodCall<AgentT> = OptionalArgsAgentClientCall<AgentT> &
  RequiredArgsAgentClientCall<AgentT>;

type UntypedAgentClientCall = {
  <T extends SerializableReturnValue>(
    method: string,
    args?: SerializableValue[],
    options?: CallOptions
  ): Promise<T>;
  <T = unknown>(
    method: string,
    args?: unknown[],
    options?: CallOptions
  ): Promise<T>;
};

type AgentClientCall<AgentT> = keyof AgentMethods<AgentT> extends never
  ? UntypedAgentClientCall
  : AgentMethodCall<AgentT>;

/**
 * Creates a proxy that wraps RPC method calls.
 * Internal JS methods (toJSON, then, etc.) return undefined to avoid
 * triggering RPC calls during serialization (e.g., console.log)
 */
export function createStubProxy<T = Record<string, Method>>(
  call: (method: string, args: unknown[]) => unknown
): T {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- proxy needs any for dynamic method access
  return new Proxy<any>(
    {},
    {
      get: (_target, method) => {
        if (isInternalJsStubProp(method)) {
          return undefined;
        }
        return (...args: unknown[]) => call(method as string, args);
      }
    }
  );
}

/**
 * WebSocket client for connecting to an Agent
 */
export class AgentClient<
  AgentT = unknown,
  State = AgentT extends { get state(): infer S } ? S : AgentT
> extends PartySocket {
  agent: string;
  name: string;
  call: AgentClientCall<AgentT>;
  stub: AgentClientStub<AgentT>;

  /**
   * The current agent state, updated on server broadcasts and client setState calls.
   * Starts as undefined until the first state message is received from the server.
   */
  state: State | undefined = undefined;

  /**
   * Whether the client has received identity from the server.
   * Becomes true with `ready`: after the identity message, or after the
   * initial state message when the server sends one.
   * Resets to false on connection close.
   */
  identified = false;

  /**
   * Set when the connection closed and will not reconnect on its own (see
   * `onConnectionError`). Cleared when a connection opens.
   */
  connectionError: AgentConnectionError | null = null;

  /**
   * Promise that resolves when identity has been received from the server.
   * When the server also sends the stored state on connect, it resolves only
   * after that state has been applied, so `state` is current once it settles.
   * Servers without that signal resolve on identity alone.
   * Useful for waiting before making calls that depend on knowing the instance.
   * Resets on connection close so it can be awaited again after reconnect.
   */
  get ready(): Promise<void> {
    return this.#readiness.at(this.connectionKey).promise;
  }

  private options: AgentClientOptions<State>;
  readonly #rpc = new JsonRpcClient();
  readonly #readiness = new ClientReadiness();
  private _previousName: string | null = null;
  private _previousAgent: string | null = null;

  /** Canonical destination and transport; refreshed credentials do not change it. */
  get connectionKey(): string {
    return JSON.stringify([
      socketDestinationKey(this.partySocketOptions),
      this.options.transport ?? "cf-websocket"
    ]);
  }

  #applyIdentity(newName: string, newAgent: string): void {
    const oldName = this._previousName;
    const oldAgent = this._previousAgent;

    // Resolve ready/identified
    this.identified = true;
    this.#readiness.at(this.connectionKey).resolve();

    // Detect identity change on reconnect
    if (
      oldName !== null &&
      oldAgent !== null &&
      (oldName !== newName || oldAgent !== newAgent)
    ) {
      if (this.options.onIdentityChange) {
        this.options.onIdentityChange(oldName, newName, oldAgent, newAgent);
      } else {
        const agentChanged = oldAgent !== newAgent;
        const nameChanged = oldName !== newName;
        let changeDescription = "";
        if (agentChanged && nameChanged) {
          changeDescription = `agent "${oldAgent}" → "${newAgent}", instance "${oldName}" → "${newName}"`;
        } else if (agentChanged) {
          changeDescription = `agent "${oldAgent}" → "${newAgent}"`;
        } else {
          changeDescription = `instance "${oldName}" → "${newName}"`;
        }
        console.warn(
          `[agents] Identity changed on reconnect: ${changeDescription}. ` +
            "This can happen with server-side routing (e.g., basePath with getAgentByName) " +
            "where the instance is determined by auth/session. " +
            "Provide onIdentityChange callback to handle this explicitly, " +
            "or ignore if this is expected for your routing pattern."
        );
      }
    }

    // Always update from server identity (server is authoritative)
    this._previousName = newName;
    this._previousAgent = newAgent;
    this.name = newName;
    this.agent = newAgent;

    // Call onIdentity callback
    this.options.onIdentity?.(newName, newAgent);
  }

  /**
   * The live Cap'n Web socket on the `"capnweb"` transport. PartySocket
   * constructs a new one on every reconnect; the bound class reports each
   * into this holder, which exists before `super()` runs.
   */
  readonly #capnWeb: { current: CapnWebSocket | null };
  readonly #nativeQueue = new NativeCallQueue();

  constructor(options: AgentClientOptions<State>) {
    const capnWeb: { current: CapnWebSocket | null } = { current: null };
    const socketClass =
      options.transport === "capnweb"
        ? {
            WebSocket: boundCapnWebSocket((socket) => {
              capnWeb.current = socket;
            })
          }
        : {};
    const agentNamespace = camelCaseToKebabCase(options.agent);
    const self: { current: AgentClient<AgentT, State> | null } = {
      current: null
    };
    const closeClassifier = createCloseClassifier({
      socket: () => self.current,
      shouldReconnectOnClose: () => options.shouldReconnectOnClose,
      maxRetries: () => options.maxRetries
    });
    const classifyReconnect = closeClassifier.shouldReconnectOnClose;

    // If basePath is provided, use it directly; otherwise construct from agent/name
    const socketOptions = options.basePath
      ? {
          basePath: options.basePath,
          path: options.path,
          ...options,
          ...socketClass,
          shouldReconnectOnClose: classifyReconnect
        }
      : {
          party: agentNamespace,
          prefix: "agents",
          room: options.name || "default",
          path: options.path,
          ...options,
          ...socketClass,
          shouldReconnectOnClose: classifyReconnect
        };

    super(socketOptions);
    self.current = this;
    this.#capnWeb = capnWeb;
    this.agent = agentNamespace;
    this.name = options.name || "default";
    this.options = options;

    this.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const parsedMessage = parseClientFrame(event.data);
        if (!parsedMessage) return;
        if (parsedMessage.type === MessageType.CF_AGENT_IDENTITY) {
          if (
            typeof parsedMessage.name !== "string" ||
            typeof parsedMessage.agent !== "string"
          )
            return;
          this.#readiness.identity(
            this,
            { name: parsedMessage.name, agent: parsedMessage.agent },
            parsedMessage.stateFollows === true,
            ({ name, agent }) => this.#applyIdentity(name, agent)
          );
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
          this.state = parsedMessage.state as State;
          try {
            this.options.onStateUpdate?.(
              parsedMessage.state as State,
              "server"
            );
          } finally {
            this.#readiness.state(this, ({ name, agent }) =>
              this.#applyIdentity(name, agent)
            );
          }
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE_ERROR) {
          this.options.onStateUpdateError?.(parsedMessage.error as string);
          return;
        }
        if (parsedMessage.type === MessageType.RPC) {
          this.#rpc.receive(this, parsedMessage);
        }
      }
    });

    this.addEventListener("open", () => {
      this.connectionError = null;
      this.#rpc.flush(this);
      const native = this.#capnWeb.current;
      if (native) this.#nativeQueue.flush(native);
    });

    // Clean up pending calls and reset ready state when connection closes
    this.addEventListener("close", (event) => {
      const finalClose = closeClassifier.takeFinalClose();
      // Reset ready state for next connection
      this.identified = false;
      this.#readiness.reset(this.connectionKey, this);

      if (this.shouldReconnect && !finalClose) {
        // Transient disconnect: reject calls whose request was already
        // transmitted — their response can never arrive. Unsent calls stay
        // pending for the next open, unless their own deadline expires.
        this.#rpc.close(this);
      } else {
        // Permanent close (close() called or reconnection ended): nothing
        // will ever flush the buffer, so reject everything.
        this.#rpc.dispose();
        this.#nativeQueue.rejectAll(new AgentConnectionClosedError());
        if (finalClose) {
          const error = new AgentConnectionError(event);
          this.connectionError = error;
          this.options.onConnectionError?.(error);
        }
      }
    });

    this.call = this._callImpl.bind(this) as AgentClientCall<AgentT>;
    this.stub = createStubProxy((method, args) =>
      this._callImpl(method, args)
    ) as AgentClientStub<AgentT>;
  }

  setState(state: State) {
    this.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
    this.state = state;
    this.options.onStateUpdate?.(state, "client");
  }

  /**
   * Close the connection and immediately reject all pending RPC calls.
   * This provides immediate feedback on intentional close rather than
   * waiting for the WebSocket close handshake to complete.
   *
   * Note: Any calls made after `close()` will be rejected when the
   * underlying WebSocket close event fires.
   */
  close(code?: number, reason?: string) {
    // Immediately reject all pending calls on intentional close
    this.#rpc.dispose();
    this.#nativeQueue.rejectAll(new AgentConnectionClosedError());

    // Then close the underlying socket
    super.close(code, reason);
  }

  /**
   * Call a method on the Agent.
   * When AgentT is provided, method names are inferred from the agent's methods.
   * Falls back to untyped string-based calls when AgentT is not provided.
   */
  private async _callImpl(
    method: string,
    args: unknown[] = [],
    options?: CallOptions
  ): Promise<unknown> {
    // On the Cap'n Web transport, callables are native methods on the
    // session root: invoke them directly so an RpcTarget result arrives as
    // a live stub. The JSON `rpc` frame below is the WebSocket wire's protocol.
    if (this.options.transport === "capnweb") {
      const timeout =
        this.options.defaultCallTimeout ?? DEFAULT_CALL_TIMEOUT_MS;
      const native = this.#capnWeb.current;
      if (native && this.readyState === this.OPEN) {
        return nativeCall(native, method, args, options, timeout);
      }
      if (this.connectionError && this.readyState === this.CLOSED) {
        throw new AgentConnectionClosedError();
      }
      // Connecting or between reconnects: hold the call as a native call
      // rather than queueing a JSON frame that would change its meaning.
      return this.#nativeQueue.enqueue(method, args, options, timeout);
    }
    if (this.connectionError && this.readyState === this.CLOSED) {
      throw new AgentConnectionClosedError();
    }

    return this.#rpc.call(
      this,
      method,
      args,
      options,
      this.options.defaultCallTimeout ?? DEFAULT_CALL_TIMEOUT_MS
    );
  }
}

/**
 * Make an HTTP request to an Agent
 * @param opts Connection options
 * @param init Request initialization options
 * @returns Promise resolving to a Response
 */
export function agentFetch(opts: AgentClientFetchOptions, init?: RequestInit) {
  const agentNamespace = camelCaseToKebabCase(opts.agent);

  // If basePath is provided, use it directly; otherwise construct from agent/name
  // When basePath is set, room/party aren't used by PartySocket (basePath replaces the URL)
  if (opts.basePath) {
    return PartySocket.fetch(
      { basePath: opts.basePath, ...opts } as unknown as PartyFetchOptions,
      init
    );
  }

  return PartySocket.fetch(
    {
      party: agentNamespace,
      prefix: "agents",
      room: opts.name || "default",
      ...opts
    },
    init
  );
}
