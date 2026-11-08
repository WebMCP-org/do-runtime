import { GLOB_MAGIC, createGlobMatcher, getGlobPrefix } from "./glob";
import { dirname, normalizePath } from "./path-utils";

export const MAX_WORKSPACE_PATH_LENGTH = 4096;

export function normalizeWorkspacePath(path: string): string {
  if (path.includes("\0")) {
    throw fileSystemError("EINVAL", "path contains a null byte");
  }
  const normalized = normalizePath(path);
  if (normalized.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw fileSystemError("ENAMETOOLONG", "path exceeds 4096 characters");
  }
  return normalized;
}

export function workspaceBasename(path: string): string {
  return normalizeWorkspacePath(path).split("/").at(-1) ?? "";
}

export function workspaceDirname(path: string): string {
  return dirname(normalizeWorkspacePath(path));
}
export const workspaceGlobToRegex = createGlobMatcher;

export function workspacePathParts(path: string): string[] {
  return normalizeWorkspacePath(path).split("/").filter(Boolean);
}

export function hasWorkspaceGlobMagic(pattern: string): boolean {
  return GLOB_MAGIC.test(pattern);
}

export function workspaceGlobPrefix(pattern: string): string {
  return normalizeWorkspacePath(getGlobPrefix(pattern));
}

export function fileSystemError(
  code: string,
  message: string
): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Validate byte ranges before calling APIs whose slicing rules accept negatives. */
export function validateReadRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw Object.assign(new RangeError("EINVAL: invalid byte range"), {
      code: "EINVAL"
    });
  }
}
