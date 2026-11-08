import { InMemoryFs, type WorkspaceFsLike } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";
import { WorkspaceFileSystem } from "@mcp-b/browser-workspace";
import { validateReadRange } from "@mcp-b/browser-workspace/paths";

const unsupported = async (): Promise<never> => {
  throw new Error("unsupported");
};

// Every member rejects unless a test overrides it.
function workspaceLike(overrides: Partial<WorkspaceFsLike>): WorkspaceFsLike {
  return {
    readFile: unsupported,
    readFileBytes: unsupported,
    writeFile: unsupported,
    writeFileBytes: unsupported,
    appendFile: unsupported,
    exists: unsupported,
    stat: unsupported,
    lstat: unsupported,
    mkdir: unsupported,
    readDir: unsupported,
    rm: unsupported,
    cp: unsupported,
    mv: unsupported,
    symlink: unsupported,
    readlink: unsupported,
    glob: unsupported,
    ...overrides
  };
}

describe("WorkspaceFileSystem", () => {
  it("reads byte ranges through legacy WorkspaceFsLike adapters", async () => {
    // No readFileRange: the adapter must slice readFileBytes.
    const memory = new InMemoryFs();
    const ws = workspaceLike({
      readFileBytes: (path) => memory.readFileBytes(path).catch(() => null),
      writeFileBytes: (path, content) =>
        memory.writeFileBytes(path, new Uint8Array(content)),
      symlink: (target, linkPath) => memory.symlink(target, linkPath)
    });
    const fs = new WorkspaceFileSystem(ws);
    await ws.writeFileBytes("/ranges", new Uint8Array([0, 128, 255, 4]));
    await ws.symlink("ranges", "/range-link");

    expect(Array.from(await fs.readFileRange("/range-link", 1, 2))).toEqual([
      128, 255
    ]);
    expect(Array.from(await fs.readFileRange("/ranges", 8, 2))).toEqual([]);
    expect(Array.from(await fs.readFileRange("/ranges", 0, 0))).toEqual([]);
    await expect(fs.readFileRange("/missing", 0, 1)).rejects.toMatchObject({
      code: "ENOENT"
    });
    // No appendFileBytes: the adapter must read, join and write.
    await fs.appendFile("/ranges", new Uint8Array([9]));
    expect(Array.from(await fs.readFileBytes("/ranges"))).toEqual([
      0, 128, 255, 4, 9
    ]);
  });

  it("rejects backends that return more bytes than requested", async () => {
    const fs = new WorkspaceFileSystem(
      Object.assign(workspaceLike({}), {
        readFileRange: async () => new Uint8Array(3)
      })
    );
    await expect(fs.readFileRange("/f", 0, 2)).rejects.toMatchObject({
      code: "EIO"
    });
  });

  it("lists a large directory once from a proxy that ignores readDir paging", async () => {
    const page = Array.from({ length: 1001 }, (_, index) => ({
      path: `/many/${index}`,
      name: String(index),
      type: "file" as const,
      mimeType: "text/plain",
      size: 0,
      createdAt: 0,
      updatedAt: 0
    }));
    const fs = new WorkspaceFileSystem(
      workspaceLike({ readDir: async () => page })
    );

    await expect(fs.readdir("/many")).resolves.toHaveLength(1001);
  });
});

describe("validateReadRange", () => {
  it.each([
    [-1, 1],
    [0, -1],
    [0.5, 1],
    [0, 1.5],
    [Number.MAX_SAFE_INTEGER, 1]
  ])("rejects offset %d length %d", (offset, length) => {
    expect(() => validateReadRange(offset, length)).toThrow(
      expect.objectContaining({ name: "RangeError", code: "EINVAL" })
    );
  });

  it("accepts nonnegative safe integers", () => {
    expect(() => validateReadRange(0, 0)).not.toThrow();
    expect(() => validateReadRange(3, 5)).not.toThrow();
  });
});
