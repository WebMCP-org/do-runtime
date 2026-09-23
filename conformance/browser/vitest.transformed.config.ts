import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { doRuntimeAwaitTransform } from "../../src/vite";
import lane from "./vitest.config";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The same suite with the probe compiled the way a consumer compiles actor code. The workerd
 * lane stays untransformed: it is the oracle this lane's transformed awaits must agree with.
 */
export default mergeConfig(
  lane,
  defineConfig({
    plugins: [
      doRuntimeAwaitTransform({ include: "**/conformance/fixtures/probe.ts", asyncContext: true }),
    ],
    resolve: {
      alias: {
        "@mcp-b/do-runtime/gate": `${packageRoot}src/gate.ts`,
        "@mcp-b/do-runtime/browser/async-hooks": `${packageRoot}src/browser/async-hooks.ts`,
      },
    },
    test: { name: "browser-transformed" },
  }),
);
