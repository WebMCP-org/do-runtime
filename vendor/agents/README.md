# Rook Agents SDK fork

This workspace owns the Cloudflare Agents SDK behavior that Rook depends on.
It preserves the upstream package names, except the fork-owned
`@mcp-b/browser-workspace`, and builds JavaScript and declarations from the
same source.

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
`pnpm test:browser` builds and exercises the browser messenger leaves and the
`@mcp-b/browser-workspace` OPFS and directory-handle suites in Chromium,
including native sockets in a real Worker. See
[the integration guide](docs/think/browser-messengers.md) and
[current browser integrations](docs/browser-compatibility.md).

The native Agents and Think files run serially. Agents has a recorded
parallel-worker bridge-test flake; Think's expanded suite hit its 60-second
module-warmup deadline locally when loaded in parallel. All 1328 Think cases
passed with serial file execution; retries remain disabled.

## Packages

- `agents@0.32.0`
- `@cloudflare/ai-chat@0.12.2`
- `@cloudflare/think@0.23.0`
- `@cloudflare/voice@0.5.0`
- `@cloudflare/shell@0.5.0`
- `@cloudflare/codemode@0.5.6`
- `@mcp-b/browser-workspace@0.2.0` (fork-owned, no upstream counterpart; 0.1.0 shipped in `rook-sdk-576d9f3fe35a`, 0.2.0 in `rook-sdk-19cd4c3db334`)

Rook consumes these built packages. `@mcp-b/do-runtime` remains a lower
layer and has no dependency on the SDK.

See [VENDOR.md](VENDOR.md) for the upstream pin and
[docs/fork-diff.md](docs/fork-diff.md) for the maintained changes.
