import { RpcTarget } from "cloudflare:workers";
import type { FiberContext } from "agents";
import { TextSegmentJoiner } from "agents/chat";
import type { UIMessage } from "ai";
import type { ChatStartEvent, StreamCallback } from "../think";
import type { MessengerEvent } from "./events";
import { toMessengerUserMessage } from "./events";

export const MESSENGER_REPLY_FIBER_NAME = "think:messenger-reply";

export const EMPTY_MESSENGER_RESPONSE =
  "I couldn't produce a text response. Please try again.";
export const ERROR_MESSENGER_RESPONSE =
  "Sorry, I couldn't answer that right now. Please try again.";
export const INTERRUPTED_MESSENGER_RESPONSE =
  "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

type Wake = () => void;

export interface TextStreamCallbackOptions {
  onVisibleStart?: () => Promise<void> | void;
  visibleSoftLimit?: number;
}

export class TextStreamCallback extends RpcTarget implements StreamCallback {
  private readonly onVisibleStart?: () => Promise<void> | void;
  private readonly textSegmentJoiner = new TextSegmentJoiner();
  private readonly visibleChunks: string[] = [];
  private readonly wakeups: Wake[] = [];
  private readonly visibleSoftLimit?: number;
  private chatRequestId?: string;
  private closed = false;
  private completed = false;
  private interrupted = false;
  private error?: Error;
  private text = "";
  private visibleClosed = false;
  private visibleLimitReachedValue = false;
  private visibleStarted = false;
  private visibleTextValue = "";

  constructor(options: TextStreamCallbackOptions = {}) {
    super();
    this.onVisibleStart = options.onVisibleStart;
    this.visibleSoftLimit = options.visibleSoftLimit;
  }

  onStart(event: ChatStartEvent): void {
    this.chatRequestId = event.requestId;
  }

  onEvent(json: string): void {
    const chunk = streamChunkFromJson(json);
    if (!chunk) return;

    let pushedText = false;
    for (const event of this.textSegmentJoiner.pushChunk(chunk)) {
      if (event.type !== "text") continue;
      this.text += event.text;
      this.pushVisibleText(event.text);
      pushedText = true;
    }
    if (pushedText) this.wake();
  }

  onDone(): void {
    this.completed = true;
    this.close();
  }

  onError(error: string): void {
    this.fail(new Error(error));
  }

  onInterrupted(): void {
    // The attempt was interrupted and a continuation (not this callback) owns
    // the real answer — delivered only to WebSocket connections, never to this
    // surface. Mark interrupted and stop the visible stream WITHOUT failing it,
    // so delivery surfaces the interrupted apology instead of treating the
    // partial as the final reply (#1644).
    this.interrupted = true;
    this.close();
  }

  wasInterrupted(): boolean {
    return this.interrupted;
  }

  close(): void {
    this.closed = true;
    this.visibleClosed = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.visibleClosed = true;
    this.wake();
  }

  hasText(): boolean {
    return this.text.trim().length > 0;
  }

  wasCompleted(): boolean {
    return this.completed;
  }

  remainingText(): string {
    return this.text.slice(this.visibleTextValue.length);
  }

  requestId(): string | undefined {
    return this.chatRequestId;
  }

  textSoFar(): string {
    return this.text;
  }

  visibleLimitReached(): boolean {
    return this.visibleLimitReachedValue;
  }

  visibleText(): string {
    return this.visibleTextValue;
  }

