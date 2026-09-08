import { createGlobMatcher, getGlobPrefix } from "../helpers";
import { dirname, normalizePath } from "../fs/path-utils";

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

export const workspaceDirname = dirname;
export const workspaceGlobToRegex = createGlobMatcher;

export function workspacePathParts(path: string): string[] {
  return normalizeWorkspacePath(path).split("/").filter(Boolean);
}

export function hasWorkspaceGlobMagic(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
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
