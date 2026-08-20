import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const version = packageJson.devDependencies?.workerd;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("package.json must pin workerd to an exact release");
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

const readme = await readFile(new URL("README.md", root), "utf8");
const decisions = await readFile(new URL("docs/decisions.md", root), "utf8");
if (!readme.includes(`conformance oracle is pinned to \`v${version}\``)) {
  throw new Error(`README.md does not name oracle v${version}`);
}
if (!decisions.includes(`oracle is pinned separately to release \`v${version}\``)) {
  throw new Error(`docs/decisions.md does not name oracle v${version}`);
}

console.log(`workerd oracle pins agree on v${version}`);
