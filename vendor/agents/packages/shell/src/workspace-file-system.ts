import { validateReadRange } from "./fs/read-range";
import type { FileInfo, WorkspaceFsLike } from "./filesystem";
import type { FileSystem, FileSystemDirent, FsStat } from "./fs/interface";

import {
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath,
  resolveSymlinkTarget
} from "./fs/path-utils";

const READ_DIRECTORY_PAGE_SIZE = 1000;

/** Create an Error with code='ENOENT' that Node fs consumers expect. */
function enoent(path: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, stat '${path}'`),
    { code: "ENOENT" }
  );
}

// ── WorkspaceFileSystem ───────────────────────────────────────────────
//
// Thin adapter that makes any `WorkspaceFsLike` (a concrete `Workspace`
// or a cross-DO proxy that satisfies the interface) look like a
// `FileSystem`. Handles the two main API differences:
//   - Workspace.readFile / readFileBytes return null on missing;
//     FileSystem requires ENOENT to be thrown.
//   - Workspace.stat / lstat return Workspace-specific FileStat;
//     FileSystem.stat / lstat return FsStat = { type, size, mtime, mode? }.

export class WorkspaceFileSystem implements FileSystem {
  constructor(private readonly ws: WorkspaceFsLike) {}

  async readFile(path: string): Promise<string> {
    const content = await this.ws.readFile(path);
    if (content === null) {
      throw enoent(path);
    }
    return content;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const bytes = await this.ws.readFileBytes(path);
    if (bytes === null) {
      throw enoent(path);
    }
    return bytes;
  }

  async readFileRange(
    path: string,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    validateReadRange(offset, length);
    const bytes = this.ws.readFileRange
      ? await this.ws.readFileRange(path, offset, length)
      : (await this.ws.readFileBytes(path))?.slice(offset, offset + length);
    if (bytes == null) throw enoent(path);
    if (bytes.byteLength > length)
      throw new Error("EIO: byte range exceeded requested length");
    return bytes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ws.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.ws.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.ws.appendFile(path, content);
      return;
    }

    if (this.ws.appendFileBytes) {
      await this.ws.appendFileBytes(path, content);
      return;
    }

    const existing = await this.ws.readFileBytes(path);
    if (existing === null) {
      await this.ws.writeFileBytes(path, content);
      return;
    }

    const combined = new Uint8Array(existing.byteLength + content.byteLength);
    combined.set(existing);
    combined.set(content, existing.byteLength);
    await this.ws.writeFileBytes(path, combined);
  }

  async exists(path: string): Promise<boolean> {
    return this.ws.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const s = await this.ws.stat(path);
    if (!s) {
      throw enoent(path);
    }
    return fromWorkspaceStat(s);
  }

  async lstat(path: string): Promise<FsStat> {
    const s = await this.ws.lstat(path);
    if (!s) {
      throw enoent(path);
    }
    return fromWorkspaceStat(s);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ws.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readAllEntries(path)).map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    return (await this.readAllEntries(path)).map((e) => ({
      name: e.name,
      type: e.type
    }));
  }

  private async readAllEntries(path: string): Promise<FileInfo[]> {
    const entries = new Map<string, FileInfo>();
    for (;;) {
      const page = await this.ws.readDir(path, {
        limit: READ_DIRECTORY_PAGE_SIZE,
        offset: entries.size
      });
      const before = entries.size;
      for (const entry of page) {
        if (!entries.has(entry.name)) entries.set(entry.name, entry);
      }
      // A backend that ignores `offset` repeats a page it already returned.
      if (page.length < READ_DIRECTORY_PAGE_SIZE || entries.size === before)
        return [...entries.values()];
    }
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await this.ws.rm(path, options);
  }

  async cp(
    src: string,
    dest: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    await this.ws.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.ws.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.ws.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.ws.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    const original = normalizePath(path);
    let pending = original.split("/").filter(Boolean);
    const resolved: string[] = [];
    let followed = 0;
    while (pending.length > 0) {
      const part = pending.shift()!;
      const candidate = `/${resolved.concat(part).join("/")}`;
      const stat = await this.ws.lstat(candidate);
      if (!stat) throw enoent(candidate);
      if (stat.type !== "symlink") {
        resolved.push(part);
        continue;
      }
      if (++followed > MAX_SYMLINK_DEPTH) {
        throw Object.assign(
          new Error(`ELOOP: too many levels of symbolic links: ${original}`),
          { code: "ELOOP" }
        );
      }
      const target = resolveSymlinkTarget(
        candidate,
        await this.ws.readlink(candidate)
      );
      pending = normalizePath(`${target}/${pending.join("/")}`)
        .split("/")
        .filter(Boolean);
      resolved.length = 0;
    }
    return `/${resolved.join("/")}`;
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    return (await this.ws.glob(pattern)).map((e) => e.path);
  }
}

// ── Private helpers ───────────────────────────────────────────────────

function fromWorkspaceStat(
  stat: Pick<FileInfo, "type" | "size" | "updatedAt">
): FsStat {
  return { type: stat.type, size: stat.size, mtime: new Date(stat.updatedAt) };
}
