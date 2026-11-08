# @mcp-b/browser-workspace

Workspace filesystems for browser-hosted agents: one over a private OPFS
directory, one over a user-picked File System Access directory, and an adapter
that presents either as Shell's `FileSystem`.

They implement `@cloudflare/shell`'s `WorkspaceFsLike` and `FileSystem`
contracts. Shell is a type-only peer dependency: nothing from it loads at
runtime. The path normalization and glob dialect are copies of Shell's (and
`@cloudflare/computer`'s), not imports.

These modules used to ship as `@cloudflare/shell/browser`,
`@cloudflare/shell/paths` and `@cloudflare/shell/browser/native-file-system`.
They moved here so Shell can stay frozen at upstream.

## Entry points

- `@mcp-b/browser-workspace`: `OpfsWorkspace` (`OpfsWorkspaceOptions`),
  `DirectoryHandleWorkspace` (`DirectoryHandleWorkspaceOptions`),
  `WorkspaceFileSystem`, `RangeWorkspaceFsLike` (`WorkspaceFsLike` plus the
  optional native `readFileRange` and `appendFileBytes` the adapter prefers),
  and `validateReadRange`.
- `@mcp-b/browser-workspace/paths`: workspace path helpers
  (`normalizeWorkspacePath`, `workspaceDirname`, `workspaceBasename`,
  `workspacePathParts`, `workspaceGlobToRegex`, `workspaceGlobPrefix`,
  `hasWorkspaceGlobMagic`, `fileSystemError`, `validateReadRange`,
  `MAX_WORKSPACE_PATH_LENGTH`).
- `@mcp-b/browser-workspace/native-file-system`: low-level helpers over native
  directory and file handles that both workspaces build on.

## Existing browser directories

`DirectoryHandleWorkspace` implements the filesystem contract over an existing
`FileSystemDirectoryHandle`. It reads the folder directly, without OPFS's
private `data/` or `meta/` directories. The host persists the handle, obtains
permission in a visible context, and passes one stable `lockName` shared by
every instance opening that folder:

```ts
import { DirectoryHandleWorkspace } from "@mcp-b/browser-workspace";

const workspace = new DirectoryHandleWorkspace({
  root: directoryHandle,
  lockName: directoryIdentity
});
await workspace.writeFile("/notes.txt", "Hello");
```

Native directories do not support symbolic links; `symlink` reports that.

## Browser OPFS workspace

`OpfsWorkspace` stores a workspace in a dedicated OPFS directory the host
selects:

```ts
import { OpfsWorkspace } from "@mcp-b/browser-workspace";

const storage = await navigator.storage.getDirectory();
const root = await storage.getDirectoryHandle("workspace", { create: true });
const workspace = new OpfsWorkspace({ root });

await workspace.writeFile("/notes/today.md", "Hello from a browser Worker");
await workspace.symlink("today.md", "/notes/latest.md");
const text = await workspace.readFile("/notes/latest.md");
```

It requires OPFS and Web Locks in a secure context, and loads without Node
shims. Instances and Workers sharing a root coordinate through locks derived
from its OPFS path. Files live in `data/`; `meta/` stores only symlinks.
`getDataDirectory()` returns the tree to observe for native file changes.

## Shared behaviour

- Writes, appends and `writeStream(path, stream, signal?)` commit through native
  writable streams; a failed write preserves the existing contents. Appends
  restage the whole file, so large append workloads may need a journal.
- Directory copies and moves can leave a partial destination on failure;
  retrying completes them. Regular-file moves need the browser's native
  `FileSystemFileHandle.move`.
- `readDir` returns 1,000 entries by default, ordered by type and then UTF-8
  name; page with `offset` and `limit`.
- MIME types come from filenames and the browser, not write-time declarations.
  `createdAt` is the native modification time; directory timestamps are zero.
- `WorkspaceFileSystem` follows intermediate symlinks, reads every listing page,
  and uses native range reads and binary append when the workspace has them.

## Tests

From `vendor/agents`:

```sh
pnpm --filter @mcp-b/browser-workspace test          # Node: adapter, range and glob checks
pnpm --filter @mcp-b/browser-workspace test:browser  # Chromium via Playwright: OPFS and directory handles
```

The browser lane needs Playwright's Chromium (`pnpm exec playwright install chromium`).
