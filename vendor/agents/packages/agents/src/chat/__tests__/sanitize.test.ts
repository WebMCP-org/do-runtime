import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeMessage } from "../sanitize";

describe("sanitizeMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and keeps the settled copy of a duplicate tool call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const message: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-lookup",
          toolCallId: "tool-1",
          state: "input-available",
          input: { query: "q" }
        },
        {
          type: "tool-lookup",
          toolCallId: "tool-1",
          state: "output-available",
          input: { query: "q" },
          output: { answer: 42 }
        },
        {
          type: "tool-confirm",
          toolCallId: "tool-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        },
        {
          type: "tool-confirm",
          toolCallId: "tool-2",
          state: "input-available",
          input: {}
        }
      ]
    };

    const sanitized = sanitizeMessage(message);

    expect(sanitized.parts).toHaveLength(2);
    expect(sanitized.parts[0]).toMatchObject({
      toolCallId: "tool-1",
      state: "output-available",
      output: { answer: 42 }
    });
    expect(sanitized.parts[1]).toMatchObject({
      toolCallId: "tool-2",
      state: "approval-responded"
    });
    expect(warn).toHaveBeenCalledWith(
      "[agents/chat] Message assistant-1 contained 2 duplicate tool part(s); " +
        "deduplicated before persistence."
    );
  });

  it("does not regress a complete tool input to a streaming duplicate", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [
        {
          type: "tool-lookup",
          toolCallId: "tool-1",
          state: "input-available",
          input: { query: "complete" }
        },
        {
          type: "tool-lookup",
          toolCallId: "tool-1",
          state: "input-streaming",
          input: { query: "partial" }
        }
      ]
    };

    expect(sanitizeMessage(message).parts).toEqual([message.parts[0]]);
  });
});
