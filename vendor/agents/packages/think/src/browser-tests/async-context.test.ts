import { describe, expect, it } from "vitest";
import {
  currentRequest,
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