  async *stream(): AsyncIterable<string> {
    while (true) {
      const next = this.visibleChunks.shift();
      if (next !== undefined) {
        await this.markVisibleStarted();
        yield next;
        continue;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.closed || this.visibleClosed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wakeups.push(resolve);
      });
    }
  }

  private pushVisibleText(text: string): void {
    if (this.visibleClosed) {
      return;
    }

    if (this.visibleSoftLimit === undefined) {
      this.visibleChunks.push(text);
      this.visibleTextValue += text;
      return;
    }

    const remaining = this.visibleSoftLimit - this.visibleTextValue.length;
    if (remaining <= 0) {
      this.visibleClosed = true;
      this.visibleLimitReachedValue = true;
      return;
    }

    const visible = text.slice(0, remaining);
    if (visible) {
      this.visibleChunks.push(visible);
      this.visibleTextValue += visible;
    }

    if (
      visible.length < text.length ||
      this.visibleTextValue.length >= this.visibleSoftLimit
    ) {
      this.visibleClosed = true;
      this.visibleLimitReachedValue = true;
    }
  }

  private wake(): void {
    for (const wake of this.wakeups.splice(0)) {
      wake();
    }
  }

  private async markVisibleStarted(): Promise<void> {
    if (this.visibleStarted) {
      return;
    }
    this.visibleStarted = true;
    await this.onVisibleStart?.();
  }
}

function streamChunkFromJson(
  json: string
): { delta?: unknown; type?: unknown } | null {
  try {
    const chunk: unknown = JSON.parse(json);
    return typeof chunk === "object" && chunk !== null
      ? (chunk as { delta?: unknown; type?: unknown })
      : null;
  } catch {
    return null;
  }
}

export type MessengerReplyStage = "accepted" | "streaming" | "completed";

/**
 * Explicit delivery lifecycle kind, orthogonal to {@link MessengerReplyStage}.
 * Lets surfaces (voice/CLI especially) tell a final answer from an interim
 * progress note from a deterministic notice from a control command, rather than
 * inferring from text shape.
 */
export type DeliveryKind = "final" | "interim" | "notice" | "command";

/**
 * Explicit delivery lifecycle tag carried on the wire/snapshot. Orthogonal to,
 * and additive on top of, {@link MessengerReplyStage}: recovery still switches
 * on `stage`, while `kind`/`turnEnded` give non-streaming-text surfaces
 * (voice/CLI) an explicit signal instead of inferring from text shape.
 */
export interface DeliveryTag {
  stage: MessengerReplyStage;
  kind: DeliveryKind;
  turnEnded: boolean;
}

/** Derive a sensible default tag from a reply stage. */
export function defaultDeliveryTag(stage: MessengerReplyStage): DeliveryTag {
  return {
    stage,
    kind: stage === "completed" ? "final" : "interim",
    turnEnded: stage === "completed"
  };
}

export interface MessengerReplySnapshot {
  event: MessengerEvent;
  stage: MessengerReplyStage;
  tag?: DeliveryTag;
  thread?: unknown;
  type: typeof MESSENGER_REPLY_FIBER_NAME;
}

export function messengerReplySnapshot(
  stage: MessengerReplyStage,
  event: MessengerEvent,
  thread?: unknown,
  tag?: DeliveryTag
): MessengerReplySnapshot {
  return {
    event,
    stage,
    tag: tag ?? defaultDeliveryTag(stage),
    thread,
    type: MESSENGER_REPLY_FIBER_NAME
  };
}

export function parseMessengerReplySnapshot(
  snapshot: unknown
): MessengerReplySnapshot | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<MessengerReplySnapshot>;
  if (
    candidate.type !== MESSENGER_REPLY_FIBER_NAME ||
    (candidate.stage !== "accepted" &&
      candidate.stage !== "streaming" &&
      candidate.stage !== "completed") ||
    candidate.event === undefined
  ) {
    return null;
  }

  return {
    event: candidate.event,
    stage: candidate.stage,
    tag: candidate.tag ?? defaultDeliveryTag(candidate.stage),
    thread: candidate.thread,
    type: MESSENGER_REPLY_FIBER_NAME
  };
}

export function messengerReplyRecoveryMode(
  snapshot: MessengerReplySnapshot
): "answer" | "apologize" | null {
  if (snapshot.stage === "accepted") {
    return "answer";
  }
  if (snapshot.stage === "streaming") {
    return "apologize";
  }
  return null;
}

