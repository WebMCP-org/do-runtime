import { fileURLToPath } from "node:url";

// Self-imports resolve to source so tests need no prior build.
export const alias = [
  {
    find: /^@mcp-b\/browser-workspace$/,
    replacement: fileURLToPath(new URL("../index.ts", import.meta.url))
  },
  {
    find: /^@mcp-b\/browser-workspace\/paths$/,
    replacement: fileURLToPath(new URL("../paths.ts", import.meta.url))
  }
];
