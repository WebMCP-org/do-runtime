import { playwright } from "@vitest/browser-playwright";
import { alias } from "./alias.ts";

export default {
  resolve: { alias },
  worker: { format: "es" },
  test: {
    name: "browser-workspace-browser",
    include: ["src/tests/*.browser.test.ts"],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      // The OPFS walk test samples reachable heap; it needs gc() and exact sizes.
      provider: playwright({
        launchOptions: {
          args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"]
        }
      }),
      headless: true,
      instances: [{ browser: "chromium" }]
    }
  }
};
