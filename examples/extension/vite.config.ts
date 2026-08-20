import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The runtime's source, which this example consumes as TypeScript rather than as
 * a build artifact: `@mcp-b/do-runtime`'s package exports point at `src/`.
 */
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  /**
   * Un-hashed, predictable output, because a manifest cannot reference a hash.
   * The three entries below are the three files `manifest.json` and the two HTML
   * pages name; everything else is free to be hashed.
   */
  build: {
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
  },

  resolve: {
    alias: {
      /**
       * The specifier a Workers module imports `DurableObject` and `RpcTarget`
       * from. No browser resolves it, so the host supplies it — exactly as
       * `wrangler.jsonc` supplies it on Cloudflare — and what it supplies is this
       * package's own port of the module.
       *
       * **One specifier, deliberately.** `@mcp-b/do-runtime/cloudflare-workers`
       * resolves to the same file, but through a different module id, and two
       * copies of that module in one bundle would give two different `RpcTarget`
       * classes — so capnweb would refuse an instance of the wrong one. Every
       * file in this example imports `cloudflare:workers`.
       */
      "cloudflare:workers": `${packageRoot}src/api/cloudflare-workers.ts`,
    },
  },
});
