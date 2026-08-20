import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cloudflareWorkersModule = `${repoRoot}dist/cloudflare-workers.js`;

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
      // Use the package subpath so application code and runtime transport share
      // one DurableObject/RpcTarget identity, while authored source keeps the
      // exact platform specifier it will deploy with.
      "cloudflare:workers": cloudflareWorkersModule,
      "cloudflare:email": `${repoRoot}examples/platform-shims/cloudflare-email.ts`,
      "node:async_hooks": "unenv/node/async_hooks",
      "node:diagnostics_channel": "unenv/node/diagnostics_channel",
      "node:os": "unenv/node/os",
      path: "unenv/node/path",
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
      // The platform shims above live outside this example's root.
      allow: [repoRoot],
    },
  },
  preview: { headers: crossOriginIsolation },
});
