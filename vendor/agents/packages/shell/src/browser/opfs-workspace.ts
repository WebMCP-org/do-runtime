import type { FileInfo, Workspace, WorkspaceFsLike } from "../filesystem";
import {
  MAX_WORKSPACE_PATH_LENGTH,
  fileSystemError as fsError,
  hasWorkspaceGlobMagic,
  normalizeWorkspacePath as normalizePath,
  workspaceBasename as getBasename,
  workspaceDirname as getParent,
  workspaceGlobPrefix,
  workspaceGlobToRegex,
  workspacePathParts as pathParts
} from "./paths";
import {
  DEFAULT_READ_DIR_LIMIT,
  SYMLINK_MIME_TYPE,
  compareBinaryString,
  compareTypeThenName,
  isMissingEntry as isMissing,
  isTypeMismatch,
  moveNativeFile,
  nativeDirectoryEntries,
  nativeDirectoryInfo,
  nativeFileInfo,
  translateFileSystemError,
  toArrayBuffer,
  type NativeEntry
} from "./native-file-system";
import { MAX_SYMLINK_DEPTH } from "../fs/path-utils";

export interface OpfsWorkspaceOptions {
  /** Dedicated OPFS directory selected by the host. Contains data/ and meta/. */
  root: FileSystemDirectoryHandle;
}

type WorkspaceArgs<K extends keyof Workspace> = Parameters<Workspace[K]>;

/**
 * A recorded symlink, and the only thing a manifest holds. OPFS has no symlink of
 * its own, so the metadata tree is the only place one can exist. Everything else
 * about a symlink — its type, its mime type, its zero size — is the same for every
 * one of them, so only the target and the timestamps are written down.
 */
type SymlinkEntry = {
  target: string;
  createdAt: number;
  updatedAt: number;
};

type DirectoryManifest = {
  entries: Record<string, SymlinkEntry>;
};

type DirectoryState = {
  handle: FileSystemDirectoryHandle;
  manifest: DirectoryManifest;
  /** Canonical serialization of what the metadata file currently holds, so a
   * write that changes no symlink can skip touching it. */
  persistedJson: string;
};

type WorkspaceRoots = {
  data: FileSystemDirectoryHandle;
  meta: FileSystemDirectoryHandle;
};

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
/** Arbitrary, and only a guard against a pathological path. */
const MAX_MKDIR_DEPTH = 100;
const MANIFEST_FILE = "entries.json";
/** The files themselves. Observers watch this tree, so manifest and SQLite
 * traffic never surfaces as a workspace change. */
const WORKSPACE_DATA_DIRECTORY = "data";
/** The symlink manifests, and nothing else. */
const WORKSPACE_METADATA_DIRECTORY = "meta";

/** Every key a manifest record may carry, tied to the record it describes so
 * adding a field to SymlinkEntry cannot leave the validator rejecting what
 * `symlink` now writes. */
const MANIFEST_ENTRY_KEYS = [
  "target",
  "createdAt",
  "updatedAt"
] as const satisfies readonly (keyof SymlinkEntry)[];

/** Derived rather than written out, because this exact string is what decides a
 * metadata file gets deleted instead of written — see `replaceManifestFile`. */
const EMPTY_MANIFEST_JSON = canonicalManifestJson(entryDictionary());

/**
 * Native OPFS WorkspaceFsLike. Files live in data/; meta/ records only symlinks.
 * Pass a dedicated OPFS directory; the host owns its identity and lifecycle.
 * Web Locks coordinate all instances/workers opening the same directory.
 * File contents commit when native writable streams close; failed writes abort.
 */
export class OpfsWorkspace implements WorkspaceFsLike {
  private readonly root: FileSystemDirectoryHandle;
  private rootsPromise: Promise<WorkspaceRoots> | undefined;
  private lockNamePromise: Promise<string> | undefined;

  constructor({ root }: OpfsWorkspaceOptions) {
    this.root = root;
  }

  /** FileSystemObservers should watch this tree, excluding symlink manifests. */
  async getDataDirectory(): Promise<FileSystemDirectoryHandle> {
    return (await this.roots()).data;
  }

  private async lockName(): Promise<string> {
    return (this.lockNamePromise ??= (async () => {
      const storage = await navigator.storage.getDirectory();
      const path = await storage.resolve(this.root);
      if (path === null)
        throw fsError("ENOTSUP", "workspace root must be inside OPFS");
      return `shell-opfs:${JSON.stringify(path)}`;
    })().catch((error: unknown) => {
      this.lockNamePromise = undefined;
      throw error;
    }));
  }

