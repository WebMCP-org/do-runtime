# Decision memo: Rook's workspace, `@cloudflare/shell` vs `@cloudflare/computer`

Date: 2026-11-07. This was a read-only investigation. Nothing in either repo was changed and nothing was posted.

Sources and their abbreviations:

- **do-runtime**: the main checkout at `109eed62` (branch `alex/shell-glob-braces`).
- **Rook**: `rook-sdk-0-32` at `4893fce9` (branch `alex/sdk-0-32`).
- **C10**: Computer 0.10.0 as published on npm.
- **docs**: Computer's design docs (`docs/*.md` in cloudflare/computer).

Rook paths are relative to `rook-sdk-0-32/packages/`. "Shell" means do-runtime's `vendor/agents/packages/shell/src/`.

## Bottom line

Rook already takes the structural route.

- Think's `ThinkWorkspace` needs only `.fs` with eight methods, and `runtime` and `assets` are optional (upstream `think/src/workspace-files.ts:8-38`).
- Rook supplies that `.fs` with `BrowserWorkspace.fs` (`think-app/workspace/browser-workspace.ts:51`).
- Think's tools are already Computer's `createAITools({ workspace })`.

So what is left of "Shell" in Rook is not the agent workspace. It is a **browser filesystem library**: OPFS, native directories and paths. It also includes three Shell subsystems that Computer cannot replace in the browser: the checked-code `workspace` API, git, and archives.

Adopting dofs (option c) mechanically works on do-runtime storage. It still loses live native folders, and it reverses Rook ADRs 0006 and 0010.

**Recommendation:** (b). Do it as "extract and own", not "rewrite onto Computer". Leave (c) for later, gated on two upstream changes.

## 1. What Rook uses Shell for

Rook imports Shell in 40 files (10 of them tests) across five entry points:

- `.`: types, `WorkspaceFileSystem` and `createWorkspaceStateBackend`
- `/browser`
- `/browser/native-file-system`
- `/paths`
- `/git` and `/state-methods`

