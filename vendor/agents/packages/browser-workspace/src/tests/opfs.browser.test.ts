import { afterEach, expect, it } from "vitest";
import { OpfsWorkspace } from "@mcp-b/browser-workspace";
import { seedFiles } from "./native-tree";

const directories: string[] = [];

function directory(): string {
  const name = `shell-opfs-test-${crypto.randomUUID()}`;
  directories.push(name);
  return name;
}

async function run(
  name: string,
  operation: string,
  writer?: string
): Promise<unknown> {
  const worker = new Worker(new URL("./opfs.worker.ts", import.meta.url), {
    type: "module"
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{ result?: unknown; error?: string }>
      ) => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ name, operation, writer });
    });
  } finally {
    worker.terminate();
  }
}

afterEach(async () => {
  const root = await navigator.storage.getDirectory();
  for (const name of directories.splice(0))
    await root.removeEntry(name, { recursive: true });
});

it("meets the basic file contract and persists across Workers", async () => {
  const name = directory();
  const expected = {
    text: "hello 🌍",
    target: "notes.txt",
    bytes: [0, 255, 128]
  };
  expect(await run(name, "contract")).toEqual(expected);
  expect(await run(name, "read-contract")).toEqual({
    text: expected.text,
    bytes: expected.bytes
  });
});

it("lists and pages in SQLite binary order, with canonical glob matching", async () => {
  const result = await run(directory(), "listing");
  expect(result).toMatchObject({
    whole: [
      { name: "Z", type: "directory" },
      { name: "a.txt", type: "file" },
      { name: "z.txt", type: "file" },
      { name: "Ä.txt", type: "file" },
      { name: "\uE000.txt", type: "file" },
      { name: "😀.txt", type: "file" },
      { name: "link", type: "symlink" }
    ],
    empty: [],
    glob: ["/listing/a.txt", "/listing/z.txt"],
    info: { fileCount: 5, r2FileCount: 0 }
  });
  if (
    !result ||
    typeof result !== "object" ||
    !("whole" in result) ||
    !("pages" in result)
  )
    throw new Error("Missing listing");
  expect(result.pages).toEqual(result.whole);
});

it("follows relative and intermediate symlinks and rejects loops", async () => {
  expect(await run(directory(), "symlinks")).toEqual({
    direct: "updated",
    relative: "updated",
    link: "sub/file.txt",
    dangling: "symlink",
    exists: true,
    missing: null,
    loop: "ELOOP",
    glob: ["/real/sub/file.txt"]
  });
});

it("copies directories and symlinks, replaces files natively and rejects overlap", async () => {
  expect(await run(directory(), "copy-move")).toEqual({
    copy: "new",
    copiedLink: false,
    movedLink: "nested/file.txt",
    movedLinkKeptCreatedAt: true,
    replaced: "new",
    source: false,
    overlap: "EINVAL",
    copiedSource: true
  });
});

it("preserves existing bytes after native write, append, stream and abort failures", async () => {
  expect(await run(directory(), "failed-write")).toEqual({
    failures: [
      "ENOSPC",
      "ENOSPC",
      "ENOSPC",
      "ENOSPC",
      "ENOSPC",
      "EIO",
      "ECANCELED"
    ],
    kept: "previous"
  });
});

it("rejects a symlink record that collides with a native file and removes empty metadata directories", async () => {
  const result = await run(directory(), "metadata");
  expect(result).toMatchObject({
    rejected: "EIO",
    metadataGone: true,
    kept: "preserved"
  });
  if (
    !result ||
    typeof result !== "object" ||
    !("before" in result) ||
    !("after" in result)
  )
    throw new Error("Missing metadata");
  expect(result.after).toBe(result.before);
});

it("reports a quota failure during a copy as ENOSPC", async () => {
  expect(await run(directory(), "failed-copy")).toBe("ENOSPC");
});

it("rejects every malformed symlink manifest with EIO and leaves it unchanged", async () => {
  const results = await run(directory(), "corrupt-manifests");
  if (!Array.isArray(results)) throw new Error("Missing manifest results");
  expect(results).toHaveLength(7);
  for (const result of results) {
    expect(result).toEqual({
      body: result.body,
      code: "EIO",
      stored: result.body
    });
  }
});

it("serializes appends from separate Workers using the same OPFS root", async () => {
  const name = directory();
  await Promise.all([
    run(name, "append", "first"),
    run(name, "append", "second")
  ]);
  expect(await run(name, "read-appends")).toEqual(
    ["first", "second"]
      .flatMap((writer) =>
        Array.from({ length: 12 }, (_, i) => `${writer}:${i}`)
      )
      .sort()
  );
});

it("reads bounded binary ranges through OPFS without reading a whole native file", async () => {
  expect(await run(directory(), "byte-ranges")).toEqual({
    prefix: [0, 1, 2],
    suffix: [254, 255],
    empty: [],
    pastEnd: [],
    missing: null,
    directory: "EISDIR",
    invalid: "EINVAL",
    reads: [3, 2, 0, 0]
  });
});

it("globs a pattern without ** by listing only the directories it can reach and reading only its matches", async () => {
  expect(await run(directory(), "glob-pruning")).toEqual({
    matches: ["/projects/a/PROJECT.md", "/projects/b/PROJECT.md"],
    listed: [
      "data/projects",
      "data/projects/a",
      "data/projects/b",
      "data/projects/c"
    ],
    read: ["data/projects/a/PROJECT.md", "data/projects/b/PROJECT.md"]
  });
});

