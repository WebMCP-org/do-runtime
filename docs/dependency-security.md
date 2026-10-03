# Dependency security review — October 2, 2026

The Cloudflare sync includes targeted security overrides in both pnpm workspaces.
They keep the installed major versions, retain the existing Babel 7 override,
and leave the exact workerd oracle pin unchanged. Direct package ranges were
not broadened. The export checker now uses Node 24's `node:fs/promises.glob`,
removing its sole `fast-glob` dependency and the vulnerable `braces` graph. `pnpm install --ignore-scripts` completed without peer warnings.

The [latest Workers test pool](https://registry.npmjs.org/@cloudflare/vitest-pool-workers/latest)
is still `0.22.0` and pins `miniflare@5.20260815.0-alpha` and `wrangler@4.124.0`.
Updating the top-level Wrangler alone cannot remove its vulnerable Sharp and
Undici copies. The overrides therefore apply to affected transitive versions.
Fixed versions were checked against npm package metadata before installation;
all selected releases support the repository's Node 24 environment.

## Installed fixes

These are the exact override entries. “Both” means the root workspace and
`vendor/agents`; “vendor” means that only the vendored workspace had an affected
version. A selector stops applying once its parent resolves a newer version.

| Selector | Fixed version | Workspace | Advisory evidence |
| --- | --- | --- | --- |
| `sharp@0.35.2` | `0.35.4` | Both | [libheif vulnerabilities](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) |
| `undici@>=7 <7.29.1` | `7.29.1` | Both | [WebSocket denial of service](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5), [additional high-severity finding](https://github.com/advisories/GHSA-w293-vg96-wgc3); this also resolves the reported 7.28/7.29 moderate and low findings |
| `brace-expansion@>=5 <5.0.12` | `5.0.12` | Both | [Nested-brace stack exhaustion](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [latest affected range](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) |
| `fast-uri@>=3 <3.1.8` | `3.1.8` | Both | [High-severity affected range](https://github.com/advisories/GHSA-qw65-cvwx-89v3), [latest affected range](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) |
| `ip-address@>=10 <10.7.1` | `10.7.1` | Both | [High-severity affected range](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), [latest affected range](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) |
| `ws@>=8 <8.21.0` | `8.21.0` | Vendor | [Affected versions below 8.21.0](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) |
| `fastify@>=5 <5.12.5` | `5.12.5` | Vendor | [High-severity affected range](https://github.com/advisories/GHSA-667r-xxjv-c9mm), [latest affected range](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc) |
| `find-my-way@>=9 <9.7.0` | `9.7.0` | Vendor | [HTTP/2 denial of service](https://github.com/advisories/GHSA-c96f-x56v-gq3h); npm has no 9.6.1 release, so 9.7.0 is the first published release satisfying the fixed range |
| `hono@>=4 <4.13.7` | `4.13.7` | Vendor | [Latest affected range](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) |
| `@hono/node-server@>=1 <1.19.15` | `1.19.15` | Vendor | [Affected versions below 1.19.15](https://github.com/advisories/GHSA-frvp-7c67-39w9) |
| `qs@>=6 <6.16.0` | `6.16.0` | Vendor | [Latest affected range](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) |

## Audit result and remaining findings

`pnpm audit --json` was run immediately before and after these installs. Counts
are reported advisories, not separate exploitable application paths. The
initial scan includes the new example crypto shims, so it differs from the
older 17/61 scan taken before those dependencies were installed.

| Workspace | Before | After |
| --- | --- | --- |
| Root | 18: 5 high, 9 moderate, 4 low | 1 low; no high or moderate findings |
| Vendor | 62: 23 high, 34 moderate, 5 low | 6: 1 high, 4 moderate, 1 low |

The remaining findings are explicit exclusions from the compatible overrides:

- **Evalite's static server:** `evalite@0.19.0 > @fastify/static@8.3.0`
  has one [high route-guard bypass](https://github.com/advisories/GHSA-83w8-p2f5-377r)
  and three moderate findings
  ([directory traversal](https://github.com/advisories/GHSA-pr96-94w5-mx2h),
  [encoded separators](https://github.com/advisories/GHSA-x428-ghpx-8j92),
  [noncanonical paths](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj)).
  Fixing all four requires static 10.1.2 or newer, outside Evalite's `^8.2.0`
  range. The [latest stable Evalite](https://registry.npmjs.org/evalite/latest)
  remains 0.19.0; its 1.0 prerelease is a separate tool migration. This is
  development evaluation tooling, not a runtime package dependency.
- **Evalite's file detector:** `evalite@0.19.0 > file-type@19.6.0` has a
  [moderate malformed-ASF infinite loop](https://github.com/advisories/GHSA-5v7r-6r5c-r473).
  Its fix requires 21.3.1 or newer, outside Evalite's `^19.6.0` range.
- **Browser crypto:** `node-stdlib-browser > crypto-browserify > elliptic@6.6.1`
  has a [low cryptographic-implementation finding](https://github.com/advisories/GHSA-848j-6mx2-7j84).
  The advisory names 6.6.2, but [npm metadata](https://registry.npmjs.org/elliptic)
  lists no published release satisfying that range. The dependency is present
  in both example builds and Think's browser development setup. The current
  compatibility need is synchronous hashing; this audit does not establish
  that elliptic signing or key agreement is exercised by those builds.

The dependency audit is not a claim that every reported vulnerability is
reachable, nor that the remaining packages are safe for arbitrary inputs.
Removing these exclusions requires an evaluation-tool migration, a smaller
browser crypto adapter, or upstream fixes with validation for those surfaces.

The removed `fast-glob > micromatch > braces@3.0.3` dependency had a
[high deeply-nested-pattern denial of service](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
Its named 3.0.4 fix is not published. Using the built-in glob implementation for
`packages/*/package.json` removes that advisory without replacing the dependency
with another package or changing the export check's scope.

## Validation

After installing the security overrides, all 1,022 runtime unit tests,
82 workerd conformance tests, and 50 Think agent-tool tests passed. The latter
runs through the affected Workers test pool and its overridden dependencies.
The Node 24 export checker also passed for all six maintained SDK packages
after their build. The broader SDK, browser, and example validation is recorded
with the sync.
