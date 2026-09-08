import { fileURLToPath } from "node:url";
import nodeStdlib from "node-stdlib-browser";
import { playwright } from "@vitest/browser-playwright";
import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";
import { messengerServer } from "./messenger-server";
import { doRuntimeAwaitTransform } from "../../../../../../src/vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The adapter imports stay real. Only their demonstrated Node/browser gaps
// are replaced, using the same public leaves consumers can alias in a Worker.
export default defineConfig({
  plugins: [
    messengerServer(),
    doRuntimeAwaitTransform({
      asyncContext: true,
      include: [
        here("./async-context.actor.ts"),
        here("../../../agents/src/lifecycle/current-agent.ts"),
        here("../../../agents/src/observability/**"),
        here("../../../agents/src/tests/observability/recording-tracer.ts")
      ]
    })
  ],
  define: { "process.env": "{}", global: "globalThis" },
  optimizeDeps: {
    include: [
      "@chat-adapter/discord",
      "@chat-adapter/slack",
      "@chat-adapter/state-memory",
      "chat",
      "ai",
      "ai/test",
      "process"
    ]
  },
  resolve: {
    conditions: ["worker", ...defaultClientConditions],
    alias: [
      {
        find: "@mcp-b/do-runtime/gate",
        replacement: here("../../../../../../src/gate.ts")
      },
      {
        find: "@mcp-b/do-runtime/browser/async-hooks",
        replacement: here("../../../../../../src/browser/async-hooks.ts")
      },
      {
        find: "@slack/web-api",
        replacement: fileURLToPath(
          import.meta
            .resolve("@cloudflare/think/messengers/browser/slack-web-api")
        )
      },
      {
        find: "@slack/socket-mode",
        replacement: fileURLToPath(
          import.meta
            .resolve("@cloudflare/think/messengers/browser/slack-socket-mode")
        )
      },
      {
        find: "discord.js",
        replacement: fileURLToPath(
          import.meta.resolve("@cloudflare/think/messengers/browser/discord-js")
        )
      },
      { find: /^crypto$/, replacement: here("./node-crypto.ts") },
      {
        find: /^(?:node:)?async_hooks$/,
        replacement: here("../../../../../../src/browser/async-hooks.ts")
      },
      ...Object.entries(nodeStdlib).map(([name, replacement]) => ({
        find: new RegExp(`^(?:node:)?${name}$`),
        replacement
      }))
    ]
  },
  worker: { format: "es" },
  test: {
    name: "think-browser",
    include: [here("./*.test.ts")],
    setupFiles: [here("./setup.ts")],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }]
    }
  }
});
