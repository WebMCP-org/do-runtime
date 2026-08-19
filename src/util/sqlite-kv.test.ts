/**
 * ← workerd `src/workerd/util/sqlite-kv-test.c++`, all five `KJ_TEST` cases.
 *
 * Upstream builds its database from `kj::newInMemoryDirectory`; ours comes from
 * `backends/node-sqlite.ts` on `:memory:`, which is the same idea through the
 * substrate we actually have.
 *
 * Three assertions upstream makes cannot be made here, and each one is about
 * `sqlite.{h,c++}` rather than about `SqliteKv`:
 *
 *  - `sqliteObserver.rowsRead` / `rowsWritten`. These are billing counters read
 *    from libsql's `STMTSTATUS_ROWS_READ` / `_WRITTEN`, which neither
 *    `node:sqlite` nor sqlite-wasm exposes. Nothing in `sqlite-kv.c++` branches
 *    on them.
 *  - `KJ_EXPECT_THROW_MESSAGE("string or blob too big: SQLITE_TOOBIG", ...)`.
 *    The 2.2MB ceiling is workerd's `SQLITE_MAX_LENGTH` build flag, not a
 *    SQLite default (which is 1e9) and not something either backend can set.
 *    The half of "large key" that survives — a 2MB key round-tripping — is the
 *    half that tests `SqliteKv`.
 *  - The same limit is how "multi-put rollback on error" forces a put to fail
 *    mid-batch. Here the failure is injected at the `SqlDatabase` seam instead,
 *    so the SAVEPOINT/ROLLBACK TO under test still runs against real SQLite.
 */

import { describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SqliteKv } from "./sqlite-kv";
import { SqliteDatabase, type SqlDatabase, type SqlResult, type SqlValue } from "./sqlite";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);

async function openDatabase(wrap?: (backend: SqlDatabase) => SqlDatabase): Promise<SqliteDatabase> {
  const backend = await createNodeSqlProvider().open("foo");
  return new SqliteDatabase(wrap === undefined ? backend : wrap(backend));
}

function listing(kv: SqliteKv) {
  return (
    begin: string,
    end: string | undefined,
    limit: number | undefined,
    order: "FORWARD" | "REVERSE",
  ): string => {
    const results: string[] = [];
    const count = kv.list(begin, end, limit, order, (key, value) => {
      results.push(`${key}=${text(value)}`);
    });
    expect(results.length).toBe(count);
    return results.join(", ");
  };
}

