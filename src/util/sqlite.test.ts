/**
 * ← workerd `src/workerd/util/sqlite-test.c++`, the `KJ_TEST("SQLite onRollback")` case.
 *
 * That file has 29 cases and 28 of them measure workerd's binding to the SQLite
 * C API — the VFS, read-only attach, the authorizer, row counters, prepareMulti,
 * the memory-metering allocator, critical-error handling. None of that is ported
 * here, so testing it would be testing `node:sqlite`.
 *
 * `onRollback` is the exception, and it is the one thing in `sqlite.{h,c++}`
 * this package genuinely reimplements: `sqlite-kv` and `sqlite-metadata` both
 * keep in-memory state that a rollback has to invalidate, upstream derives the
 * transaction/savepoint stack from the SQLite authorizer, and we derive it from
 * the statement text instead. The derivation is ours, so its tests are too —
 * the last three cases here have no upstream counterpart and cover what the
 * text-derived version can get wrong that the authorizer-derived one cannot.
 *
 * Upstream's `MockRollbackCallback` distinguishes "still live" from "committed"
 * by whether the `kj::Function` was destroyed. JS has no destructor, so
 * "committed" is asserted through its only observable consequence: a later
 * rollback does not invoke it either.
 */

import { describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SqliteKv } from "./sqlite-kv";
import { SqliteMetadata } from "./sqlite-metadata";
import { SqliteCriticalError, SqliteDatabase } from "./sqlite";

async function openDatabase(): Promise<SqliteDatabase> {
  return new SqliteDatabase(await createNodeSqlProvider().open("foo"));
}

function mockRollbackCallback() {
  let calls = 0;
  return {
    create: () => (): void => {
      calls += 1;
    },
    isStillLive: (): boolean => calls === 0,
    wasRolledBack: (): boolean => calls === 1,
  };
}

/** "Discarded without invoking": not called, and a fresh rollback does not call it either. */
function expectCommitted(db: SqliteDatabase, cb: ReturnType<typeof mockRollbackCallback>): void {
  expect(cb.isStillLive()).toBe(true);
  db.run("BEGIN TRANSACTION");
  db.run("ROLLBACK TRANSACTION");
  expect(cb.isStillLive()).toBe(true);
}

describe("SQLite onRollback", () => {
  test("SQLite onRollback", async () => {
    const db = await openDatabase();

    // With no transactions open, the callback is dropped immediately.
    {
      const cb = mockRollbackCallback();
      db.onRollback(cb.create());
      expectCommitted(db, cb);
    }

    // Committed transactions drop the callback without invoking it.
    {
      db.run("BEGIN TRANSACTION");

      const cb = mockRollbackCallback();
      db.onRollback(cb.create());
      expect(cb.isStillLive()).toBe(true);

      db.run("COMMIT TRANSACTION");

      expectCommitted(db, cb);
    }

    {
      db.run("SAVEPOINT foo");

      const cb = mockRollbackCallback();
      db.onRollback(cb.create());
      expect(cb.isStillLive()).toBe(true);

      db.run("RELEASE SAVEPOINT foo");

      expectCommitted(db, cb);
    }

    // Rollbacks invoke the callback.
    {
      db.run("BEGIN TRANSACTION");

      const cb = mockRollbackCallback();
      db.onRollback(cb.create());
      expect(cb.isStillLive()).toBe(true);

      db.run("ROLLBACK TRANSACTION");

      expect(cb.wasRolledBack()).toBe(true);
    }

    {
      db.run("SAVEPOINT foo");

      const cb = mockRollbackCallback();
      db.onRollback(cb.create());
      expect(cb.isStillLive()).toBe(true);

      db.run("ROLLBACK TO SAVEPOINT foo");
      expect(cb.wasRolledBack()).toBe(true);

      // The savepoint still exists until we release it...
      db.run("RELEASE SAVEPOINT foo");
    }

    // Make a whole stack, do partial rollbacks...
    {
      db.run("BEGIN TRANSACTION");

      const cb1 = mockRollbackCallback();
      db.onRollback(cb1.create());

      db.run("SAVEPOINT foo");
      db.run("SAVEPOINT bar");

      const cb2 = mockRollbackCallback();
      db.onRollback(cb2.create());

      db.run("RELEASE bar");

      expect(cb1.isStillLive()).toBe(true);
      expect(cb2.isStillLive()).toBe(true);

      db.run("SAVEPOINT baz");
      db.run("ROLLBACK TO baz");

      expect(cb1.isStillLive()).toBe(true);
      expect(cb2.isStillLive()).toBe(true);

      db.run("SAVEPOINT qux");
      db.run("ROLLBACK TO foo");

      expect(cb1.isStillLive()).toBe(true);
      expect(cb2.wasRolledBack()).toBe(true);

      db.run("COMMIT TRANSACTION");

      expectCommitted(db, cb1);
    }
  });
});