  async readFile(path: string): Promise<string | null> {
    const bytes = await this.readFileBytes(path);
    return bytes === null ? null : TEXT_DECODER.decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () => {
      if (normalized === "/") {
        throw fsError("EISDIR", `${path} is a directory`);
      }
      const resolved = await this.resolveSymlink(normalized);
      if (resolved === "/") {
        throw fsError("EISDIR", `${path} is a directory`);
      }
      return this.withEntryRead(resolved, async (native) => {
        if (!native) return null;
        if (native.kind !== "file")
          throw fsError("EISDIR", `${path} is a directory`);
        return new Uint8Array(await (await native.getFile()).arrayBuffer());
      });
    });
  }

  async getNativeFile(path: string): Promise<File | null> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () => {
      if (normalized === "/") {
        throw fsError("EISDIR", `${path} is a directory`);
      }
      const resolved = await this.resolveSymlink(normalized);
      if (resolved === "/") {
        throw fsError("EISDIR", `${path} is a directory`);
      }
      return this.withEntryRead(resolved, async (native) => {
        if (!native) return null;
        if (native.kind !== "file")
          throw fsError("EISDIR", `${path} is a directory`);
        return native.getFile();
      });
    });
  }

  // A stored file's mime type is its name — see `nativeFileInfo` — so every write
  // here accepts a declared type and discards it.
  async writeFile(
    path: string,
    content: string,
    _mimeType?: string
  ): Promise<void> {
    await this.writeBytes(path, TEXT_ENCODER.encode(content));
  }

  async writeFileBytes(
    path: string,
    content: Uint8Array | ArrayBuffer,
    _mimeType?: string
  ): Promise<void> {
    await this.writeBytes(path, normalizeBytes(content));
  }

  async appendFile(
    path: string,
    content: string,
    _mimeType?: string
  ): Promise<void> {
    await this.appendFileBytes(path, TEXT_ENCODER.encode(content));
  }

  async appendFileBytes(
    path: string,
    content: Uint8Array | ArrayBuffer,
    _mimeType?: string
  ): Promise<void> {
    const bytes = normalizeBytes(content);
    await this.withWritableParent(path, async (state, resolved) => {
      await appendBytes(
        await openFileForWrite(state, getBasename(resolved), resolved),
        bytes,
        resolved
      );
    });
  }

  async writeStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.withWritableParent(path, async (state, resolved) => {
      const handle = await openFileForWrite(
        state,
        getBasename(resolved),
        resolved
      );
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await handle.createWritable();
        await stream.pipeTo(writable, { signal });
      } catch (error) {
        await writable?.abort(error).catch(() => undefined);
        throw translateFileSystemError(error, resolved);
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () =>
      normalized === "/"
        ? true
        : (await this.lstatWithinTree(normalized)) !== null
    );
  }

  async stat(path: string): Promise<FileInfo | null> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () =>
      this.lstatResolvedWithinTree(await this.resolveSymlink(normalized))
    );
  }

  async lstat(path: string): Promise<FileInfo | null> {
    const normalized = normalizePath(path);
    return this.withSharedTree(() => this.lstatWithinTree(normalized));
  }

  async mkdir(
    path: string,
    options?: WorkspaceArgs<"mkdir">[1]
  ): Promise<void> {
    const normalized = normalizePath(path);
    await this.withExclusiveTree(async () => {
      const resolved = await this.resolveIntermediateSymlinks(normalized);
      await this.mkdirUnlocked(resolved, options?.recursive ?? false);
    });
  }

  async readDir(
    path = "/",
    options?: WorkspaceArgs<"readDir">[1]
  ): Promise<FileInfo[]> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () => {
      const resolved = await this.resolveSymlink(normalized);
      const stat = await this.lstatResolvedWithinTree(resolved);
      if (!stat || stat.type !== "directory") return [];
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = Math.max(0, options?.limit ?? DEFAULT_READ_DIR_LIMIT);
      return this.withDirectoryRead(resolved, (state) =>
        this.describePage(resolved, state, offset, limit)
      );
    });
  }

  async rm(path: string, options?: WorkspaceArgs<"rm">[1]): Promise<void> {
    const normalized = normalizePath(path);
    await this.withExclusiveTree(async () => {
      const resolved = await this.resolveIntermediateSymlinks(normalized);
      if (resolved === "/") {
        throw fsError("EPERM", "cannot remove root directory");
      }
      const stat = await this.lstatUnlocked(resolved);
      if (!stat) {
        if (options?.force) return;
        throw fsError("ENOENT", `no such file or directory: ${path}`);
      }
      if (stat.type !== "directory") {
        await this.removeLeafUnlocked(resolved);
        return;
      }
      // A recursive removal hands the whole subtree to OPFS and never needs to
      // know what is in it.
      if (
        !options?.recursive &&
        (await this.readDirectoryUnlocked(resolved)).length > 0
      ) {
        throw fsError("ENOTEMPTY", `directory not empty: ${path}`);
      }
      await this.removeDirectoryTreeUnlocked(resolved);
    });
  }

  async cp(
    source: string,
    destination: string,
    options?: WorkspaceArgs<"cp">[2]
  ): Promise<void> {
    const requestedSource = normalizePath(source);
    const requestedDestination = normalizePath(destination);
    await this.withExclusiveTree(async () => {
      const sourcePath =
        await this.resolveIntermediateSymlinks(requestedSource);
      const destinationPath =
        await this.resolveIntermediateSymlinks(requestedDestination);
      if (sourcePath === "/") {
        throw fsError("EPERM", "cannot copy root directory");
      }
      const stat = await this.lstatUnlocked(sourcePath);
      if (!stat) {
        throw fsError("ENOENT", `no such file or directory: ${source}`);
      }
      if (sourcePath === destinationPath) return;
      if (stat.type !== "directory") {
        try {
          await this.copyEntryUnlocked(sourcePath, destinationPath);
        } catch (error) {
          throw partialCopyError(error, source, destination);
        }
        return;
      }
      if (!options?.recursive) {
        throw fsError(
          "EISDIR",
          `cannot copy directory without recursive: ${source}`
        );
      }
      assertNoDirectoryOverlap(sourcePath, destinationPath, "copy");
      if (destinationPath === "/") {
        throw fsError("EPERM", "cannot overwrite root directory");
      }
      try {
        await this.copyEntryUnlocked(sourcePath, destinationPath);
      } catch (error) {
        throw partialCopyError(error, source, destination);
      }
    });
  }

  async mv(
    source: string,
    destination: string,
    options?: WorkspaceArgs<"mv">[2]
  ): Promise<void> {
    const requestedSource = normalizePath(source);
    const requestedDestination = normalizePath(destination);
    await this.withExclusiveTree(async () => {
      const sourcePath =
        await this.resolveIntermediateSymlinks(requestedSource);
      const destinationPath =
        await this.resolveIntermediateSymlinks(requestedDestination);
      if (sourcePath === "/") {
        throw fsError("EPERM", "cannot move root directory");
      }
      const stat = await this.lstatUnlocked(sourcePath);
      if (!stat) {
        throw fsError("ENOENT", `no such file or directory: ${source}`);
      }
      if (sourcePath === destinationPath) return;
      if (stat.type !== "directory") {
        const destinationStat = await this.lstatUnlocked(destinationPath);
        if (destinationStat?.type === "directory") {
          throw fsError("EISDIR", `cannot overwrite directory: ${destination}`);
        }
        // OPFS owns a native atomic replacement primitive for regular files.
        // Keep symlinks on the manifest copy/delete path: they have no native
        // handle to move, and a final symlink at the destination is manifest
        // state rather than a file that the platform can replace atomically.
        if (stat.type === "file" && destinationStat?.type !== "symlink") {
          await this.moveFileUnlocked(sourcePath, destinationPath);
          return;
        }
        if (destinationStat) await this.removeLeafUnlocked(destinationPath);
        try {
          await this.copyEntryUnlocked(sourcePath, destinationPath);
        } catch (error) {
          throw partialCopyError(error, source, destination);
        }
        await this.preserveMovedSymlinkTimestamps(destinationPath, stat);
        try {
          await this.removeLeafUnlocked(sourcePath);
        } catch (error) {
          throw moveSourceRemovalError(error, source, destination);
        }
        return;
      }
      if (!(options?.recursive ?? true)) {
        throw fsError(
          "EISDIR",
          `cannot move directory without recursive: ${source}`
        );
      }
      assertNoDirectoryOverlap(sourcePath, destinationPath, "move");
      if (destinationPath === "/") {
        throw fsError("EPERM", "cannot overwrite root directory");
      }
      try {
        await this.copyEntryUnlocked(sourcePath, destinationPath);
      } catch (error) {
        throw partialCopyError(error, source, destination);
      }
      try {
        await this.removeDirectoryTreeUnlocked(sourcePath);
      } catch (error) {
        throw moveSourceRemovalError(error, source, destination);
      }
    });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (!target || target.trim().length === 0) {
      throw fsError("EINVAL", "symlink target must not be empty");
    }
    if (target.length > MAX_WORKSPACE_PATH_LENGTH) {
      throw fsError(
        "ENAMETOOLONG",
        `symlink target exceeds ${MAX_WORKSPACE_PATH_LENGTH} characters`
      );
    }
    const normalized = normalizePath(linkPath);
    await this.withExclusiveTree(async () => {
      const resolved = await this.resolveIntermediateSymlinks(normalized);
      if (resolved === "/") {
        throw fsError("EPERM", "cannot create symlink at root");
      }
      await this.createDirectoryChainUnlocked(getParent(resolved));
      const existing = await this.lstatUnlocked(resolved);
      if (existing) {
        throw fsError("EEXIST", `path already exists: ${linkPath}`);
      }
      const parentPath = getParent(resolved);
      const state = await this.openDirectoryState(parentPath);
      if (!state)
        throw fsError("ENOENT", `parent directory not found: ${parentPath}`);
      const now = Date.now();
      state.manifest.entries[getBasename(resolved)] = {
        target,
        createdAt: now,
        updatedAt: now
      };
      await this.saveManifestIfChanged(parentPath, state);
    });
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    return this.withSharedTree(async () => {
      // One reader for both steps, so resolving the path and then reading the
      // link at the end of it share a single descent of the metadata tree.
      const readSymlink = this.createSymlinkReader();
      const resolved = await resolvePathSymlinks(
        normalized,
        false,
        readSymlink
      );
      const link = await readSymlink(resolved);
      if (link) return link.target;
      if (await this.lstatResolvedWithinTree(resolved)) {
        throw fsError("EINVAL", `not a symlink: ${path}`);
      }
      throw fsError("ENOENT", `no such file or directory: ${path}`);
    });
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    const normalized = normalizePath(pattern);
    return this.withSharedTree(async () => {
      const resolvedPattern = await this.resolveGlobPattern(normalized);
      const matcher = workspaceGlobToRegex(resolvedPattern);
      // Nothing outside the pattern's literal prefix can match the regex, so the
      // walk is bounded to that subtree — and reading a directory costs a lock, a
      // manifest and an OPFS enumeration each.
      const all = await this.collectAllEntriesWithinTree(
        workspaceGlobPrefix(resolvedPattern)
      );
      return all
        .filter((entry) => matcher.test(entry.path))
        .sort((left, right) => compareBinaryString(left.path, right.path));
    });
  }

  private async resolveGlobPattern(pattern: string): Promise<string> {
    if (!hasWorkspaceGlobMagic(pattern)) return this.resolveSymlink(pattern);
    const prefix = workspaceGlobPrefix(pattern);
    if (prefix === "/") return pattern;
    const resolvedPrefix = await this.resolveSymlink(prefix);
    return normalizePath(`${resolvedPrefix}${pattern.slice(prefix.length)}`);
  }

  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.withSharedTree(async () => {
      const entries = await this.collectAllEntriesWithinTree();
      return {
        fileCount: entries.filter((entry) => entry.type === "file").length,
        directoryCount: entries.filter((entry) => entry.type === "directory")
          .length,
        totalBytes: entries.reduce(
          (total, entry) => total + (entry.type === "file" ? entry.size : 0),
          0
        ),
        r2FileCount: 0
      };
    });
  }

  private async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.withWritableParent(path, async (state, resolved) => {
      await replaceFile(
        await openFileForWrite(state, getBasename(resolved), resolved),
        bytes,
        resolved
      );
    });
  }

  /** Two passes at most: the first may find the parent missing, the second runs
   * after it has been created. A third means something else is removing it. */
  private static readonly MAX_WRITE_PARENT_ATTEMPTS = 2;

  /**
   * Runs a write inside the locked directory that holds it, creating that
   * directory first if it is not there yet. The lock's own inspection is the only
   * thing that establishes the parent exists.
   */
  private async withWritableParent(
    path: string,
    operation: (state: DirectoryState, resolved: string) => Promise<void>
  ): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "/") {
      throw fsError("EISDIR", "cannot write to root directory");
    }
    for (
      let attempt = 0;
      attempt < OpfsWorkspace.MAX_WRITE_PARENT_ATTEMPTS;
      attempt += 1
    ) {
      const written = await this.withSharedTree(async () => {
        const resolved = await this.resolveSymlink(normalized);
        if (resolved === "/") {
          throw fsError("EISDIR", `${path} is a directory`);
        }
        const parentPath = getParent(resolved);
        return this.withDirectoryLock(parentPath, "exclusive", async () => {
          const state = await this.openDirectoryState(parentPath);
          if (!state) return false;
          await operation(state, resolved);
          return true;
        });
      });
      if (written) return;
      // The parent is missing, or is not a directory at all. Creating it either
      // succeeds or reports ENOTDIR.
      await this.createWriteParent(normalized);
    }
    throw fsError(
      "ENOENT",
      `parent directory kept disappearing while writing ${path}`
    );
  }

  private async createWriteParent(path: string): Promise<void> {
    await this.withExclusiveTree(async () => {
      const resolved = await this.resolveSymlink(path);
      await this.createDirectoryChainUnlocked(getParent(resolved));
    });
  }

  private async resolveSymlink(path: string): Promise<string> {
    return resolvePathSymlinks(path, true, this.createSymlinkReader());
  }

  private async resolveIntermediateSymlinks(path: string): Promise<string> {
    return resolvePathSymlinks(path, false, this.createSymlinkReader());
  }

  /**
   * A reader for the symlinks along one path resolution.
   *
   * Every answer is in the metadata tree, never the data tree, so one descent is
   * shared between the components and an absent segment answers for everything
   * below it at once — which, given that a directory holding no symlink has no
   * metadata directory, costs a path with no symlink on it a single probe rather
   * than one per component.
   *
   * No directory lock is taken: manifests are replaced whole through an atomic
   * swap, and the tree lock the caller already holds serializes symlink changes
   * against readers, so a half-written file cannot be observed.
   */
  private createSymlinkReader(): (
    path: string
  ) => Promise<SymlinkEntry | undefined> {
    const descents = new Map<
      string,
      Promise<FileSystemDirectoryHandle | null>
    >();
    const descend = (
      path: string
    ): Promise<FileSystemDirectoryHandle | null> => {
      let pending = descents.get(path);
      if (!pending) {
        pending =
          path === "/"
            ? this.roots().then((roots) => roots.meta)
            : descend(getParent(path)).then((parent) =>
                parent ? openChildDirectory(parent, getBasename(path)) : null
              );
        descents.set(path, pending);
      }
      return pending;
    };
    return async (path) => {
      const parentPath = getParent(path);
      const loaded = await this.readManifestIn(
        await descend(parentPath),
        parentPath
      );
      return loaded.manifest.entries[getBasename(path)];
    };
  }

  private async lstatWithinTree(path: string): Promise<FileInfo | null> {
    return this.lstatResolvedWithinTree(
      await this.resolveIntermediateSymlinks(path)
    );
  }

  private async lstatResolvedWithinTree(
    path: string
  ): Promise<FileInfo | null> {
    const normalized = normalizePath(path);
    if (normalized === "/") return nativeDirectoryInfo("/");
    const parentPath = getParent(normalized);
    const name = getBasename(normalized);
    try {
      return await this.withDirectoryRead(parentPath, (state) =>
        this.describeNamedChild(normalized, state, name)
      );
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async lstatUnlocked(path: string): Promise<FileInfo | null> {
    const normalized = normalizePath(path);
    if (normalized === "/") return nativeDirectoryInfo("/");
    const state = await this.openDirectoryState(getParent(normalized));
    if (!state) return null;
    return this.describeNamedChild(normalized, state, getBasename(normalized));
  }

  /**
   * Reads one already-resolved entry, handing the operation the native handle
   * rather than a description of it. Reading a file needs the handle and nothing
   * else, and describing an entry costs OPFS a `File` snapshot of it, so a read
   * that described what it was about to open paid for two.
   *
   * The operation runs while the directory lock is held and must not raise ENOENT
   * of its own: ENOENT here means the parent directory is gone, and is answered by
   * running the operation once more with no entry.
   */
  private async withEntryRead<T>(
    path: string,
    operation: (native: NativeEntry | undefined) => Promise<T> | T
  ): Promise<T> {
    const normalized = normalizePath(path);
    const name = getBasename(normalized);
    try {
      return await this.withDirectoryRead(
        getParent(normalized),
        async (state) => {
          const native = await openChildEntry(state.handle, name);
          // Symlinks were followed before this point, so one recorded here is a
          // manifest describing something the path can no longer mean.
          if (state.manifest.entries[name]) {
            throw fsError(
              "EIO",
              `corrupt manifest: ${normalized} is recorded as a symlink`
            );
          }
          return operation(native);
        }
      );
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return operation(undefined);
      throw error;
    }
  }

  /** Describes one child by name, looking its handle up. A caller that already
   * holds the listing uses `describeListedChild` instead. */
  private async describeNamedChild(
    path: string,
    state: DirectoryState,
    name: string
  ): Promise<FileInfo | null> {
    return describeEntry(
      path,
      state.manifest.entries[name],
      await openChildEntry(state.handle, name)
    );
  }

  private async describeAll(
    path: string,
    state: DirectoryState
  ): Promise<FileInfo[]> {
    const children = await listChildren(state.handle);
    return Promise.all(
      childNames(state, children).map((name) =>
        this.describeListedChild(path, state, name, children.get(name))
      )
    );
  }

  /**
   * Describes one page of a directory, in the order the whole directory sorts in.
   * A name and its kind place an entry in that order and the listing carries
   * both, so only the entries the page returns are described.
   */
  private async describePage(
    path: string,
    state: DirectoryState,
    offset: number,
    limit: number
  ): Promise<FileInfo[]> {
    const children = await listChildren(state.handle);
    const ordered = childNames(state, children)
      .map((name) => ({
        name,
        type: entryType(state.manifest.entries[name], children.get(name))
      }))
      .sort(compareTypeThenName);
    return Promise.all(
      ordered
        .slice(offset, offset + limit)
        .map(({ name }) =>
          this.describeListedChild(path, state, name, children.get(name))
        )
    );
  }

  /** Describes a child whose native handle the caller already holds from its
   * listing, so describing it costs no second lookup. */
  private async describeListedChild(
    path: string,
    state: DirectoryState,
    name: string,
    native: NativeEntry | undefined
  ): Promise<FileInfo> {
    const child = childPath(path, name);
    const info = await describeEntry(
      child,
      state.manifest.entries[name],
      native
    );
    if (!info)
      throw fsError("EIO", `directory entry vanished while listing: ${child}`);
    return info;
  }

  private async withDirectoryRead<T>(
    path: string,
    operation: (state: DirectoryState) => Promise<T> | T
  ): Promise<T> {
    return this.withDirectoryLock(path, "shared", async () => {
      const state = await this.openDirectoryState(path);
      if (!state) {
        throw fsError("ENOENT", `no such directory: ${path}`);
      }
      return operation(state);
    });
  }

  private async withDirectoryLock<T>(
    path: string,
    mode: LockMode,
    operation: () => Promise<T>
  ): Promise<T> {
    return navigator.locks.request(
      `${await this.lockName()}:dir:${normalizePath(path)}`,
      { mode },
      operation
    );
  }

  /**
   * Opens a directory: its OPFS handle, plus whatever symlinks are recorded
   * beneath it. Nothing here can disagree with OPFS, because OPFS is the only
   * record of everything it can store — so there is nothing to reconcile.
   */
  private async openDirectoryState(
    path: string
  ): Promise<DirectoryState | null> {
    const handle = await this.openDataDirectory(path);
    if (!handle) return null;
    const loaded = await this.readManifestIn(
      await this.openMetadataDirectory(path),
      path
    );
    return {
      handle,
      manifest: loaded.manifest,
      persistedJson: loaded.serialized
    };
  }

  private async readManifestIn(
    directory: FileSystemDirectoryHandle | null,
    path: string
  ): Promise<{ manifest: DirectoryManifest; serialized: string }> {
    // No metadata directory means no symlinks — the invariant in this class's
    // documentation is what makes that a sound answer rather than a guess.
    const absent = {
      manifest: { entries: entryDictionary() },
      serialized: EMPTY_MANIFEST_JSON
    };
    if (!directory) return absent;
    let handle: FileSystemFileHandle;
    try {
      handle = await directory.getFileHandle(MANIFEST_FILE);
    } catch (error) {
      if (isMissing(error)) return absent;
      throw error;
    }
    // Only the parse is corruption. A read that fails is a read that failed, and
    // saying "corrupt manifest" would send the agent after the wrong problem.
    const text = await (await handle.getFile()).text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw fsError(
        "EIO",
        `corrupt metadata manifest for ${path}: ${errorMessage(error)}`
      );
    }
    // Keep strict: symlink metadata and file contents are separate writes;
    // treating a torn manifest as absent would silently lose filesystem links.
    const manifest = validateManifest(value, path);
    return { manifest, serialized: canonicalManifestJson(manifest.entries) };
  }

  private async saveManifestIfChanged(
    path: string,
    state: DirectoryState
  ): Promise<void> {
    const serialized = canonicalManifestJson(state.manifest.entries);
    if (serialized === state.persistedJson) return;
    await this.replaceManifestFile(path, serialized);
    state.persistedJson = serialized;
  }

  private async replaceManifestFile(
    path: string,
    serialized: string
  ): Promise<void> {
    if (serialized === EMPTY_MANIFEST_JSON) {
      // Not an optimization: an empty manifest and its directory have to go, or
      // the no-symlink-no-metadata-directory invariant is broken and every later
      // resolution steps through the shell that was left behind.
      const directory = await this.openMetadataDirectory(path);
      if (!directory) return;
      await removeEntryIfPresent(directory, MANIFEST_FILE, false);
      await this.pruneEmptyMetadataDirectories(path);
      return;
    }
    const directory = await this.createMetadataDirectory(path);
    let handle: FileSystemFileHandle;
    try {
      handle = await directory.getFileHandle(MANIFEST_FILE, { create: true });
    } catch (error) {
      throw translateFileSystemError(error, path);
    }
    await replaceFile(handle, TEXT_ENCODER.encode(serialized), path);
  }

  private async mkdirUnlocked(path: string, recursive: boolean): Promise<void> {
    if (path === "/") return;
    const existing = await this.lstatUnlocked(path);
    if (existing) {
      if (existing.type === "directory" && recursive) return;
      throw fsError(
        "EEXIST",
        existing.type === "directory"
          ? `directory already exists: ${path}`
          : `path exists as a file: ${path}`
      );
    }
    if (recursive) {
      await this.createDirectoryChainUnlocked(path);
      return;
    }
    const parentPath = getParent(path);
    const parent = await this.lstatUnlocked(parentPath);
    if (!parent) {
      throw fsError("ENOENT", `parent directory not found: ${parentPath}`);
    }
    if (parent.type !== "directory") {
      throw fsError("ENOTDIR", `parent is not a directory: ${parentPath}`);
    }
    const state = await this.openDirectoryState(parentPath);
    if (!state)
      throw fsError("ENOENT", `parent directory not found: ${parentPath}`);
    // The native directory is the whole fact; its metadata directory is created
    // on demand by the first symlink beneath it.
    await state.handle.getDirectoryHandle(getBasename(path), { create: true });
  }

  /** Creates a directory and every missing directory above it in one descent:
   * OPFS creates a directory that already exists by handing back the one that is
   * there, so the chain needs no per-level existence check. */
  private async createDirectoryChainUnlocked(path: string): Promise<void> {
    if (!path || path === "/") return;
    const parts = pathParts(path);
    if (parts.length > MAX_MKDIR_DEPTH) {
      throw fsError(
        "ELOOP",
        `mkdir recursion too deep (max ${MAX_MKDIR_DEPTH} levels)`
      );
    }
    let directory = (await this.roots()).data;
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      try {
        directory = await directory.getDirectoryHandle(part, { create: true });
      } catch (error) {
        // `current` exists only to name the level that stopped the descent.
        if (isTypeMismatch(error)) {
          throw fsError("ENOTDIR", `${current} is not a directory`);
        }
        throw translateFileSystemError(error, current);
      }
    }
  }

  private async readDirectoryUnlocked(path: string): Promise<FileInfo[]> {
    const state = await this.openDirectoryState(path);
    if (!state) return [];
    return this.describeAll(path, state);
  }

  private async copyEntryUnlocked(
    source: string,
    destination: string
  ): Promise<void> {
    const sourceStat = await this.lstatUnlocked(source);
    if (!sourceStat) {
      throw fsError("ENOENT", `no such file or directory: ${source}`);
    }
    if (sourceStat.type === "symlink") {
      const destinationStat = await this.lstatUnlocked(destination);
      if (destinationStat) {
        // A same-target symlink is tolerated so retrying an interrupted
        // copy/move can run to completion.
        if (
          destinationStat.type === "symlink" &&
          destinationStat.target === sourceStat.target
        ) {
          return;
        }
        throw fsError("EEXIST", `path already exists: ${destination}`);
      }
      await this.createSymlinkUnlocked(sourceStat.target!, destination);
      return;
    }
    if (sourceStat.type === "file") {
      const sourceParent = await this.openDirectoryState(getParent(source));
      const sourceHandle =
        sourceParent &&
        (await openChildEntry(sourceParent.handle, getBasename(source)));
      if (!sourceHandle || sourceHandle.kind !== "file") {
        throw fsError("EIO", `missing native source file: ${source}`);
      }
      await this.writeBytesUnlocked(
        destination,
        new Uint8Array(await (await sourceHandle.getFile()).arrayBuffer())
      );
      return;
    }

    const destinationStat = await this.lstatUnlocked(destination);
    if (destinationStat && destinationStat.type !== "directory") {
      throw fsError("EEXIST", `path already exists: ${destination}`);
    }
    if (!destinationStat) await this.mkdirUnlocked(destination, true);
    const children = (await this.readDirectoryUnlocked(source)).sort(
      compareTypeThenName
    );
    for (const child of children) {
      await this.copyEntryUnlocked(
        child.path,
        childPath(destination, child.name)
      );
    }
  }

  private async writeBytesUnlocked(
    path: string,
    bytes: Uint8Array
  ): Promise<void> {
    const resolved = await this.resolveSymlink(path);
    if (resolved === "/")
      throw fsError("EISDIR", "cannot write to root directory");
    const parentPath = getParent(resolved);
    await this.createDirectoryChainUnlocked(parentPath);
    const state = await this.openDirectoryState(parentPath);
    if (!state)
      throw fsError("ENOENT", `parent directory not found: ${parentPath}`);
    await replaceFile(
      await openFileForWrite(state, getBasename(resolved), resolved),
      bytes,
      resolved
    );
  }

  private async moveFileUnlocked(
    source: string,
    destination: string
  ): Promise<void> {
    const sourceParent = await this.openDirectoryState(getParent(source));
    const sourceHandle =
      sourceParent &&
      (await openChildEntry(sourceParent.handle, getBasename(source)));
    if (!sourceHandle || sourceHandle.kind !== "file") {
      throw fsError("EIO", `missing native source file: ${source}`);
    }
    const destinationParentPath = getParent(destination);
    await this.createDirectoryChainUnlocked(destinationParentPath);
    const destinationParent = await this.openDirectoryState(
      destinationParentPath
    );
    if (!destinationParent) {
      throw fsError(
        "ENOENT",
        `parent directory not found: ${destinationParentPath}`
      );
    }
    await moveNativeFile(
      sourceHandle,
      destinationParent.handle,
      getBasename(destination),
      source,
      destination
    );
  }

  private async createSymlinkUnlocked(
    target: string,
    linkPath: string
  ): Promise<void> {
    const parentPath = getParent(linkPath);
    await this.createDirectoryChainUnlocked(parentPath);
    const state = await this.openDirectoryState(parentPath);
    if (!state)
      throw fsError("ENOENT", `parent directory not found: ${parentPath}`);
    const now = Date.now();
    state.manifest.entries[getBasename(linkPath)] = {
      target,
      createdAt: now,
      updatedAt: now
    };
    await this.saveManifestIfChanged(parentPath, state);
  }

  /** A moved symlink carries its source's creation time across, because the
   * manifest is the only place a symlink's timestamps live. A moved file's come
   * from the copy OPFS just made. */
  private async preserveMovedSymlinkTimestamps(
    path: string,
    source: FileInfo
  ): Promise<void> {
    if (source.type !== "symlink") return;
    const parentPath = getParent(path);
    const state = await this.openDirectoryState(parentPath);
    const entry = state?.manifest.entries[getBasename(path)];
    // The copy that ran a moment ago, under this same lock, wrote this record.
    if (!state || !entry) {
      throw fsError(
        "EIO",
        `moved symlink is missing from ${parentPath} after the copy`
      );
    }
    entry.createdAt = source.createdAt;
    entry.updatedAt = Date.now();
    await this.saveManifestIfChanged(parentPath, state);
  }

  /** Every caller has already established, under this lock, that the entry is not
   * a directory, so this costs one removal and no lookup of its own. */
  private async removeLeafUnlocked(path: string): Promise<void> {
    const parentPath = getParent(path);
    const state = await this.openDirectoryState(parentPath);
    if (!state) return;
    const name = getBasename(path);
    await removeEntryIfPresent(state.handle, name, false);
    delete state.manifest.entries[name];
    await this.saveManifestIfChanged(parentPath, state);
  }

  private async removeDirectoryTreeUnlocked(path: string): Promise<void> {
    const parentPath = getParent(path);
    const parent = await this.openDirectoryState(parentPath);
    if (parent) {
      const name = getBasename(path);
      await removeEntryIfPresent(parent.handle, name, true);
      delete parent.manifest.entries[name];
      await this.saveManifestIfChanged(parentPath, parent);
    }
    await this.removeMetadataDirectory(path);
  }

  private async removeMetadataDirectory(path: string): Promise<void> {
    if (path === "/") return;
    const parent = await this.openMetadataDirectory(getParent(path));
    if (!parent) return;
    await removeEntryIfPresent(parent, getBasename(path), true);
    await this.pruneEmptyMetadataDirectories(getParent(path));
  }

  /**
   * Removes every metadata directory that holds nothing, upward from a path, so
   * removing the last symlink restores this class's invariant rather than leaving
   * an empty shell for every later resolution to step through. Manifests are only
   * written under the exclusive tree lock, so nothing can be creating a sibling
   * underneath what this prunes.
   */
  private async pruneEmptyMetadataDirectories(path: string): Promise<void> {
    for (let current = path; current !== "/"; current = getParent(current)) {
      const parent = await this.openMetadataDirectory(getParent(current));
      if (!parent) return;
      const child = await openChildDirectory(parent, getBasename(current));
      if (!child || !(await isEmptyDirectory(child))) return;
      await removeEntryIfPresent(parent, getBasename(current), false);
    }
  }

  private async collectAllEntriesWithinTree(root = "/"): Promise<FileInfo[]> {
    const start =
      root === "/"
        ? nativeDirectoryInfo("/")
        : await this.lstatWithinTree(root);
    if (!start) return [];
    const output: FileInfo[] = [start];
    const visit = async (path: string): Promise<void> => {
      const entries = await this.withDirectoryRead(path, (state) =>
        this.describeAll(path, state)
      );
      entries.sort((left, right) => compareBinaryString(left.path, right.path));
      for (const entry of entries) {
        output.push(entry);
        if (entry.type === "directory") await visit(entry.path);
      }
    };
    if (start.type === "directory") await visit(root);
    return output;
  }

  /** Opened once per instance. A failure clears the memo rather than poisoning
   * every later call with the promise that rejected. */
  private async roots(): Promise<WorkspaceRoots> {
    return (this.rootsPromise ??= this.initializeRoots().catch(
      (error: unknown) => {
        this.rootsPromise = undefined;
        throw error;
      }
    ));
  }

  private async initializeRoots(): Promise<WorkspaceRoots> {
    if (!navigator.storage?.getDirectory) {
      throw fsError("ENOTSUP", "OPFS is required for the direct workspace");
    }
    const root = this.root;
    const [data, meta] = await Promise.all([
      root.getDirectoryHandle(WORKSPACE_DATA_DIRECTORY, { create: true }),
      root.getDirectoryHandle(WORKSPACE_METADATA_DIRECTORY, { create: true })
    ]);
    return { data, meta };
  }

  private async openDataDirectory(
    path: string
  ): Promise<FileSystemDirectoryHandle | null> {
    const { data } = await this.roots();
    return openDirectoryPath(data, pathParts(path));
  }

  private async openMetadataDirectory(
    path: string
  ): Promise<FileSystemDirectoryHandle | null> {
    const { meta } = await this.roots();
    return openDirectoryPath(meta, pathParts(path));
  }

  private async createMetadataDirectory(
    path: string
  ): Promise<FileSystemDirectoryHandle> {
    const { meta } = await this.roots();
    return createDirectoryPath(meta, pathParts(path), path);
  }

  private async withSharedTree<T>(operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(
      `${await this.lockName()}:tree`,
      { mode: "shared" },
      operation
    );
  }

  private async withExclusiveTree<T>(operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(
      `${await this.lockName()}:tree`,
      { mode: "exclusive" },
      operation
    );
  }
}

