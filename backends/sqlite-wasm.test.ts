import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import {
  createSqliteWasmProvider,
  SqliteWasmActorStorage,
  SqliteWasmDatabase,
  SqliteWasmRestoreError,
  type SqliteWasmDatabaseHandle,
  type SqliteWasmHost,
  type SqliteWasmStatement,
} from "./sqlite-wasm";

class FakeDatabase implements SqliteWasmDatabaseHandle {
  readonly pointer = 1;

  prepare(_sql: string): SqliteWasmStatement {
    throw new Error("not used");
  }

  changes(): number {
    return 0;
  }

  close(): void {}
}

test("reset fails closed when the SAH pool does not remove the database", () => {
  const opened: string[] = [];
  const host = {
    capi: {
      SQLITE_LIMIT_LENGTH: 0,
      sqlite3_complete: () => 1 as const,
      sqlite3_get_autocommit: () => 1,
      sqlite3_limit: () => 1,
    },
    pool: {
      OpfsSAHPoolDb: class extends FakeDatabase {
        constructor(filename: string) {
          super();
          opened.push(filename);
        }
      },
      exportFile: async () => new Uint8Array(),
      importDb: async () => 0,
      getFileNames: () => [],
      unlink: () => false,
    },
  } satisfies SqliteWasmHost;
  const database = new SqliteWasmDatabase(host, "/actor.root.sqlite");

  expect(() => database.reset()).toThrow("SAH pool did not unlink /actor.root.sqlite");
  expect(opened).toEqual(["/actor.root.sqlite"]);
});

test("actor storage copies and deletes every database under its prefix", async () => {
  const files = new Map<string, Uint8Array>([
    ["/source.root.sqlite", new Uint8Array([1])],
    ["/source.facets.sqlite", new Uint8Array([2])],
    ["/destination.old.sqlite", new Uint8Array([3])],
  ]);
  const host = {
    capi: {
      SQLITE_LIMIT_LENGTH: 0,
      sqlite3_complete: () => 1 as const,
      sqlite3_get_autocommit: () => 1,
      sqlite3_limit: () => 1,
    },
    pool: {
      OpfsSAHPoolDb: FakeDatabase,
      exportFile: async (name: string) => {
        const image = files.get(name);
        if (image === undefined) throw new Error(`missing test file ${name}`);
        return image;
      },
      importDb: async (name: string, image: Uint8Array) => {
        files.set(name, image);
        return 0;
      },
      getFileNames: () => [...files.keys()],
      unlink: (name: string) => files.delete(name),
    },
  } satisfies SqliteWasmHost;

  const source = new SqliteWasmActorStorage(host, "/source");
  const destination = new SqliteWasmActorStorage(host, "/destination");
  await destination.copyFrom(source);

  expect([...files]).toEqual([
    ["/source.root.sqlite", new Uint8Array([1])],
    ["/source.facets.sqlite", new Uint8Array([2])],
    ["/destination.root.sqlite", new Uint8Array([1])],
    ["/destination.facets.sqlite", new Uint8Array([2])],
  ]);

  destination.deleteAll();
  expect([...files.keys()]).toEqual(["/source.root.sqlite", "/source.facets.sqlite"]);
});

test("actor storage preserves the destination when the source cannot be exported", async () => {
  const files = new Map<string, Uint8Array>([
    ["/source.root.sqlite", new Uint8Array([1])],
    ["/destination.root.sqlite", new Uint8Array([2])],
  ]);
  const host = {
    capi: {
      SQLITE_LIMIT_LENGTH: 0,
      sqlite3_complete: () => 1 as const,
      sqlite3_get_autocommit: () => 1,
      sqlite3_limit: () => 1,
    },
    pool: {
      OpfsSAHPoolDb: FakeDatabase,
      exportFile: async () => {
        throw new Error("source export failed");
      },
      importDb: async (name: string, image: Uint8Array) => {
        files.set(name, image);
        return 0;
      },
      getFileNames: () => [...files.keys()],
      unlink: (name: string) => files.delete(name),
    },
  } satisfies SqliteWasmHost;

  const source = new SqliteWasmActorStorage(host, "/source");
  const destination = new SqliteWasmActorStorage(host, "/destination");
  await expect(destination.copyFrom(source)).rejects.toThrow("source export failed");

  expect(files.get("/destination.root.sqlite")).toEqual(new Uint8Array([2]));
});

