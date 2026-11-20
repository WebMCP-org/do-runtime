import type { UIMessage } from "ai";
import {
  useAgentChat as useAgentChatCore,
  type UseAgentChatOptions
} from "agents/chat/react";

export {
  getToolPartState,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolApproval,
  getAgentMessages,
  useAgentChatHistory
} from "agents/chat/react";

export type {
  AITool,
  ClientToolSchema,
  PrepareSendMessagesRequestOptions,
  PrepareSendMessagesRequestResult,
  OnToolCallCallback,
  ChatTurnEndEvent,
  ChatTurnOutcome
} from "agents/chat/react";

export type ThinkChatOptions<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
> = Omit<UseAgentChatOptions<State, ChatMessage>, "syncMessagesToServer">;

export type UseThinkChatOptions<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
> = ThinkChatOptions<State, ChatMessage>;

/**
 * Think-facing chat hook.
 *
 * On Think, `setMessages` updates the local view only. It does not persist a
 * client-pushed transcript because Think's Session tree is server-authoritative.
 * Use `clearHistory()` for persisted clears.
 */
export function useAgentChat<
  State = unknown,
  ChatMessage extends UIMessage = UIMessage
>(options: ThinkChatOptions<State, ChatMessage>) {
  return useAgentChatCore<State, ChatMessage>({
    ...options,
    syncMessagesToServer: false
  });
}