describe("SQLite-KV", () => {
  test("refuses an incompatible present table without changing it", async () => {
    const db = await openDatabase();
    db.run("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value TEXT)");
    const before = db.run("SELECT sql FROM sqlite_master WHERE name = '_cf_KV'").rawRows;

    expect(() => new SqliteKv(db)).toThrow("Incompatible @mcp-b/do-runtime storage schema");
    expect(db.run("SELECT sql FROM sqlite_master WHERE name = '_cf_KV'").rawRows).toEqual(before);
  });

  test("refuses an incompatible table whose name differs only by case", async () => {
    const db = await openDatabase();
    db.run("CREATE TABLE _CF_KV (key TEXT PRIMARY KEY, value TEXT)");

    expect(() => new SqliteKv(db)).toThrow("Incompatible @mcp-b/do-runtime storage schema");
  });

  test("SQLite-KV", async () => {
    const kv = new SqliteKv(await openDatabase());

    kv.put("foo", bytes("abc"));
    kv.put("bar", bytes("def"));
    kv.put("baz", bytes("123"));
    kv.put("qux", bytes("321"));

    expect(text(kv.get("foo") as Uint8Array)).toBe("abc");
    expect(text(kv.get("bar") as Uint8Array)).toBe("def");
    expect(kv.get("corge")).toBeUndefined();

    const list = listing(kv);
    const F = "FORWARD" as const;
    const R = "REVERSE" as const;

    expect(list("", undefined, undefined, F)).toBe("bar=def, baz=123, foo=abc, qux=321");
    expect(list("cat", undefined, undefined, F)).toBe("foo=abc, qux=321");
    expect(list("foo", undefined, undefined, F)).toBe("foo=abc, qux=321");
    expect(list("fop", undefined, undefined, F)).toBe("qux=321");
    expect(list("foo ", undefined, undefined, F)).toBe("qux=321");

    expect(list("", "cat", undefined, F)).toBe("bar=def, baz=123");
    expect(list("", "foo", undefined, F)).toBe("bar=def, baz=123");
    expect(list("", "fop", undefined, F)).toBe("bar=def, baz=123, foo=abc");

    expect(list("", undefined, 2, F)).toBe("bar=def, baz=123");
    expect(list("", undefined, 3, F)).toBe("bar=def, baz=123, foo=abc");
    expect(list("baz", undefined, 2, F)).toBe("baz=123, foo=abc");
    expect(list("", "foo", 1, F)).toBe("bar=def");
    expect(list("", "foo", 2, F)).toBe("bar=def, baz=123");
    expect(list("", "foo", 3, F)).toBe("bar=def, baz=123");

    expect(list("", undefined, undefined, R)).toBe("qux=321, foo=abc, baz=123, bar=def");
    expect(list("foo", undefined, undefined, R)).toBe("qux=321, foo=abc");
    expect(list("", "foo", undefined, R)).toBe("baz=123, bar=def");
    expect(list("", undefined, 2, R)).toBe("qux=321, foo=abc");
    expect(list("", "foo", 1, R)).toBe("baz=123");

    expect(kv.delete("baz")).toBe(true);
    expect(kv.delete("corge")).toBe(false);

    expect(list("", undefined, undefined, F)).toBe("bar=def, foo=abc, qux=321");

    // Put can overwrite.
    kv.put("foo", bytes("hello"));
    expect(list("", undefined, undefined, F)).toBe("bar=def, foo=hello, qux=321");

    // deleteAll()
    expect(kv.deleteAll()).toBe(3);
    expect(list("", undefined, undefined, F)).toBe("");

    expect(kv.get("bar")).toBeUndefined();

    kv.put("bar", bytes("ghi"));
    kv.put("corge", bytes("garply"));

    expect(list("", undefined, undefined, F)).toBe("bar=ghi, corge=garply");
    expect(text(kv.get("bar") as Uint8Array)).toBe("ghi");
  });

  test("large key", async () => {
    const kv = new SqliteKv(await openDatabase());

    // 2MB because we document a 2MB limit for SQLite Durable Objects.
    const closeToLimitString = "x".repeat(2_000_000);
    kv.put(closeToLimitString, bytes("hello"));

    expect(text(kv.get(closeToLimitString) as Uint8Array)).toBe("hello");
  });

  test("SQLite-KV multi-put", async () => {
    const kv = new SqliteKv(await openDatabase());

    kv.put(
      [
        { key: "foo", value: bytes("abc") },
        { key: "bar", value: bytes("def") },
        { key: "baz", value: bytes("123") },
      ],
      { allowUnconfirmed: false },
    );

    expect(text(kv.get("foo") as Uint8Array)).toBe("abc");
    expect(text(kv.get("bar") as Uint8Array)).toBe("def");
    expect(text(kv.get("baz") as Uint8Array)).toBe("123");

    // Test multi-put overwrites existing values.
    kv.put(
      [
        { key: "foo", value: bytes("xyz") },
        { key: "bar", value: bytes("uvw") },
      ],
      { allowUnconfirmed: false },
    );

    expect(text(kv.get("foo") as Uint8Array)).toBe("xyz");
    expect(text(kv.get("bar") as Uint8Array)).toBe("uvw");
    // Verify other key unchanged.
    expect(text(kv.get("baz") as Uint8Array)).toBe("123");

    // Test empty multi-put (should succeed).
    kv.put([], { allowUnconfirmed: false });

    // Verify database unchanged.
    expect(text(kv.get("foo") as Uint8Array)).toBe("xyz");
  });

  test("SQLite-KV multi-put rollback on error", async () => {
    const db = await openDatabase((backend) => failingOn(backend, "key3"));
    const kv = new SqliteKv(db);

    // Pre-populate with some data.
    kv.put("existing", bytes("value"));

    expect(() =>
      kv.put(
        [
          { key: "key1", value: bytes("value1") },
          { key: "key2", value: bytes("value2") },
          { key: "key3", value: bytes("value3") },
        ],
        { allowUnconfirmed: false },
      ),
    ).toThrow("string or blob too big: SQLITE_TOOBIG");

    // Verify that the first two keys were NOT written (transaction rolled back).
    expect(kv.get("key1")).toBeUndefined();
    expect(kv.get("key2")).toBeUndefined();

    // Verify existing data is unchanged.
    expect(text(kv.get("existing") as Uint8Array)).toBe("value");
  });

  test("SQLite-KV multi-put with allowUnconfirmed", async () => {
    const kv = new SqliteKv(await openDatabase());

    kv.put(
      [
        { key: "foo", value: bytes("abc") },
        { key: "bar", value: bytes("def") },
      ],
      { allowUnconfirmed: true },
    );

    expect(text(kv.get("foo") as Uint8Array)).toBe("abc");
    expect(text(kv.get("bar") as Uint8Array)).toBe("def");
  });
});

