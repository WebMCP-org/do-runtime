import type { WorkspaceFsLike } from "./filesystem";
import { FileSystemStateBackend } from "./memory";
import { WorkspaceFileSystem } from "./workspace-file-system";

export { WorkspaceFileSystem } from "./workspace-file-system";

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Wrap a `Workspace` (or any `WorkspaceFsLike` — e.g. a cross-DO proxy
 * forwarding each call to a parent agent's workspace over RPC) in a
 * `FileSystemStateBackend` suitable for codemode's `state.*` sandbox
 * API. The backend reuses `WorkspaceFileSystem` as its adapter, so
 * every caller gets identical ENOENT and stat-normalization semantics.
 */
export function createWorkspaceStateBackend(
  workspace: WorkspaceFsLike
): FileSystemStateBackend {
  return new FileSystemStateBackend(new WorkspaceFileSystem(workspace));
}

/** @deprecated Use `FileSystemStateBackend` */
export const WorkspaceStateBackend = FileSystemStateBackend;