test.each(["snapshot", "clone"])("failed %s replacement restores every destination database", async (operation) => {
  const image = new Uint8Array(512);
  image.set(new TextEncoder().encode("SQLite format 3\0"));
  const files = new Map<string, Uint8Array>([
    ["/source.root.sqlite", image],
    ["/source.facets.sqlite", image],
    ["/destination.root.sqlite", new Uint8Array([1])],
    ["/destination.old.sqlite", new Uint8Array([2])],
    ["/unrelated.root.sqlite", new Uint8Array([3])],
  ]);
  const original = new Map(files);
  const host = memoryHost(files);
  const importDb = host.pool.importDb;
  let imports = 0;
  host.pool.importDb = (name, bytes) => {
    // The real pool may have removed/truncated its file before import throws.
    if (++imports === 2) {
      files.delete(name);
      throw new Error("injected import failure");
    }
    return importDb(name, bytes);
  };

  const restore = operation === "snapshot"
    ? createSqliteWasmProvider(host, { prefix: "/destination" }).importSnapshot({
        version: 1,
        databases: [{ name: "root", image }, { name: "facets", image }],
      })
    : new SqliteWasmActorStorage(host, "/destination").copyFrom(
        new SqliteWasmActorStorage(host, "/source"),
      );
  await expect(restore).rejects.toThrow("injected import failure");
  expect(files).toEqual(original);
});

test("a failed rollback retains the original images for host recovery", async () => {
  const image = new Uint8Array(512);
  image.set(new TextEncoder().encode("SQLite format 3\0"));
  const files = new Map([["/destination.root.sqlite", image]]);
  const host = memoryHost(files);
  host.pool.importDb = () => { throw new Error("persistent I/O failure"); };
  const provider = createSqliteWasmProvider(host, { prefix: "/destination" });
  const error = await provider.importSnapshot({ version: 1, databases: [{ name: "root", image }] })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(SqliteWasmRestoreError);
  if (!(error instanceof SqliteWasmRestoreError)) throw new Error("Expected recovery images");
  expect(error.errors).toHaveLength(2);
  const recoveryHost = memoryHost(new Map());
  const recovery = createSqliteWasmProvider(recoveryHost, { prefix: "/recovery" });
  await recovery.importSnapshot(error.recoverySnapshot);
  expect(await recovery.exportSnapshot()).toEqual({ version: 1, databases: [{ name: "root", image }] });
});

test("rollback does not rewrite files that replacement never touched", async () => {
  const files = new Map([
    ["/destination.root.sqlite", new Uint8Array([1])],
    ["/destination.facets.sqlite", new Uint8Array([2])],
  ]);
  const host = memoryHost(files);
  host.pool.unlink = (name) => {
    files.delete(name);
    throw new Error("unlink I/O failure");
  };
  const attempted: string[] = [];
  host.pool.importDb = (name) => {
    attempted.push(name);
    throw new Error("rollback I/O failure");
  };
  await expect(createSqliteWasmProvider(host, { prefix: "/destination" }).importSnapshot({
    version: 1, databases: [],
  })).rejects.toBeInstanceOf(SqliteWasmRestoreError);
  expect(attempted).toEqual(["/destination.root.sqlite"]);
  expect(files.get("/destination.facets.sqlite")).toEqual(new Uint8Array([2]));
});

test("snapshot import copies Buffer inputs before exporting existing storage", async () => {
  const image = Buffer.alloc(512);
  image.set(new TextEncoder().encode("SQLite format 3\0"));
  const expected = new Uint8Array(image);
  const files = new Map([["/destination.root.sqlite", new Uint8Array([1])]]);
  const host = memoryHost(files);
  const exportFile = host.pool.exportFile;
  host.pool.exportFile = (name) => {
    image.fill(0);
    return exportFile(name);
  };
  await createSqliteWasmProvider(host, { prefix: "/destination" }).importSnapshot({
    version: 1, databases: [{ name: "root", image }],
  });
  expect(files.get("/destination.root.sqlite")).toEqual(expected);
});

function memoryHost(files: Map<string, Uint8Array>): SqliteWasmHost {
  return {
    capi: {
      SQLITE_LIMIT_LENGTH: 0,
      sqlite3_complete: () => 1,
      sqlite3_get_autocommit: () => 1,
      sqlite3_limit: () => 1,
    },
    pool: {
      OpfsSAHPoolDb: FakeDatabase,
      getFileNames: () => [...files.keys()],
      exportFile: (name) => {
        const image = files.get(name);
        if (image === undefined) throw new Error(`Missing ${name}`);
        return image;
      },
      importDb: (name, image) => {
        files.set(name, image);
        return 0;
      },
      unlink: (name) => files.delete(name),
    },
  };
}
