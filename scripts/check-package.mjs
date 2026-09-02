import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

console.log(`package smoke passed with ${files.size} files`);
