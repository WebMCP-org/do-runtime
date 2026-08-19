/**
 * The contrast run. Same reason for existing separately as the browser config
 * beside it: no lane's `include` may reach a benchmark.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  test: {
    name: "bench-node",
    root: packageRoot,
    environment: "node",
    include: ["conformance/bench/sql-latency.node.bench.ts"],
  },
});