/** Prototype-less, so a name in a hostile manifest cannot reach Object.prototype. */
function entryDictionary(): Record<string, SymlinkEntry> {
  const entries: Record<string, SymlinkEntry> = Object.create(null);
  return entries;
}

/** Name-ordered, so a directory whose symlinks did not change serializes to a
 * byte-identical string and its write is skipped. */
function canonicalManifestJson(source: Record<string, SymlinkEntry>): string {
  const entries = entryDictionary();
  for (const name of Object.keys(source).sort(compareBinaryString)) {
    entries[name] = source[name]!;
  }
  return JSON.stringify({ entries });
}

function validateManifest(value: unknown, path: string): DirectoryManifest {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "entries") ||
    !("entries" in value)
  ) {
    throw fsError("EIO", `corrupt metadata manifest for ${path}`);
  }
  if (!isObject(value.entries)) {
    throw fsError("EIO", `corrupt metadata manifest entries for ${path}`);
  }
  const entries = entryDictionary();
  for (const [name, candidate] of Object.entries(value.entries)) {
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      !isSymlinkEntry(candidate)
    ) {
      throw fsError(
        "EIO",
        `corrupt metadata manifest entry ${name} in ${path}`
      );
    }
    if (
      Object.keys(candidate).some(
        (key) => !MANIFEST_ENTRY_KEYS.some((allowed) => allowed === key)
      ) ||
      candidate.target.trim().length === 0 ||
      candidate.target.length > MAX_WORKSPACE_PATH_LENGTH
    ) {
      throw fsError(
        "EIO",
        `corrupt metadata manifest record for ${childPath(path, name)}`
      );
    }
    entries[name] = {
      target: candidate.target,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt
    };
  }
  return { entries };
}