/**
 * Ours, not upstream's: the cursor form of `list()`. Upstream reaches it
 * through `forEach` in every one of its own assertions, so `next()` and the
 * one-cursor-at-a-time rule have no test there.
 */
describe("SqliteKv::ListCursor", () => {
  test("a cursor walks one pair at a time and then reports none", async () => {
    const kv = new SqliteKv(await openDatabase());
    kv.put("a", bytes("1"));
    kv.put("b", bytes("2"));

    const cursor = kv.list("", undefined, undefined, "FORWARD");
    expect(cursor.next()).toEqual({ key: "a", value: bytes("1") });
    expect(cursor.next()).toEqual({ key: "b", value: bytes("2") });
    expect(cursor.next()).toBeUndefined();
    expect(cursor.wasCanceled()).toBe(false);
  });

  test("starting a second list cancels the first", async () => {
    const kv = new SqliteKv(await openDatabase());
    kv.put("a", bytes("1"));

    const first = kv.list("", undefined, undefined, "FORWARD");
    const second = kv.list("", undefined, undefined, "FORWARD");

    expect(first.wasCanceled()).toBe(true);
    expect(first.next()).toBeUndefined();
    expect(second.wasCanceled()).toBe(false);
    expect(second.next()).toEqual({ key: "a", value: bytes("1") });
  });

  test("listing an uncreated table yields an empty cursor", async () => {
    const kv = new SqliteKv(await openDatabase());

    const cursor = kv.list("", undefined, undefined, "FORWARD");
    expect(cursor.next()).toBeUndefined();
    expect(cursor.wasCanceled()).toBe(false);
  });
});

/** Throws in place of one specific put, standing in for workerd's SQLITE_TOOBIG. */
function failingOn(backend: SqlDatabase, key: string): SqlDatabase {
  return {
    prepare(sql) {
      const statement = backend.prepare(sql);
      return {
        sql: statement.sql,
        parameterCount: statement.parameterCount,
        execute(params) {
          if (params[0] === key) throw new Error("string or blob too big: SQLITE_TOOBIG");
          return statement.execute(params);
        },
        close: () => statement.close(),
      };
    },
    exec(sql: string, params: readonly SqlValue[]): SqlResult {
      if (params[0] === key) throw new Error("string or blob too big: SQLITE_TOOBIG");
      return backend.exec(sql, params);
    },
    get databaseSize(): number {
      return backend.databaseSize;
    },
    // Delegated, not stubbed: answering this wrong makes the real database look
    // like it auto-rolled back, and the rollback under test would be reported as
    // a critical error instead.
    get inTransaction(): boolean {
      return backend.inTransaction;
    },
    reset: () => backend.reset(),
    close: () => backend.close(),
  };
}
