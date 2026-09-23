import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { browserHost, doRuntimeAwaitTransform } from "@mcp-b/do-runtime/vite";
import agents from "agents/vite";
import { defaultClientConditions, defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const resolvePackage = createRequire(import.meta.url).resolve;
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
  "**/node_modules/**/@modelcontextprotocol/**",
];

/**
 * The facet modules the actor worker imports by URL into its own realm, each
 * built alone by `vite build --mode <name>`. A chunk shared with another entry
 * would bind its globals to the root actor's scope, so `browserHost` fails the
 * build when a facet chunk imports one.
 */
const facetEntries = new Map([
  ["counter-child", "src/worker/counter-child.worker.ts"],
  ["think-probe", "src/worker/think-probe.ts"],
]);

export default defineConfig(({ mode }) => ({
  plugins: [
    ...agents(),
    ...browserHost({
      include: actorAwaitTransformInclude,
      facets: {
        registry: "__doRuntimeExtensionFacetScopes",
        match: (chunk) =>
          [...facetEntries.values()].some((entry) => chunk.facadeModuleId?.endsWith(entry)),
      },
    }),
    // A facet pass builds actor code outside `worker`, so it adds the transform
    // that the preset keeps out of page builds.
    ...(facetEntries.has(mode)
      ? [doRuntimeAwaitTransform({ include: actorAwaitTransformInclude, asyncContext: true })]
      : []),
  ],
  /**
   * Un-hashed, predictable entries because the manifest and runtime facet
   * loader cannot reference content hashes.
   */
  build:
    facetEntries.has(mode)
      ? {
          outDir: "dist",
          emptyOutDir: false,
          target: "esnext",
          minify: false,
          modulePreload: false,
          rollupOptions: {
            input: facetEntries.get(mode),
            // The actor worker imports the facet's class exports at runtime, so
            // they are the extension's host ABI rather than dead entry code.
            preserveEntrySignatures: "strict",
            output: {
              codeSplitting: false,
              // `subAgent(CounterLeaf)` routes by class name, which a minifier
              // would mangle. The preset keeps names only in `worker` output.
              keepNames: true,
              entryFileNames: `${mode}.js`,
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
            // Relative to `root`, which is this directory. The two HTML entries sit at
            // the example root rather than under `src/`, so their built copies land at
            // `dist/offscreen.html` and `dist/popup.html` — the flat paths the manifest
            // and `chrome.offscreen.createDocument({ url })` both expect.
            input: {
              background: "src/background.ts",
              offscreen: "offscreen.html",
              popup: "popup.html",
            },
            output: {
              entryFileNames: "[name].js",
              chunkFileNames: "assets/[name]-[hash].js",
              assetFileNames: "assets/[name]-[hash][extname]",
            },
          },
        },

  // `browserHost` adds the rest: Workers build as ES modules, which top-level
  // await and module chunks need; they keep class names and run the transform.
  worker: {
    plugins: () => agents(),
  },

  resolve: {
    conditions: ["worker", ...defaultClientConditions],
    // `browserHost` aliases `cloudflare:workers`, `cloudflare:email` and
    // `async_hooks` to the package's own files.
    alias: {
      ...(mode === "think-probe"
        ? {
            "@cloudflare/shell": cloudflareShellModule,
            crypto: unenvNode("crypto"),
            "node:crypto": unenvNode("crypto"),
            "node:events": unenvNode("events"),
            "node:stream/promises": unenvNode("stream/promises"),
            "node:stream": unenvNode("stream"),
            "node:zlib": unenvNode("zlib"),
          }
        : {}),
      "node:diagnostics_channel": unenvNode("diagnostics_channel"),
      "node:os": unenvNode("os"),
      path: unenvNode("path"),
    },
  },
}));
