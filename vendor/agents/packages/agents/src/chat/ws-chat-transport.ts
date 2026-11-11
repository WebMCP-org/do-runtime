/**
 * Framework-neutral WebSocket transport for AI SDK chat clients.
 *
 * Speaks the CF_AGENT protocol directly and returns AI SDK UI message chunks
 * without reconstructing an HTTP response or parsing an SSE stream.
 */

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { nanoid } from "nanoid";
import { STREAM_RESUME_NONE_REASONS } from "./protocol";
import {
  applyChatResponseFrame,
  failChatStream,
  ReplayChunkBatch
} from "./replay-batch";
import { AppliedChunkLedger, ContinuationReplayFilter } from "./replay-dedupe";
import { MessageType, type OutgoingMessage } from "./wire-types";

/**
 * Short safety-net timeout for a resume probe when the server has said nothing.
 * Under normal operation the server answers a `STREAM_RESUME_REQUEST` with
 * `STREAM_RESUMING`, `STREAM_RESUME_NONE`, or `STREAM_PENDING` well before this.
 */
const RESUME_PROBE_TIMEOUT_MS = 5000;

/**
 * Extended backstop applied once the server says a turn is pending
 * (`STREAM_PENDING`, #1784). The pre-stream window (queueing, MCP setup,
 * debounce, model latency) can exceed the short probe timeout, and the server
 * guarantees a follow-up `STREAM_RESUMING` or `STREAM_RESUME_NONE` — so we wait
 * much longer (refreshed on every keep-waiting frame) but still cap it so a
 * dropped follow-up degrades to a null resolve instead of hanging forever.
 */
const RESUME_PENDING_TIMEOUT_MS = 60000;

const SOCKET_CLOSED_MID_STREAM = "WebSocket closed mid-stream";

/**
 * Ends a stream whose socket closed before the terminal `done` frame, so the
 * AI SDK reports an interrupted turn instead of a completed one (#2013).
 * Uses an error chunk because `controller.error()` would discard chunks the
 * consumer has not read yet.
 */
function interruptChatStream(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  batch?: ReplayChunkBatch
): void {
  batch?.flush();
  controller.enqueue({ type: "error", errorText: SOCKET_CLOSED_MID_STREAM });
  controller.close();
}

/**
 * A live-JavaScript-realm outbox keyed by AI SDK's stable chat id. Keeping the
 * exact serialized frame here lets a newly mounted hook/transport replay a
 * request whose persistence receipt was lost with the previous socket.
 */
interface PendingChatRequest {
  readonly requestId: string;
  readonly frame: string;
  readonly acknowledge?: () => void;
}

type StreamPendingFrame = Extract<
  OutgoingMessage<UIMessage>,
  { type: MessageType.CF_AGENT_STREAM_PENDING }
>;

type StreamResumeNone = Pick<
  Extract<
    OutgoingMessage<UIMessage>,
    { type: MessageType.CF_AGENT_STREAM_RESUME_NONE }
  >,
  "probeId" | "reason"
>;

type StreamResumeOffer = Pick<
  Extract<
    OutgoingMessage<UIMessage>,
    { type: MessageType.CF_AGENT_STREAM_RESUMING }
  >,
  "id" | "probeId"
>;

interface ResumeHandshake {
  readonly probeId: string;
  cancel(): void;
  retry(): void;
  resume(data: { id: string }): void;
  none(data: StreamResumeNone): boolean;
  pending(data: StreamPendingFrame): void;
}

type ChatResponseReceipt = Pick<
  Extract<
    OutgoingMessage<UIMessage>,
    { type: MessageType.CF_AGENT_USE_CHAT_RESPONSE }
  >,
  "error" | "outcome"
>;

function isChatReceipt({ error, outcome }: ChatResponseReceipt): boolean {
  return (
    !error &&
    (outcome === undefined ||
      outcome === "completed" ||
      outcome === "recovering")
  );
}

const pendingChatRequests = new Map<string, PendingChatRequest>();

function rememberPendingChatRequest(
  chatId: string,
  request: PendingChatRequest
): void {
  if (pendingChatRequests.has(chatId)) {
    throw new Error("This chat already has an unacknowledged request");
  }
  pendingChatRequests.set(chatId, request);
}