/**
 * Describes an entry from the two records that can describe it: a manifest's
 * symlink, or OPFS's own handle. This precedence is the whole relationship
 * between the two trees, so it is stated once.
 *
 * A recorded symlink and a native entry cannot share a name — the manifest would
 * be describing something OPFS also describes, and nothing could say which of the
 * two the path meant.
 */
async function describeEntry(
  path: string,
  link: SymlinkEntry | undefined,
  native: NativeEntry | undefined
): Promise<FileInfo | null> {
  if (link) {
    if (native) {
      throw fsError(
        "EIO",
        `corrupt manifest: symlink ${path} collides with a native entry`
      );
    }
    return {
      path,
      name: getBasename(path),
      type: "symlink",
      mimeType: SYMLINK_MIME_TYPE,
      size: 0,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      target: link.target
    };
  }
  if (!native) return null;
  if (native.kind === "directory") return nativeDirectoryInfo(path);
  return nativeFileInfo(path, await native.getFile());
}

/** Where an entry sorts, without describing it: the manifest and the listing
 * between them already say which of the three kinds a name is. */
function entryType(
  link: SymlinkEntry | undefined,
  native: NativeEntry | undefined
): FileInfo["type"] {
  if (link) return "symlink";
  return native?.kind === "directory" ? "directory" : "file";
}

