import { readFile, readdir, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);

for (const name of await readdir(dist, { recursive: true })) {
  if (!name.endsWith(".d.ts")) continue;

  const file = new URL(name, dist);
  const source = await readFile(file, "utf8");
  const fixed = source.replace(
    /((?:from\s+|import\s*\()\s*["'])(\.\.?\/[^"']+)(["'])/g,
    (match, before, specifier, after) =>
      /\.[a-z\d]+$/i.test(specifier)
        ? match
        : `${before}${specifier}.js${after}`,
  );

  if (fixed !== source) await writeFile(file, fixed);
}

await writeFile(
  new URL("cloudflare-workers.d.ts", dist),
  'export * from "./src/api/cloudflare-workers.js";\n',
);
