import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `${here}wrangler.test.jsonc` },
      miniflare: {
        outboundService: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new Response("fetched");
        },
      },
    }),
  ],
  // The suite imports `conformance:host`; each lane resolves it to its own
  // implementation. Same mechanism the extension's hostAliases already uses.
  resolve: { alias: { "conformance:host": `${here}host.ts` } },
  test: {
    name: "workerd",
    root: packageRoot,
    include: ["conformance/suite/**/*.spec.ts"],
  },
});
