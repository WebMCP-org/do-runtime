import { build } from "tsdown";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/think.ts",
      "src/workflows.ts",
      "src/extensions/index.ts",
      "src/react.tsx",
      "src/messengers/index.ts",
      "src/messengers/telegram.ts",
      "src/messengers/browser/index.ts",
      "src/messengers/browser/slack.ts",
      "src/messengers/browser/discord.ts",
      "src/messengers/browser/slack-web-api.ts",
      "src/messengers/browser/slack-socket-mode.ts",
      "src/messengers/browser/discord-js.ts",

      "src/tools/workspace.ts",
      "src/tools/fetch.ts",
      "src/tools/execute.ts",
      "src/tools/extensions.ts",
      "src/tools/browser.ts",
      "src/tools/sandbox.ts"
    ],
    deps: {
      skipNodeModulesBundle: true,
      neverBundle: ["cloudflare:workers"]
    },
    format: "esm",
    outputOptions: { keepNames: true },
    sourcemap: true,
    fixedExtension: false
  });

  // then run oxfmt on the generated .d.ts files
  formatDeclarationFiles();

  copyPackageDocs(import.meta.url, "think");

  process.exit(0);
}

main().catch((err) => {
  // Build failures should fail
  console.error(err);
  process.exit(1);
});
