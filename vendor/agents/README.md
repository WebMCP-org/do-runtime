# Rook Agents SDK fork

This workspace owns the Cloudflare Agents SDK behavior that Rook depends on.
It preserves the upstream package names and builds JavaScript and declarations
from the same source.

## Setup

Use Node 24 and pnpm 11:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check
pnpm test
```

`pnpm test` is the maintained Rook regression gate. It covers the fork's
recovery, replay, Stop, messenger, model, React, and voice behavior. It does
not run intentionally retired Codemode execution or unrelated upstream apps.
The native Agents files run serially because their fixed-delay bridge tests
have a recorded parallel-worker flake; retries remain disabled.

## Packages

- `agents@0.22.0`
- `@cloudflare/ai-chat@0.11.0`
- `@cloudflare/think@0.17.0`
- `@cloudflare/voice@0.4.0`
- `@cloudflare/shell@0.4.3`
- `@cloudflare/codemode@0.5.1`

Rook consumes these built packages. `@mcp-b/do-runtime` remains a lower
layer and has no dependency on the SDK.

See [VENDOR.md](VENDOR.md) for the upstream pin and
[docs/fork-diff.md](docs/fork-diff.md) for the maintained changes.
