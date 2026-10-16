import { expectTypeOf, it } from "vitest";
import type { InferToolInput } from "@tanstack/ai";
import type { createCodeTool } from "../tanstack-ai";

it("retains the canonical builder's schema and literal name in its public type", () => {
  type CodeTool = ReturnType<typeof createCodeTool>;
  expectTypeOf<CodeTool["name"]>().toEqualTypeOf<"codemode_execute">();
  expectTypeOf<InferToolInput<CodeTool>>().toEqualTypeOf<{ code: string }>();
});
