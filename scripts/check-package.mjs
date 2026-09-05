import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.license !== "FSL-1.1-MIT") {
  throw new Error(`package license is ${manifest.license}; expected FSL-1.1-MIT`);
}
if (manifest.publishConfig?.access !== "public") {
  throw new Error("scoped package must publish with public access");
}
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
  "docs/assets/browser-agent-runtime.png",
  "docs/assets/extension-agent-runtime.svg",
  "docs/migrations.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/src/index.d.ts",
  "dist/cloudflare-workers.d.ts",
  "dist/backends/node-sqlite.js",
  "dist/backends/sqlite-wasm.js",
  "dist/gate.js",
  "dist/vite.js",
  "LICENSE.workerd",
  "NOTICE",
]) {
  if (!files.has(required)) throw new Error(`packed package is missing ${required}`);
}
for (const file of files) {
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(file) || (file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
    throw new Error(`packed package contains development source: ${file}`);
  }
}
for (const [name, target] of Object.entries(manifest.exports)) {
  const paths = typeof target === "string" ? [target] : Object.values(target);
  for (const path of paths) {
    if (typeof path === "string" && path.startsWith("./") && !files.has(path.slice(2))) {
      throw new Error(`packed package export ${name} is missing ${path}`);
    }
  }
}

const modules = new Map();
for (const [name, target] of Object.entries(manifest.exports)) {
  const path = typeof target === "string" ? target : target.import;
  if (typeof path === "string" && path.endsWith(".js")) {
    modules.set(name, await import(new URL(`../${path.slice(2)}`, import.meta.url)));
  }
}
const runtime = modules.get(".");
const alarmCoordinator = modules.get("./browser/alarm-coordinator");
const messagePortWebSocket = modules.get("./browser/message-port-websocket");
const offscreenDocument = modules.get("./browser/offscreen-document");
const nodeBackend = modules.get("./backends/node-sqlite");
const gate = modules.get("./gate");
const vite = modules.get("./vite");
if (typeof runtime.createActorContainer !== "function") {
  throw new Error("packed root entry does not export createActorContainer");
}
if (typeof runtime.BrokenActorError !== "function" || typeof runtime.CanceledError !== "function") {
  throw new Error("packed root entry does not export its actor lifecycle errors");
}
if (
  typeof alarmCoordinator.BrowserAlarmCoordinator !== "function" ||
  typeof alarmCoordinator.parseBrowserAlarmTransportJournal !== "function"
) {
  throw new Error("packed browser alarm entry does not export its coordinator and parser");
}
if (
  typeof messagePortWebSocket.MessagePortWebSocket !== "function" ||
  typeof messagePortWebSocket.createMessagePortWebSocketConstructor !== "function" ||
  typeof messagePortWebSocket.serveMessagePortWebSockets !== "function"
) {
  throw new Error("packed MessagePort WebSocket entry does not export its host helpers");
}
if (typeof offscreenDocument.OffscreenDocumentCoordinator !== "function") {
  throw new Error("packed offscreen document entry does not export its coordinator");
}
if (typeof nodeBackend.createNodeSqlProvider !== "function") {
  throw new Error("packed Node backend does not export createNodeSqlProvider");
}
if (typeof gate.__gate !== "function" || typeof gate.__gateAsyncIterable !== "function") {
  throw new Error("packed gate entry does not export its helpers");
}
if (typeof vite.doRuntimeAwaitTransform !== "function") {
  throw new Error("packed Vite entry does not export doRuntimeAwaitTransform");
}

// Compile and run the documented host against only the files npm will ship.
const consumer = mkdtempSync(join(tmpdir(), "do-runtime-consumer-"));
try {
  const nodeModules = join(consumer, "node_modules");
  const packageDirectory = join(nodeModules, manifest.name);
  for (const file of files) {
    const destination = join(packageDirectory, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(file, root), destination);
  }
  for (const dependency of [
    ...Object.keys(manifest.dependencies),
    "@cloudflare/workers-types",
    "@types/node",
  ]) {
    const destination = join(nodeModules, dependency);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(fileURLToPath(new URL(`node_modules/${dependency}`, root)), destination, "junction");
  }
  const minimalHost = readFileSync(join(packageDirectory, "README.md"), "utf8")
    .split("## Minimal host\n")[1]?.split("\n## ")[0];
  const source = minimalHost?.match(/```ts\n([\s\S]*?)```/)?.[1];
  const config = minimalHost?.match(/```json\n([\s\S]*?)```/)?.[1];
  if (!source || !config) throw new Error("README minimal host or TypeScript configuration is missing");
  writeFileSync(join(consumer, "tsconfig.json"), config);
  writeFileSync(
    join(consumer, "host.mts"),
    `${source}\nimport { strictEqual } from "node:assert";\nstrictEqual(await counter.increment(), 3);\n`,
  );
  for (const args of [
    [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)), "-p", consumer],
    [join(consumer, "host.mts")],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: consumer, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || String(result.error || "README consumer smoke failed"));
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

console.log(`package smoke passed with ${files.size} files`);
