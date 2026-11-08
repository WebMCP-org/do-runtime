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
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }]
    }
  }
};
