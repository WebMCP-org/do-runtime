import { parseSync, type FilterPattern } from "vite";
import { describe, expect, test } from "vitest";
import { doRuntimeAwaitTransform } from "./vite";

const HEADER =
  '/* @do-runtime-gated */\nimport { __gateAsyncIterable, __gateAwait, __resumeAwait } from "@mcp-b/do-runtime/gate";\n';

async function transform(
  code: string,
  id = "/actor.js",
  options?: { include?: FilterPattern; exclude?: FilterPattern },
): Promise<string> {
  const hook = doRuntimeAwaitTransform(options).transform;
  if (hook === undefined) throw new Error("await transform has no transform hook");
  const handler = typeof hook === "function" ? hook : hook.handler;
  const result = await Reflect.apply(
    handler,
    {
      parse(source: string) {
        return parseSync(id, source).program;
      },
    },
    [code, id],
  );
  if (result === null || result === undefined) return code;
  return typeof result === "string" ? result : result.code;
}

describe("doRuntimeAwaitTransform", () => {
  test("gates a plain await", async () => {
    const source = "async function run() { return await task; }\n";

    await expect(transform(source)).resolves.toBe(
      `${HEADER}async function run() { return __resumeAwait((await __gateAwait((task)))); }\n`,
    );
  });

  test("gates each operation of a for-await iterator", async () => {
    const source = "async function run() { for await (const value of values) consume(value); }\n";

    await expect(transform(source)).resolves.toBe(
      `${HEADER}async function run() { for await (const value of __gateAsyncIterable((values))) consume(value); }\n`,
    );
  });

  test.each([
    {
      name: "nested awaits",
      source: "const value = await outer(await inner);\n",
      expected:
        "const value = __resumeAwait((await __gateAwait((outer(__resumeAwait((await __gateAwait((inner)))))))));\n",
    },
    {
      name: "arrow, object method, and class method bodies",
      source:
        "const arrow = async () => await one;\nconst object = { async method() { await two; } };\nclass Example { async method() { await three; } }\n",
      expected:
        "const arrow = async () => __resumeAwait((await __gateAwait((one))));\nconst object = { async method() { __resumeAwait((await __gateAwait((two)))); } };\nclass Example { async method() { __resumeAwait((await __gateAwait((three)))); } }\n",
    },
    {
      name: "async generators",
      source: "async function* values() { yield await item; }\n",
      expected: "async function* values() { yield __resumeAwait((await __gateAwait((item)))); }\n",
    },
    {
      name: "top-level await",
      source: "const value = await task;\n",
      expected: "const value = __resumeAwait((await __gateAwait((task))));\n",
    },
    {
      name: "await precedence",
      source: "const first = await a ?? b;\nconst second = await (a, b);\n",
      expected:
        "const first = __resumeAwait((await __gateAwait((a)))) ?? b;\nconst second = __resumeAwait((await __gateAwait(((a, b)))));\n",
    },
  ])("preserves $name", async ({ source, expected }) => {
    await expect(transform(source)).resolves.toBe(`${HEADER}${expected}`);
  });

  test("is idempotent once the marker is present", async () => {
    const source = `${HEADER}const value = __resumeAwait((await __gateAwait((task))));\n`;

    await expect(transform(source)).resolves.toBe(source);
  });

  test("honors an exclude filter", async () => {
    const source = "const value = await task;\n";

    await expect(transform(source, "/generated/actor.js", { exclude: "**/generated/**" })).resolves.toBe(
      source,
    );
  });

  test("excludes do-runtime internals by default", async () => {
    const source = "const value = await task;\n";

    await expect(
      transform(source, "/project/node_modules/@mcp-b/do-runtime/dist/index.js"),
    ).resolves.toBe(source);
  });
});