export function messengerReplyFailureMode(
  hasStreamedText: boolean,
  completedModelTurn = false,
  expectedDeliveryCompletion = false
): "apologize" | "error" | null {
  if (expectedDeliveryCompletion) {
    return null;
  }

  if (completedModelTurn) {
    return "error";
  }

  return hasStreamedText ? "apologize" : "error";
}

export interface MessengerDeliveryTarget {
  cancelChat(
    requestId: string,
    reason?: string
  ): boolean | void | Promise<boolean | void>;
  chatWithMessengerDelivery(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerEvent,
    surface: MessengerDeliverySurface
  ): Promise<void>;
}

/**
 * A file to upload alongside a reply. Structurally the chat SDK's `FileUpload`,
 * restated here so this module keeps depending only on the delivery surface's
 * shape rather than on a chat-sdk import.
 */
export interface MessengerDeliveryFile {
  data: ArrayBuffer | Blob;
  filename: string;
  mimeType?: string;
}

export interface MessengerDeliveryPostable {
  files?: MessengerDeliveryFile[];
  markdown: string;
}

/**
 * The postable subset a delivery surface accepts. Every implementation is a
 * chat-sdk `Thread`, whose `post()` already takes files on each of its postable
 * shapes and hands them to the adapter's own uploader — so a host with a file
 * to deliver posts it here rather than reaching for a provider's REST API.
 * Streams stay text-only: no adapter attaches files to a streamed message.
 */
export interface MessengerDeliverySurface {
  post(
    message: string | MessengerDeliveryPostable | AsyncIterable<string>
  ): Promise<unknown>;
  startTyping?(status?: string): Promise<void>;
}

/**
 * The delivery surface as seen by a conversation agent across the RPC boundary.
 *
 * A host with files to deliver can keep the bytes on the side that owns the
 * surface — `onReplyComplete` receives the live one — instead of copying an
 * attachment through the Agent RPC proxy before the adapter uploads it.
 */
class MessengerDeliverySurfaceTarget
  extends RpcTarget
  implements MessengerDeliverySurface
{
  constructor(private readonly surface: MessengerDeliverySurface) {
    super();
  }

  post(
    message: string | MessengerDeliveryPostable | AsyncIterable<string>
  ): Promise<unknown> {
    return this.surface.post(message);
  }
}

export interface MessengerDeliveryPolicy {
  emptyResponseText?: string;
  errorResponseText?: string;
  interruptedResponseText?: string;
  isExpectedDeliveryCompletion?(
    error: unknown,
    callback: TextStreamCallback
  ): boolean;
  /**
   * Fires after a completed reply has been posted, with the full reply text,
   * the event that produced it, and the surface it was posted to, so a host can
   * act on the finished message from a place that can await and can address the
   * originating thread (resolving workspace file links into provider
   * attachments, for example). It also fires with empty text on the
   * empty-response fallback.
   *
   * The surface is the live delivery surface, not the serializable event: a host
   * follows up through the same adapter that just delivered the reply, with no
   * provider REST client, credential, or thread-id decoding of its own.
   *
   * A throw never reaches the user: the reply is already posted, so the catch
   * below reports through `isExpectedDeliveryCompletion` and still completes the
   * turn. A host that needs its own failure to be visible must say so itself.
   */
  onReplyComplete?(
    text: string,
    event: MessengerEvent,
    surface: MessengerDeliverySurface
  ): Promise<void> | void;
  splitText?(text: string): string[];
  visibleSoftLimit?: number;
}

export interface DeliverMessengerReplyOptions {
  checkpoint?: (snapshot: MessengerReplySnapshot) => Promise<void> | void;
  event: MessengerEvent;
  fiber?: FiberContext;
  policy?: MessengerDeliveryPolicy;
  snapshotEvent?: MessengerEvent;
  snapshotThread?: unknown;
  surface: MessengerDeliverySurface;
  target: MessengerDeliveryTarget;
  userMessage?: UIMessage;
}

