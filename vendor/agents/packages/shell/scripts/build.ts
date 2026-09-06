import { build } from "tsdown";
import { copyPackageDocs } from "../../../scripts/copy-package-docs";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: [
      "src/index.ts",
      "src/workers.ts",
      "src/state-methods.ts",
      "src/git/index.ts"
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

  formatDeclarationFiles();

  copyPackageDocs(import.meta.url, "shell");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
