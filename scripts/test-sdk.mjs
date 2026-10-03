import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const workerdPath = createRequire(import.meta.url)("workerd").default;

// The Workers pool pins its own older binary. Exercise the SDK against the
// same exact workerd oracle as runtime conformance, including in CI.
const result = spawnSync("pnpm", ["--dir", "vendor/agents", "test"], {
  stdio: "inherit",
  // Windows installs pnpm as a .cmd launcher; POSIX executes it directly.
  shell: process.platform === "win32",
  env: {
    ...process.env,
    MINIFLARE_WORKERD_PATH: process.env.MINIFLARE_WORKERD_PATH ?? workerdPath,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
