import { rm } from "node:fs/promises";
import { build } from "vite";

const root = new URL("../", import.meta.url);
await rm(new URL("dist", root), { recursive: true, force: true });

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: new URL("dist", root).pathname,
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: "es2023",
    lib: {
      entry: {
        index: new URL("src/index.ts", root).pathname,
        "server/alarm-scheduler": new URL("src/server/alarm-scheduler.ts", root).pathname,
        "backends/sqlite-wasm": new URL("backends/sqlite-wasm.ts", root).pathname,
        "backends/node-sqlite": new URL("backends/node-sqlite.ts", root).pathname,
        "cloudflare-workers": new URL("src/api/cloudflare-workers.ts", root).pathname,
        conformance: new URL("conformance/host.ts", root).pathname,
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) =>
        id === "capnweb" || id === "@ungap/structured-clone" || id.startsWith("node:"),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