describe("statement classification", () => {
  test("a batch executes in order and returns the last statement with its bindings", async () => {
    const db = await openDatabase();

    expect(
      db.run(
        "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT); " +
          "INSERT INTO things VALUES (1, 'one'); " +
          "SELECT name FROM things WHERE id = ?;",
        1,
      ).rawRows,
    ).toEqual([["one"]]);

    // A semicolon inside a literal, an identifier or a comment is not a boundary.
    db.run("UPDATE things SET name = 'a;b' WHERE id = 1 -- ;");
    expect(db.run("SELECT name FROM things /* ; */ WHERE id = ?", 1).rawRows[0]?.[0]).toBe("a;b");
  });

  test("a trigger body remains one SQLite statement inside a batch", async () => {
    const db = await openDatabase();

    expect(
      db.run(
        `CREATE TABLE trigger_probe(value INTEGER);
         CREATE TRIGGER trigger_probe_after_insert AFTER INSERT ON trigger_probe BEGIN
           INSERT INTO trigger_probe VALUES (new.value + 1);
           INSERT INTO trigger_probe VALUES (new.value + 98);
         END;
         INSERT INTO trigger_probe VALUES (1);
         SELECT value FROM trigger_probe WHERE value >= ? ORDER BY value;`,
        2,
      ).rawRows,
    ).toEqual([[2], [99]]);
  });

  test("only the final statement accepts exactly its compiled bindings", async () => {
    const db = await openDatabase();

    expect(() => db.run("SELECT ?; SELECT ?", 1)).toThrow(
      "only the last statement can have parameters",
    );
    expect(() => db.run("SELECT ?, ?", 1)).toThrow(
      "Wrong number of parameter bindings for SQL query.",
    );
    expect(() => db.run("SELECT ?")).toThrow("Wrong number of parameter bindings for SQL query.");
  });

  test("SQLite rejects malformed transaction statements before bookkeeping", async () => {
    const db = await openDatabase();

    expect(() => db.run("RELEASE")).toThrow("incomplete input");
    expect(() => db.run("BEGIN CONCURRENT")).toThrow('near "CONCURRENT": syntax error');
  });

  test("transaction statements are recognised in their spelling variants", async () => {
    const db = await openDatabase();

    for (const [open, close] of [
      ["BEGIN", "COMMIT"],
      ["BEGIN TRANSACTION", "END"],
      ["begin immediate", "end transaction"],
      ["BEGIN DEFERRED TRANSACTION", "COMMIT TRANSACTION"],
      ["BEGIN EXCLUSIVE", "ROLLBACK"],
      ["  /* lead */ BEGIN;", "-- trail\n ROLLBACK TRANSACTION ;"],
    ] as const) {
      const cb = mockRollbackCallback();
      db.run(open);
      db.onRollback(cb.create());
      expect(cb.isStillLive()).toBe(true);
      db.run(close);
    }

    // Savepoint names are case-insensitive and may be quoted, so the stack has
    // to fold them the way SQLite does.
    db.run('SAVEPOINT "Foo"');
    const cb = mockRollbackCallback();
    db.onRollback(cb.create());
    db.run("ROLLBACK TO foo");
    expect(cb.wasRolledBack()).toBe(true);
    db.run("RELEASE SAVEPOINT FOO");
  });

  test("reset is refused while a transaction is open", async () => {
    const db = await openDatabase();

    db.run("BEGIN TRANSACTION");
    expect(() => db.reset()).toThrow("can't reset() a database during a transaction");
    db.run("ROLLBACK TRANSACTION");

    db.run("SAVEPOINT foo");
    expect(() => db.reset()).toThrow("can't reset() a database during a transaction");
    db.run("RELEASE foo");

    db.reset();
  });

  test("reset notifies its listeners before the database goes", async () => {
    const db = await openDatabase();
    db.run("CREATE TABLE things (id INTEGER PRIMARY KEY)");

    const seen: string[] = [];
    db.addResetListener({
      beforeSqliteReset(): void {
        // The table is still there at this point; that is what "before" buys a
        // listener that needs to read its own state on the way out.
        seen.push(String(db.run("SELECT count(*) FROM things").rawRows[0]?.[0]));
      },
    });

    db.reset();

    expect(seen).toEqual(["0"]);
    expect(() => db.run("SELECT count(*) FROM things")).toThrow();
  });
});

