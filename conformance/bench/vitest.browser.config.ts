/**
 * The benchmark's own config, so no lane picks it up.
 *
 * `include` names the two bench files and nothing else, and the file names end
 * in `.bench.ts` rather than `.spec.ts` so the browser lane's
 * `conformance/browser/*.smoke.spec.ts` and `conformance/suite/**` globs cannot
 * reach them either. The baseline stays exactly what it was: unit 755,
 * workerd 38/38, node 38/38, browser 41/41.
 *
 * `optimizeDeps` is copied from `conformance/browser/vitest.config.ts` — named
 * so the first worker to import the driver does not trigger a mid-run
 * re-optimisation. The COOP/COEP headers are the benchmark's own: the SAH pool
 * runs fine without cross-origin isolation (measured 2026-08-20 — plain-HTTP
 * page, headless Chromium, pool installs and round-trips), but an isolated page
 * gets 5 µs `performance.now()` resolution instead of 100 µs.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  optimizeDeps: { include: ["@sqlite.org/sqlite-wasm"] },
  server: {
    headers: {
      // Not for the SAH pool — it needs no isolation. Isolation is what gives
      // `performance.now()` 5 µs resolution instead of 100 µs, which the report
      // prints as its clock floor.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "bench-browser",
    root: packageRoot,
    include: [
      "conformance/bench/await-transform.bench.ts",
      "conformance/bench/sql-latency.browser.bench.ts",
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
