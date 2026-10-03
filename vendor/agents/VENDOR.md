# Vendor provenance

Upstream: <https://github.com/cloudflare/agents>

Release pin: `agents@0.26.0`
(`74570a19aafc676dd85831a31af047817e7bba12`).

The package versions match the 0.26 release:

- `agents@0.26.0`
- `@cloudflare/think@0.20.0`
- `@cloudflare/ai-chat@0.12.1`
- `@cloudflare/voice@0.5.0`
- `@cloudflare/shell@0.4.3`
- `@cloudflare/codemode@0.5.3`

This fork contains only the package closure used by Rook. Compare future
upstream releases against the commit above, reconcile
[current divergences](docs/fork-diff.md), update each affected row in place
(remove retired rows; Git preserves history), then run `pnpm build && pnpm check &&
pnpm test` here and the runtime's example gate.
