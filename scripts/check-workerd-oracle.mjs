import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const version = packageJson.devDependencies?.workerd;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("package.json must pin workerd to an exact release");
}
const typesVersion = `5.${version.split(".").slice(1).join(".")}`;
for (const path of [
  "package.json",
  "vendor/agents/package.json",
  "examples/extension/package.json",
  "examples/vibe-platform/package.json",
]) {
  const manifest = JSON.parse(await readFile(new URL(path, root), "utf8"));
  if (manifest.devDependencies?.["@cloudflare/workers-types"] !== typesVersion) {
    throw new Error(`${path} must pin @cloudflare/workers-types to ${typesVersion}`);
  }
}

const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
const platforms = [
  "@cloudflare/workerd-darwin-64",
  "@cloudflare/workerd-darwin-arm64",
  "@cloudflare/workerd-linux-64",
  "@cloudflare/workerd-linux-arm64",
  "@cloudflare/workerd-windows-64",
  "workerd",
];
for (const name of platforms) {
  if (!workspace.includes(`- "${name}@${version}"`)) {
    throw new Error(`pnpm-workspace.yaml must exclude ${name}@${version} from the release-age gate`);
  }
}
if (!workspace.includes(`- "@cloudflare/workers-types@${typesVersion}"`)) {
  throw new Error(`pnpm-workspace.yaml must exclude @cloudflare/workers-types@${typesVersion} from the release-age gate`);
}

const readme = await readFile(new URL("README.md", root), "utf8");
const decisions = await readFile(new URL("docs/decisions.md", root), "utf8");
const sync = await readFile(new URL("docs/workerd-sync.md", root), "utf8");
if (!readme.includes(`conformance oracle is pinned to \`v${version}\``)) {
  throw new Error(`README.md does not name oracle v${version}`);
}
if (!decisions.includes(`oracle is pinned separately to release \`v${version}\``)) {
  throw new Error(`docs/decisions.md does not name oracle v${version}`);
}
if (!sync.includes(`oracle is now pinned to \`v${version}\``)) {
  throw new Error(`docs/workerd-sync.md does not record the re-pin to oracle v${version}`);
}

console.log(`workerd oracle pins agree on v${version}`);