// Recorded from the walk that described every entry below a pattern's prefix
// and filtered them, which a narrower walk must reproduce exactly.
it("keeps glob results and their order across pattern shapes", async () => {
  const g = {
    hidden: "directory /g/.hidden",
    h: "file /g/.hidden/h.txt",
    Z: "directory /g/Z",
    c: "file /g/Z/c.txt",
    deeper: "directory /g/Z/deeper",
    d: "file /g/Z/deeper/d.txt",
    a: "file /g/a.txt",
    b: "file /g/b.md",
    dangling: "symlink /g/dangling",
    dirlink: "symlink /g/dirlink",
    empty: "directory /g/empty",
    link: "symlink /g/link.txt",
    sub: "directory /g/sub",
    e: "file /g/sub/e.txt",
    f: "file /g/sub/f.md",
    umlaut: "file /g/Ä.txt",
    emoji: "file /g/😀.txt"
  };
  expect(await run(directory(), "glob-results")).toEqual({
    "/g/*": [
      g.hidden,
      g.Z,
      g.a,
      g.b,
      g.dangling,
      g.dirlink,
      g.empty,
      g.link,
      g.sub,
      g.umlaut,
      g.emoji
    ],
    "/g/*.txt": [g.a, g.link, g.umlaut, g.emoji],
    "/g/*/*.txt": [g.h, g.c, g.e],
    "/g/**/*.txt": [g.h, g.c, g.d, g.a, g.link, g.e, g.umlaut, g.emoji],
    "/g/**": [
      g.hidden,
      g.h,
      g.Z,
      g.c,
      g.deeper,
      g.d,
      g.a,
      g.b,
      g.dangling,
      g.dirlink,
      g.empty,
      g.link,
      g.sub,
      g.e,
      g.f,
      g.umlaut,
      g.emoji
    ],
    "/**/d.txt": [g.d],
    "/g/{a,b}.*": [g.a, g.b],
    "/g/?.md": [g.b],
    "/g/[ab].*": [g.a, g.b],
    "/{g/sub,g/Z}/*.txt": [g.c, g.e],
    "/alias/*.txt": [g.a, g.link, g.umlaut, g.emoji],
    "/alias/*/*": [g.h, g.c, g.deeper, g.e, g.f],
    "/alias": ["directory /g"],
    "/g/link.txt": [g.a],
    "/g/dangling": [],
    "/g/sub": [g.sub],
    "/": ["directory /"],
    "/g/a.txt/*": [],
    "/nope/*": []
  });
});

it("totals files, directories and bytes across symlinks, Trash and dot folders in one listing each", async () => {
  expect(await run(directory(), "workspace-info")).toEqual({
    info: {
      fileCount: 6,
      directoryCount: 9,
      totalBytes: 275,
      r2FileCount: 0
    },
    listed: [
      "data",
      "data/.Trash",
      "data/.Trash/folder",
      "data/.Trash/folder/empty",
      "data/.config",
      "data/docs",
      "data/docs/nested",
      "data/docs/nested/deep",
      "data/empty"
    ],
    read: [
      "data/.Trash/folder/x.md",
      "data/.Trash/old.txt",
      "data/.config/settings.json",
      "data/docs/a.txt",
      "data/docs/nested/deep/b.bin",
      "data/notes.md"
    ]
  });
});

it("stops a workspace walk between directories once its signal aborts", async () => {
  expect(await run(directory(), "workspace-info-abort")).toEqual({
    error: "AbortError",
    listings: 3
  });
});

it("totals a large workspace without retaining an entry per file", async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  // Each read is a fresh snapshot of the heap.
  const heap = () =>
    (performance as Performance & { memory?: { usedJSHeapSize: number } })
      .memory?.usedJSHeapSize;
  if (!gc || heap() === undefined)
    throw new Error("the browser lane runs Chromium with --expose-gc");
  const root = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(directory(), { create: true });
  const ws = new OpfsWorkspace({ root });
  const files = Array.from({ length: 2000 }, (_, index): [string, string] => [
    `/tree/d${Math.floor(index / 100)}/n${index % 5}/file-${index}.txt`,
    "x".repeat(index % 7)
  ]);
  await seedFiles(ws, files);
  const expected = {
    fileCount: files.length,
    // The root, /tree, 20 d* and 100 n* directories.
    directoryCount: 122,
    totalBytes: files.reduce((total, [, content]) => total + content.length, 0),
    r2FileCount: 0
  };
  // Compile the walk before measuring it.
  expect(await ws.getWorkspaceInfo()).toEqual(expected);

  // Sample what is still reachable each time the walk lists a directory.
  const retained = () => {
    gc();
    return heap() ?? 0;
  };
  const entries = FileSystemDirectoryHandle.prototype.entries;
  let baseline = 0;
  let peak = 0;
  FileSystemDirectoryHandle.prototype.entries = function () {
    peak = Math.max(peak, retained() - baseline);
    return entries.call(this);
  };
  try {
    baseline = retained();
    expect(await ws.getWorkspaceInfo()).toEqual(expected);
  } finally {
    FileSystemDirectoryHandle.prototype.entries = entries;
  }
  // An entry kept per file costs a couple of hundred bytes; a walk holding only
  // the directories still to visit stays well under a quarter of that.
  expect(peak).toBeLessThan(files.length * 64);
});
