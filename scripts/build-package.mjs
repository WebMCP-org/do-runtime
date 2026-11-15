import { readFile } from "node:fs/promises";
import { build } from "vite";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
// Every import of a runtime dependency is its bare package id; a subpath import would be bundled.
const runtimeDependencies = new Set([
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies),
]);

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: new URL("dist", root).pathname,
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "es2023",
    lib: {
      entry: {
        index: new URL("src/index.ts", root).pathname,
        browser: new URL("src/browser.ts", root).pathname,
        "browser/worker-supervisor": new URL("src/browser/worker-supervisor.ts", root).pathname,
        "browser/actor-tree": new URL("src/browser/actor-tree.ts", root).pathname,
        "browser/chrome-port-websocket": new URL("src/browser/chrome-port-websocket.ts", root).pathname,
        "browser/alarm-coordinator": new URL(
          "src/browser/alarm-coordinator.ts",
          root,
        ).pathname,
        "browser/message-port-websocket": new URL(
          "src/browser/message-port-websocket.ts",
          root,
        ).pathname,
        "browser/offscreen-document": new URL(
          "src/browser/offscreen-document.ts",
          root,
        ).pathname,
        "browser/async-hooks": new URL("src/browser/async-hooks.ts", root).pathname,
        "backends/sqlite-wasm": new URL("backends/sqlite-wasm.ts", root).pathname,
        "backends/node-sqlite": new URL("backends/node-sqlite.ts", root).pathname,
        "cloudflare-workers": new URL("src/api/cloudflare-workers.ts", root).pathname,
        "cloudflare-email": new URL("src/api/cloudflare-email.ts", root).pathname,
        telemetry: new URL("src/telemetry.ts", root).pathname,
        gate: new URL("src/gate.ts", root).pathname,
        vite: new URL("src/vite.ts", root).pathname,
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => runtimeDependencies.has(id) || id.startsWith("node:"),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
