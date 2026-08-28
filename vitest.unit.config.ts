import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { doRuntimeAwaitTransform } from "./src/vite.ts";

/**
 * The unit lane: tests co-located with the module they port, named after the
 * upstream test file they came from.
 *
 * This is not the conformance suite and does not overlap it. Conformance
 * asserts observable Durable Object behaviour against three runtimes; this lane
 * ports workerd's OWN unit tests — `io-gate-test.c++` and friends — so the
 * internal structure is checked by the same assertions upstream checks it with.
 * A ported module without an upstream test file gets no unit tests; its
 * coverage comes from conformance. Package-original machinery with no workerd
 * counterpart to conform to — runtime storage versioning, the Drizzle
 * migration flow — is the one exception: its contract is pinned here.
 */
export default defineConfig({
  plugins: [
    doRuntimeAwaitTransform({ include: "**/src/fixtures/await-transform.actor.ts" }),
  ],
  resolve: {
    alias: {
      "@mcp-b/do-runtime/gate": fileURLToPath(new URL("./src/gate.ts", import.meta.url)),
    },
  },
  test: {
    name: "unit",
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["src/**/*.test.ts", "backends/**/*.test.ts"],
  },
});
