/** Native traversal and writes adapted from Componentor LocalFolderDrive 3.3.1
 * (MIT), then extended for Workspace byte ranges, locking and errno semantics.
 * https://github.com/componentor/fs/blob/v3.3.1/src/src/drives/localfolder-drive.ts
 * See THIRD_PARTY_NOTICES in this package for the retained license.
 */
import type { FileInfo, WorkspaceFsLike } from "../filesystem";
import {
  DEFAULT_READ_DIR_LIMIT,
  compareBinaryString,
  compareTypeThenName,
  nativeDirectoryEntries,
  moveNativeFile,
  nativeDirectoryInfo,
  nativeFileInfo,
  translateFileSystemError,
  domErrorName,
  toArrayBuffer,
  type NativeEntry
} from "./native-file-system";
import {
  hasWorkspaceGlobMagic,
  normalizeWorkspacePath,
  workspaceGlobPrefix,
  workspaceGlobToRegex,
  workspacePathParts,
  fileSystemError as fsError,
  validateReadRange
} from "./paths";

export interface DirectoryHandleWorkspaceOptions {
  /** An existing native directory. No private data or metadata layout is created. */
  root: FileSystemDirectoryHandle;
  /** Stable across every instance opening this directory; supplied by its owner. */
  lockName: string;
}

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

/** Workspace filesystem over an existing File System Access directory.
 * The host owns handle persistence and permission prompts. Web Locks serialize
 * mutations across workers; failed native writes abort their uncommitted data.
 * Native directories do not support symbolic links or removal of their root.
 */
export class DirectoryHandleWorkspace implements WorkspaceFsLike {
  private readonly root: FileSystemDirectoryHandle;
  private readonly lockName: string;

  constructor({ root, lockName }: DirectoryHandleWorkspaceOptions) {
    this.root = root;
    this.lockName = lockName;
  }
  async readFile(path: string): Promise<string | null> {
    const bytes = await this.readFileBytes(path);
    return bytes === null ? null : TEXT_DECODER.decode(bytes);
  }

  async readFileRange(
    path: string,
    offset: number,
    length: number
  ): Promise<Uint8Array | null> {
    validateReadRange(offset, length);
    return this.withNativeFile(
      path,
      async (file) =>
        new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
    );
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.withNativeFile(
      path,
      async (file) => new Uint8Array(await file.arrayBuffer())
    );
  }

  async getNativeFile(path: string): Promise<File | null> {
    return this.withNativeFile(path, async (file) => file);
  }

