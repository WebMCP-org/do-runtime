import { Buffer } from "node:buffer";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { expect, test, vi } from "vitest";
import {
  createSqliteWasmProvider,
  exportSqliteWasmPoolSnapshot,
  importSqliteWasmPoolSnapshot,
  installSqliteWasmHost,
  SqliteWasmActorStorage,
  SqliteWasmDatabase,
  SqliteWasmPoolRestoreError,
  SqliteWasmRestoreError,
  validateSqliteWasmPoolSnapshot,
  type SqliteWasmDatabaseHandle,
  type SqliteWasmHost,
  type SqliteWasmPoolSnapshot,
  type SqliteWasmStatement,
} from "./sqlite-wasm";

/** The real engine over Emscripten's in-memory filesystem; no test here reaches OPFS. */
const sqlite3 = await sqlite3InitModule();

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
      reserveMinimumCapacity: async (minimum: number) => minimum,
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

test("opens reserve every file plus a journal per connection, one at a time", async () => {
  const files = new Map<string, Uint8Array>();
  const host = memoryHost(files);
  const reserved: number[] = [];
  const provider = createSqliteWasmProvider(
    {
      ...host,
      pool: {
        ...host.pool,
        // SQLite creates the database file when it opens it.
        OpfsSAHPoolDb: class extends FakeDatabase {
          constructor(filename: string) {
            super();
            files.set(filename, new Uint8Array());
          }
        },
        reserveMinimumCapacity: async (minimum: number) => {
          reserved.push(minimum);
          return minimum;
        },
      },
    },
    { prefix: "/actor" },
  );

  // Concurrent, as a root and its facets open; each reservation sees every open before it.
  await Promise.all(["root", "facets", "facet"].map((name) => provider.open(name)));
  expect(reserved).toEqual([2, 4, 6]);
  provider.close();
  // Three files and one connection; closing asked for nothing.
  (await provider.open("root")).close();
  expect(reserved).toEqual([2, 4, 6, 4]);
});

test("a failed open leaves no connection counted", async () => {
  const host = memoryHost(new Map());
  const reserved: number[] = [];
  host.pool.reserveMinimumCapacity = async (minimum) => {
    reserved.push(minimum);
    return minimum;
  };
  const provider = createSqliteWasmProvider(host, { prefix: "/actor" });
  const limit = host.capi.sqlite3_limit;
  host.capi.sqlite3_limit = () => {
    throw new Error("SQLite setup failed");
  };
  await expect(provider.open("root")).rejects.toThrow("SQLite setup failed");
  host.capi.sqlite3_limit = limit;
  (await provider.open("root")).close();
  // This fake creates no file, so each open asks for its own file and journal and nothing more.
  expect(reserved).toEqual([2, 2]);
});

test("imports reserve their files in the open queue and refuse an open queued ahead of them", async () => {
  const image = headerOnlyImage();
  const files = new Map([
    ["/source.root.sqlite", image],
    ["/source.facets.sqlite", image],
  ]);
  const host = memoryHost(files);
  const reserved: number[] = [];
  host.pool.reserveMinimumCapacity = async (minimum) => {
    reserved.push(minimum);
    return minimum;
  };
  // A running actor, whose journal needs a slot through every import below.
  const running = await createSqliteWasmProvider(host, { prefix: "/running" }).open("root");
  await new SqliteWasmActorStorage(host, "/clone").copyFrom(new SqliteWasmActorStorage(host, "/source"));
  const restore = createSqliteWasmProvider(host, { prefix: "/restore" });
  await restore.importSnapshot({ version: 1, databases: [{ name: "root", image }] });
  // 2 files + 2 for the open; then 2 files + 2 cloned + 1 journal; then 4 + 1 restored + 1.
  expect(reserved).toEqual([4, 5, 6]);

  const opening = restore.open("root");
  await expect(
    restore.importSnapshot({ version: 1, databases: [{ name: "root", image }] }),
  ).rejects.toThrow("Cannot snapshot or restore while database handles are open.");
  (await opening).close();
  running.close();
});

test("a clone closes a destination open queued ahead of it before replacing its files", async () => {
  const image = headerOnlyImage();
  const files = new Map([
    ["/source.root.sqlite", image],
    ["/clone.root.sqlite", image],
  ]);
  const base = memoryHost(files);
  const handles = new Set<SqliteWasmDatabaseHandle>();
  const handlesAtUnlink: number[] = [];
  const host: SqliteWasmHost = {
    ...base,
    pool: {
      ...base.pool,
      OpfsSAHPoolDb: class extends FakeDatabase {
        constructor() {
          super();
          handles.add(this);
        }
        override close(): void {
          handles.delete(this);
        }
      },
      unlink: (name) => {
        handlesAtUnlink.push(handles.size);
        return files.delete(name);
      },
      // A macrotask, so the open is still queued when the clone starts.
      reserveMinimumCapacity: (minimum) =>
        new Promise<number>((resolve) => setTimeout(() => resolve(minimum))),
    },
  };
  const destination = new SqliteWasmActorStorage(host, "/clone");
  const opening = destination.open("root");
  await destination.copyFrom(new SqliteWasmActorStorage(host, "/source"));
  expect(handlesAtUnlink).toEqual([0]);
  expect(handles.size).toBe(0);
  await opening;
});

