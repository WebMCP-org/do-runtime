import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Cross-origin isolation, and who actually needs it.
 *
 * These two headers are here for **`@rolldown/browser`**, which is a Rust
 * bundler compiled to WASI with threads: it needs `SharedArrayBuffer`, and a
 * browser only hands one out to a cross-origin-isolated document.
 *
 * They are NOT for the Durable Object runtime, and they are not for the OPFS
 * SAH pool either. Synchronous SQLite in a browser comes from
 * `createSyncAccessHandle` in a dedicated worker, which needs no isolation of
 * any kind — measured, and it is the reason the runtime can be embedded in
 * pages and extensions that could never turn these on. Delete the bundler and
 * you can delete these two lines.
 *
 * `credentialless` rather than `require-corp` on purpose: the preview iframe
 * pulls React from esm.sh, and under `require-corp` every one of those
 * responses would need a `Cross-Origin-Resource-Policy` header that esm.sh does
 * not send. `credentialless` sends the no-cors requests without credentials
 * instead, which is exactly the trade a preview wants.
 */
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  resolve: {
    alias: {
      // The actor imports `DurableObject` from the platform module by its real
      // specifier, exactly as it would on Cloudflare. Supplying that module is
      // the host's job here, the same way `wrangler.jsonc` supplies bindings
      // there.
      "cloudflare:workers": `${repoRoot}src/api/cloudflare-workers.ts`,
    },
  },
  optimizeDeps: {
    // Both of these locate a `.wasm` with `new URL("…", import.meta.url)`.
    // Pre-bundling rewrites the module into `.vite/deps`, the relative URL
    // follows it, and the wasm is not there. The sqlite driver's own README
    // prescribes this exclusion for the same reason.
    exclude: ["@sqlite.org/sqlite-wasm", "@rolldown/browser"],
  },
  server: {
    headers: crossOriginIsolation,
    fs: {
      // `@mcp-b/do-runtime` is a workspace link whose exports are TypeScript
      // SOURCE, so the dev server serves files from outside this example's root.
      allow: [repoRoot],
    },
  },
  preview: { headers: crossOriginIsolation },
});