  /** Keep the mount's shared lock through snapshot creation and any byte read. */
  private async withNativeFile<T>(
    path: string,
    read: (file: File) => Promise<T>
  ): Promise<T | null> {
    try {
      return await this.withTree(path, "shared", async ({ parts, root }) => {
        if (parts.length === 0)
          throw fsError("EISDIR", `${path} is a directory`);
        const entry = await getEntry(root, parts);
        if (!entry) return null;
        if (entry.kind !== "file") {
          throw fsError("EISDIR", `${path} is a directory`);
        }
        return read(await entry.getFile());
      });
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async writeFile(
    path: string,
    content: string,
    _mimeType?: string
  ): Promise<void> {
    await this.writeFileBytes(path, TEXT_ENCODER.encode(content));
  }

  async writeFileBytes(
    path: string,
    content: Uint8Array | ArrayBuffer,
    _mimeType?: string
  ): Promise<void> {
    await this.withTree(path, "exclusive", async ({ parts, root }) => {
      assertMutableEntry(parts, path);
      await writeBytes(root, parts, normalizeBytes(content));
    });
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
    await this.withTree(path, "exclusive", async ({ parts, root }) => {
      assertMutableEntry(parts, path);
      const parent = await getDirectory(root, parts.slice(0, -1), true);
      const handle = await parent.getFileHandle(parts.at(-1)!, {
        create: true
      });
      const file = await handle.getFile();
      const writable = await handle.createWritable({ keepExistingData: true });
      await useWritable(writable, async () => {
        await writable.seek(file.size);
        await writable.write(toArrayBuffer(normalizeBytes(content)));
      });
    });
  }

  async writeStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.withTree(path, "exclusive", async ({ parts, root }) => {
      assertMutableEntry(parts, path);
      const parent = await getDirectory(root, parts.slice(0, -1), true);
      const handle = await parent.getFileHandle(parts.at(-1)!, {
        create: true
      });
      const writable = await handle.createWritable();
      try {
        await stream.pipeTo(writable, { signal });
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/") return true;
    try {
      return await this.withTree(
        normalized,
        "shared",
        async ({ parts, root }) =>
          parts.length === 0 ? true : (await getEntry(root, parts)) !== null
      );
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  async stat(path: string): Promise<FileInfo | null> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/") return nativeDirectoryInfo("/");
    try {
      return await this.withTree(
        normalized,
        "shared",
        async ({ parts, root }) => {
          if (parts.length === 0) return nativeDirectoryInfo("/");
          const entry = await getEntry(root, parts);
          return entry ? entryInfo(normalized, entry) : null;
        }
      );
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async lstat(path: string): Promise<FileInfo | null> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.withTree(path, "exclusive", async ({ parts, root }) => {
      if (parts.length === 0) {
        if (options?.recursive) return;
        throw fsError("EEXIST", `directory already exists: ${path}`);
      }
      if (options?.recursive) {
        await getDirectory(root, parts, true);
        return;
      }
      const parent = await getDirectory(root, parts.slice(0, -1), false);
      if (await getEntry(root, parts)) {
        throw fsError("EEXIST", `path already exists: ${path}`);
      }
      await parent.getDirectoryHandle(parts.at(-1)!, { create: true });
    });
  }

  async readDir(
    path = "/",
    options?: { limit?: number; offset?: number }
  ): Promise<FileInfo[]> {
    const normalized = normalizeWorkspacePath(path);
    try {
      return await this.withTree(
        normalized,
        "shared",
        async ({ parts, root }) => {
          const entry = parts.length === 0 ? root : await getEntry(root, parts);
          if (!entry || entry.kind !== "directory") return [];
          // Do not retain every native child handle while sorting a large
          // directory. The iterator may yield thousands of capability objects;
          // keep only clone-safe names/kinds and reopen handles for the page we
          // actually return.
          const children: Pick<FileInfo, "name" | "type">[] = [];
          for await (const [name, child] of nativeDirectoryEntries(entry)) {
            children.push({ name, type: child.kind });
          }
          const offset = Math.max(0, options?.offset ?? 0);
          const limit = Math.max(0, options?.limit ?? DEFAULT_READ_DIR_LIMIT);
          const page = children
            .sort(compareTypeThenName)
            .slice(offset, offset + limit);
          return Promise.all(
            page.map(async ({ name, type }) => {
              const child =
                type === "directory"
                  ? await entry.getDirectoryHandle(name)
                  : await entry.getFileHandle(name);
              return entryInfo(`/${parts.concat(name).join("/")}`, child);
            })
          );
        }
      );
    } catch (error) {
      if (hasFsCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    try {
      await this.withTree(path, "exclusive", async ({ parts, root }) => {
        assertMutableEntry(parts, path);
        const entry = await getEntry(root, parts);
        if (!entry) {
          if (options?.force) return;
          throw fsError("ENOENT", `no such file or directory: ${path}`);
        }
        const parent = await getDirectory(root, parts.slice(0, -1), false);
        try {
          await parent.removeEntry(parts.at(-1)!, {
            recursive: options?.recursive ?? false
          });
        } catch (error) {
          if (options?.force && domErrorName(error) === "NotFoundError") return;
          throw error;
        }
      });
    } catch (error) {
      if (options?.force && hasFsCode(error, "ENOENT")) return;
      throw error;
    }
  }

  async cp(
    source: string,
    destination: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const sourceParts = workspacePathParts(source);
    const destinationParts = workspacePathParts(destination);
    assertMutableEntry(destinationParts, destination);
    await this.withLock("exclusive", async () => {
      const sourceEntry = await getEntry(this.root, sourceParts).catch(
        (error) => {
          throw translateFileSystemError(error, source);
        }
      );
      if (!sourceEntry) {
        throw fsError("ENOENT", `no such file or directory: ${source}`);
      }
      try {
        await copyEntry(
          this.root,
          sourceParts,
          destinationParts,
          options?.recursive ?? false
        );
      } catch (error) {
        throw partialCopyError(error, source, destination);
      }
    });
  }

  async mv(
    source: string,
    destination: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const sourceParts = workspacePathParts(source);
    const destinationParts = workspacePathParts(destination);
    assertMutableEntry(sourceParts, source);
    assertMutableEntry(destinationParts, destination);
    await this.withLock("exclusive", async () => {
      let sourceEntry: NativeEntry;
      try {
        const resolved = await getEntry(this.root, sourceParts);
        if (!resolved) {
          throw fsError("ENOENT", `no such file or directory: ${source}`);
        }
        sourceEntry = resolved;
      } catch (error) {
        throw translateFileSystemError(error, source);
      }
      if (sameParts(sourceParts, destinationParts)) return;
      if (sourceEntry.kind === "file") {
        try {
          const destinationEntry = await getEntry(this.root, destinationParts);
          if (destinationEntry?.kind === "directory") {
            throw fsError(
              "EISDIR",
              `cannot overwrite directory: ${destination}`
            );
          }
          const destinationParent = await getDirectory(
            this.root,
            destinationParts.slice(0, -1),
            true
          );
          await moveNativeFile(
            sourceEntry,
            destinationParent,
            destinationParts.at(-1)!,
            source,
            destination
          );
        } catch (error) {
          throw translateFileSystemError(error, `${source} -> ${destination}`);
        }
        return;
      }
      try {
        await copyEntry(
          this.root,
          sourceParts,
          destinationParts,
          options?.recursive ?? true
        );
      } catch (error) {
        throw partialCopyError(error, source, destination);
      }
      try {
        const parent = await getDirectory(
          this.root,
          sourceParts.slice(0, -1),
          false
        );
        await parent.removeEntry(sourceParts.at(-1)!, {
          recursive: sourceEntry.kind === "directory"
        });
      } catch (error) {
        const translated = translateFileSystemError(error, source);
        throw fsError(
          translated.code,
          `move copied ${source} to ${destination}, but could not remove the source; both may remain (${translated.message})`
        );
      }
    });
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    normalizeWorkspacePath(linkPath);
    throw fsError(
      "ENOTSUP",
      `symbolic links are not supported in native directories: ${linkPath}`
    );
  }

  async readlink(path: string): Promise<string> {
    normalizeWorkspacePath(path);
    throw fsError(
      "ENOTSUP",
      `symbolic links are not supported in native directories: ${path}`
    );
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    const normalized = normalizeWorkspacePath(pattern);
    const regex = workspaceGlobToRegex(normalized);
    if (!hasWorkspaceGlobMagic(normalized)) {
      const info = await this.stat(normalized);
      return info && regex.test(info.path) ? [info] : [];
    }
    return this.withLock("shared", async () => {
      try {
        const output: FileInfo[] = [];
        const prefix = workspaceGlobPrefix(normalized);
        const start = await getEntry(
          this.root,
          prefix.split("/").filter(Boolean)
        );
        if (!start) return [];
        if (regex.test(prefix)) output.push(await entryInfo(prefix, start));
        const maxDepth = normalized.includes("**")
          ? Number.POSITIVE_INFINITY
          : pathDepth(normalized);
        if (start.kind === "directory" && pathDepth(prefix) < maxDepth) {
          await walkDirectory(
            start,
            prefix === "/" ? "" : prefix,
            regex,
            output,
            maxDepth
          );
        }
        return output.sort((left, right) =>
          compareBinaryString(left.path, right.path)
        );
      } catch (error) {
        throw translateFileSystemError(error, pattern);
      }
    });
  }

  private async withTree<T>(
    path: string,
    mode: LockMode,
    operation: (entry: {
      parts: string[];
      root: FileSystemDirectoryHandle;
    }) => Promise<T>
  ): Promise<T> {
    const parts = workspacePathParts(path);
    return this.withLock(mode, async () => {
      try {
        return await operation({ parts, root: this.root });
      } catch (error) {
        throw translateFileSystemError(error, path);
      }
    });
  }

  private async withLock<T>(
    mode: LockMode,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!navigator.locks)
      throw fsError("ENOTSUP", "Web Locks are required for native directories");
    return navigator.locks.request(this.lockName, { mode }, operation);
  }
}

async function walkDirectory(
  directory: FileSystemDirectoryHandle,
  path: string,
  regex: RegExp,
  output: FileInfo[],
  maxDepth: number
): Promise<void> {
  for await (const [name, entry] of nativeDirectoryEntries(directory)) {
    const entryPath = `${path}/${name}`;
    if (regex.test(entryPath)) output.push(await entryInfo(entryPath, entry));
    if (entry.kind === "directory" && pathDepth(entryPath) < maxDepth) {
      await walkDirectory(entry, entryPath, regex, output, maxDepth);
    }
  }
}

function pathDepth(path: string): number {
  return normalizeWorkspacePath(path).split("/").filter(Boolean).length;
}

async function copyEntry(
  root: FileSystemDirectoryHandle,
  sourceParts: string[],
  destinationParts: string[],
  recursive: boolean
): Promise<void> {
  const sourcePath = `/${sourceParts.join("/")}`;
  const destinationPath = `/${destinationParts.join("/")}`;
  const source = await getEntry(root, sourceParts);
  if (!source) {
    throw fsError("ENOENT", `no such file or directory: ${sourcePath}`);
  }
  if (source.kind === "file") {
    await writeBytes(
      root,
      destinationParts,
      new Uint8Array(await (await source.getFile()).arrayBuffer())
    );
    return;
  }
  if (!recursive) {
    throw fsError(
      "EISDIR",
      `cannot copy directory without recursive: ${sourcePath}`
    );
  }
  if (isSameOrDescendant(sourceParts, destinationParts)) {
    throw fsError(
      "EINVAL",
      `cannot copy a directory into itself: ${sourcePath} -> ${destinationPath}`
    );
  }
  await getDirectory(root, destinationParts, true);
  for await (const [name] of nativeDirectoryEntries(source)) {
    await copyEntry(
      root,
      sourceParts.concat(name),
      destinationParts.concat(name),
      true
    );
  }
}

async function writeBytes(
  root: FileSystemDirectoryHandle,
  parts: string[],
  bytes: Uint8Array
): Promise<void> {
  const parent = await getDirectory(root, parts.slice(0, -1), true);
  const handle = await parent.getFileHandle(parts.at(-1)!, { create: true });
  const writable = await handle.createWritable();
  await useWritable(writable, () => writable.write(toArrayBuffer(bytes)));
}

async function useWritable(
  writable: FileSystemWritableFileStream,
  write: () => Promise<void>
): Promise<void> {
  try {
    await write();
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function getEntry(
  root: FileSystemDirectoryHandle,
  parts: string[]
): Promise<NativeEntry | null> {
  if (parts.length === 0) return root;
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await getDirectory(root, parts.slice(0, -1), false);
  } catch (error) {
    if (isMissingOrTypeMismatch(error)) return null;
    throw error;
  }
  const name = parts.at(-1)!;
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (!isMissingOrTypeMismatch(error)) throw error;
  }
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isMissingOrTypeMismatch(error)) return null;
    throw error;
  }
}

function isSameOrDescendant(parent: string[], candidate: string[]): boolean {
  return (
    candidate.length >= parent.length &&
    parent.every((part, index) => candidate[index] === part)
  );
}

function sameParts(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

async function getDirectory(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory;
}

async function entryInfo(path: string, entry: NativeEntry): Promise<FileInfo> {
  if (entry.kind === "directory") return nativeDirectoryInfo(path);
  return nativeFileInfo(path, await entry.getFile());
}

function assertMutableEntry(parts: string[], path: string): void {
  if (parts.length === 0) {
    throw fsError("EPERM", `cannot modify native directory root: ${path}`);
  }
}

function normalizeBytes(content: Uint8Array | ArrayBuffer): Uint8Array {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function isMissingOrTypeMismatch(error: unknown): boolean {
  const name = domErrorName(error);
  return name === "NotFoundError" || name === "TypeMismatchError";
}

function partialCopyError(
  error: unknown,
  source: string,
  destination: string
): Error {
  const translated = translateFileSystemError(
    error,
    `${source} -> ${destination}`
  );
  return fsError(
    translated.code,
    `copy failed from ${source} to ${destination}; the destination may be partial and the source was not removed (${translated.message})`
  );
}

function hasFsCode(
  error: Parameters<typeof translateFileSystemError>[0],
  code: string
): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
