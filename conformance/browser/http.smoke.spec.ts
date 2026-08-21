import { expect, test } from "vitest";
import { gateResponseBody } from "../../src/api/http";

test("a gated tee branch remains a native Response body", async () => {
  const response = gateResponseBody(
    { awaitIo: async <T>(promise: Promise<T>): Promise<T> => await promise },
    new Response("hello"),
  );
  const body = response.body;
  if (body === null) throw new Error("expected a body");

  const [branch] = body.tee();
  expect(await new Response(branch).text()).toBe("hello");
});
