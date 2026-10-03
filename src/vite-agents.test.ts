import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, parseSync, transformWithOxc } from "vite";
import { expect, test } from "vitest";
import { doRuntimeAwaitTransform } from "./vite";

// Exercise the vendored SDK's actual wrapper without bringing its server, storage and
// transport dependencies into this compiler regression. Lifecycle admission is controlled
// below; browser AsyncLocalStorage and the full Vite transform are real.
test("transformed Agent methods retain sync returns and async cold-start admission", async () => {
  const sdkSource = readFileSync(
    new URL("../vendor/agents/packages/agents/src/index.ts", import.meta.url),
    "utf8",
  );
  const declarations = parseSync("agent.ts", sdkSource).program.body.filter(
    (node) =>
      (node.type === "FunctionDeclaration" && node.id?.name === "withAgentContext") ||
      (node.type === "VariableDeclaration" &&
        node.declarations.some(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            ["AsyncFunction", "agentContextWrappers"].includes(declaration.id.name),
        )),
  );
  expect(declarations.some((node) => node.type === "FunctionDeclaration")).toBe(true);
  const wrapper = declarations.map((node) => sdkSource.slice(node.start, node.end)).join("\n");
  const actorId = "/agent-context.actor.js";
  const hooksId = fileURLToPath(new URL("./browser/async-hooks.ts", import.meta.url));
  const source = await transformWithOxc(
    `import { AsyncLocalStorage } from ${JSON.stringify(hooksId)};
    const store = new AsyncLocalStorage();
    const getCurrentAgent = () => store.getStore() ?? {};
    const runInInvocation = (context, callback) => store.run(context, callback);
    ${wrapper}
    let keyCalls = 0;
    const key = () => { keyCalls++; return "computed"; };
    class Probe {
      lifecycle = {
        started: false,
        isStarted() { return this.started; },
        async start() { await Promise.resolve(); this.started = true; }
      };
      sync() { return { value: 7, context: getCurrentAgent().agent === this }; }
      async [key()]() {
        const started = this.lifecycle.started;
        const before = getCurrentAgent().agent === this;
        await Promise.resolve();
        return { started, before, after: getCurrentAgent().agent === this };
      }
    }
    for (const name of ["sync", "computed"]) {
      Probe.prototype[name] = withAgentContext(Probe.prototype[name]);
    }
    async function declared() { await Promise.resolve(); return 1; }
    const expressed = async function () { await Promise.resolve(); return 2; };
    const arrow = async () => { await Promise.resolve(); return 3; };
    const methodKey = Symbol("method");
    class Base { value(input) { return input + 1; } }
    class Methods extends Base {
      offset = 2;
      async [methodKey](input) { await Promise.resolve(); return super.value(input) + this.offset; }
      static async value(input) { await Promise.resolve(); return input; }
      async #private() { await Promise.resolve(); return this.offset; }
      async privateValue() { return this.#private(); }
      async fail() { throw new Error("method failed"); }
    }
    const object = {
      async value(input) { await Promise.resolve(); return input; },
      async *generator() { yield await Promise.resolve(9); }
    };
    export function methods() {
      const instance = new Methods();
      return {
        tags: [instance[methodKey], Methods.value, instance.privateValue, object.value]
          .map(method => Object.prototype.toString.call(method)),
        values: Promise.all([declared(), expressed(), arrow(), instance[methodKey](4),
          Methods.value(5), instance.privateValue(), object.value(6)]),
        failure: instance.fail(),
        iterator: object.generator()
      };
    }
    export function run() {
      const first = new Probe();
      const second = new Probe();
      const immediate = first.sync();
      const syncStarted = first.lifecycle.started;
      return { immediate, syncStarted, keyCalls,
        pending: Promise.all([first.computed(), second.computed()]),
        leaked: getCurrentAgent().agent !== undefined };
    }`,
    "fixture.ts",
    { lang: "ts", target: "esnext" },
  );
  const generated = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "virtual-agent-context",
        resolveId: (id) =>
          id === "agent-context-entry"
            ? actorId
            : id === "@mcp-b/do-runtime/gate"
              ? "\0gate"
              : id === "@mcp-b/do-runtime/browser/async-hooks"
                ? hooksId
                : null,
        load: (id) =>
          id === actorId
            ? source.code
            : id === "\0gate"
              ? "export const __gateAwait = x => x, __resumeAwait = x => x, __gateAsyncIterable = x => x;"
              : null,
      },
      doRuntimeAwaitTransform({ include: actorId, asyncContext: true }),
    ],
    build: {
      write: false,
      minify: false,
      target: "esnext",
      rollupOptions: { input: "agent-context-entry", preserveEntrySignatures: "strict" },
    },
  });
  if (Array.isArray(generated) || !("output" in generated)) throw new Error("Expected one bundle");
  const chunk = generated.output.find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Expected generated JavaScript");
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
  );
  const kinds = module.methods();
  await expect(kinds.failure).rejects.toThrow("method failed");
  expect(kinds.tags).toEqual(Array(4).fill("[object AsyncFunction]"));
  expect(await kinds.values).toEqual([1, 2, 3, 7, 5, 2, 6]);
  expect(await kinds.iterator.next()).toEqual({ value: 9, done: false });
  expect(await kinds.iterator.next()).toEqual({ value: undefined, done: true });
  const result = module.run();
  expect(result.immediate).toEqual({ value: 7, context: true });
  expect(result.syncStarted).toBe(false);
  expect(result.keyCalls).toBe(1);
  expect(result.leaked).toBe(false);
  expect(await result.pending).toEqual([
    { started: true, before: true, after: true },
    { started: true, before: true, after: true },
  ]);
});