async function openChildDirectory(
  directory: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await directory.getDirectoryHandle(name);
  } catch (error) {
    if (isMissing(error)) return null;
    // A file where a metadata directory belongs is corruption, not absence:
    // reporting absence would answer "this holds no symlink" for a directory
    // whose symlinks are unreachable.
    if (isTypeMismatch(error)) {
      throw fsError("EIO", `metadata path is not a directory: ${name}`);
    }
    throw error;
  }
}

/** Walks to a directory, or reports that it is not there. */
async function openDirectoryPath(
  root: FileSystemDirectoryHandle,
  parts: string[]
): Promise<FileSystemDirectoryHandle | null> {
  let directory = root;
  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part);
    } catch (error) {
      if (isMissing(error) || isTypeMismatch(error)) return null;
      throw error;
    }
  }
  return directory;
}

/** Walks to a directory, creating every missing level. OPFS hands back a
 * directory that already exists, so this needs no existence check of its own. */
async function createDirectoryPath(
  root: FileSystemDirectoryHandle,
  parts: string[],
  path: string
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part, { create: true });
    } catch (error) {
      throw translateFileSystemError(error, path);
    }
  }
  return directory;
}

/**
 * Looks up one child by name. Resolving a path lstats every component along it,
 * so this must not list a directory to answer about a single entry. OPFS reports
 * the kind through the error it throws, which is why this tries file then
 * directory.
 */
