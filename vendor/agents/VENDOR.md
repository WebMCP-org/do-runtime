# Vendor provenance

Upstream: <https://github.com/cloudflare/agents>

Release pin: `agents@0.23.0`
(`5f7ad7e4edac2ec8dd1d6a31758f251cb52373fa`).

The package versions match the 0.23 release:

- `agents@0.23.0`
- `@cloudflare/think@0.18.0`
- `@cloudflare/ai-chat@0.12.0`
- `@cloudflare/voice@0.5.0`
- `@cloudflare/shell@0.4.3`
- `@cloudflare/codemode@0.5.2`

This fork contains only the package closure used by Rook. Compare future
upstream releases against the commit above, reconcile
[the fork ledger](docs/fork-diff.md), then run `pnpm build && pnpm check &&
pnpm test` here and the runtime's example gate.