function forgetPendingChatRequest(
  chatId: string,
  requestId: string
): PendingChatRequest | undefined {
  const pending = pendingChatRequests.get(chatId);
  if (pending?.requestId === requestId) {
    pendingChatRequests.delete(chatId);
    return pending;
  }
}

function forgetPendingChatRequestById(
  requestId: string
): PendingChatRequest | undefined {
  for (const [chatId, request] of pendingChatRequests) {
    if (request.requestId === requestId) {
      pendingChatRequests.delete(chatId);
      return request;
    }
  }
}

function lastUserMessageId(messages: readonly UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
}

/**
 * Agent-like interface for sending/receiving WebSocket messages.
 * Matches `AgentClient` from `agents/client` and the connection returned by
 * `useAgent` from `agents/react`.
 */
export interface AgentConnection {
  // PartySocket returns `false` when the frame was buffered (socket not OPEN)
  // rather than sent immediately; `void` keeps non-PartySocket providers valid.
  send: (data: string) => boolean | void;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal }
  ) => void;
  removeEventListener: (
    type: string,
    listener: (event: MessageEvent) => void
  ) => void;
}

export type WebSocketChatTransportOptions<
  ChatMessage extends UIMessage = UIMessage
> = {
  /** The framework-neutral AgentClient or useAgent connection. */
  agent: AgentConnection;
  /**
   * Callback to add custom fields to the request body before sending.
   */
  prepareBody?: (options: {
    messages: ChatMessage[];
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Optional set to track active request IDs.
   * IDs are added when a request starts and removed when it completes.
   * Used by the onAgentMessage handler to skip messages already handled by the transport.
   */
  activeRequestIds?: Set<string>;
  /**
   * Whether generic client-side abort/cancel lifecycle should cancel the
   * server turn. Explicit cancellation via cancelActiveServerTurn() always
   * sends CF_AGENT_CHAT_REQUEST_CANCEL.
   * @default false
   */
  cancelOnClientAbort?: boolean;
  /**
   * Called when a `submit-message` request frame was buffered rather than sent
   * immediately (the socket was not OPEN, so PartySocket queued it for the next
   * reconnect). The hook uses this to preserve the optimistic message across the
   * reconnect transcript replay. `messageId` is the submitted user message's id.
   */
  onRequestBuffered?: (messageId: string | undefined) => void;
  /** Reports the first server receipt for a submitted user message. */
  onRequestAcknowledged?: (messageId: string) => void;
};

/**
 * ChatTransport that sends messages over WebSocket and returns a
 * ReadableStream<UIMessageChunk> that the AI SDK's useChat consumes directly.
 *
 * This low-level transport handles new and regenerated request streams plus
 * cancellation. Higher-level protocol coordination such as automatic reconnect
 * resume, cross-tab transcript synchronization, and client-tool continuations
 * is provided by integrations such as `useAgentChat`.
 */
export class WebSocketChatTransport<
  ChatMessage extends UIMessage = UIMessage
> implements ChatTransport<ChatMessage> {
  agent: AgentConnection;
  private prepareBody?: WebSocketChatTransportOptions<ChatMessage>["prepareBody"];
  private activeRequestIds?: Set<string>;
  private cancelOnClientAbort: boolean;
  private onRequestBuffered?: WebSocketChatTransportOptions<ChatMessage>["onRequestBuffered"];
  private onRequestAcknowledged?: WebSocketChatTransportOptions<ChatMessage>["onRequestAcknowledged"];

  /**
   * Continuation chunks this client applied, shared with the hook's fallback
   * observer so a replay after reconnect skips them on either path (#1951).
   */
  readonly appliedChunks = new AppliedChunkLedger();
  // Only the pending handshake consumes replies from the shared handler.
  private _resumeHandshake: ResumeHandshake | null = null;
  // Set when a client-side tool result/approval is expected to trigger
  // a new continuation stream. In this mode reconnectToStream() returns
  // a deferred ReadableStream immediately so AI SDK status can transition
  // to "submitted" before the server starts streaming.
  private _expectToolContinuation = false;
  private _abortToolContinuation: (() => boolean) | null = null;
  private _activeServerTurnId: string | null = null;
  private _cancelAttachedStream: (() => boolean) | null = null;
  // Local-only detach for a resume stream owned by an obsolete Chat/agent
  // generation. Unlike explicit cancellation, this never cancels server work.
  private _detachResumeStream: (() => boolean) | null = null;

  constructor(options: WebSocketChatTransportOptions<ChatMessage>) {
    this.agent = options.agent;
    this.prepareBody = options.prepareBody;
    this.activeRequestIds = options.activeRequestIds;
    this.cancelOnClientAbort = options.cancelOnClientAbort ?? false;
    this.onRequestBuffered = options.onRequestBuffered;
    this.onRequestAcknowledged = options.onRequestAcknowledged;
  }

  /**
   * Point the singleton transport at a new Agent connection. A pending resolver
   * belongs to the old Chat/socket generation and must settle before messages
   * from the replacement connection can be consumed (#1914 review).
   */
  setAgent(agent: AgentConnection) {
    if (this.agent === agent) return;
    this.resetResumeState();
    this.agent = agent;
  }

  setCancelOnClientAbort(cancelOnClientAbort: boolean) {
    this.cancelOnClientAbort = cancelOnClientAbort;
  }

  /** Discard any unacknowledged request owned by an explicit chat clear. */
  discardPendingRequest(chatId: string): boolean {
    const discarded = pendingChatRequests.delete(chatId);
    this.resetResumeState();
    return discarded;
  }

  /**
   * Explicitly cancel the active server turn, if any.
   * This is separate from generic client-side abort/cancel lifecycle so
   * clients can detach locally without stopping server work.
   */
  cancelActiveServerTurn(): boolean {
    const requestId = this._activeServerTurnId;
    let cancelledRequest = false;

    if (requestId) {
      forgetPendingChatRequestById(requestId);
      this.sendCancelFrame(requestId);
      this._cancelAttachedStream?.();
      this.clearActiveServerTurn(requestId);
      cancelledRequest = true;
    }

    const cancelledToolContinuation = this.abortActiveToolContinuation();
    return cancelledRequest || cancelledToolContinuation;
  }

  /**
   * The server turn this transport last attached to that has not reported a
   * terminal frame. A socket close ends the local stream but keeps this set,
   * since the server keeps running the turn.
   */
  get activeServerTurnId(): string | null {
    return this._activeServerTurnId;
  }

  private sendCancelFrame(requestId: string) {
    try {
      this.agent.send(
        JSON.stringify({
          id: requestId,
          type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL
        })
      );
    } catch {
      // Ignore failures (e.g. agent already disconnected)
    }
  }

  private setActiveServerTurn(
    requestId: string,
    cancelAttachedStream: (() => boolean) | null
  ) {
    this._activeServerTurnId = requestId;
    this._cancelAttachedStream = cancelAttachedStream;
  }

  private clearActiveServerTurn(requestId: string) {
    if (this._activeServerTurnId === requestId) {
      this._activeServerTurnId = null;
      this._cancelAttachedStream = null;
    }
  }

  /**
   * Mark that the next reconnectToStream() call should attach to a
   * server-initiated tool continuation rather than a page-load resume.
   */
  expectToolContinuation() {
    this._expectToolContinuation = true;
  }

  /**
   * Abort the active client-side tool continuation stream, if one is attached
   * to a server request id.
   */
  abortActiveToolContinuation(): boolean {
    return this._abortToolContinuation?.() ?? false;
  }

  /**
   * True when the transport is waiting for a resume handshake. If supplied,
   * the probe ID must match that handshake.
   */
  isAwaitingResume(probeId?: string): boolean {
    const handshake = this._resumeHandshake;
    return (
      handshake !== null &&
      (probeId === undefined || handshake.probeId === probeId)
    );
  }

  /**
   * Settle and detach the current handshake without interpreting it as a
   * server-idle response. Used when the owning hook/agent generation changes.
   */
  cancelPendingResume(): boolean {
    const handshake = this._resumeHandshake;
    if (!handshake) return false;
    handshake.cancel();
    return true;
  }

  /**
   * Invalidate all client-side resume state for an obsolete hook/agent
   * generation without cancelling its durable server turn.
   */
  resetResumeState(): void {
    this._expectToolContinuation = false;
    this.cancelPendingResume();
    this._detachResumeStream?.();
  }

  /**
   * Re-send the active handshake request on the latest socket generation. This
   * preserves one AI SDK resume operation while recovering a request/reply lost
   * with the previous WebSocket.
   */
  retryPendingResume(): boolean {
    const handshake = this._resumeHandshake;
    if (!handshake) return false;
    handshake.retry();
    return true;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_RESUMING.
   * If reconnectToStream is waiting, this handles the resume handshake
   * (ACK + stream creation) and returns true. Otherwise returns false
   * so the caller can use its own fallback path.
   */
  handleStreamResuming(data: StreamResumeOffer): boolean {
    const handshake = this._resumeHandshake;
    if (!handshake) return false;
    // Consume an obsolete reply so it cannot attach through the fallback path.
    if (this.isAwaitingResume(data.probeId)) handshake.resume(data);
    return true;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_RESUME_NONE.
   * If reconnectToStream is waiting, resolves the promise with null
   * immediately (no 5-second timeout). Returns true if handled.
   */
  handleStreamResumeNone(data: StreamResumeNone = {}): boolean {
    return this._resumeHandshake?.none(data) ?? false;
  }

  /**
   * Called by onAgentMessage when it receives CF_AGENT_STREAM_PENDING (#1784):
   * the server accepted a turn but its stream has not started yet. If a resume
   * path is awaiting, extend its probe timeout (so it keeps waiting for the
   * eventual STREAM_RESUMING / STREAM_RESUME_NONE instead of resolving null
   * after the short window). Returns true if a waiting path consumed it.
   */
  handleStreamPending(data: StreamPendingFrame): boolean {
    const handshake = this._resumeHandshake;
    handshake?.pending(data);
    if (data.persisted === true && data.id) {
      forgetPendingChatRequestById(data.id)?.acknowledge?.();
    }
    return handshake !== null;
  }

  /**
   * Called by the hook's shared message handler when a server turn finishes
   * outside the currently attached transport stream, such as after local-only
   * client cleanup.
   */
  handleServerTurnCompleted(requestId: string, response?: ChatResponseReceipt) {
    const pending = forgetPendingChatRequestById(requestId);
    if (response && isChatReceipt(response)) pending?.acknowledge?.();
    this.clearActiveServerTurn(requestId);
  }

  hasUnacknowledgedRequest(chatId: string): boolean {
    return pendingChatRequests.has(chatId);
  }

  /**
   * Register a server turn that is being rendered outside a transport-owned
   * stream, such as the hook's fallback cross-tab/resume observer path.
   */
  observeServerTurn(requestId: string) {
    this.setActiveServerTurn(requestId, null);
  }

  async sendMessages(options: {
    chatId: string;
    messages: ChatMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: "submit-message" | "regenerate-message";
    messageId?: string;
    body?: object;
    headers?: Record<string, string> | Headers;
    metadata?: unknown;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const chatId = options.chatId;
    const requestId = nanoid(8);
    const abortController = new AbortController();
    let completed = false;
    let requestSent = false;
    let requestAcknowledged = false;

    // Build the request body
    let extraBody: Record<string, unknown> = {};
    if (this.prepareBody) {
      extraBody = await this.prepareBody({
        messages: options.messages,
        trigger: options.trigger,
        messageId: options.messageId
      });
    }
    if (options.body) {
      extraBody = {
        ...extraBody,
        ...(options.body as Record<string, unknown>)
      };
    }

    const bodyPayload = JSON.stringify({
      messages: options.messages,
      trigger: options.trigger,
      ...extraBody
    });

    // Track this request so the onAgentMessage handler skips it
    this.activeRequestIds?.add(requestId);

    // Create a ReadableStream<UIMessageChunk> that emits parsed chunks
    // as they arrive over the WebSocket
    const agent = this.agent;
    const activeIds = this.activeRequestIds;

    // Single cleanup helper — every terminal path (done, error, abort)
    // goes through here exactly once.
    // keepId: when true, do NOT remove requestId from activeIds. Used by
    // explicit cancellation so onAgentMessage skips in-flight chunks
    // and the server's final done:true signal until cleanup happens there.
    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (!keepId) {
        activeIds?.delete(requestId);
      }
      abortController.abort();
    };

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    // Abort handler: terminate the local stream. By default, generic AI SDK
    // abort/cancel lifecycle is local-only so durable server turns can continue
    // and be resumed. Use cancelActiveServerTurn() for explicit user/app
    // cancellation, or cancelOnClientAbort for request-lifetime semantics.
    const onAbort = () => {
      if (completed) return;
      if (this.cancelOnClientAbort) {
        forgetPendingChatRequest(chatId, requestId);
        if (requestSent) {
          this.sendCancelFrame(requestId);
        }
        finish(() => streamController.error(abortError), requestSent);
      } else {
        finish(() => streamController.error(abortError), false, !requestSent);
      }
    };

    // streamController is assigned synchronously by start(), so it is
    // always available by the time onAbort or onMessage can fire.
    let streamController!: ReadableStreamDefaultController<UIMessageChunk>;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<ChatMessage>;

            if (
              data.type === MessageType.CF_AGENT_STREAM_PENDING &&
              data.id === requestId &&
              data.persisted === true
            ) {
              requestAcknowledged = true;
              forgetPendingChatRequest(chatId, requestId)?.acknowledge?.();
              return;
            }
            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;
            requestAcknowledged = true;
            const pending = forgetPendingChatRequest(chatId, requestId);
            if (isChatReceipt(data)) pending?.acknowledge?.();

            if (data.error) {
              finish(() =>
                controller.error(new Error(data.body || "Stream error"))
              );
              return;
            }

            // Parse the body as UIMessageChunk and enqueue
            if (data.body?.trim()) {
              try {
                const chunk = JSON.parse(data.body) as UIMessageChunk;
                controller.enqueue(chunk);
              } catch {
                // Skip malformed chunk bodies
              }
            }

            if (data.done) {
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        const onClose = () => {
          if (!requestAcknowledged) {
            finish(() =>
              controller.error(
                new Error(
                  "Connection closed before the chat request was acknowledged"
                )
              )
            );
            return;
          }
          finish(() => interruptChatStream(controller), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: abortController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: abortController.signal
        });
      },
      cancel() {
        onAbort();
      }
    });

    // Handle abort from the caller
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
    }

    if (completed) {
      return stream;
    }

    const traceparent =
      options.headers instanceof Headers
        ? options.headers.get("traceparent")
        : Object.entries(options.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "traceparent"
          )?.[1];
    const requestFrame = JSON.stringify({
      id: requestId,
      init: {
        method: "POST",
        body: bodyPayload,
        ...(traceparent ? { headers: { traceparent } } : {})
      },
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST
    });
    const userMessageId =
      options.trigger === "submit-message" && this.onRequestAcknowledged
        ? lastUserMessageId(options.messages)
        : undefined;
    try {
      rememberPendingChatRequest(chatId, {
        requestId,
        frame: requestFrame,
        ...(userMessageId
          ? {
              acknowledge: () => {
                void Promise.resolve()
                  .then(() => this.onRequestAcknowledged?.(userMessageId))
                  .catch(() =>
                    console.error(
                      "Chat request acknowledgement observer failed"
                    )
                  );
              }
            }
          : {})
      });
    } catch (error) {
      finish(() =>
        streamController.error(
          error instanceof Error ? error : new Error(String(error))
        )
      );
      throw error;
    }

    // Send the request over WebSocket. `send()` returns false when the frame
    // was buffered (socket not OPEN) rather than sent immediately; a buffered
    // submit means the server hasn't seen the message yet, so tell the hook to
    // preserve it across the reconnect transcript replay. Only an explicit
    // false counts — non-PartySocket doubles return undefined (treated as sent).
    requestSent = true;
    const sent = agent.send(requestFrame);
    if (sent === false && options.trigger === "submit-message") {
      this.onRequestBuffered?.(
        userMessageId ?? lastUserMessageId(options.messages)
      );
    }

    return stream;
  }

  async reconnectToStream(options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // A transport has one handshake slot. Returning null for an unexpected
    // concurrent caller is safer than overwriting callbacks owned by the first
    // AI SDK request (StrictMode/manual overlap); the hook serializes its normal
    // mount, tool, public, and reconnect entry points.
    if (this.isAwaitingResume()) return null;

    if (this._expectToolContinuation) {
      this._expectToolContinuation = false;
      return this._createToolContinuationStream();
    }

    // Detect whether the server has an active stream for this chat.
    // Instead of registering another message listener (which races with the
    // hook), expose identity-owned callbacks consumed synchronously by the
    // shared handler.
    const activeIds = this.activeRequestIds;
    const probeId = nanoid(8);
    const pendingRequest = pendingChatRequests.get(options.chatId);
    const previousTurnId = this._activeServerTurnId;

    return new Promise<ReadableStream<UIMessageChunk> | null>((resolve) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const done = (
        value:
          | ReadableStream<UIMessageChunk>
          | Promise<ReadableStream<UIMessageChunk>>
          | null
      ) => {
        if (resolved) return;
        resolved = true;
        if (this._resumeHandshake === handshake) this._resumeHandshake = null;
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };

      const armTimeout = (delay: number) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => done(null), delay);
      };

      // Keep-waiting (#1784): the server says a turn is accepted but its stream
      // has not started. Extend this operation's own timeout only.
      const onStreamPending = (data: StreamPendingFrame) => {
        if (resolved) return;
        armTimeout(RESUME_PENDING_TIMEOUT_MS);
        if (
          pendingRequest &&
          pendingChatRequests.get(options.chatId) === pendingRequest &&
          data.persisted === true &&
          data.id === pendingRequest.requestId
        ) {
          forgetPendingChatRequest(
            options.chatId,
            pendingRequest.requestId
          )?.acknowledge?.();
          activeIds?.add(pendingRequest.requestId);
          done(this._createResumeStream(pendingRequest.requestId));
        }
      };

      const onResumeNone = (data: StreamResumeNone) => {
        if (data.probeId && data.probeId !== probeId) return false;
        if (
          pendingRequest &&
          pendingChatRequests.get(options.chatId)?.requestId ===
            pendingRequest.requestId
        ) {
          // The replay and probe share a socket but their server handlers may
          // race. NONE only answers the probe; it cannot reject a retained chat
          // request that is still awaiting its persistence receipt.
          armTimeout(RESUME_PENDING_TIMEOUT_MS);
          return true;
        }
        if (
          previousTurnId &&
          data.probeId === probeId &&
          data.reason === STREAM_RESUME_NONE_REASONS.IDLE
        ) {
          this.clearActiveServerTurn(previousTurnId);
        }
        done(null);
        return true;
      };

      const onResume = (data: { id: string }) => {
        const requestId = data.id;
        activeIds?.add(requestId);
        const stream = this._createResumeStream(requestId, true);

        this.agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
            id: requestId
          })
        );

        done(stream);
      };

      // Re-arm both the request and timeout on each replacement socket. This is
      // a retransmission of this resolver's handshake, not a second Chat resume.
      const retryResumeProbe = () => {
        if (resolved) return;
        armTimeout(RESUME_PROBE_TIMEOUT_MS);
        try {
          if (
            pendingRequest &&
            pendingChatRequests.get(options.chatId) === pendingRequest
          ) {
            this.agent.send(pendingRequest.frame);
          }
          this.agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
              probeId
            })
          );
        } catch {
          // The next socket open retries again; the timeout remains a backstop.
        }
      };

      const handshake: ResumeHandshake = {
        probeId,
        cancel: () => done(null),
        retry: retryResumeProbe,
        resume: onResume,
        none: onResumeNone,
        pending: onStreamPending
      };
      this._resumeHandshake = handshake;
      retryResumeProbe();
    });
  }

  /**
   * Creates a deferred ReadableStream for client-side tool continuations.
   * The stream is returned immediately so AI SDK status becomes "submitted"
   * right after addToolOutput()/addToolApprovalResponse(), then it waits for
   * the server to announce the continuation via STREAM_RESUMING.
   */
  private _createToolContinuationStream(): ReadableStream<UIMessageChunk> {
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const streamController = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let requestId: string | null = null;
    let readerController: ReadableStreamDefaultController<UIMessageChunk> | null =
      null;
    // Held outside start() so the close and detach paths can flush replayed
    // content before they close the stream.
    let replayBatch: ReplayChunkBatch | null = null;
    const probeId = nanoid(8);
    let handshake: ResumeHandshake | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortToolContinuationRef: (() => boolean) | null = null;
    let detachResumeStreamRef: (() => boolean) | null = null;

    const clearOwnedHandshake = () => {
      if (this._resumeHandshake === handshake) this._resumeHandshake = null;
      if (timeout) clearTimeout(timeout);
    };

    const finish = (action: () => void, keepRequestId = false) => {
      if (completed) return;
      completed = true;
      if (this._abortToolContinuation === abortToolContinuationRef) {
        this._abortToolContinuation = null;
      }
      if (this._detachResumeStream === detachResumeStreamRef) {
        this._detachResumeStream = null;
      }
      clearOwnedHandshake();
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (requestId && !keepRequestId) {
        activeIds?.delete(requestId);
      }
      streamController.abort();
    };

    const transport = this;

    abortToolContinuationRef = () => {
      if (completed) return false;

      if (requestId === null) {
        finish(() => readerController?.error(abortError));
        return true;
      }

      try {
        agent.send(
          JSON.stringify({
            type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
            id: requestId
          })
        );
      } catch {
        // Ignore failures (e.g. agent already disconnected)
      }

      // Keep the ID so the shared message handler ignores in-flight chunks
      // until the server's terminal frame performs its normal cleanup.
      finish(() => readerController?.error(abortError), true);
      return true;
    };
    this._abortToolContinuation = abortToolContinuationRef;
    detachResumeStreamRef = () => {
      if (completed) return false;
      finish(() => {
        replayBatch?.flush();
        readerController?.close();
      });
      return true;
    };
    this._detachResumeStream = detachResumeStreamRef;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        readerController = controller;
        const batch = new ReplayChunkBatch(controller);
        replayBatch = batch;
        let replayFilter: ContinuationReplayFilter<
          OutgoingMessage<UIMessage> & {
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE;
          }
        > | null = null;
        const armTimeout = (delay: number) => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => finish(() => controller.close()), delay);
        };

        const close = () => finish(() => controller.close());

        const onResumeNone = (data: StreamResumeNone) => {
          if (data.probeId && data.probeId !== probeId) return false;
          close();
          return true;
        };

        const onResume = (data: { id: string }) => {
          if (requestId) return;

          requestId = data.id;
          activeIds?.add(requestId);
          clearOwnedHandshake();

          agent.send(
            JSON.stringify({
              type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
              id: requestId
            })
          );
        };

        const onStreamPending = () => {
          if (completed) return;
          armTimeout(RESUME_PENDING_TIMEOUT_MS);
        };

        const retryResumeProbe = () => {
          if (completed || requestId !== null) return;
          armTimeout(RESUME_PROBE_TIMEOUT_MS);
          try {
            transport.agent.send(
              JSON.stringify({
                type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
                probeId
              })
            );
          } catch {
            // A later socket open can retry this same deferred handshake.
          }
        };

        handshake = {
          probeId,
          cancel: close,
          retry: retryResumeProbe,
          resume: onResume,
          none: onResumeNone,
          pending: onStreamPending
        };
        transport._resumeHandshake = handshake;

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<UIMessage>;

            if (
              data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
              requestId == null ||
              data.id !== requestId
            ) {
              return;
            }

            if (data.error) {
              transport.appliedChunks.forget(requestId);
              finish(() => failChatStream(batch, data.body || "Stream error"));
              return;
            }

            replayFilter ??= new ContinuationReplayFilter(
              transport.appliedChunks,
              requestId
            );
            for (const frame of replayFilter.frames(data)) {
              applyChatResponseFrame(batch, frame);
            }

            if (data.done) {
              transport.appliedChunks.forget(requestId);
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        // Before the resume handshake there is no server turn to interrupt;
        // closing cleanly lets the hook re-probe on the next open.
        const onClose = () =>
          finish(() =>
            requestId === null
              ? controller.close()
              : interruptChatStream(controller, batch)
          );

        agent.addEventListener("message", onMessage, {
          signal: streamController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: streamController.signal
        });

        retryResumeProbe();
      },
      cancel() {
        if (requestId && transport.cancelOnClientAbort) {
          transport.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {});
        }
      }
    });
  }

  /**
   * Creates a ReadableStream that receives resumed stream chunks
   * and forwards them to useChat as UIMessageChunk objects.
   */
  private _createResumeStream(
    requestId: string,
    resumeAcknowledged = false
  ): Promise<ReadableStream<UIMessageChunk>> {
    // AI SDK snapshots the hydrated assistant after reconnectToStream resolves.
    // Wait for the first frame so the hook can clear a matching chunk-0 replay
    // before that snapshot; clearing the visible messages later cannot reset
    // AI SDK's private streaming buffer.
    let resolveReady: (stream: ReadableStream<UIMessageChunk>) => void;
    const ready = new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
      resolveReady = resolve;
    });
    // Read agent at resolve time (not when reconnectToStream was called)
    // so chunk listener attaches to the latest socket after _pk changes.
    const agent = this.agent;
    const activeIds = this.activeRequestIds;
    const chunkController = new AbortController();
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    let completed = false;
    let detachResumeStream: (() => boolean) | null = null;
    let resumeAckSent = resumeAcknowledged;

    const finish = (
      action: () => void,
      keepId = false,
      clearServerTurn = true
    ) => {
      if (completed) return;
      completed = true;
      if (clearServerTurn) {
        this.clearActiveServerTurn(requestId);
      }
      if (this._detachResumeStream === detachResumeStream) {
        this._detachResumeStream = null;
      }
      try {
        action();
      } catch {
        // Stream may already be closed
      }
      if (!keepId) {
        activeIds?.delete(requestId);
      }
      chunkController.abort();
      resolveReady(stream);
    };

    let streamController: ReadableStreamDefaultController<UIMessageChunk> | null =
      null;
    // Held outside start() so the close and detach paths can flush replayed
    // content before they close the stream.
    let replayBatch: ReplayChunkBatch | null = null;
    const cancelActiveRequest = () => {
      if (completed) return false;
      finish(() => streamController?.error(abortError), true);
      return true;
    };
    this.setActiveServerTurn(requestId, cancelActiveRequest);

    const transport = this;
    detachResumeStream = () => {
      if (completed) return false;
      finish(() => {
        replayBatch?.flush();
        streamController?.close();
      });
      return true;
    };
    this._detachResumeStream = detachResumeStream;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        streamController = controller;
        const batch = new ReplayChunkBatch(controller);
        replayBatch = batch;
        const replayFilter = new ContinuationReplayFilter<
          OutgoingMessage<UIMessage> & {
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE;
          }
        >(transport.appliedChunks, requestId);

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(
              event.data as string
            ) as OutgoingMessage<UIMessage>;

            if (
              data.type === MessageType.CF_AGENT_STREAM_RESUMING &&
              data.id === requestId
            ) {
              if (!resumeAckSent) {
                resumeAckSent = true;
                agent.send(
                  JSON.stringify({
                    type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
                    id: requestId
                  })
                );
              }
              return;
            }

            if (data.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE) return;
            if (data.id !== requestId) return;
            const pending = forgetPendingChatRequestById(requestId);
            if (isChatReceipt(data)) pending?.acknowledge?.();

            if (data.error) {
              transport.appliedChunks.forget(requestId);
              finish(() => failChatStream(batch, data.body || "Stream error"));
              return;
            }

            for (const frame of replayFilter.frames(data)) {
              applyChatResponseFrame(batch, frame);
            }
            resolveReady(stream);

            if (data.done) {
              transport.appliedChunks.forget(requestId);
              finish(() => controller.close());
            }
          } catch {
            // Ignore non-JSON messages
          }
        };

        const onClose = () => {
          finish(() => interruptChatStream(controller, batch), false, false);
        };

        agent.addEventListener("message", onMessage, {
          signal: chunkController.signal
        });
        agent.addEventListener("close", onClose, {
          signal: chunkController.signal
        });
      },
      cancel() {
        if (transport.cancelOnClientAbort) {
          forgetPendingChatRequestById(requestId);
          transport.sendCancelFrame(requestId);
          finish(() => {}, true);
        } else {
          finish(() => {}, false, false);
        }
      }
    });
    return ready;
  }
}
