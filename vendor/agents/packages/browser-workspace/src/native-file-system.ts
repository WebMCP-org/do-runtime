/** File System Access metadata, ordering, and errno conversion for OPFS. */

import type { FileInfo } from "../filesystem";
import { MIME_BY_EXTENSION } from "../fs/mime-types";
import { fileSystemError, workspaceBasename } from "./paths";

type MovableFileHandle = FileSystemFileHandle & {
  move(destination: FileSystemDirectoryHandle, name: string): Promise<void>;
};

export type NativeEntry = FileSystemDirectoryHandle | FileSystemFileHandle;

/** Narrows the platform's base handles to directory or file handles. */
export async function* nativeDirectoryEntries(
  directory: FileSystemDirectoryHandle
): AsyncIterableIterator<[string, NativeEntry]> {
  for await (const [name, entry] of directory.entries()) {
    if (!isNativeEntry(entry)) {
      throw new TypeError(`Unsupported file-system entry: ${name}`);
    }
    yield [name, entry];
  }
}

function isNativeEntry(entry: FileSystemHandle): entry is NativeEntry {
  return entry.kind === "directory" || entry.kind === "file";
}

/** Inherited from the pinned upstream `Workspace`: the page size `readDir`
 * answers with when a caller names none. */
export const DEFAULT_READ_DIR_LIMIT = 1000;

const TEXT_ENCODER = new TextEncoder();

/** The types nothing on disk carries, so every backend has to invent the same
 * ones. Directories and symlinks have no mime type of their own; a file whose
 * name suggests nothing is bytes. */
const DIRECTORY_MIME_TYPE = "inode/directory";
export const SYMLINK_MIME_TYPE = "inode/symlink";
const UNKNOWN_FILE_MIME_TYPE = "application/octet-stream";

export function nativeMimeType(name: string, declared = ""): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? (declared || UNKNOWN_FILE_MIME_TYPE);
}

/**
 * Describes a stored file from its handle alone. A mime type declared at write
 * time is never recorded; the name decides. OPFS keeps no creation time, so
 * `createdAt` is the modification time and moves with every write.
 */
export function nativeFileInfo(path: string, file: File): FileInfo {
  return {
    path,
    name: workspaceBasename(path),
    type: "file",
    mimeType: nativeMimeType(file.name, file.type),
    size: file.size,
    createdAt: file.lastModified,
    updatedAt: file.lastModified
  };
}

/** Native directories have no timestamps; use zero instead of the read time. */
export function nativeDirectoryInfo(path: string): FileInfo {
  return {
    path,
    name: workspaceBasename(path),
    type: "directory",
    mimeType: DIRECTORY_MIME_TYPE,
    size: 0,
    createdAt: 0,
    updatedAt: 0
  };
}

/** Match Workspace's UTF-8 binary ordering so pagination is deterministic. */
export function compareTypeThenName(
  left: Pick<FileInfo, "name" | "type">,
  right: Pick<FileInfo, "name" | "type">
): number {
  return (
    compareBinaryString(left.type, right.type) ||
    compareBinaryString(left.name, right.name)
  );
}

export function compareBinaryString(left: string, right: string): number {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

/**
 * Gives a platform failure the errno its caller switches on.
 *
 * Agents and tools read `error.code`, so a quota failure has to arrive as ENOSPC
 * from whichever backend hit it. An error that already carries a code is one of
 * ours and passes through untouched; anything unrecognized stays EIO rather than
 * being guessed at.
 */
export function translateFileSystemError(
  error: unknown,
  path: string
): Error & { code: string } {
  if (isFileSystemError(error)) return error;
  const code =
    {
      AbortError: "ECANCELED",
      InvalidModificationError: "ENOTEMPTY",
      NotAllowedError: "EACCES",
      NotFoundError: "ENOENT",
      NoModificationAllowedError: "EPERM",
      QuotaExceededError: "ENOSPC",
      SecurityError: "EACCES",
      TypeMismatchError: "ENOTDIR"
    }[domErrorName(error) ?? ""] ?? "EIO";
  const detail =
    error instanceof Error && error.message ? ` (${error.message})` : "";
  return fileSystemError(code, `${path}${detail}`);
}

function isFileSystemError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

/** Atomically renames or replaces one native file. Chromium reports an open
 * source or destination handle as a busy file rather than a permission error. */
export async function moveNativeFile(
  handle: FileSystemFileHandle,
  destinationDirectory: FileSystemDirectoryHandle,
  destinationName: string,
  source: string,
  destination: string
): Promise<void> {
  if (!hasNativeMove(handle)) {
    throw fileSystemError("ENOTSUP", "native file move is required");
  }
  try {
    await handle.move(destinationDirectory, destinationName);
  } catch (error) {
    if (domErrorName(error) === "NoModificationAllowedError") {
      throw fileSystemError(
        "EBUSY",
        `file is busy: ${source} -> ${destination}`
      );
    }
    throw translateFileSystemError(error, `${source} -> ${destination}`);
  }
}

/** A detached copy of a view's bytes, which every backend hands to callers. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function domErrorName(error: unknown): string | undefined {
  if (error instanceof DOMException) return error.name;
  return hasErrorName(error) ? error.name : undefined;
}

function hasErrorName(error: unknown): error is { name: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    typeof error.name === "string"
  );
}

function hasNativeMove(
  handle: FileSystemFileHandle
): handle is MovableFileHandle {
  return "move" in handle && typeof handle.move === "function";
}

/** The platform's way of saying a name is not in a directory. */
export function isMissingEntry(error: unknown): boolean {
  return domErrorName(error) === "NotFoundError";
}

/** The platform's way of saying a name is there but is the other kind — the only
 * report OPFS gives of an entry's kind without listing its directory. */
export function isTypeMismatch(error: unknown): boolean {
  return domErrorName(error) === "TypeMismatchError";
}
