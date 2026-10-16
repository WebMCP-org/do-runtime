import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DirectoryHandleWorkspace,
  OpfsWorkspace,
  WorkspaceFileSystem
} from "@cloudflare/shell/browser";
import {
  normalizeWorkspacePath,
  workspaceDirname,
  workspaceGlobPrefix,
  workspaceGlobToRegex
} from "@cloudflare/shell/paths";

let root: FileSystemDirectoryHandle;
let name: string;
let workspace: DirectoryHandleWorkspace;

beforeEach(async () => {
  name = `shell-directory-${crypto.randomUUID()}`;
  root = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(name, { create: true });
  workspace = new DirectoryHandleWorkspace({ root, lockName: name });
});

afterEach(async () => {
  await (
    await navigator.storage.getDirectory()
  ).removeEntry(name, { recursive: true });
});

it("opens existing files directly without creating a private directory layout", async () => {
  const file = await root.getFileHandle("existing.txt", { create: true });
  const writer = await file.createWritable();
  await writer.write("existing 🌍");
  await writer.close();
  expect(await workspace.readFile("/existing.txt")).toBe("existing 🌍");
  expect(await workspace.readFileRange("/existing.txt", 0, 8)).toEqual(
    new TextEncoder().encode("existing")
  );
  expect(await workspace.getNativeFile("/existing.txt")).toMatchObject({
    name: "existing.txt"
  });
  expect((await workspace.readDir()).map((entry) => entry.name)).toEqual([
    "existing.txt"
  ]);
  await expect(
    workspace.readFileRange("/existing.txt", -1, 2)
  ).rejects.toMatchObject({ code: "EINVAL" });
  await expect(workspace.readFile("/")).rejects.toMatchObject({
    code: "EISDIR"
  });
  await expect(workspace.rm("/", { recursive: true })).rejects.toMatchObject({
    code: "EPERM"
  });
});

it("shares mutation locks across instances and commits binary append without lost writes", async () => {
  const peer = new DirectoryHandleWorkspace({ root, lockName: name });
  await workspace.writeFileBytes("/bytes", new Uint8Array([0, 255]));
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? workspace : peer).appendFileBytes(
        "/bytes",
        new Uint8Array([index])
      )
    )
  );
  expect(await workspace.readFileBytes("/bytes")).toEqual(
    new Uint8Array([0, 255, ...Array.from({ length: 20 }, (_, index) => index)])
  );
});

it("aborts failed stream writes without replacing existing file bytes", async () => {
  await workspace.writeFile("/keep.txt", "original");
  await expect(
    workspace.writeStream(
      "/keep.txt",
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("source failed"));
        }
      })
    )
  ).rejects.toMatchObject({ code: "EIO" });
  expect(await workspace.readFile("/keep.txt")).toBe("original");
});

it("pages native metadata in binary order and scopes glob traversal", async () => {
  await workspace.mkdir("/dir");
  for (const entry of ["😀.txt", "a.txt", "z.txt", "Ä.txt", "other.json"])
    await workspace.writeFile(`/dir/${entry}`, entry);
  expect(
    (await workspace.readDir("/dir", { limit: 2, offset: 1 })).map(
      (entry) => entry.name
    )
  ).toEqual(["other.json", "z.txt"]);
  expect(
    (await workspace.glob("/dir/*.txt")).map((entry) => entry.path)
  ).toEqual(["/dir/a.txt", "/dir/z.txt", "/dir/Ä.txt", "/dir/😀.txt"]);
  expect(
    (await workspace.glob("/**")).some((entry) => entry.path === "/")
  ).toBe(true);
  expect(await workspace.readFile("/missing/child")).toBeNull();
  expect(await workspace.readDir("/dir/a.txt")).toEqual([]);
});

