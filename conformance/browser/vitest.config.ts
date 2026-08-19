import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "conformance:host": `${here}host.ts`,
      // The probe imports the built-in module by its platform specifier, exactly as it does on
      // the oracle lane. Supplying it is the lane's job, the same way `wrangler.test.jsonc`
      // supplies the bindings — and this package's `cloudflare:workers` is what the probe reaches
      // through it. The actor worker rewrites the same specifier out of the facet's source, for
      // the same reason and by the same route as the node lane.
      "cloudflare:workers": `${packageRoot}src/api/cloudflare-workers.ts`,
    },
  },
  /**
   * Named rather than discovered, because discovery happens mid-run here.
   * `capnweb` and the sqlite driver are reached only from worker modules, which
   * Vite's scanner does not follow, so the first worker to import one triggers a
   * re-optimisation and vitest reloads the test file underneath itself — "Vite
   * unexpectedly reloaded a test", which is a flake with a different victim every
   * time.
   */
  optimizeDeps: { include: ["capnweb", "@sqlite.org/sqlite-wasm"] },
  server: {
    headers: {
      // sqlite-wasm's SAH pool needs cross-origin isolation.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "browser",
    root: packageRoot,
    // Both the conformance suite and the storage smoke spec. The smoke spec is not part of the
    // suite: it imports the backend directly rather than routing through `host.spawn()`, which is
    // what let it prove the storage floor existed a section before the lane did.
    include: ["conformance/suite/**/*.spec.ts", "conformance/browser/*.smoke.spec.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