/**
 * ← `SqliteDatabase::handleCriticalError`, which has no upstream unit test —
 * `sqlite-test.c++`'s three critical-error cases drive it through the C API's
 * error codes, which we never see.
 *
 * A capped `max_page_count` produces a real SQLITE_FULL, and SQLite really does
 * roll the open transaction back underneath us, so nothing here is simulated.
 */
describe("critical errors", () => {
  async function openCappedDatabase(): Promise<SqliteDatabase> {
    const db = new SqliteDatabase(await createNodeSqlProvider().open("foo"));
    db.run("CREATE TABLE things (id INTEGER PRIMARY KEY, payload TEXT)");
    db.run("PRAGMA max_page_count = 32");
    return db;
  }

  function fillUntilFull(db: SqliteDatabase): unknown {
    try {
      for (let index = 0; index < 20_000; index += 1) {
        db.run("INSERT INTO things VALUES (?, ?)", index, "x".repeat(400));
      }
    } catch (error) {
      return error;
    }
    throw new Error("expected the database to fill up");
  }

  test("a transaction SQLite rolled back on its own is detected and is fatal", async () => {
    const db = await openCappedDatabase();

    db.run("BEGIN TRANSACTION");
    const thrown = fillUntilFull(db);

    // Not the driver's "database or disk is full", which a caller would handle
    // as an ordinary statement failure and carry on from.
    expect(thrown).toBeInstanceOf(SqliteCriticalError);
    expect(String(thrown)).toContain("in-memory view of this database is now stale");
    expect((thrown as Error).cause).toBeDefined();

    expect(db.observedCriticalError()).toBe(thrown);
    expect(() => db.run("SELECT 1")).toThrow(SqliteCriticalError);
    expect(() => db.reset()).toThrow(SqliteCriticalError);
  });

  test("a cache the rollback invalidated is never read through", async () => {
    const db = await openCappedDatabase();
    const metadata = new SqliteMetadata(db);
    metadata.setAlarm(1_000, false);

    db.run("BEGIN TRANSACTION");
    metadata.setAlarm(2_000, false);
    fillUntilFull(db);

    // SQLite has taken the 2_000 back and the cache still holds it. The whole
    // point is that nobody gets to read it: every path in throws instead.
    expect(() => metadata.getAlarm()).toThrow(SqliteCriticalError);
    expect(() => metadata.setAlarm(3_000, false)).toThrow(SqliteCriticalError);
  });

  test("an answer served without a statement is refused too", async () => {
    const db = await openCappedDatabase();
    // Never written to, so `get` answers "no table, so no value" from a flag
    // rather than from SQL — the one read a latched error would not stop.
    const kv = new SqliteKv(db);
    expect(kv.get("anything")).toBeUndefined();

    db.run("BEGIN TRANSACTION");
    fillUntilFull(db);

    expect(() => kv.get("anything")).toThrow(SqliteCriticalError);
    expect(() => kv.list("", undefined, undefined, "FORWARD")).toThrow(SqliteCriticalError);
  });

  test("an ordinary failure inside a transaction is left alone", async () => {
    const db = await openCappedDatabase();
    db.run("INSERT INTO things VALUES (1, 'a')");

    db.run("BEGIN TRANSACTION");
    const cb = mockRollbackCallback();
    db.onRollback(cb.create());

    // A constraint violation does not roll anything back, so the transaction is
    // still open, the callback is still live, and firing it here would restore a
    // cache the database has moved past.
    expect(() => db.run("INSERT INTO things VALUES (1, 'b')")).toThrow(/UNIQUE|constraint/i);
    expect(db.observedCriticalError()).toBeUndefined();
    expect(cb.isStillLive()).toBe(true);

    db.run("INSERT INTO things VALUES (2, 'b')");
    db.run("COMMIT TRANSACTION");
    expect(db.run("SELECT count(*) FROM things").rawRows[0]?.[0]).toBe(2);
  });

  test("a failure outside any transaction is left alone", async () => {
    const db = await openCappedDatabase();
    fillUntilFull(db);

    expect(db.observedCriticalError()).toBeUndefined();
    expect(db.run("SELECT 1").rawRows[0]?.[0]).toBe(1);
  });

  test("the backend reports whether SQLite has a transaction open", async () => {
    const backend = await createNodeSqlProvider().open("foo");

    expect(backend.inTransaction).toBe(false);
    backend.exec("BEGIN TRANSACTION", []);
    expect(backend.inTransaction).toBe(true);
    backend.exec("ROLLBACK TRANSACTION", []);
    expect(backend.inTransaction).toBe(false);
  });
});