it("copies trees, atomically replaces files, and rejects overlapping copies and symlinks", async () => {
  await workspace.writeFile("/source/nested/file.txt", "source");
  await workspace.cp("/source", "/copy", { recursive: true });
  expect(await workspace.readFile("/copy/nested/file.txt")).toBe("source");
  await workspace.writeFile("/replacement.txt", "replacement");
  await workspace.mv("/replacement.txt", "/copy/nested/file.txt");
  expect(await workspace.readFile("/copy/nested/file.txt")).toBe("replacement");
  expect(await workspace.exists("/replacement.txt")).toBe(false);
  await expect(
    workspace.cp("/source", "/source/child", { recursive: true })
  ).rejects.toMatchObject({ code: "EINVAL" });
  await expect(workspace.symlink("/source", "/link")).rejects.toMatchObject({
    code: "ENOTSUP"
  });
  expect(await workspace.exists("/link")).toBe(false);
});

it("moves directory trees and reports entries below a missing or file parent", async () => {
  await workspace.writeFile("/tree/nested/file.txt", "value");
  await workspace.mv("/tree", "/moved");
  expect(await workspace.readFile("/moved/nested/file.txt")).toBe("value");
  expect(await workspace.exists("/tree")).toBe(false);
  await expect(workspace.mkdir("/moved")).rejects.toMatchObject({
    code: "EEXIST"
  });
  for (const missing of ["/absent/child", "/moved/nested/file.txt/child"]) {
    await expect(workspace.rm(missing)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await workspace.rm(missing, { force: true });
  }
});

it("uses the same validated path family for traversal, dirname, and glob prefixes", () => {
  expect(normalizeWorkspacePath("a/../b//c")).toBe("/b/c");
  expect(workspaceDirname("a/../b//c")).toBe("/b");
  expect(workspaceGlobPrefix("/b/**/c?.{txt,json}")).toBe("/b");
  expect(
    workspaceGlobToRegex("/b/**/c?.{txt,json}").test("/b/sub/c1.txt")
  ).toBe(true);
  for (const invalid of ["/bad\0name", "/" + "x".repeat(4096)]) {
    expect(() => normalizeWorkspacePath(invalid)).toThrow();
    expect(() => workspaceDirname(invalid)).toThrow();
  }
});

it("resolves intermediate and relative symlinks through the canonical adapter", async () => {
  const native = new OpfsWorkspace({ root });
  const fs = new WorkspaceFileSystem(native);
  await native.writeFile("/actual/nested/file.txt", "value");
  await native.symlink("/actual", "/link");
  await native.symlink("../link/nested", "/aliases/relative");
  expect(await fs.realpath("/link/nested/file.txt")).toBe(
    "/actual/nested/file.txt"
  );
  expect(await fs.realpath("/aliases/relative/file.txt")).toBe(
    "/actual/nested/file.txt"
  );
  await native.symlink("/loop", "/loop");
  await expect(fs.realpath("/loop/file.txt")).rejects.toThrow("ELOOP");
});

it("reads every native directory page through the canonical adapter", async () => {
  const fs = new WorkspaceFileSystem(workspace);
  for (let index = 0; index < 1001; index++)
    await workspace.writeFile(`/entry-${String(index).padStart(4, "0")}`, "");
  const names = await fs.readdir("/");
  expect(names).toHaveLength(1001);
  expect(names.at(-1)).toBe("entry-1000");
  const entries = await fs.readdirWithFileTypes("/");
  expect(entries.map((entry) => entry.name)).toEqual(names);
  expect(entries.every((entry) => entry.type === "file")).toBe(true);
});

it("uses native binary append locking through the canonical adapter", async () => {
  const fs = new WorkspaceFileSystem(workspace);
  const peer = new WorkspaceFileSystem(
    new DirectoryHandleWorkspace({ root, lockName: name })
  );
  await fs.writeFileBytes("/bytes", new Uint8Array([255]));
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? fs : peer).appendFile("/bytes", new Uint8Array([index]))
    )
  );
  expect(await fs.readFileBytes("/bytes")).toEqual(
    new Uint8Array([255, ...Array.from({ length: 20 }, (_, index) => index)])
  );
});
