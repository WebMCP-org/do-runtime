import { playwright } from "@vitest/browser-playwright";

export default {
  worker: { format: "es" },
  test: {
    name: "shell-browser",
    include: ["src/browser-tests/*.test.ts"],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }]
    }
  }
};
