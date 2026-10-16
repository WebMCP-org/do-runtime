import { stripNodeModulesSourceMapReferences } from "../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

// The TypeScript compiler runs at the package's build boundary, outside Workers.
export default defineConfig({
  plugins: [stripNodeModulesSourceMapReferences()],
  test: { name: "node", include: ["src/node-tests/**/*.test.ts"] }
});
