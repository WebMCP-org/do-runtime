import { expect, test } from "vitest";
import {
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
      unlink: () => false,
    },
  } satisfies SqliteWasmHost;
  const database = new SqliteWasmDatabase(host, "/actor.root.sqlite");

  expect(() => database.reset()).toThrow("SAH pool did not unlink /actor.root.sqlite");
  expect(opened).toEqual(["/actor.root.sqlite"]);
});
