import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "conformance:host": `${here}host.ts`,
      // The probe imports the built-in module by its platform specifier, exactly as it does on
      // the oracle lane. Supplying it is the lane's job, the same way `wrangler.test.jsonc`
      // supplies the bindings — and this package's `cloudflare:workers` is what the probe reaches
      // through it.
      "cloudflare:workers": `${packageRoot}src/api/cloudflare-workers.ts`,
    },
  },
  test: {
    name: "node",
    root: packageRoot,
    environment: "node",
    include: ["conformance/suite/**/*.spec.ts"],
  },
});
