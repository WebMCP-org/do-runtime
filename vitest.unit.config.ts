import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The unit lane: tests co-located with the module they port, named after the
 * upstream test file they came from.
 *
 * This is not the conformance suite and does not overlap it. Conformance
 * asserts observable Durable Object behaviour against three runtimes; this lane
 * ports workerd's OWN unit tests — `io-gate-test.c++` and friends — so the
 * internal structure is checked by the same assertions upstream checks it with.
 * A module here without an upstream test file gets no unit tests; its coverage
 * comes from conformance.
 */
export default defineConfig({
  test: {
    name: "unit",
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["src/**/*.test.ts", "backends/**/*.test.ts"],
  },
});
