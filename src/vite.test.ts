import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, parseSync, type Plugin, type UserConfig } from "vite";
import { describe, expect, test } from "vitest";
import {
  browserHost,
  doRuntimeAwaitTransform,
  workersModuleAliases,
  type DoRuntimeAwaitTransformOptions,
} from "./vite";

const HEADER =
  '/* @do-runtime-gated */\nimport { __gateAsyncIterable, __gateAwait, __resumeAwait } from "@mcp-b/do-runtime/gate";\n';

async function transformWith(plugin: Plugin, code: string, id: string): Promise<string> {
  const hook = plugin.transform;
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

async function transform(
  code: string,
  id = "/actor.js",
  options?: DoRuntimeAwaitTransformOptions,
  command?: "build" | "serve",
): Promise<string> {
  const plugin = doRuntimeAwaitTransform(options);
  if (command !== undefined) {
    const hook = plugin.configResolved;
    if (hook === undefined) throw new Error("await transform has no configResolved hook");
    const handler = typeof hook === "function" ? hook : hook.handler;
    await Reflect.apply(handler, {}, [{ command }]);
  }
  return await transformWith(plugin, code, id);
}

describe("doRuntimeAwaitTransform", () => {
  test("preserves awaited async-generator cleanup on return and throw, including yield delegation", async () => {
    const actorId = "/generator.actor.js";
    const actorSource = `
      async function* values(events, rejectCleanup) {
        try { yield 1; yield 2; }
        finally {
          events.push("cleanup started");
          await (rejectCleanup ? Promise.reject(new Error("cleanup rejected")) : Promise.resolve());
          events.push("cleanup finished");
        }
      }
      async function* delegated(events, rejectCleanup) {
        return yield* values(events, rejectCleanup);
      }
      export async function run(method, delegate, rejectCleanup) {
        const events = [];
        const iterator = (delegate ? delegated : values)(events, rejectCleanup);
        events.push(await iterator.next());
        try { events.push(await iterator[method](method === "throw" ? new Error("stopped") : 9)); }
        catch (error) { events.push(error.message); }
        events.push(await iterator.next());
        return events;
      }
    `;
    const generated = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "virtual-generator",
          resolveId: (id) =>
            id === "generator-entry"
              ? actorId
              : id.startsWith("@mcp-b/do-runtime/")
                ? `\0${id}`
                : null,
          load: (id) =>
            id === actorId
              ? actorSource
              : id === "\0@mcp-b/do-runtime/gate"
                ? "export const __gateAwait = x => x, __resumeAwait = x => x, __gateAsyncIterable = x => x;"
                : id === "\0@mcp-b/do-runtime/browser/async-hooks"
                  ? "export {};"
                  : null,
        },
        doRuntimeAwaitTransform({ include: actorId, asyncContext: true }),
        // A second async-context transform, as `browserHost()` beside a host's own, must
        // leave the helper the first one corrected alone.
        doRuntimeAwaitTransform({ include: "/unused", asyncContext: true }),
      ],
      build: {
        write: false,
        minify: false,
        target: "esnext",
        rollupOptions: {
          input: "generator-entry",
          preserveEntrySignatures: "strict",
        },
      },
    });
    if (Array.isArray(generated) || !("output" in generated))
      throw new Error("Expected one bundle");
    const chunk = generated.output.find((output) => output.type === "chunk");
    if (!chunk) throw new Error("Expected generated JavaScript");
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
    )) as {
      run(method: string, delegate: boolean, rejectCleanup: boolean): Promise<unknown[]>;
    };
    for (const delegate of [false, true]) {
      for (const method of ["return", "throw"]) {
        expect(await module.run(method, delegate, false)).toEqual([
          { value: 1, done: false },
          "cleanup started",
          "cleanup finished",
          method === "return" ? { value: 9, done: true } : "stopped",
          { value: undefined, done: true },
        ]);
        expect(await module.run(method, delegate, true)).toEqual([
          { value: 1, done: false },
          "cleanup started",
          "cleanup rejected",
          { value: undefined, done: true },
        ]);
      }
    }
  });

  test("requires review when the opt-in Oxc helper correction no longer matches", async () => {
    const id = "\0@oxc-project+runtime@next/helpers/esm/wrapAsyncGenerator.js";
    const source = "export default function changedHelper() {}";
    await expect(transform(source, id)).resolves.toBe(source);
    await expect(transform(source, id, { asyncContext: true })).rejects.toThrow(
      "Oxc async-generator helper changed",
    );
  });

  test("lowers async functions and generators for browser context while preserving gates", async () => {
    const output = await transform(
      "export async function* values() { yield await item; } export const immediate = async () => 1;",
      "/actor.js",
      { asyncContext: true },
    );
    expect(output).toContain("@mcp-b/do-runtime/browser/async-hooks");
    expect(output).toContain("helpers/wrapAsyncGenerator");
    expect(output).toContain("helpers/asyncToGenerator");
    expect(output).toContain("__gateAwait");
    expect(output).not.toMatch(/async (function|\()/);
  });

  test("gates a plain await", async () => {
    const source = "async function run() { return await task; }\n";

    await expect(transform(source)).resolves.toBe(
      `${HEADER}async function run() { return __resumeAwait((await __gateAwait((task)))); }\n`,
    );
  });

  test("identifies lockless transformed awaits in development", async () => {
    const source = "async function run() { return await task; }\n";

    await expect(transform(source, "/actor.js", undefined, "serve")).resolves.toBe(
      `${HEADER}async function run() { return __resumeAwait((await __gateAwait((task), "/actor.js"))); }\n`,
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

    await expect(
      transform(source, "/generated/actor.js", { exclude: "**/generated/**" }),
    ).resolves.toBe(source);
  });

  test("excludes do-runtime internals by default", async () => {
    const source = "const value = await task;\n";

    await expect(
      transform(source, "/project/node_modules/@mcp-b/do-runtime/dist/index.js"),
    ).resolves.toBe(source);
  });

  test("asserts coverage against code added by a later transform", async () => {
    const actorId = "/actor.js";
    let actorSource =
      "export async function run(values) { await first; for await (const value of values) consume(value); }\n";
    const virtualActor: Plugin = {
      name: "virtual-actor",
      resolveId: (id) => (id === "actor-entry" ? actorId : null),
      load: (id) => (id === actorId ? actorSource : null),
    };
    const lateAwait: Plugin = {
      name: "late-await",
      enforce: "post",
      transform: (code, id) => (id === actorId ? `${code}\nawait second;\n` : null),
    };
    const actorBuild = (plugins: Plugin[]) =>
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [virtualActor, doRuntimeAwaitTransform(), ...plugins],
        build: {
          write: false,
          target: "esnext",
          rollupOptions: {
            input: "actor-entry",
            external: ["@mcp-b/do-runtime/gate"],
          },
        },
      });

    await expect(actorBuild([])).resolves.toBeDefined();
    await expect(actorBuild([lateAwait])).rejects.toThrow("/actor.js: 2/3");
    actorSource = "export async function run() { await using resource = open(); }\n";
    await expect(actorBuild([])).rejects.toThrow("/actor.js: 0/1");
  });
});