| Feature                                                      | Rook use (file:line)                                                                                                                                              | Shell provider (fork-only?)                                                                      | Computer concept that could carry it                                              | Computer equivalent usable in do-runtime today?                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPFS workspace (`rook/workspaces/<id>/{data,meta}`)          | `think-app/workspace/opfs-workspace.ts:1,19`, `browser-workspace.ts:18`                                                                                           | `browser/opfs-workspace.ts` (1,653 lines, fork)                                                  | `Workspace` over dofs (`storage: DurableObjectStorageLike`, C10 `index.d.ts:151`) | Different model: SQLite rows in one actor DB instead of OPFS files (see §2)                                                                                                                                                                                                                           |
| Host-selected native folders at `/mounts/<name>`             | `local-folder-workspace.ts:1`, `host/local-folder-mounts.ts`                                                                                                      | `browser/directory-handle-workspace.ts` (654, fork)                                              | Mounts                                                                            | **No.** C10 has `type Mount = EagerMount` only (`index.d.ts:52`). Indexing runs `clearRoot` and then `materialize` copies into SQLite (`index.js:5085-5095`). There is no write-back: `put`/`delete` are design-doc targets (`06_mount_interface.md:3-9`, "diverged from the current implementation") |
| `/mcp` reference files (read-only, live)                     | `mcp-workspace.ts:17`                                                                                                                                             | Paths and native-metadata leaves                                                                 | `EagerMount` with `version`                                                       | Yes, as a copy refreshed on version change                                                                                                                                                                                                                                                            |
| Symlinks                                                     | `browser-workspace.ts:230-243`                                                                                                                                    | OPFS `meta/` manifests (fork)                                                                    | dofs symlinks (`supportsSymlinks = true`)                                         | Yes (probe below)                                                                                                                                                                                                                                                                                     |
| Web Locks: tree lock and per-directory locks                 | `opfs-workspace.ts:34`, `storage-layout.ts:22`; ADR 0006 lock protocol                                                                                            | OPFS and directory-handle backends                                                               | dofs `transactionSync` inside one actor                                           | Different model: one writer actor, and no cross-worker locks needed                                                                                                                                                                                                                                   |
| Staged writes and atomic download                            | `browser-workspace.ts:95-130` (`writeStreamAtomic`), staged append                                                                                                | OPFS backend, `appendFileBytes` (fork, `filesystem.ts`)                                          | `fs.writeFile` + `rename` in a transaction                                        | Yes                                                                                                                                                                                                                                                                                                   |
| Byte-range reads                                             | `workspace-filesystem.ts:65-80`, `bash-filesystem.ts:39`                                                                                                          | `fs/read-range.ts`, `readFileRange` (fork)                                                       | `readFile(path, { byteOffset, byteLength })`                                      | Yes                                                                                                                                                                                                                                                                                                   |
| find/grep/glob for Think tools                               | `workspace-filesystem.ts:122-165,364-438` (verbatim port of Computer's private compiler, guarded by `extension/.../fixtures/computer-glob-port.contract.test.ts`) | n/a                                                                                              | `WorkspaceFilesystem.find/grep`                                                   | Yes, but only for a dofs `Workspace`. Computer does not export the walk or the compiler                                                                                                                                                                                                               |
| `glob()` in Rook backends (Shell dialect)                    | `mcp-workspace.ts:3-9`, `local-folder-workspace.ts:18-22`, `fixtures/memory-workspace.ts`                                                                         | `paths.ts` → `helpers.ts createGlobMatcher` (this branch's fork edit, ledger `fork-diff.md:197`) | n/a                                                                               | There are two dialects today                                                                                                                                                                                                                                                                          |
| Checked-code `workspace` API (46 methods, archives included) | `extension/.../connectors/workspace.ts:4-5`, `sandbox/workspace-executable-typecheck.ts:3`                                                                        | `state-methods.ts`, `memory.ts`, `extras.ts readArchive` (fork edits, `fork-diff.md:148-150`)    | Codemode backend's `node:fs/promises` (`18_runtime_migration.md`)                 | **No.** It needs Worker Loader, and do-runtime's channels refuse `getEntrypoint` (`docs/cloudflare-sync-2026-10-31.md:164`). C10 has no archive API                                                                                                                                                   |
| Git (isomorphic-git)                                         | `connectors/github.ts:1-2,245`, `agents/worker-agent.ts:1253`                                                                                                     | `git/` over `WorkspaceFileSystem`                                                                | `workspace.git` / `createGitClient`                                               | Only over dofs: it needs `provider(): SQLiteWorkspaceProvider` (`shared-BbpnqJrh.d.ts:997`)                                                                                                                                                                                                           |
| Live Bash (just-bash `MountableFs`)                          | `execution/bash-filesystem.ts:1-30`                                                                                                                               | `WorkspaceFileSystem` (fork)                                                                     | `worker-shell` backend                                                            | **No.** It needs a Worker Loader (`backends/worker-shell/index.d.ts:229-249`)                                                                                                                                                                                                                         |
| File-change observation                                      | `workspace-change-observer.ts:1,50` (`FileSystemObserver` on the OPFS `data/` dir)                                                                                | Data-directory handle                                                                            | dofs `vfs_changes` / `supportsWatch`                                              | Would need a rewrite                                                                                                                                                                                                                                                                                  |

## 2. Can dofs run on do-runtime's storage as-is?

**Mostly yes, verified in the Node lane.**

dofs is bundled into Computer's `dist/index.js` (DDL at `index.js:95-369`). It asks very little of the storage object:

- `sql.exec(...).toArray()` plus optional `transactionSync` (`shared-BbpnqJrh.d.ts:2-12`);
- `RETURNING`, `WITH RECURSIVE`, `PRAGMA table_info` and `ALTER TABLE` (`index.js:55,146,468`);
- 512 KiB chunks (`index.js:962`), which fit under do-runtime's 8 MiB length limit (`src/util/sqlite.ts:79`).

do-runtime allows `table_info` (`src/api/sql.ts:426`) and provides `transactionSync` (`src/api/actor-state.ts:704`).

**Probe.** A scratch test (not committed) built a do-runtime `createActorContainer` over `backends/node-sqlite`. It ran Computer **0.8.0**'s `new Workspace({ storage: ctx.storage })`, the copy installed in do-runtime's pnpm store, through these operations:

- mkdir -p;
- a text write and a 3 MiB binary write;
- a range read;
- a symlink, then a read through it;
- `find` and `grep`;
- rename, readdir, stat;
- recursive rm, then `ENOENT`.

Every operation passed. The database was 3.3 MB afterwards.

UNVERIFIED:

- 0.10.0 (its peers are not installed);
- the sqlite-wasm/SAH browser lane;
- `@platformatic/vfs` for git in the browser.

Runtime imports are `node:crypto`, `node:events`, `node:fs`, `capnweb` and `cloudflare:workers` (`index.js:11-15`). do-runtime supplies `cloudflare:workers` (`src/vite.ts:347`). Rook's browser lane already resolves `node:events` and `unenv/node/fs` for Computer (Rook commit `1cda05e1`).

**So the integration is a few days. The architecture is the real problem.** A dofs Workspace lives in one actor's SQLite database. Today the root and every conversation worker open the same OPFS identity directly (ADR 0010: one worker per conversation). Under dofs, every other worker reaches the files through `getWorkspace(stub)` over Cap'n Web, and every file byte is committed synchronously in the owner's worker. ADR 0006 rejected that shape twice:

- under "Shared SQLite… restores database ownership and the cross-worker coordination this design exists to remove" (`docs/adr/0006-direct-opfs-decision-gate.md:69`);
- in its context section, which describes the old SQLite Workspace in exactly these terms.

ADR 0010:22 measured synchronous commits stalling a worker for "high-hundreds of milliseconds". Worker Loader backends (codemode and worker-shell `exec`) stay unavailable in either case.

## 3. Losses and gains

|                                                                                          | (b) extract and own                                                                                                 | (c) dofs + mounts                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live native folders (no copy; writes hit disk; ADR 0006 "Native folder mounts")          | Kept                                                                                                                | **Lost.** An eager mount copies the folder into SQLite, clears its root on every index and never writes back. Keeping the feature means keeping `DirectoryHandleWorkspace` outside Computer anyway |
| OPFS persistence model (per-file OPFS, direct multi-worker access, `FileSystemObserver`) | Kept                                                                                                                | Replaced by one SQLite DB per owner actor. Native observation and lock-free concurrent readers in other workers are lost                                                                           |
| Think options and tools unmodified                                                       | Already true. `workspace-read.ts` (fork) stays in both options                                                      | Same                                                                                                                                                                                               |
| find/grep/glob owned upstream; 438-line adapter and drift test deleted                   | **Not gained**, unless Computer exports its walk and compiler                                                       | Gained, for the dofs tree only                                                                                                                                                                     |
| Shell fork edits deleted                                                                 | Only the fork-only browser files leave Shell. `state-methods`, `memory`, `extras`, `git` and `prompt` stay vendored | Not all of them: the checked-code API and archives still need Shell's state backend                                                                                                                |
| Computer git and change feed                                                             | No                                                                                                                  | Yes                                                                                                                                                                                                |

## 4. Cost

These are estimates, not measurements.

| Option              | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rough effort                                                                                                               | Data migration                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Stay and fork   | Each refresh re-checks 7 Shell ledger rows (`fork-diff.md:146-150,160-161,197`). Each weekly Computer bump re-runs the drift test and re-ports on a change. Glob work keeps happening in two dialects: this branch is 4 files and 115 lines just to align Shell's braces with Computer. If upstream deletes `packages/shell`, the fork becomes its only owner (about 10,700 lines of non-test TypeScript and 10 test files)                                                                                                                                                                                                                                                                          | 0 now, then about 0.5-1 day per refresh, rising                                                                            | None                                                                                                                                                                                                                                                                                                                                                                                            |
| (b) Extract and own | do-runtime moves 8 fork-only files (about 2,800 lines: `browser/*`, `workspace-file-system.ts`, `fs/read-range.ts`, `fs/mime-types.ts`) and their 2 browser test files (635 lines) into a fork-owned package. It copies the 4 Shell types/utilities they import (`FileInfo`, `WorkspaceFsLike`, `fs/interface`, `path-utils`, plus the glob compiler). The Rook adapter (`workspace-filesystem.ts`) and its drift test can move there, which also leaves one glob dialect. Rook re-points 28 non-test import lines from `/browser`, `/paths` and `/browser/native-file-system`, and 18 non-test root-entry type imports (`FileInfo`, `WorkspaceFsLike`); `state-methods`/`git` imports stay on Shell | 3-5 days. Another 1-2 weeks only if every Rook consumer moves from `WorkspaceFsLike` to the Computer `fs` shape (optional) | **None.** The OPFS layout `rook/workspaces/<id>/{data,meta}` and the layout version (`storage-layout.ts:8-10`) are unchanged                                                                                                                                                                                                                                                                    |
| (c) dofs + mount    | Rewrite most of `think-app/workspace/*` (12 files, 2,039 lines), plus `bash-filesystem.ts`, `connectors/workspace.ts`, `github.ts`, `worker-agent.ts`, the change observer, the companion RPC mirror and the design-system `WorkspaceSource`. Add owner-actor RPC for conversation workers. Native folders still need (b)'s backend                                                                                                                                                                                                                                                                                                                                                                  | 4-8 weeks (UNVERIFIED)                                                                                                     | One-way import on upgrade: walk OPFS `data/`, replay `meta/` symlinks into dofs, and follow ADR 0048's rules (disk contents win, conflicts preserved, retry after a degraded start). Keep the OPFS tree for at least one release so rollback works, because older builds read only OPFS. Quota roughly doubles during the copy. Add a frozen released-profile case to `docs/release-upgrade.md` |

## 5. Recommendation

**Take (b).** The upstream rule is "do not add new uses of Shell". Rook's agent workspace already satisfies it through `ThinkWorkspace.fs`.

The fork-only browser filesystem is about 2,800 lines and lives in Shell only by history. Move it to a fork-owned package. Then Shell stops growing (this branch's brace fix is the last Shell edit worth making), and its remaining upstream parts can be frozen until they have replacements.

Do not adopt dofs now. It reverses ADR 0006 and ADR 0010, loses live native folders, and still leaves Shell in place for checked code and archives. Revisit (c) when both of these hold:

1. Computer ships lazy or write-back mounts.
2. do-runtime's Worker Loader serves `getEntrypoint`.

**One upstream ask removes the remaining drift.** Ask Computer to export `compileGlob` and a structural `find`/`grep` over `readdir`/`readFile`. That deletes Rook's verbatim port and its drift test under either option. (This is a suggestion only; nothing was posted.)

**First concrete step.** In do-runtime, cut a branch that adds a fork-owned package and moves into it, unchanged, with the same export names:

- `shell/src/browser/*`
- `workspace-file-system.ts`
- `fs/read-range.ts`
- `fs/mime-types.ts`
- copies of the four Shell leaves they import

Keep `@cloudflare/shell/browser`, `/paths` and `/browser/native-file-system` as one-release re-exports, so Rook can re-point its imports in its own PR. The package name is open. Then move the two browser tests and update the `fork-diff.md` rows at lines 146-147 and 160-161.

Status, 2026-11-07: done on branch `alex/browser-workspace-package` as `@mcp-b/browser-workspace`, merged as #120 on 2026-11-08. The one deviation from this plan is that Shell's three browser entry points were removed rather than kept as one-release re-exports: Rook takes npm `@mcp-b/do-runtime` and the rook-sdk tarballs from the same main commit together, and re-points its imports in that same bump. The four leaves were copied into the package, which imports only types from Shell, so the browser bundle stays free of Shell's Node-builtin imports. The glob dialect is therefore duplicated between Shell's `helpers.ts` and the package, which is acceptable because Shell is frozen. `fs/mime-types.ts` also stays in Shell because `extras.ts` uses it.