async function openChildEntry(
  directory: FileSystemDirectoryHandle,
  name: string
): Promise<NativeEntry | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (!isTypeMismatch(error)) throw error;
  }
  try {
    return await directory.getDirectoryHandle(name);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function childNames(
  state: DirectoryState,
  children: Map<string, NativeEntry>
): string[] {
  return [
    ...new Set([...Object.keys(state.manifest.entries), ...children.keys()])
  ];
}

async function isEmptyDirectory(
  directory: FileSystemDirectoryHandle
): Promise<boolean> {
  return (await nativeDirectoryEntries(directory).next()).done === true;
}

async function listChildren(
  directory: FileSystemDirectoryHandle
): Promise<Map<string, NativeEntry>> {
  const children = new Map<string, NativeEntry>();
  for await (const [name, entry] of nativeDirectoryEntries(directory))
    children.set(name, entry);
  return children;
}

/** Opens a child for writing without listing the directory: OPFS itself reports a
 * name that is already a directory, via TypeMismatchError. */
async function openFileForWrite(
  state: DirectoryState,
  name: string,
  path: string
): Promise<FileSystemFileHandle> {
  try {
    return await state.handle.getFileHandle(name, { create: true });
  } catch (error) {
    if (isTypeMismatch(error))
      throw fsError("EISDIR", `${path} is a directory`);
    throw translateFileSystemError(error, path);
  }
}

/** Swaps the file's whole contents, so no reader can see a partial write. A
 * failure here is usually the disk being full, which the caller switches on. */
async function replaceFile(
  handle: FileSystemFileHandle,
  bytes: Uint8Array,
  path: string
): Promise<void> {
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(toArrayBuffer(bytes));
    await writable.close();
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
    throw translateFileSystemError(error, path);
  }
}

