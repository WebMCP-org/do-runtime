import { afterEach, expect, it } from "vitest";

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

it("shares the file contract with Shell memory and persists across Workers", async () => {
  const name = directory();
  const expected = {
    text: "hello 🌍",
    target: "notes.txt",
    bytes: [0, 255, 128]
  };
  expect(await run(name, "contract")).toEqual({
    memory: expected,
    opfs: expected
  });
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

it("rejects corrupt symlink metadata unchanged and removes empty metadata directories", async () => {
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
