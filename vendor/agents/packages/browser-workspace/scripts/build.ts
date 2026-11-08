import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    target: "es2021",
    entry: ["src/index.ts", "src/paths.ts", "src/native-file-system.ts"],
    deps: { neverBundle: true },
    format: "esm",
    outputOptions: { keepNames: true },
    sourcemap: true,
    fixedExtension: false
  });
  formatDeclarationFiles();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
