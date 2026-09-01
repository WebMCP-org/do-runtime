# Vendor provenance

Upstream: <https://github.com/cloudflare/agents>

Release pin: `agents@0.22.0`
(`676b3d35a82db3147c7aa1505f7f2d5ef48f359b`).

The package versions match the 0.22 release:

- `agents@0.22.0`
- `@cloudflare/think@0.17.0`
- `@cloudflare/ai-chat@0.11.0`
- `@cloudflare/voice@0.4.0`
- `@cloudflare/shell@0.4.3`
- `@cloudflare/codemode@0.5.1`

This fork contains only the package closure used by Rook. Compare future
upstream releases against the commit above, reconcile
[the fork ledger](docs/fork-diff.md), then run `pnpm build && pnpm check &&
pnpm test` here and the runtime's example gate.