export async function deliverMessengerReply(
  options: DeliverMessengerReplyOptions
): Promise<void> {
  const emptyResponseText =
    options.policy?.emptyResponseText ?? EMPTY_MESSENGER_RESPONSE;
  const errorResponseText =
    options.policy?.errorResponseText ?? ERROR_MESSENGER_RESPONSE;
  const interruptedResponseText =
    options.policy?.interruptedResponseText ?? INTERRUPTED_MESSENGER_RESPONSE;
  let completedModelTurn = false;
  const snapshotEvent = options.snapshotEvent ?? options.event;
  const checkpoint =
    options.checkpoint ??
    ((snapshot: MessengerReplySnapshot) => {
      options.fiber?.stash(snapshot);
    });

  const callback = new TextStreamCallback({
    onVisibleStart: async () => {
      await checkpoint(
        messengerReplySnapshot(
          "streaming",
          snapshotEvent,
          options.snapshotThread
        )
      );
    },
    visibleSoftLimit: options.policy?.visibleSoftLimit
  });
  const post = options.surface
    .post(callback.stream())
    .catch(async (error: unknown) => {
      if (options.policy?.isExpectedDeliveryCompletion?.(error, callback)) {
        return;
      }

      const requestId = callback.requestId();
      if (requestId) {
        await Promise.resolve(
          options.target.cancelChat(requestId, toError(error).message)
        ).catch(() => undefined);
      }
      callback.fail(error);
      throw error;
    });

  try {
    await options.surface.startTyping?.("Thinking...");
    const userMessage =
      options.userMessage ?? toMessengerUserMessage(options.event);
    await options.target.chatWithMessengerDelivery(
      userMessage,
      callback,
      snapshotEvent,
      new MessengerDeliverySurfaceTarget(options.surface)
    );
    if (callback.wasInterrupted()) {
      // The model turn was interrupted and routed into bounded recovery; the
      // recovered answer is produced later by a scheduled continuation and
      // broadcast only to WebSocket connections, NOT to this one-shot messenger
      // delivery. Do NOT mark the turn complete or finalize the truncated
      // partial as the reply — surface the interrupted apology so the user
      // knows to retry (#1644). `completedModelTurn` stays false.
      callback.close();
      await post.catch(() => undefined);
      await options.surface
        .post(interruptedResponseText)
        .catch(() => undefined);
      await checkpoint(
        messengerReplySnapshot(
          "completed",
          snapshotEvent,
          options.snapshotThread
        )
      );
      return;
    }
    completedModelTurn = true;
    callback.close();
    await post;
    if (!callback.hasText()) {
      await options.surface.post(emptyResponseText);
    }
    for (const chunk of options.policy?.splitText?.(callback.remainingText()) ??
      []) {
      await options.surface.post(chunk);
    }
    // Checkpoint before the hook, not after: the hook does host I/O that can
    // take seconds, and a fiber left at "streaming" for that long recovers as
    // an apology posted underneath a reply the user can already read.
    await checkpoint(
      messengerReplySnapshot("completed", snapshotEvent, options.snapshotThread)
    );
    await options.policy?.onReplyComplete?.(
      callback.textSoFar(),
      snapshotEvent,
      options.surface
    );
  } catch (error) {
    callback.fail(error);
    await post.catch(() => undefined);
    const expectedDeliveryCompletion =
      options.policy?.isExpectedDeliveryCompletion?.(error, callback) ?? false;
    const failureMode = messengerReplyFailureMode(
      callback.hasText(),
      completedModelTurn,
      expectedDeliveryCompletion || callback.wasCompleted()
    );

    if (failureMode === null) {
      await checkpoint(
        messengerReplySnapshot(
          "completed",
          snapshotEvent,
          options.snapshotThread
        )
      );
      return;
    }

    if (failureMode === "apologize") {
      await options.surface
        .post(interruptedResponseText)
        .catch(() => undefined);
      await checkpoint(
        messengerReplySnapshot(
          "completed",
          snapshotEvent,
          options.snapshotThread
        )
      );
      return;
    }

    await options.surface
      .post({
        markdown: errorResponseText
      })
      .catch(() => undefined);
    await checkpoint(
      messengerReplySnapshot("completed", snapshotEvent, options.snapshotThread)
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
