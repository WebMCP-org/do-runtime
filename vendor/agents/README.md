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
recovery, replay, Stop, messenger, model, React, voice, and browser transport behavior. It does
not run intentionally retired Codemode execution or unrelated upstream apps.
`pnpm test:browser` builds and exercises the browser messenger leaves in
Chromium, including native sockets in a real Worker. See
[the integration guide](docs/think/browser-messengers.md) and
[the next browser compatibility candidates](docs/browser-compatibility.md).

The native Agents and Think files run serially. Agents has a recorded
parallel-worker bridge-test flake; Think's expanded suite hit its 60-second
module-warmup deadline locally when loaded in parallel. All 626 Think cases
passed with serial file execution; retries remain disabled.

## Packages

- `agents@0.23.0`
- `@cloudflare/ai-chat@0.12.0`
- `@cloudflare/think@0.18.0`
- `@cloudflare/voice@0.5.0`
- `@cloudflare/shell@0.4.3`
- `@cloudflare/codemode@0.5.2`

Rook consumes these built packages. `@mcp-b/do-runtime` remains a lower
layer and has no dependency on the SDK.

See [VENDOR.md](VENDOR.md) for the upstream pin and
[docs/fork-diff.md](docs/fork-diff.md) for the maintained changes.
