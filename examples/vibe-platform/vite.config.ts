import { fileURLToPath } from "node:url";
import { workersModuleAliases } from "@mcp-b/do-runtime/vite";
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
    alias: [
      // The package's own `cloudflare:workers` and `cloudflare:email`, so
      // application code and runtime transport share one DurableObject/RpcTarget
      // identity, while authored source keeps the exact platform specifier it
      // will deploy with.
      ...workersModuleAliases(),
      { find: "node:async_hooks", replacement: "unenv/node/async_hooks" },
      { find: "node:diagnostics_channel", replacement: "unenv/node/diagnostics_channel" },
      { find: "node:os", replacement: "unenv/node/os" },
      { find: "path", replacement: "unenv/node/path" },
    ],
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
      // The package's `dist/` files above live outside this example's root.
      allow: [repoRoot],
    },
  },
  preview: { headers: crossOriginIsolation },
});
