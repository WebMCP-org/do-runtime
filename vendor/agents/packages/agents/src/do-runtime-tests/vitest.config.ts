import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { doRuntimeAwaitTransform } from "../../../../../../src/vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const runtime = (path: string) => here(`../../../../../../${path}`);

// The SDK under do-runtime itself: a real actor container over node:sqlite,
// real input gates, and the Lifecycle compiled with the await transform the
// way a consumer compiles it. The workerd lane cannot see a lost input lock.
export default defineConfig({
  plugins: [
    doRuntimeAwaitTransform({
      asyncContext: true,
      include: [here("../lifecycle/**"), here("./*.actor.ts")]
    })
  ],
  resolve: {
    alias: {
      "@mcp-b/do-runtime/gate": runtime("src/gate.ts"),
      "@mcp-b/do-runtime/browser/async-hooks": runtime(
        "src/browser/async-hooks.ts"
      ),
      "cloudflare:workers": runtime("src/api/cloudflare-workers.ts")
    }
  },
  test: {
    name: "do-runtime",
    environment: "node",
    include: [here("./*.test.ts")]
  }
});
