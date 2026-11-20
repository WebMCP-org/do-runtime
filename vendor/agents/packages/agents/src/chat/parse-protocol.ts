/** Decode untrusted chat frames once, before either chat host uses their fields. */
import { z } from "zod";
import { CHAT_MESSAGE_TYPES } from "./protocol";

const requestId = z.string().min(1);
const clientTool = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional()
});
const incomingFrame = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST),
      id: requestId,
      init: z
        .object({ method: z.string().optional(), body: z.string().optional() })
        .catchall(z.unknown())
    }),
    z.object({ type: z.literal(CHAT_MESSAGE_TYPES.CHAT_CLEAR) }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL),
      id: requestId
    }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.TOOL_RESULT),
      toolCallId: requestId,
      toolName: z.string().optional(),
      output: z.unknown().optional(),
      state: z.enum(["output-available", "output-error"]).optional(),
      errorText: z.string().optional(),
      autoContinue: z.boolean().optional(),
      clientTools: z.array(clientTool).optional()
    }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.TOOL_APPROVAL),
      toolCallId: requestId,
      approved: z.boolean(),
      autoContinue: z.boolean().optional()
    }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST),
      probeId: requestId.optional()
    }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK),
      id: requestId
    }),
    z.object({
      type: z.literal(CHAT_MESSAGE_TYPES.CHAT_MESSAGES),
      messages: z.array(z.unknown())
    })
  ])
  .transform((frame) => {
    switch (frame.type) {
      case CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST:
        return { ...frame, type: "chat-request" as const };
      case CHAT_MESSAGE_TYPES.CHAT_CLEAR:
        return { type: "clear" as const };
      case CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL:
        return { ...frame, type: "cancel" as const };
      case CHAT_MESSAGE_TYPES.TOOL_RESULT:
        return { ...frame, type: "tool-result" as const };
      case CHAT_MESSAGE_TYPES.TOOL_APPROVAL:
        return { ...frame, type: "tool-approval" as const };
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST:
        return { ...frame, type: "stream-resume-request" as const };
      case CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK:
        return { ...frame, type: "stream-resume-ack" as const };
      case CHAT_MESSAGE_TYPES.CHAT_MESSAGES:
        return { ...frame, type: "messages" as const };
    }
  });

export type ChatProtocolEvent = z.output<typeof incomingFrame>;

/** A recognized protocol frame failed validation; never dispatch it as an application message. */
export class ChatProtocolError extends Error {
  constructor(
    readonly frameType: string,
    cause: z.ZodError
  ) {
    super(`Invalid chat protocol frame: ${frameType}`, { cause });
    this.name = "ChatProtocolError";
  }
}

const recognizedTypes = new Set<string>([
  CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
  CHAT_MESSAGE_TYPES.CHAT_CLEAR,
  CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
  CHAT_MESSAGE_TYPES.TOOL_RESULT,
  CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
  CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
  CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
  CHAT_MESSAGE_TYPES.CHAT_MESSAGES
]);

/** Unknown application messages return null; malformed recognized chat frames throw. */
export function parseProtocolMessage(raw: string): ChatProtocolEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    data === null ||
    typeof data !== "object" ||
    !("type" in data) ||
    typeof data.type !== "string" ||
    !recognizedTypes.has(data.type)
  )
    return null;
  const result = incomingFrame.safeParse(data);
  if (!result.success) throw new ChatProtocolError(data.type, result.error);
  return result.data;
}
