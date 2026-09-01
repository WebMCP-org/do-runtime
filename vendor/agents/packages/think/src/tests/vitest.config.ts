import { createRequire } from "node:module";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;
const workspaceRequire = createRequire(
  path.resolve(testsDir, "../../../..", "package.json")
);

export default defineConfig({
  resolve: {
    alias: [
      // Think's runtime seams must exercise the edited SDK, not stale dist.
      {
        find: /^agents$/,
        replacement: path.join(testsDir, "../../../agents/src/index.ts")
      },
      {
        find: /^agents\/chat$/,
        replacement: path.join(testsDir, "../../../agents/src/chat/index.ts")
      },
      {
        find: /^@cloudflare\/codemode\/ai$/,
        replacement: workspaceRequire.resolve("@cloudflare/codemode/ai")
      },
      {
        find: /^@cloudflare\/codemode$/,
        replacement: workspaceRequire.resolve("@cloudflare/codemode")
      },
      {
        find: /^@cloudflare\/shell$/,
        replacement: path.join(testsDir, "../../../shell/src/index.ts")
      },
      {
        find: /^@cloudflare\/shell\/workers$/,
        replacement: path.join(testsDir, "../../../shell/src/workers.ts")
      }
    ]
  },
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "workers",
    include: [path.join(testsDir, "**/*.test.ts")],
    exclude: [path.join(testsDir, "../e2e-tests/**")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 10000,
    retry: 3,
    // Under the full parallel matrix, tearing down the workers-pool isolates can
    // overrun vitest's 10s default and surface as "Worker exited unexpectedly"
    // (an infra teardown race, not a test failure that `retry` can catch). Give
    // the pool room to terminate cleanly so a slow teardown can't red an
    // otherwise-green run.
    teardownTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    }
  }
});