test("from source, the plugin leaves its injected imports to the host's resolution", async () => {
  // The package's built siblings resolve these; this repository's own lanes alias them to
  // source instead, and must keep that identity. `scripts/check-package.mjs` pins the built side.
  const hook = doRuntimeAwaitTransform({ asyncContext: true }).resolveId;
  if (typeof hook !== "object") throw new Error("expected an ordered resolveId hook");
  for (const id of ["@mcp-b/do-runtime/gate", "@mcp-b/do-runtime/browser/async-hooks"]) {
    expect(await Reflect.apply(hook.handler, {}, [id, undefined, {}])).toBeNull();
  }
});

describe("browserHost", () => {
  const include = "**/actor/**";

  function pluginNamed(plugins: readonly Plugin[], name: string): Plugin {
    const plugin = plugins.find((candidate) => candidate.name === name);
    if (plugin === undefined) throw new Error(`browserHost returned no ${name} plugin`);
    return plugin;
  }

  function presetConfig(plugins: readonly Plugin[]): UserConfig {
    const hook = pluginNamed(plugins, "do-runtime-browser-host").config;
    if (typeof hook !== "function") throw new Error("expected a config function");
    return Reflect.apply(hook, {}, [{}, { command: "build", mode: "production" }]) as UserConfig;
  }

  test("aliases the platform modules and async_hooks to the files the export map names", async () => {
    // From source the preset leaves them to the host, as the plugin does its injected imports.
    expect(workersModuleAliases()).toEqual([]);
    expect(presetConfig(browserHost({ include })).resolve?.alias).toEqual([]);

    // The built entry, which `pnpm typecheck` builds first, as CI does.
    const built = (await import(
      new URL("../dist/vite.js", import.meta.url).href
    )) as typeof import("./vite");
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<
        "./cloudflare-workers" | "./cloudflare-email" | "./browser/async-hooks",
        { import: string }
      >;
    };
    const exported = (subpath: keyof typeof manifest.exports): string =>
      fileURLToPath(new URL(manifest.exports[subpath].import, new URL("../", import.meta.url)));
    const workers = [
      { find: "cloudflare:workers", replacement: exported("./cloudflare-workers") },
      { find: "cloudflare:email", replacement: exported("./cloudflare-email") },
    ];
    const asyncHooks = {
      find: /^(node:)?async_hooks$/,
      replacement: exported("./browser/async-hooks"),
    };

    expect(built.workersModuleAliases()).toEqual(workers);
    expect(presetConfig(built.browserHost({ include })).resolve?.alias).toEqual([
      ...workers,
      asyncHooks,
    ]);
    expect(
      presetConfig(built.browserHost({ include, asyncContext: false })).resolve?.alias,
    ).toEqual(workers);
    for (const { replacement } of [...workers, asyncHooks]) {
      expect(existsSync(replacement)).toBe(true);
    }
  });

  test("builds Workers as named ES modules through the transform, whole per facet realm", async () => {
    const plugins = (worker: UserConfig["worker"]) =>
      (worker?.plugins?.() ?? []).map((plugin) => plugin as Plugin);
    const facets = { registry: "__facets", match: () => true };

    const { worker } = presetConfig(browserHost({ include, facets }));
    expect(worker?.format).toBe("es");
    expect(worker?.rolldownOptions?.output).toEqual({ keepNames: true, codeSplitting: false });
    expect(plugins(worker).map((plugin) => plugin.name)).toEqual([
      "do-runtime-await-transform",
      "do-runtime-facet-bundles",
    ]);

    const plain = presetConfig(browserHost({ include })).worker;
    expect(plain?.rolldownOptions?.output).toEqual({ keepNames: true });
    const [transform, ...others] = plugins(plain);
    expect(others).toEqual([]);
    if (transform === undefined) throw new Error("Workers get no await transform");
    // The Worker transform honours `include` and lowers for async context.
    const source = "export async function f() { await x; }\n";
    expect(await transformWith(transform, source, "/src/actor/a.js")).toContain(
      "@mcp-b/do-runtime/browser/async-hooks",
    );
    await expect(transformWith(transform, source, "/src/page/a.js")).resolves.toBe(source);
  });

  test("runs the await transform in application plugins only while serving", () => {
    expect(pluginNamed(browserHost({ include }), "do-runtime-await-transform").apply).toBe("serve");
  });

  test("banners a self-contained facet chunk and fails a build whose facet chunk imports another", async () => {
    const modules: Record<string, string> = {
      "/facet.js":
        'import { same } from "/shared.js";\nexport const facet = () => same(new WebSocketPair());\nexport const later = () => import("/lazy.js");\n',
      "/root.js": 'import { same } from "/shared.js";\nexport const root = same;\n',
      "/shared.js": "export const same = (value) => value;\n",
      "/lazy.js": "export const lazy = 1;\n",
    };
    const virtualModules: Plugin = {
      name: "virtual-facet",
      resolveId: (id) => (id in modules ? id : null),
      load: (id) => modules[id] ?? null,
    };
    const facetBuild = (input: Record<string, string>, codeSplitting: boolean) =>
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [
          virtualModules,
          ...browserHost({
            include,
            facets: { registry: "__facets", match: (chunk) => chunk.name === "facet" },
          }),
        ],
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input,
            preserveEntrySignatures: "strict",
            output: { codeSplitting, banner: "/* host banner */" },
          },
        },
      });

    await expect(facetBuild({ facet: "/facet.js", root: "/root.js" }, true)).rejects.toThrow(
      /facet chunk assets\/facet-[\w-]+\.js imports assets\/shared-[\w-]+\.js, assets\/lazy-[\w-]+\.js/,
    );

    const generated = await facetBuild({ facet: "/facet.js" }, false);
    if (Array.isArray(generated) || !("output" in generated)) {
      throw new Error("Expected one bundle");
    }
    const { code } = generated.output[0];
    // Rolldown reprints the banner (`undefined` becomes `void 0`), so match its bindings.
    expect(code).toContain("/* host banner */");
    expect(code).toContain('globalThis["__facets"]');
    expect(code).toMatch(
      /const \{[^}]*\bWebSocketPair\b[^}]*\} = __facetScope;[\s\S]*new WebSocketPair\(\)/,
    );
  });
});
