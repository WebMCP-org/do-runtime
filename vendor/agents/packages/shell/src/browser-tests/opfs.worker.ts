import { OpfsWorkspace } from "@cloudflare/shell/browser";
import type { WorkspaceFsLike } from "../filesystem";
import { InMemoryFs } from "../fs/in-memory-fs";

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

// The same basic file contract runs on Shell's memory and native implementations.
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
    case "contract":
      return {
        memory: await fileContract(new InMemoryFs()),
        opfs: await fileContract(ws)
      };
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
      await ws.writeFile("/destination.txt", "old");
      await ws.mv("/moved/nested/file.txt", "/destination.txt");
      const overlap = await errorCode(
        ws.cp("/copy", "/copy/nested/inside", { recursive: true })
      );
      await ws.rm("/copy/link");
      return {
        copy: await ws.readFile("/copy/nested/file.txt"),
        copiedLink: await ws.exists("/copy/link"),
        movedLink: await ws.readlink("/moved/link"),
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
