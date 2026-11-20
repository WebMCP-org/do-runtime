import { describe, expect, it } from "vitest";
import {
  WorkspaceFileSystem,
  type RangeWorkspaceFsLike
} from "@mcp-b/browser-workspace";
import { validateReadRange } from "@mcp-b/browser-workspace/paths";

const unsupported = async (): Promise<never> => {
  throw new Error("unsupported");
};

// Every member rejects unless a test overrides it.
function workspaceLike(
  overrides: Partial<RangeWorkspaceFsLike>
): RangeWorkspaceFsLike {
  return {
    readFile: unsupported,
    readFileRange: unsupported,
    appendFileBytes: unsupported,
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
  it("delegates bounded reads and binary append to the native owner", async () => {
    const readRange = async (_path: string, offset: number, length: number) =>
      new Uint8Array([0, 128, 255, 4]).slice(offset, offset + length);
    let appended: Uint8Array | ArrayBuffer | undefined;
    const fs = new WorkspaceFileSystem(
      workspaceLike({
        readFileRange: readRange,
        appendFileBytes: async (_path, bytes) => {
          appended = bytes;
        }
      })
    );
    expect(Array.from(await fs.readFileRange("/ranges", 1, 2))).toEqual([
      128, 255
    ]);
    const bytes = new Uint8Array([9]);
    await fs.appendFile("/ranges", bytes);
    expect(appended).toBe(bytes);
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

  it("reads every page and rejects repeated full pages", async () => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      path: `/many/${index}`,
      name: String(index),
      type: "file" as const,
      mimeType: "text/plain",
      size: 0,
      createdAt: 0,
      updatedAt: 0
    }));
    const fs = new WorkspaceFileSystem(
      workspaceLike({
        readDir: async (_path, options) =>
          entries.slice(
            options?.offset ?? 0,
            (options?.offset ?? 0) + (options?.limit ?? entries.length)
          )
      })
    );
    expect(await fs.readdir("/many")).toEqual(entries.map(({ name }) => name));
    const repeated = new WorkspaceFileSystem(
      workspaceLike({
        readDir: async () => entries.slice(0, 1000)
      })
    );
    await expect(repeated.readdir("/many")).rejects.toMatchObject({
      code: "EIO"
    });
  });

  it("rejects a proxy that ignores readDir paging", async () => {
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

    await expect(fs.readdir("/many")).rejects.toMatchObject({ code: "EIO" });
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
