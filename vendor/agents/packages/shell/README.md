# `@cloudflare/shell`

> **Experimental.** API surface is still settling — expect breaking changes.

Sandboxed JavaScript execution and filesystem runtime for Cloudflare Workers agents.

The published package includes the Workspace guide at `docs/index.md`.

Instead of parsing shell syntax, `@cloudflare/shell` runs JavaScript inside an isolated Worker and exposes a typed `state` object for operating on a filesystem backend. It is designed for agent workflows that need structured state operations, predictable semantics, and coarse host-side filesystem primitives.

## What it is

- A runtime-neutral `StateBackend` interface for filesystem/state operations
- A `FileSystem` interface with two implementations: `InMemoryFs` (ephemeral) and `WorkspaceFileSystem` (durable)
- `FileSystemStateBackend` — a single adapter wrapping any `FileSystem` into a `StateBackend`
- `Workspace` — durable file storage backed by SQLite + optional R2
- `stateTools(workspace)` — a `ToolProvider` for `@cloudflare/codemode` that exposes `state.*` in sandboxed executions
- `createGit(filesystem)` — pure-JS git operations via isomorphic-git, backed by the virtual filesystem
- `gitTools(workspace)` — a `ToolProvider` for `@cloudflare/codemode` that exposes `git.*` in sandboxed executions with auto-injected auth
- A prebuilt `state` stdlib with type declarations for LLM prompts

## What it is not

This is **not** a bash interpreter. It does not parse shell syntax, expose pipes, or emulate POSIX shell behavior. It executes JavaScript.

## Example — in-memory state

```ts
import { createMemoryStateBackend } from "@cloudflare/shell";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

const backend = createMemoryStateBackend({
  files: {
    "/src/app.ts": 'export const answer = "foo";\n'
  }
});

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

const result = await executor.execute(
  `async () => {
    const text = await state.readFile("/src/app.ts");
    await state.writeFile("/src/app.ts", text.replace("foo", "bar"));
    return await state.readFile("/src/app.ts");
  }`,
  [resolveProvider(stateToolsFromBackend(backend))]
);
```

## Example — durable Workspace

```ts
import { Agent } from "agents";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.MY_BUCKET,
    name: () => this.name
  });

  async run(code: string) {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return executor.execute(code, [
      resolveProvider(stateTools(this.workspace))
    ]);
  }
}
```

## Example — git operations

```ts
import { Agent } from "agents";
import { Workspace } from "@cloudflare/shell";
import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";

class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name
  });

  async run() {
    const git = createGit(new WorkspaceFileSystem(this.workspace));

    await git.clone({ url: "https://github.com/org/repo", depth: 1 });
    await this.workspace.writeFile("/README.md", "# Updated");
    await git.add({ filepath: "." });
    await git.commit({
      message: "update readme",
      author: { name: "Agent", email: "agent@example.com" }
    });
    await git.push({ token: this.env.GITHUB_TOKEN });
  }
}
```

### Git commands

`init`, `clone`, `status`, `add`, `rm`, `commit`, `log`, `branch`, `checkout`, `fetch`, `pull`, `push`, `diff`, `remote`

### Git ToolProvider for codemode

`gitTools(workspace)` exposes all git commands inside sandboxed executions. Default auth is auto-injected into clone/fetch/pull/push — the LLM never sees secrets.

```ts
import { stateTools } from "@cloudflare/shell/workers";
import { gitTools } from "@cloudflare/shell/git";

const providers = [
  resolveProvider(stateTools(this.workspace)),
  resolveProvider(gitTools(this.workspace, { token: this.env.GITHUB_TOKEN }))
];
```

For Git servers that require Basic auth, pass hidden default credentials:

```ts
const providers = [
  resolveProvider(stateTools(this.workspace)),
  resolveProvider(
    gitTools(this.workspace, {
      auth: {
        username: "git",
        password: this.env.GIT_PASSWORD
      }
    })
  )
];
```

If both `auth` and `token` are configured, `auth` is used. Direct tool-call auth, if supplied, takes precedence over either default.

## Browser OPFS workspace

The browser entry provides a `WorkspaceFsLike` implementation over native OPFS.
The host selects a dedicated directory; application identities and mounted
folders stay outside the backend.

```ts
import { OpfsWorkspace } from "@cloudflare/shell/browser";

const storage = await navigator.storage.getDirectory();
const root = await storage.getDirectoryHandle("workspace", { create: true });
const workspace = new OpfsWorkspace({ root });

await workspace.writeFile("/notes/today.md", "Hello from a browser Worker");
await workspace.symlink("today.md", "/notes/latest.md");
const text = await workspace.readFile("/notes/latest.md");
const page = await workspace.readDir("/notes", { limit: 100, offset: 0 });
const file = await workspace.getNativeFile("/notes/today.md");
```

This entry requires OPFS and Web Locks in a secure browser context and loads
without Node shims. The Chromium tests run the built entry in real Workers.
Separate instances and Workers coordinate through locks derived from the
selected root's OPFS path. Files live in `data/`; `meta/` stores only symlinks.
`getDataDirectory()` returns the tree to observe for native file changes.