async function appendBytes(
  handle: FileSystemFileHandle,
  bytes: Uint8Array,
  path: string
): Promise<void> {
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const file = await handle.getFile();
    // Stage existing bytes too: a failed append must not expose partial data.
    writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(file.size);
    await writable.write(toArrayBuffer(bytes));
    await writable.close();
  } catch (error) {
    await writable?.abort(error).catch(() => undefined);
    throw translateFileSystemError(error, path);
  }
}

async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function normalizeBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function resolvePathSymlinks(
  path: string,
  followFinal: boolean,
  readSymlink: (path: string) => Promise<SymlinkEntry | undefined>
): Promise<string> {
  const original = normalizePath(path);
  let pending = pathParts(original);
  const resolved: string[] = [];
  let followed = 0;

  while (pending.length > 0) {
    const part = pending.shift()!;
    const candidate = `/${resolved.concat(part).join("/")}`;
    const isFinal = pending.length === 0;
    const link =
      !followFinal && isFinal ? undefined : await readSymlink(candidate);
    if (!link) {
      resolved.push(part);
      continue;
    }
    followed += 1;
    if (followed > MAX_SYMLINK_DEPTH) {
      throw fsError("ELOOP", `too many levels of symbolic links: ${original}`);
    }
    const target = link.target.startsWith("/")
      ? normalizePath(link.target)
      : normalizePath(`${getParent(candidate)}/${link.target}`);
    pending = pathParts(
      pending.length > 0 ? `${target}/${pending.join("/")}` : target
    );
    resolved.length = 0;
  }

  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
}

