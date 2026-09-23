import { Buffer } from "node:buffer";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { expect, test, vi } from "vitest";
import {
  createSqliteWasmProvider,
  installSqliteWasmHost,
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

test("a column-less statement reports its own changeCount: 0 after DDL, 1 for an FTS5 row", async () => {
  // The real engine over Emscripten's in-memory filesystem; the pool is not involved.
  const sqlite3 = await sqlite3InitModule();
  const pool = { ...memoryHost(new Map()).pool, OpfsSAHPoolDb: sqlite3.oo1.DB };
  const database = new SqliteWasmDatabase({ pool, capi: sqlite3.capi }, "/actor.root.sqlite");
  database.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);

  expect(database.exec("INSERT INTO things VALUES (1), (2), (3)", []).rowsWritten).toBe(3);
  // sqlite3_changes() is not reset by DDL, so it would still say 3 here.
  expect(database.exec("CREATE TABLE other (id INTEGER)", []).rowsWritten).toBe(0);
  // total_changes() also counts FTS5's shadow-table writes.
  database.exec("CREATE VIRTUAL TABLE docs USING fts5(body)", []);
  expect(database.exec("INSERT INTO docs VALUES ('one')", []).rowsWritten).toBe(1);
  expect(database.exec("INSERT INTO docs VALUES ('two') RETURNING rowid", []).rowsWritten).toBe(1);
  database.close();
});

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

test.each(["open", "reset"])("%s closes the new handle when SQLite setup fails", async (operation) => {
  const handles = new Set<SqliteWasmDatabaseHandle>();
  const host = memoryHost(new Map([["/actor.root.sqlite", new Uint8Array()]]));
  const provider = createSqliteWasmProvider(
    {
      ...host,
      pool: {
        ...host.pool,
        OpfsSAHPoolDb: class extends FakeDatabase {
          constructor() {
            super();
            handles.add(this);
          }
          override close(): void {
            handles.delete(this);
          }
        },
      },
    },
    { prefix: "/actor" },
  );
  const database = operation === "reset" ? await provider.open("root") : undefined;
  host.capi.sqlite3_limit = () => {
    throw new Error("SQLite setup failed");
  };

  if (database === undefined) {
    await expect(provider.open("root")).rejects.toThrow("SQLite setup failed");
  } else {
    expect(() => database.reset()).toThrow("SQLite setup failed");
  }
  expect(handles.size).toBe(0);
  provider.close();
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

test("a pool is installed only after its previous owner has released every file", async () => {
  // A failed install deletes the pool directory, so the driver must not see a held file.
  let held = 2;
  const file = {
    kind: "file",
    createSyncAccessHandle: async () => {
      if (held === 0) return { close: () => {} };
      held -= 1;
      throw new DOMException("held by a terminated worker", "NoModificationAllowedError");
    },
  };
  const root = opfsDirectory({ ".pool": opfsDirectory({ ".opaque": opfsDirectory({ slot: file }) }) });
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  const heldAtInstall: number[] = [];
  try {
    const installing = installSqliteWasmHost(
      {
        capi: { ...memoryHost(new Map()).capi, sqlite3_vfs_find: () => 0 },
        wasm: {},
        installOpfsSAHPoolVfs: async () => {
          heldAtInstall.push(held);
          throw new Error("installed");
        },
      },
      { name: "pool" },
    );
    await expect(installing).rejects.toThrow("installed");
  } finally {
    vi.unstubAllGlobals();
  }
  expect(heldAtInstall).toEqual([0]);
});

test("concurrent installs of one pool share a single install", async () => {
  // Otherwise the second call's wait would see the first call's handles as held.
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfsDirectory({}) } });
  let installs = 0;
  const sqlite3 = {
    capi: { ...memoryHost(new Map()).capi, sqlite3_vfs_find: () => 0 },
    wasm: {},
    installOpfsSAHPoolVfs: async () => {
      installs += 1;
      return memoryHost(new Map()).pool;
    },
  };
  try {
    const [first, second] = await Promise.all([
      installSqliteWasmHost(sqlite3, { name: "pool" }),
      installSqliteWasmHost(sqlite3, { name: "pool" }),
    ]);
    expect(second).toBe(first);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(installs).toBe(1);
});

/** An OPFS directory handle over `entries`, as much of one as the pool wait reads. */
function opfsDirectory(entries: Record<string, unknown>) {
  return {
    getDirectoryHandle: async (name: string) => {
      const entry = entries[name];
      if (entry === undefined) throw new DOMException(name, "NotFoundError");
      return entry;
    },
    values: async function* () {
      yield* Object.values(entries);
    },
  };
}

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
