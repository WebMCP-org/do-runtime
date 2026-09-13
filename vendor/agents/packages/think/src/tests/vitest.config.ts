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
      //
      // EVERY `agents/*` entry point Think imports has to be aliased, not just
      // the ones whose behaviour is under test: a subpath left on `dist` loads
      // a SECOND copy of the package's module graph, and 0.23's Lifecycle
      // capabilities carry identity across it (`use()` binds services only
      // `if (capability instanceof LifecycleCapability)`, and the installed-
      // services registry is a module-level WeakMap). A dist-resolved
      // `agents/sessions` therefore installs nothing and every turn fails with
      // "Sessions must be installed with Lifecycle.use() before use".
      ...[
        ["agents", "index.ts"],
        ["agents/chat", "chat/index.ts"],
        ["agents/chat-sdk", "chat-sdk/index.ts"],
        ["agents/sessions", "sessions/index.ts"],
        ["agents/streams", "streams/index.ts"],
        ["agents/tasks", "tasks/index.ts"],
        ["agents/context", "context/index.ts"],
        ["agents/lifecycle", "lifecycle/index.ts"],
        ["agents/skills", "skills/index.ts"],
        ["agents/agent-tools", "agent-tools.ts"],
        ["agents/workflows", "workflows.ts"],
        ["agents/observability", "observability/index.ts"],
        ["agents/observability/ai", "observability/ai/index.ts"],
        ["agents/browser", "browser/index.ts"],
        ["agents/browser/ai", "browser/ai.ts"]
      ].map(([specifier, entry]) => ({
        find: new RegExp(`^${specifier.replace(/\//g, "\\/")}$`),
        replacement: path.join(testsDir, "../../../agents/src", entry)
      })),
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
