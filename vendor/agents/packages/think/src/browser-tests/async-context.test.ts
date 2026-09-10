import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  currentRequest,
  inferenceInvocation,
  newContext,
  startInvocation,
  tracedStream
} from "./async-context.actor";

// This module deliberately retains native awaits. Only the actor fixture and
// SDK modules are transformed, so a leaked scope cannot hide in the test caller.
describe("browser SDK async context", () => {
  it.each([false, true])(
    "isolates suspended invocations with shared actor=%s",
    async (sharedActor) => {
      const firstContext = newContext();
      const first = startInvocation(firstContext, "first");
      const second = startInvocation(
        sharedActor ? firstContext : newContext(),
        "second"
      );
      await Promise.all([first.started, second.started]);
      expect(currentRequest()).toBeUndefined();
      second.resume();
      const secondResult = await second.result;
      expect(currentRequest()).toBeUndefined();
      first.resume();
      const firstResult = await first.result;
      for (const [name, result] of [
        ["first", firstResult],
        ["second", secondResult]
      ] as const) {
        const expected = { request: `/${name}`, host: true, input: true };
        expect(result).toEqual({
          before: expected,
          after: expected,
          caught: expected
        });
      }
      expect(currentRequest()).toBeUndefined();
    }
  );

  it.each([false, true])(
    "restores traced generator context including cleanup with early return=%s",
    async (earlyReturn) => {
      const stream = await tracedStream(newContext());
      const consumption = stream.consume(earlyReturn);
      const other = startInvocation(newContext(), "unrelated");
      await other.started;
      expect(currentRequest()).toBeUndefined();
      other.resume();
      await other.result;
      stream.resume();
      expect(await consumption).toEqual({
        values: earlyReturn ? ["/owner"] : ["/owner", "/owner"],
        consumer: "/consumer"
      });
      expect(stream.observations).toEqual(["/owner", "/owner"]);
      const toolSpan = stream.tracing.spans.find(
        (span) => span.name === "execute_tool produce"
      );
      expect(toolSpan).toBeDefined();
      expect(toolSpan?.parent?.name).toBe("owner");
      expect(toolSpan?.endCount).toBe(1);
      expect(
        stream.tracing.spans.find((span) => span.name === "body")?.parent
      ).toBe(toolSpan);
      expect(
        stream.tracing.spans.find((span) => span.name === "cleanup")?.parent
      ).toBe(toolSpan);
      expect(currentRequest()).toBeUndefined();
    }
  );
});

it.each([false, true])(
  "binds deferred model callbacks to overlapping turns with streaming=%s",
  async (streaming) => {
    const model = () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "report",
                input: "{}"
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: 0,
                    cacheWrite: 0
                  },
                  outputTokens: { total: 1, text: 1, reasoning: 0 }
                }
              });
              controller.close();
            }
          })
        })
      });
    const first = inferenceInvocation("first", model(), streaming);
    const second = inferenceInvocation("second", model(), streaming);
    await Promise.all([first.started, second.started]);
    expect(currentRequest()).toBeUndefined();
    second.resume();
    await second.finished;
    first.resume();
    await first.finished;
    for (const [name, invocation] of [
      ["first", first],
      ["second", second]
    ] as const) {
      const phases = invocation.observations.map(({ phase }) => phase);
      expect(phases).toEqual(
        expect.arrayContaining([
          "prepareStep",
          "execute",
          "resumed",
          "onChunk",
          "onStepFinish",
          "onFinish"
        ])
      );
      if (streaming) expect(phases).toContain("cleanup");
      expect(
        invocation.observations.every(({ request }) => request === `/${name}`)
      ).toBe(true);
      expect(
        (await invocation.result.toolResults).map(({ output }) => output)
      ).toEqual(["milestone"]);
    }
    expect(currentRequest()).toBeUndefined();
  }
);
