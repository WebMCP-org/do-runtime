import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, npm_config_ignore_scripts: "true" },
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "pnpm pack failed");

const report = JSON.parse(packed.stdout);
const files = new Set(report.files.map((file) => file.path));
for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/src/index.d.ts",
  "dist/backends/node-sqlite.js",
  "dist/backends/sqlite-wasm.js",
]) {
  if (!files.has(required)) throw new Error(`packed package is missing ${required}`);
}
for (const file of files) {
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(file) || (file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
    throw new Error(`packed package contains development source: ${file}`);
  }
}

const runtime = await import(new URL("../dist/index.js", import.meta.url));
const nodeBackend = await import(new URL("../dist/backends/node-sqlite.js", import.meta.url));
if (typeof runtime.createActorContainer !== "function") {
  throw new Error("packed root entry does not export createActorContainer");
}
if (typeof nodeBackend.createNodeSqlProvider !== "function") {
  throw new Error("packed Node backend does not export createNodeSqlProvider");
}

console.log(`package smoke passed with ${files.size} files`);