function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function assertNoDirectoryOverlap(
  source: string,
  destination: string,
  operation: string
): void {
  if (
    destination.startsWith(`${source}/`) ||
    source.startsWith(`${destination}/`)
  ) {
    throw fsError(
      "EINVAL",
      `cannot ${operation} overlapping directories: ${source} -> ${destination}`
    );
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSymlinkEntry(value: unknown): value is SymlinkEntry {
  return (
    isObject(value) &&
    "target" in value &&
    typeof value.target === "string" &&
    "createdAt" in value &&
    isFiniteNumber(value.createdAt) &&
    "updatedAt" in value &&
    isFiniteNumber(value.updatedAt)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasFsCode(error: unknown, code: string): boolean {
  return isObject(error) && "code" in error && error.code === code;
}

// A partial copy/move failure names what may remain; callers can retry.
function partialCopyError(
  error: unknown,
  source: string,
  destination: string
): Error {
  return fsError(
    fsCode(error),
    `copy failed from ${source} to ${destination}; the destination may be partial and the source was not removed (${errorMessage(error)})`
  );
}

function moveSourceRemovalError(
  error: unknown,
  source: string,
  destination: string
): Error {
  return fsError(
    fsCode(error),
    `move copied ${source} to ${destination}, but could not remove the source; both may remain (${errorMessage(error)})`
  );
}

function fsCode(error: unknown): string {
  return hasStringCode(error) ? error.code : "EIO";
}

function hasStringCode(error: unknown): error is { code: string } {
  return isObject(error) && "code" in error && typeof error.code === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
