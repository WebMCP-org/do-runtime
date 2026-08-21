import { expect, test } from "vitest";
import {
  SqliteWasmActorStorage,
  SqliteWasmDatabase,
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