Writes, appends, and `writeStream(path, stream, signal?)` commit through native
writable streams; failed writes preserve existing file contents. Appends retain
the existing file in the staged write, so large append workloads may require a
journal. Directory copies and moves can leave a partial destination on failure;
retrying completes it. Regular-file moves require the browser's native
`FileSystemFileHandle.move` implementation.

`readDir` defaults to 1,000 entries, ordered by type and then UTF-8 name; use
`offset` and `limit` for additional pages. File MIME types come from filenames
and the browser, rather than write-time declarations. File creation timestamps
use the native modification time; directory timestamps are zero. Invalid
symlink metadata raises `EIO` and is preserved for inspection.

Run `pnpm --filter @cloudflare/shell test:browser` after building the package.

## Design goals

- Structured state operations instead of shell parsing
- Coarse host-side operations like `glob()` and `diff()` to avoid chatty RPC
- Compatibility with both ephemeral in-memory state and durable `Workspace`
- Secure execution with isolate-level timeouts and outbound network blocking by default

## `state` object API

The `state` object is available inside every isolate and exposes:

### Primitive filesystem

`readFile`, `writeFile`, `appendFile`, `readFileBytes`, `writeFileBytes`, `mkdir`, `rm`, `cp`, `mv`, `symlink`, `readlink`, `realpath`, `readdir`, `glob`, `stat`, `lstat`, `exists`, `diff`, `diffContent`

### JSON helpers

`readJson(path)`, `writeJson(path, value, { spaces? })`, `queryJson(path, query)`, `updateJson(path, operations)`

### Search and replace

`searchText(path, query, options?)`, `searchFiles(glob, query, options?)`, `replaceInFile(path, search, replacement, options?)`, `replaceInFiles(glob, search, replacement, { dryRun?, rollbackOnError?, ...options })`

### Filesystem queries

`find(path, options?)`, `walkTree(path, { maxDepth? })`, `summarizeTree(path, { maxDepth? })`

### Archive and compression

`createArchive(path, sources)`, `listArchive(path)`, `extractArchive(path, destination)`, `compressFile(path, destination?)`, `decompressFile(path, destination?)`, `hashFile(path, { algorithm? })`, `detectFile(path)`

### Structured edit planning

`planEdits(instructions)`, `applyEditPlan(plan, { dryRun?, rollbackOnError? })`, `applyEdits(edits, { dryRun?, rollbackOnError? })`

## Multi-file workflow

```ts
// Preview changes without applying
const preview = await state.replaceInFiles("src/**/*.ts", "foo", "bar", {
  dryRun: true
});

// Plan structured edits with intent
const plan = await state.planEdits([
  { kind: "replace", path: "/src/app.ts", search: "foo", replacement: "bar" },
  { kind: "writeJson", path: "/src/config.json", value: { enabled: true } }
]);
await state.applyEditPlan(plan);

// Apply raw edits transactionally
await state.applyEdits([
  { path: "/src/generated.ts", content: "export const generated = true;\n" }
]);
```

Batch writes roll back by default if any write fails. Set `rollbackOnError: false` to allow partial progress.

## Rough command translation

| Shell command        | `state` equivalent                                                         |
| -------------------- | -------------------------------------------------------------------------- |
| `cat`                | `state.readFile()`                                                         |
| `echo x > file`      | `state.writeFile()`                                                        |
| `mkdir`              | `state.mkdir()`                                                            |
| `ls` / `find`        | `state.readdir()` / `state.glob()`                                         |
| `find` with filters  | `state.find()`                                                             |
| `tree` / `du`        | `state.walkTree()` / `state.summarizeTree()`                               |
| `cp` / `mv` / `rm`   | `state.cp()` / `state.mv()` / `state.rm()`                                 |
| `diff`               | `state.diff()` / `state.diffContent()`                                     |
| `grep`               | `state.searchText()` / `state.searchFiles()`                               |
| `sed`                | `state.replaceInFile()` / `state.replaceInFiles()`                         |
| `jq`                 | `state.readJson()` / `state.queryJson()` / `state.updateJson()`            |
| `tar`                | `state.createArchive()` / `state.listArchive()` / `state.extractArchive()` |
| `gzip` / `gunzip`    | `state.compressFile()` / `state.decompressFile()`                          |
| `sha256sum` / `file` | `state.hashFile()` / `state.detectFile()`                                  |
| `git`                | `git.*` via `@cloudflare/shell/git`                                        |

## Maybe later

- Stream-oriented transforms inspired by `sort`, `uniq`, `comm`, `cut`, `paste`, `tr`
- Full `rg` CLI parity — file types, ignore controls, multiple roots
- Richer JSON query semantics closer to `jq` filters
- Structured patch helpers covering more of diff / codemod workflows
- A smaller "command" library built on top of `state.*`

## Relationship to other packages

- `@cloudflare/codemode`: executes sandboxed JavaScript that orchestrates tools
- `@cloudflare/shell`: provides filesystem backends and `stateTools()` ToolProvider for codemode
