import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { doRuntimeAwaitTransform } from "@mcp-b/do-runtime/vite";
import agents from "agents/vite";
import { defaultClientConditions, defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const resolvePackage = createRequire(import.meta.url).resolve;
const cloudflareWorkersModule = `${packageRoot}dist/cloudflare-workers.js`;
const cloudflareShellModule = `${packageRoot}vendor/agents/packages/shell/dist/index.js`;
const unenvNode = (name: string): string => resolvePackage(`unenv/node/${name}`);

const actorAwaitTransformInclude = [
  "**/examples/extension/src/worker/**",
  "**/vendor/agents/packages/agents/dist/**",
  "**/vendor/agents/packages/think/dist/**",
  "**/node_modules/**/agents/dist/**",
  "**/node_modules/**/@cloudflare/think/dist/**",
  "**/node_modules/**/@ai-sdk/**",
  "**/node_modules/**/ai/dist/**",
  "**/node_modules/**/chat/dist/**",
  "**/node_modules/**/partyserver/dist/**",
];

const actorPlugins = () => [
  ...agents(),
  doRuntimeAwaitTransform({ include: actorAwaitTransformInclude }),
];

const facetBanner = (chunk: { name: string }): string =>
  chunk.name === "counter-child" || chunk.name === "think-probe"
    ? `const __facetKey = new URL(import.meta.url).searchParams.get("scope");
const __facetScope = globalThis.__doRuntimeExtensionFacetScopes?.[__facetKey];
if (__facetScope === undefined) throw new Error(\`facet module has no scope named \${__facetKey}\`);
const { scheduler, setTimeout, clearTimeout, setInterval, clearInterval, fetch, crypto } = __facetScope;`
    : "";

export default defineConfig(({ mode }) => ({
  plugins: actorPlugins(),
  /**
   * Un-hashed, predictable entries because the manifest and runtime facet
   * loader cannot reference content hashes.
   */
  build:
    mode === "think-probe"
      ? {
          outDir: "dist",
          emptyOutDir: false,
          target: "esnext",
          minify: false,
          modulePreload: false,
          rollupOptions: {
            input: "src/worker/think-probe.ts",
            preserveEntrySignatures: "strict",
            output: {
              codeSplitting: false,
              banner: facetBanner,
              entryFileNames: "think-probe.js",
            },
          },
        }
      : {
          outDir: "dist",
          emptyOutDir: true,
          // MV3 pages are Chrome-only, so there is no downlevelling to do and top-level
          // await (which the sqlite driver's ESM build uses) has to survive.
          target: "esnext",
          // Readable output. An example's dist is something you open and read; a real
          // extension would leave this alone.
          minify: false,
          // Extensions load from disk. Preload hints buy nothing and add a chunk.
          modulePreload: false,
          rollupOptions: {
            // `counter-child` is imported at runtime by the actor worker, so its class
            // export is part of the extension's host ABI rather than dead app-entry code.
            preserveEntrySignatures: "strict",
            // Relative to `root`, which is this directory. The two HTML entries sit at
            // the example root rather than under `src/`, so their built copies land at
            // `dist/offscreen.html` and `dist/popup.html` — the flat paths the manifest
            // and `chrome.offscreen.createDocument({ url })` both expect.
            input: {
              background: "src/background.ts",
              "counter-child": "src/worker/counter-child.worker.ts",
              offscreen: "offscreen.html",
              popup: "popup.html",
            },
            output: {
              // A Dynamic Worker gets its own global scope on workerd. In this
              // same-worker browser host, bind the complete built facet module instead
              // so dependencies such as the Agents SDK cannot fall through to the
              // root actor's globals.
              banner: facetBanner,
              entryFileNames: "[name].js",
              chunkFileNames: "assets/[name]-[hash].js",
              assetFileNames: "assets/[name]-[hash][extname]",
            },
          },
        },

  /**
   * `new Worker(new URL(…), { type: "module" })` must build to a real module
   * worker.
   *
   * The effective worker policy on an extension page is `'self'` — either from
   * the manifest's `worker-src`, or by CSP3's fallback to `script-src` when it is
   * absent — and a `chrome-extension://` script URL satisfies it while a `blob:`
   * URL does not. Rollup's classic-worker fallback wraps the bundle in a blob, so
   * this line is what keeps the worker loadable at all.
   */
  worker: {
    format: "es",
    plugins: actorPlugins,
  },

  resolve: {
    ...(mode === "think-probe" ? { conditions: ["worker", ...defaultClientConditions] } : {}),
    alias: {
      "@mcp-b/do-runtime/gate": `${packageRoot}dist/gate.js`,
      /**
       * The specifier a Workers module imports `DurableObject` and `RpcTarget`
       * from. No browser resolves it, so the host supplies it — exactly as
       * `wrangler.jsonc` supplies it on Cloudflare — and what it supplies is this
       * package's own port of the module.
       *
       * **One module identity, deliberately.** Route the platform specifier to
       * the package's public subpath so `newRpcSession()` and application code
       * see the same `RpcTarget` class. A source-file alias would load a second
       * class beside the package build, and capnweb would refuse its instances.
       */
      "cloudflare:workers": cloudflareWorkersModule,
      "cloudflare:email": `${packageRoot}examples/platform-shims/cloudflare-email.ts`,
      ...(mode === "think-probe"
        ? {
            "@cloudflare/shell": cloudflareShellModule,
            async_hooks: unenvNode("async_hooks"),
            crypto: unenvNode("crypto"),
            "node:crypto": unenvNode("crypto"),
            "node:events": unenvNode("events"),
            "node:stream/promises": unenvNode("stream/promises"),
            "node:stream": unenvNode("stream"),
            "node:zlib": unenvNode("zlib"),
          }
        : {}),
      "node:async_hooks": unenvNode("async_hooks"),
      "node:diagnostics_channel": unenvNode("diagnostics_channel"),
      "node:os": unenvNode("os"),
      path: unenvNode("path"),
    },
  },
}));
