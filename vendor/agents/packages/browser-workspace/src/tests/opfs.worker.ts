import { OpfsWorkspace } from "@mcp-b/browser-workspace";
import type { Workspace, WorkspaceFsLike } from "@cloudflare/shell";
import { seedFiles } from "./native-tree";

async function errorCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "no error";
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? String(error.code)
      : String(error);
  }
}

/**
 * Runs an operation while counting what it asks of OPFS itself: every directory
 * listing and every file snapshot, as paths below the workspace root
 * (`data/...` for the files, `meta/...` for symlink manifests).
 */
async function observeNativeAccess<T>(
  root: FileSystemDirectoryHandle,
  operation: () => Promise<T>,
  onListing?: (count: number) => void
): Promise<{ result: T; listed: string[]; read: string[] }> {
  const listedHandles: FileSystemDirectoryHandle[] = [];
  const readHandles: FileSystemFileHandle[] = [];
  const directory = FileSystemDirectoryHandle.prototype;
  const { entries, keys, values } = directory;
  const getFile = FileSystemFileHandle.prototype.getFile;
  const listing = (handle: FileSystemDirectoryHandle) => {
    listedHandles.push(handle);
    onListing?.(listedHandles.length);
  };
  directory.entries = function () {
    listing(this);
    return entries.call(this);
  };
  directory.keys = function () {
    listing(this);
    return keys.call(this);
  };
  directory.values = function () {
    listing(this);
    return values.call(this);
  };
  FileSystemFileHandle.prototype.getFile = function () {
    readHandles.push(this);
    return getFile.call(this);
  };
  try {
    const result = await operation();
    const paths = (handles: FileSystemHandle[]) =>
      Promise.all(
        handles.map(async (handle) =>
          ((await root.resolve(handle)) ?? ["outside"]).join("/")
        )
      );
    return {
      result,
      listed: await paths(listedHandles),
      read: await paths(readHandles)
    };
  } finally {
    Object.assign(directory, { entries, keys, values });
    FileSystemFileHandle.prototype.getFile = getFile;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

// The basic file contract Shell's in-memory and SQLite workspaces also meet.
async function fileContract(
  fs: Pick<
    WorkspaceFsLike,
    "readFile" | "readFileBytes" | "symlink" | "readlink"
  > & {
    writeFile(path: string, content: string): Promise<void>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  }
) {
  await fs.writeFile("/notes.txt", "hello 🌍");
  const bytes = new Uint8Array([99, 0, 255, 128, 99]).subarray(1, 4);
  await fs.writeFileBytes("/raw.bin", bytes);
  await fs.symlink("notes.txt", "/link");
  return {
    text: await fs.readFile("/link"),
    target: await fs.readlink("/link"),
    bytes: Array.from((await fs.readFileBytes("/raw.bin")) ?? [])
  };
}

async function run(name: string, operation: string, writer = "") {
  const storage = await navigator.storage.getDirectory();
  const root = await storage.getDirectoryHandle(name, { create: true });
  const ws = new OpfsWorkspace({ root });
  switch (operation) {
    case "byte-ranges": {
      await ws.writeFileBytes(
        "/data",
        Uint8Array.from({ length: 256 }, (_, i) => i)
      );
      await ws.symlink("data", "/link");
      const reads: number[] = [];
      const arrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        reads.push(this.size);
        if (this.size > 3) throw new Error("Full-file read forbidden");
        return arrayBuffer.call(this);
      };
      try {
        return {
          prefix: Array.from((await ws.readFileRange("/link", 0, 3)) ?? []),
          suffix: Array.from((await ws.readFileRange("/data", 254, 10)) ?? []),
          empty: Array.from((await ws.readFileRange("/data", 0, 0)) ?? []),
          pastEnd: Array.from((await ws.readFileRange("/data", 300, 1)) ?? []),
          missing: await ws.readFileRange("/missing", 0, 0),
          directory: await errorCode(ws.readFileRange("/", 0, 0)),
          invalid: await errorCode(ws.readFileRange("/data", -1, 1)),
          reads
        };
      } finally {
        Blob.prototype.arrayBuffer = arrayBuffer;
      }
    }
    case "contract":
      return fileContract(ws);
    case "read-contract":
      return {
        text: await ws.readFile("/link"),
        bytes: Array.from((await ws.readFileBytes("/raw.bin")) ?? [])
      };
    case "listing": {
      await ws.mkdir("/listing/Z", { recursive: true });
      for (const file of ["😀.txt", "\uE000.txt", "Ä.txt", "z.txt", "a.txt"]) {
        await ws.writeFile(`/listing/${file}`, file);
      }
      await ws.symlink("a.txt", "/listing/link");
      const whole = await ws.readDir("/listing");
      const pages = [];
      for (let offset = 0; offset < whole.length; offset += 2) {
        pages.push(...(await ws.readDir("/listing", { offset, limit: 2 })));
      }
      return {
        whole,
        pages,
        empty: await ws.readDir("/listing", { limit: 0 }),
        glob: (await ws.glob("/list*/{a,z}.txt")).map(({ path }) => path),
        info: await ws.getWorkspaceInfo()
      };
    }
    case "symlinks": {
      await ws.writeFile("/real/sub/file.txt", "contents");
      await ws.symlink("/real", "/alias");
      await ws.symlink("sub/file.txt", "/real/relative");
      await ws.symlink("missing", "/dangling");
      await ws.symlink("/loop-b", "/loop-a");
      await ws.symlink("/loop-a", "/loop-b");
      await ws.writeFile("/alias/sub/file.txt", "updated");
      const linkInfo = await ws.lstat("/dangling");
      return {
        direct: await ws.readFile("/real/sub/file.txt"),
        relative: await ws.readFile("/alias/relative"),
        link: await ws.readlink("/alias/relative"),
        dangling: linkInfo?.type,
        exists: await ws.exists("/dangling"),
        missing: await ws.stat("/dangling"),
        loop: await errorCode(ws.readFile("/loop-a")),
        glob: (await ws.glob("/alias/**/*.txt")).map(({ path }) => path)
      };
    }
    case "copy-move": {
      await ws.writeFile("/src/nested/file.txt", "new");
      await ws.symlink("nested/file.txt", "/src/link");
      await ws.cp("/src", "/copy", { recursive: true });
      await ws.mv("/src", "/moved");
      const linkBefore = await ws.lstat("/moved/link");
      // Let the clock move, so a rewritten createdAt would differ.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ws.mv("/moved/link", "/moved/renamed-link");
      const linkAfter = await ws.lstat("/moved/renamed-link");
      await ws.writeFile("/destination.txt", "old");
      await ws.mv("/moved/nested/file.txt", "/destination.txt");
      const overlap = await errorCode(
        ws.cp("/copy", "/copy/nested/inside", { recursive: true })
      );
      await ws.rm("/copy/link");
      return {
        copy: await ws.readFile("/copy/nested/file.txt"),
        copiedLink: await ws.exists("/copy/link"),
        movedLink: await ws.readlink("/moved/renamed-link"),
        movedLinkKeptCreatedAt:
          linkBefore !== null && linkAfter?.createdAt === linkBefore.createdAt,
        replaced: await ws.readFile("/destination.txt"),
        source: await ws.exists("/src"),
        overlap,
        copiedSource: await ws.exists("/copy/nested/file.txt")
      };
    }
    case "failed-write": {
      await ws.writeFile("/kept.txt", "previous");
      const write = FileSystemWritableFileStream.prototype.write;
      const failures = [];
      try {
        // Inject disk failure after real staged bytes are written, before commit.
        FileSystemWritableFileStream.prototype.write = async function (data) {
          await write.call(this, data);
          throw new DOMException("simulated disk quota", "QuotaExceededError");
        };
        failures.push(
          await errorCode(ws.writeFile("/kept.txt", "replacement"))
        );
        failures.push(await errorCode(ws.appendFile("/kept.txt", " append")));
      } finally {
        FileSystemWritableFileStream.prototype.write = write;
      }
      const createWritable = FileSystemFileHandle.prototype.createWritable;
      try {
        FileSystemFileHandle.prototype.createWritable = async function () {
          throw new DOMException("simulated disk quota", "QuotaExceededError");
        };
        failures.push(
          await errorCode(ws.writeFile("/kept.txt", "replacement"))
        );
        failures.push(await errorCode(ws.appendFile("/kept.txt", " append")));
        failures.push(
          await errorCode(ws.writeStream("/kept.txt", new ReadableStream()))
        );
      } finally {
        FileSystemFileHandle.prototype.createWritable = createWritable;
      }
      let pulls = 0;
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0)
            controller.enqueue(new TextEncoder().encode("partial"));
          else controller.error(new Error("stream failed"));
        }
      });
      failures.push(await errorCode(ws.writeStream("/kept.txt", broken)));
      const abort = new AbortController();
      abort.abort();
      failures.push(
        await errorCode(
          ws.writeStream("/kept.txt", new ReadableStream(), abort.signal)
        )
      );
      return { failures, kept: await ws.readFile("/kept.txt") };
    }
    case "failed-copy": {
      await ws.writeFile("/source/file.txt", "source");
      const createWritable = FileSystemFileHandle.prototype.createWritable;
      try {
        FileSystemFileHandle.prototype.createWritable = async function () {
          throw new DOMException("simulated disk quota", "QuotaExceededError");
        };
        return await errorCode(ws.cp("/source", "/copy", { recursive: true }));
      } finally {
        FileSystemFileHandle.prototype.createWritable = createWritable;
      }
    }
    case "corrupt-manifests": {
      await ws.writeFile("/files/kept.txt", "preserved");
      await ws.symlink("kept.txt", "/files/link");
      const metadata = await root.getDirectoryHandle("meta");
      const handle = await (
        await metadata.getDirectoryHandle("files")
      ).getFileHandle("entries.json");
      const record = '"target":"a","createdAt":1,"updatedAt":1';
      const bodies = [
        "not json",
        '{"entries":{},"x":1}',
        '{"entries":[]}',
        `{"entries":{"..":{${record}}}}`,
        '{"entries":{"l":{"target":"","createdAt":1,"updatedAt":1}}}',
        '{"entries":{"l":{"target":"a","createdAt":null,"updatedAt":1}}}',
        `{"entries":{"l":{${record},"mode":1}}}`
      ];
      const results = [];
      for (const body of bodies) {
        const write = await handle.createWritable();
        await write.write(body);
        await write.close();
        results.push({
          body,
          code: await errorCode(ws.readDir("/files")),
          stored: await (await handle.getFile()).text()
        });
      }
      return results;
    }
    case "metadata": {
      await ws.writeFile("/files/kept.txt", "preserved");
      await ws.symlink("kept.txt", "/files/link");
      const metadata = await root.getDirectoryHandle("meta");
      const dir = await metadata.getDirectoryHandle("files");
      const handle = await dir.getFileHandle("entries.json");
      const valid = await (await handle.getFile()).text();
      const write = await handle.createWritable();
      await write.write(
        '{"entries":{"kept.txt":{"target":"elsewhere","createdAt":1,"updatedAt":1}}}'
      );
      await write.close();
      const before = await (await handle.getFile()).text();
      const rejected = await errorCode(ws.readDir("/files"));
      const after = await (await handle.getFile()).text();
      const restore = await handle.createWritable();
      await restore.write(valid);
      await restore.close();
      await ws.rm("/files/link");
      let metadataGone = false;
      try {
        await metadata.getDirectoryHandle("files");
      } catch (error) {
        metadataGone =
          error instanceof DOMException && error.name === "NotFoundError";
      }
      return {
        rejected,
        before,
        after,
        metadataGone,
        kept: await ws.readFile("/files/kept.txt")
      };
    }
    case "glob-pruning": {
      await seedFiles(ws, [
        ["/projects/a/PROJECT.md", "a"],
        ["/projects/b/PROJECT.md", "b"],
        ["/projects/b/notes.md", "notes"],
        ["/projects/c/readme.md", "c"],
        ["/projects/PROJECT.md", "too shallow"],
        ["/other/x/PROJECT.md", "outside the prefix"],
        ...Array.from({ length: 1000 }, (_, index): [string, string] => [
          `/projects/a/deep/d${index % 10}/f${index}.md`,
          "deep"
        ])
      ]);
      await ws.symlink("a", "/projects/link");
      const { result, listed, read } = await observeNativeAccess(root, () =>
        ws.glob("/projects/*/PROJECT.md")
      );
      return {
        matches: result.map(({ path }) => path),
        listed: listed.sort(),
        read: read.filter((path) => path.startsWith("data/")).sort()
      };
    }
    case "glob-results": {
      await seedFiles(ws, [
        ["/g/a.txt", "a"],
        ["/g/b.md", "b"],
        ["/g/Ä.txt", "umlaut"],
        ["/g/😀.txt", "emoji"],
        ["/g/Z/c.txt", "c"],
        ["/g/Z/deeper/d.txt", "d"],
        ["/g/sub/e.txt", "e"],
        ["/g/sub/f.md", "f"],
        ["/g/.hidden/h.txt", "h"]
      ]);
      await ws.mkdir("/g/empty");
      await ws.symlink("a.txt", "/g/link.txt");
      await ws.symlink("sub", "/g/dirlink");
      await ws.symlink("missing", "/g/dangling");
      await ws.symlink("/g", "/alias");
      const patterns = [
        "/g/*",
        "/g/*.txt",
        "/g/*/*.txt",
        "/g/**/*.txt",
        "/g/**",
        "/**/d.txt",
        "/g/{a,b}.*",
        "/g/?.md",
        "/g/[ab].*",
        "/{g/sub,g/Z}/*.txt",
        "/alias/*.txt",
        "/alias/*/*",
        "/alias",
        "/g/link.txt",
        "/g/dangling",
        "/g/sub",
        "/",
        "/g/a.txt/*",
        "/nope/*"
      ];
      const results: Record<string, string[]> = {};
      for (const pattern of patterns) {
        results[pattern] = (await ws.glob(pattern)).map(
          ({ path, type }) => `${type} ${path}`
        );
      }
      return results;
    }
    case "workspace-info": {
      await seedFiles(ws, [
        ["/notes.md", "hello"],
        ["/docs/a.txt", "abc"],
        ["/docs/nested/deep/b.bin", "x".repeat(256)],
        ["/.Trash/old.txt", "deleted"],
        ["/.Trash/folder/x.md", "xx"],
        ["/.config/settings.json", "{}"]
      ]);
      await ws.mkdir("/.Trash/folder/empty");
      await ws.mkdir("/empty");
      await ws.symlink("notes.md", "/latest");
      await ws.symlink("nested", "/docs/link-dir");
      await ws.symlink("gone", "/.Trash/dangling");
      await ws.symlink("../a.txt", "/docs/nested/up");
      // The optional signal must leave the method assignable to Shell's own.
      const getWorkspaceInfo: Workspace["getWorkspaceInfo"] =
        ws.getWorkspaceInfo.bind(ws);
      const { result, listed, read } = await observeNativeAccess(
        root,
        getWorkspaceInfo
      );
      return {
        info: result,
        listed: listed.sort(),
        read: read.filter((path) => path.startsWith("data/")).sort()
      };
    }
    case "workspace-info-abort": {
      await seedFiles(
        ws,
        Array.from({ length: 10 }, (_, index) => [`/d${index}/file.txt`, "x"])
      );
      const controller = new AbortController();
      const { result, listed } = await observeNativeAccess(
        root,
        () =>
          ws
            .getWorkspaceInfo({ signal: controller.signal })
            .then(() => "no error", errorName),
        (count) => {
          if (count === 3) controller.abort();
        }
      );
      return { error: result, listings: listed.length };
    }
    case "append":
      for (let index = 0; index < 12; index++)
        await ws.appendFile("/shared.txt", `${writer}:${index}\n`);
      return "done";
    case "read-appends":
      return (await ws.readFile("/shared.txt"))?.trim().split("\n").sort();
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

self.onmessage = async (
  event: MessageEvent<{ name: string; operation: string; writer?: string }>
) => {
  try {
    self.postMessage({
      result: await run(
        event.data.name,
        event.data.operation,
        event.data.writer
      )
    });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error)
    });
  }
};
