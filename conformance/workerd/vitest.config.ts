import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const workerdPath: string = createRequire(import.meta.url)("workerd").default;
process.env.MINIFLARE_WORKERD_PATH ??= workerdPath;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `${here}wrangler.test.jsonc` },
      miniflare: {
        // "fetched" in two chunks, the second after a timer, as every lane's outbound answers.
        outboundService: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          const body = new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("fet"));
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.enqueue(new TextEncoder().encode("ched"));
              controller.close();
            },
          });
          return new Response(body);
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