test("a failed growth fails that open with the pool's error and does not hold up the next", async () => {
  const host = memoryHost(new Map());
  const quota = new DOMException("The pool could not grow.", "QuotaExceededError");
  let full = true;
  const provider = createSqliteWasmProvider(
    {
      ...host,
      pool: {
        ...host.pool,
        reserveMinimumCapacity: async (minimum: number) => {
          if (full) throw quota;
          return minimum;
        },
      },
    },
    { prefix: "/actor" },
  );
  await expect(provider.open("root")).rejects.toBe(quota);
  full = false;
  await expect(provider.open("root")).resolves.toBeInstanceOf(SqliteWasmDatabase);
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
      reserveMinimumCapacity: async (minimum: number) => minimum,
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
      reserveMinimumCapacity: async (minimum: number) => minimum,
    },
  } satisfies SqliteWasmHost;

  const source = new SqliteWasmActorStorage(host, "/source");
  const destination = new SqliteWasmActorStorage(host, "/destination");
  await expect(destination.copyFrom(source)).rejects.toThrow("source export failed");

  expect(files.get("/destination.root.sqlite")).toEqual(new Uint8Array([2]));
});

test.each(["snapshot", "clone"])("failed %s replacement restores every destination database", async (operation) => {
  const image = headerOnlyImage();
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
  const image = headerOnlyImage();
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

test("snapshot import imports the bytes it validated, whatever the caller does with its buffers", async () => {
  const image = Buffer.alloc(512);
  image.set(new TextEncoder().encode("SQLite format 3\0"));
  const expected = new Uint8Array(image);
  const files = new Map([["/destination.root.sqlite", new Uint8Array([1])]]);
  const host = memoryHost(files);
  // The restore waits in the queue for its headroom while the caller reuses the buffer.
  const reserving = Promise.withResolvers<number>();
  host.pool.reserveMinimumCapacity = () => reserving.promise;
  const restoring = createSqliteWasmProvider(host, { prefix: "/destination" }).importSnapshot({
    version: 1,
    databases: [{ name: "root", image }],
  });
  image.fill(0);
  reserving.resolve(0);
  await restoring;
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

test("whole-pool snapshots cover every prefix and replace larger and orphan files", async () => {
  const image = sqliteImage("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('before')");
  const files = new Map([
    ["/actor.root.sqlite", image],
    ["/facet-1.root.sqlite", image],
  ]);
  const { pool } = memoryHost(files);
  const snapshot = await exportSqliteWasmPoolSnapshot(sqlite3, pool);
  expect(snapshot.files.map(({ name }) => name)).toEqual([
    "/actor.root.sqlite",
    "/facet-1.root.sqlite",
  ]);
  files.set("/orphan.root.sqlite", image);
  files.set("/actor.root.sqlite", new Uint8Array(image.byteLength * 2));
  await importSqliteWasmPoolSnapshot(sqlite3, pool, snapshot);
  expect(await exportSqliteWasmPoolSnapshot(sqlite3, pool)).toEqual(snapshot);
});

test("whole-pool preflight refuses bad names and images before replacing anything", async () => {
  const image = sqliteImage("CREATE TABLE state(value TEXT)");
  const files = new Map([["/actor.root.sqlite", image]]);
  const original = new Map(files);
  const { pool } = memoryHost(files);
  const trailing = new Uint8Array(image.byteLength + 1);
  trailing.set(image);
  const corrupt = new Uint8Array(image);
  corrupt.fill(255, 100);
  const newer = new Uint8Array(image);
  new DataView(newer.buffer).setInt32(60, 0x7fffffff);
  const cases: [SqliteWasmPoolSnapshot["files"][number], string][] = [
    [{ name: `/${"é".repeat(255)}`, image }, "Invalid SQLite pool filename"],
    [{ name: "/bad\0name.sqlite", image }, "Invalid SQLite pool filename"],
    [{ name: "/new.root.sqlite", image }, "Duplicate SQLite pool filename"],
    [{ name: "/actor.root.sqlite", image: trailing }, "is not a valid SQLite database image"],
    [{ name: "/actor.root.sqlite", image: corrupt }, "database disk image is malformed"],
    [{ name: "/actor.root.sqlite", image: newer }, "written by a newer @mcp-b/do-runtime"],
  ];
  for (const [invalid, refusal] of cases) {
    const snapshot = { version: 1, files: [{ name: "/new.root.sqlite", image }, invalid] } as const;
    expect(() => validateSqliteWasmPoolSnapshot(sqlite3, snapshot)).toThrow(refusal);
    await expect(importSqliteWasmPoolSnapshot(sqlite3, pool, snapshot)).rejects.toThrow(refusal);
    expect(files).toEqual(original);
  }
});

test("whole-pool validation and restore refuse a malformed snapshot before reading its files", async () => {
  const files = new Map([["/actor.root.sqlite", headerOnlyImage()]]);
  const original = new Map(files);
  const { pool } = memoryHost(files);
  const cases: [unknown, string][] = [
    [null, "Unsupported SQLite pool snapshot format."],
    [{ version: 1, files: null }, "Unsupported SQLite pool snapshot format."],
    [{ version: 1, files: [null] }, "SQLite pool snapshot contains an invalid file entry."],
  ];
  for (const [malformed, refusal] of cases) {
    const snapshot = malformed as SqliteWasmPoolSnapshot;
    expect(() => validateSqliteWasmPoolSnapshot(sqlite3, snapshot)).toThrow(refusal);
    await expect(importSqliteWasmPoolSnapshot(sqlite3, pool, snapshot)).rejects.toThrow(refusal);
    expect(files).toEqual(original);
  }
});

test("whole-pool failed replacement rolls back and preserves recoverable originals", async () => {
  const image = sqliteImage("CREATE TABLE state(value TEXT)");
  const files = new Map([
    ["/actor.root.sqlite", image],
    ["/facet-1.root.sqlite", image],
  ]);
  const original = new Map(files);
  const { pool } = memoryHost(files);
  const importDb = pool.importDb;
  let calls = 0;
  pool.importDb = (name, bytes) => {
    if (++calls === 2) throw new Error("native import failed");
    return importDb(name, bytes);
  };
  const snapshot: SqliteWasmPoolSnapshot = {
    version: 1,
    files: [
      { name: "/actor.root.sqlite", image },
      { name: "/facet-2.root.sqlite", image },
    ],
  };
  await expect(importSqliteWasmPoolSnapshot(sqlite3, pool, snapshot)).rejects.toThrow(
    "native import failed",
  );
  expect(files).toEqual(original);

  pool.importDb = () => {
    throw new Error("persistent I/O failure");
  };
  const error = await importSqliteWasmPoolSnapshot(sqlite3, pool, snapshot).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SqliteWasmPoolRestoreError);
  if (!(error instanceof SqliteWasmPoolRestoreError)) throw new Error("missing recovery images");
  expect(error.recoverySnapshot.files).toEqual([
    { name: "/actor.root.sqlite", image },
    { name: "/facet-1.root.sqlite", image },
  ]);
});

test("whole-pool export and restore refuse a journal SQLite cannot roll back", async () => {
  const image = sqliteImage("CREATE TABLE state(value TEXT)");
  // No database beside it, so no connection can consume it.
  const files = new Map([
    ["/actor.root.sqlite", image],
    ["/gone.root.sqlite-journal", new Uint8Array(512)],
  ]);
  const original = new Map(files);
  const { pool } = memoryHost(files);
  await expect(exportSqliteWasmPoolSnapshot(sqlite3, pool)).rejects.toThrow(
    "Cannot export a snapshot with a SQLite recovery sidecar: /gone.root.sqlite-journal",
  );
  await expect(
    importSqliteWasmPoolSnapshot(sqlite3, pool, {
      version: 1,
      files: [{ name: "/actor.root.sqlite", image }],
    }),
  ).rejects.toThrow(
    "Cannot restore a snapshot with a SQLite recovery sidecar: /gone.root.sqlite-journal",
  );
  expect(files).toEqual(original);
});

test("whole-pool export is a rescue path for a newer storage version and refuses open handles", async () => {
  const image = sqliteImage("CREATE TABLE state(value TEXT); PRAGMA user_version = 2147483647");
  const host = memoryHost(new Map([["/actor.root.sqlite", image]]));
  expect(await exportSqliteWasmPoolSnapshot(sqlite3, host.pool)).toEqual({
    version: 1,
    files: [{ name: "/actor.root.sqlite", image }],
  });
  const open = await createSqliteWasmProvider(host, { prefix: "/actor" }).open("root");
  await expect(exportSqliteWasmPoolSnapshot(sqlite3, host.pool)).rejects.toThrow(
    "Cannot snapshot or restore while database handles are open.",
  );
  open.close();
});

/** The smallest image the snapshot checks accept: one page carrying SQLite's header. */
function headerOnlyImage(): Uint8Array {
  const image = new Uint8Array(512);
  image.set(new TextEncoder().encode("SQLite format 3\0"));
  return image;
}

/** A real SQLite database image, built by `sql` in memory. */
function sqliteImage(sql: string): Uint8Array {
  const database = new sqlite3.oo1.DB();
  try {
    database.exec(sql);
    return sqlite3.capi.sqlite3_js_db_export(database);
  } finally {
    database.close();
  }
}

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
      reserveMinimumCapacity: async (minimum) => minimum,
    },
  };
}
