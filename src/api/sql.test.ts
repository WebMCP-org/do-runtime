/**
 * ← workerd `src/workerd/api/sql.{h,c++}`.
 *
 * There is no `sql-test.c++` upstream; `sql.h`'s coverage is the `sql-test.js`
 * behavioural suite, which runs inside a real Durable Object and so belongs to
 * the conformance lane rather than here. What this file asserts is the part of
 * `sql.c++` that is pure translation — cursor semantics, the two `one()`
 * messages, `databaseSize`'s arithmetic, the regulator's refusal of transaction
 * control — plus the three claims that are ours rather than upstream's: the
 * materialised-cursor divergence, the direct-construction refusal that
 * `typeof SqlStorageCursor` forces, and the empty-input-lock-stack throw.
 */

import { expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SqliteDatabase } from "../util/sqlite";
import { InputGate, OutputGate } from "../io/io-gate";
import { type Actor, IoContext, requireInputLock, type Timer } from "../io/io-context";
import {
  CURSOR_NOT_CONSTRUCTIBLE_MESSAGE,
  SQL_RESERVED_PREFIX_MESSAGE,
  SQL_TRANSACTION_REFUSED_MESSAGE,
  SqlStorage,
  SqlStorageRegulator,
} from "./sql";

class TestActor implements Actor {
  readonly inputGate = new InputGate();
  readonly outputGate = new OutputGate();
  getInputGate(): InputGate {
    return this.inputGate;
  }
  getOutputGate(): OutputGate {
    return this.outputGate;
  }
  shutdownActorCache(): void {}
  assertCanSetAlarm(): void {}
}

const idleTimer: Timer = {
  now: () => 0,
  afterDelay: () => new Promise<void>(() => {}),
};

type Fixture = { ctx: IoContext; db: SqliteDatabase; sql: SqlStorage };

async function newFixture(): Promise<Fixture> {
  const db = new SqliteDatabase(await createNodeSqlProvider().open("sql-test"));
  const actor = new TestActor();
  const ctx = new IoContext(actor, idleTimer);
  return { ctx, db, sql: new SqlStorage(ctx, { getSqliteDb: () => db }) };
}

/** Every `sql.*` entry point is gated, so every case runs inside one slice. */
function sqlTest(name: string, body: (fixture: Fixture) => void | Promise<void>): void {
  test(name, async () => {
    const fixture = await newFixture();
    await fixture.ctx.run(() => body(fixture));
  });
}

// =======================================================================================
// Cursor

sqlTest("exec returns a cursor over the rows, with column names", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two')");

  const cursor = sql.exec("SELECT id, label FROM things ORDER BY id");
  expect(cursor.columnNames).toEqual(["id", "label"]);
  expect(cursor.toArray()).toEqual([
    { id: 1, label: "one" },
    { id: 2, label: "two" },
  ]);
});

sqlTest("a cursor is iterable, and iterating consumes it", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (1), (2), (3)");

  const cursor = sql.exec("SELECT id FROM things ORDER BY id");
  expect([...cursor]).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  // Upstream's cursor is a live statement: once drained it yields nothing more.
  expect([...cursor]).toEqual([]);
});

sqlTest("next() reports done exactly as the iterator protocol does", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (7)");

  const cursor = sql.exec("SELECT id FROM things");
  expect(cursor.next()).toEqual({ done: false, value: { id: 7 } });
  expect(cursor.next()).toEqual({ done: true });
});

sqlTest("raw() yields arrays in column order and shares the cursor's position", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two')");

  const cursor = sql.exec("SELECT id, label FROM things ORDER BY id");
  expect(cursor.next()).toEqual({ done: false, value: { id: 1, label: "one" } });
  expect([...cursor.raw()]).toEqual([[2, "two"]]);
});

/**
 * Both cursor iterators are generators, so they inherit `%IteratorPrototype%`
 * exactly as upstream's `JSG_ITERABLE` objects do. `raw().toArray()` is what
 * Drizzle's `durable-sqlite` driver calls on every `values` query, so the
 * helpers are SDK-visible surface rather than a style choice. The static types
 * are Cloudflare's own (`raw(): IterableIterator<U>`, no helpers), which is why
 * the helper calls go through a cast here and in the conformance probe.
 */
type HelpedIterator<T> = IterableIterator<T> & {
  toArray(): T[];
  map<U>(fn: (value: T) => U): HelpedIterator<U>;
  take(limit: number): HelpedIterator<T>;
};
const helpers = <T>(iterator: IterableIterator<T>): HelpedIterator<T> =>
  iterator as HelpedIterator<T>;

sqlTest("both cursor iterators inherit the ES iterator helpers", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two')");
  const query = "SELECT id, label FROM things ORDER BY id";

  const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  expect(iteratorPrototype.isPrototypeOf(sql.exec(query).raw())).toBe(true);
  expect(iteratorPrototype.isPrototypeOf(sql.exec(query)[Symbol.iterator]())).toBe(true);

  expect(helpers(sql.exec(query).raw()).toArray()).toEqual([
    [1, "one"],
    [2, "two"],
  ]);
  expect(helpers(sql.exec(query)[Symbol.iterator]()).toArray()).toEqual([
    { id: 1, label: "one" },
    { id: 2, label: "two" },
  ]);
});

sqlTest("a helper chain pulls only the rows it consumes", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two'), (3, 'three')");

  // `map` and `take` are lazy, and a generator suspends at each `yield`, so the
  // cursor is asked for exactly the one row the chain yields. `rowsRead` is the
  // only window onto that, being the position `#nextRaw` has advanced to.
  const cursor = sql.exec("SELECT id, label FROM things ORDER BY id");
  expect([
    ...helpers(cursor.raw())
      .map((row) => row[1])
      .take(1),
  ]).toEqual(["one"]);
  expect(cursor.rowsRead).toBe(1);

  // Same for `break`. The iterator has no `return()` to close it (see the
  // shape test below), but the position lives on the cursor either way.
  const partial = sql.exec("SELECT id FROM things ORDER BY id");
  for (const _row of partial) break;
  expect(partial.rowsRead).toBe(1);
  // Closing one iterator does not close the cursor: the next one resumes where
  // this one stopped, because the position lives on the cursor.
  expect([...partial]).toEqual([{ id: 2 }, { id: 3 }]);
});

sqlTest("raw() and the row iterator share the cursor's one position", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two'), (3, 'three')");

  const cursor = sql.exec("SELECT id, label FROM things ORDER BY id");
  const raw = cursor.raw();
  expect(raw.next()).toEqual({ done: false, value: [1, "one"] });
  expect(cursor.next()).toEqual({ done: false, value: { id: 2, label: "two" } });
  expect(raw.next()).toEqual({ done: false, value: [3, "three"] });
  expect(cursor.rowsRead).toBe(3);

  // Exhausted stays exhausted, for this iterator and for the cursor.
  expect(raw.next()).toEqual({ done: true, value: undefined });
  expect(raw.next()).toEqual({ done: true, value: undefined });
  expect(cursor.next()).toEqual({ done: true });
});

sqlTest("an early exit leaves a retained iterator open, as upstream's do", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one'), (2, 'two'), (3, 'three')");
  const query = "SELECT id, label FROM things ORDER BY id";

  // `JSG_ITERATOR` registers `next` and self-iterability only — no `return`,
  // no `throw` (jsg/iterator.h:1036-1050; only the async variant has
  // `return_`, :1069-1085) — so `IteratorClose` after a `break`, a partial
  // destructuring, or a `take()` is a no-op and the iterator resumes.
  const abandoned = sql.exec(query).raw();
  for (const row of abandoned) {
    void row;
    break;
  }
  expect(abandoned.next()).toEqual({ done: false, value: [2, "two"] });

  const rows = sql.exec(query)[Symbol.iterator]();
  const [first] = rows;
  expect(first).toEqual({ id: 1, label: "one" });
  expect(rows.next()).toEqual({ done: false, value: { id: 2, label: "two" } });

  const taken = sql.exec(query).raw();
  expect([...helpers(taken).take(1)]).toEqual([[1, "one"]]);
  expect(taken.next()).toEqual({ done: false, value: [2, "two"] });
});

sqlTest("cursor and iterator surfaces carry workerd's shape", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (1, 'one')");
  const query = "SELECT id, label FROM things ORDER BY id";

  // ← jsg resource-type names and `JSG_STRUCT(done, value)` key order
  // (resource.h toStringTag; iterator.h:706-710); `columnNames` is a prototype
  // accessor (sql.h:210), so a cursor JSON-stringifies to `{}`.
  const cursor = sql.exec(query);
  const raw = cursor.raw();
  expect(Object.prototype.toString.call(raw)).toBe("[object RawIterator]");
  expect(Object.prototype.toString.call(sql.exec(query)[Symbol.iterator]())).toBe(
    "[object RowIterator]",
  );
  expect(Object.prototype.toString.call(cursor)).toBe("[object Cursor]");
  expect(typeof raw.return).toBe("undefined");
  expect(typeof (raw as { throw?: unknown }).throw).toBe("undefined");
  expect(Object.getOwnPropertyNames(raw)).toEqual([]);
  expect(raw[Symbol.iterator]()).toBe(raw);
  expect(Object.keys(raw.next())).toEqual(["done", "value"]);
  expect(Object.keys(raw.next())).toEqual(["done", "value"]);
  expect(JSON.stringify(cursor)).toBe("{}");

  const drained = sql.exec(query);
  drained.toArray();
  expect(Object.keys(drained.next())).toEqual(["done", "value"]);
});

sqlTest("PRAGMA outside workerd's allowlist is refused, with workerd's message", ({ sql, db }) => {
  const stamp = () => Number(db.run("PRAGMA user_version").rawRows[0]?.[0]);
  const before = stamp();
  expect(() => sql.exec("PRAGMA user_version = 7")).toThrowError("not authorized: SQLITE_AUTH");
  expect(() => sql.exec("PRAGMA user_version")).toThrowError("not authorized: SQLITE_AUTH");
  expect(() => sql.exec("PRAGMA main.user_version")).toThrowError("not authorized: SQLITE_AUTH");
  expect(() => sql.exec("PRAGMA writable_schema = ON")).toThrowError("not authorized: SQLITE_AUTH");
  expect(() => sql.exec("SELECT * FROM pragma_user_version")).toThrowError(
    "not authorized: SQLITE_AUTH",
  );
  // A batch is regulated per statement, exactly like transaction control.
  expect(() => sql.exec("SELECT 1; PRAGMA user_version = 7")).toThrowError(
    "not authorized: SQLITE_AUTH",
  );
  // The refused statement never reached the database.
  expect(stamp()).toBe(before);
});

sqlTest("allowed pragmas run, and name arguments pass the reserved-name rule", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  expect(sql.exec("PRAGMA table_info(things)").toArray()).toEqual([
    { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
  ]);
  // A quoted argument is the same name; `_cf_` stays refused through either
  // rule (the identifier scan catches the bare form first).
  expect(sql.exec("PRAGMA table_info('things')").toArray().length).toBe(1);
  expect(() => sql.exec("PRAGMA table_info(_cf_KV)")).toThrowError(SQL_RESERVED_PREFIX_MESSAGE);
  expect(() => sql.exec("PRAGMA table_info('_cf_KV')")).toThrowError(
    "not authorized: SQLITE_AUTH",
  );
  expect(() => sql.exec("PRAGMA index_list(_cf_KV)")).toThrowError(SQL_RESERVED_PREFIX_MESSAGE);
  // The boolean set reads back and takes workerd's eight literal forms.
  sql.exec("PRAGMA foreign_keys = ON");
  expect(sql.exec("PRAGMA foreign_keys").one()).toEqual({ foreign_keys: 1 });
  expect(() => sql.exec("PRAGMA foreign_keys = MAYBE")).toThrowError(
    "not authorized: SQLITE_AUTH",
  );
  // The pragma table-valued functions follow the same allowlist; a bound
  // argument is data, exactly as it is for any other statement.
  expect(
    sql.exec("SELECT name FROM pragma_table_info(?)", "things").toArray(),
  ).toEqual([{ name: "id" }]);
  expect(sql.exec("PRAGMA data_version").toArray().length).toBe(1);
  expect(() => sql.exec("PRAGMA data_version = 1")).toThrowError("not authorized: SQLITE_AUTH");
  sql.exec("PRAGMA optimize");
  expect(() => sql.exec("PRAGMA optimize = wrench")).toThrowError("not authorized: SQLITE_AUTH");
});

sqlTest("one() returns the single row", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (42)");
  expect(sql.exec("SELECT id FROM things").one()).toEqual({ id: 42 });
});

sqlTest("one() refuses an empty result, with upstream's message", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  expect(() => sql.exec("SELECT id FROM things").one()).toThrow(
    "Expected exactly one result from SQL query, but got no results.",
  );
});

sqlTest("one() refuses multiple results, with upstream's message", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (1), (2)");
  expect(() => sql.exec("SELECT id FROM things").one()).toThrow(
    "Expected exactly one result from SQL query, but got multiple results.",
  );
});

sqlTest("bindings are passed through as parameters", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, label TEXT)");
  sql.exec("INSERT INTO things VALUES (?, ?)", 5, "five");
  expect(sql.exec("SELECT label FROM things WHERE id = ?", 5).one()).toEqual({ label: "five" });
});

sqlTest("public bindings receive workerd's JSG value conversion", ({ sql }) => {
  const backing = new Uint8Array([9, 1, 2, 3, 8]);
  const bytes = new Uint8Array(backing.buffer, 1, 3);
  const view = new DataView(backing.buffer, 1, 3);
  const buffer = new Uint8Array([4, 5, 6]).buffer;

  expect(
    sql
      .exec(
        `SELECT typeof(?) AS trueType, ? AS trueValue,
                typeof(?) AS falseType, ? AS falseValue,
                typeof(?) AS undefinedType, ? AS undefinedValue,
                hex(?) AS bytesHex, hex(?) AS viewHex, hex(?) AS bufferHex`,
        true,
        true,
        false,
        false,
        undefined,
        undefined,
        bytes,
        view,
        buffer,
      )
      .one(),
  ).toEqual({
    trueType: "text",
    trueValue: "true",
    falseType: "text",
    falseValue: "false",
    undefinedType: "null",
    undefinedValue: null,
    bytesHex: "010203",
    viewHex: "010203",
    bufferHex: "040506",
  });
});

sqlTest("a statement batch returns the last statement and binds only that statement", ({ sql }) => {
  expect(
    sql
      .exec(
        "CREATE TABLE things (id INTEGER, label TEXT); " +
          "INSERT INTO things VALUES (1, 'one'); " +
          "SELECT label FROM things WHERE id = ?;",
        1,
      )
      .one(),
  ).toEqual({ label: "one" });
});

sqlTest("rowsWritten is the statement's change count", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  expect(sql.exec("INSERT INTO things VALUES (1), (2), (3)").rowsWritten).toBe(3);
});

sqlTest("rowsWritten includes DML that returns rows", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  const cursor = sql.exec("INSERT INTO things VALUES (1), (2), (3) RETURNING id");
  expect(cursor.toArray()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(cursor.rowsWritten).toBe(3);
});

sqlTest("rowsRead counts the rows this cursor has yielded", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (1), (2), (3)");

  const cursor = sql.exec("SELECT id FROM things");
  expect(cursor.rowsRead).toBe(0);
  cursor.next();
  expect(cursor.rowsRead).toBe(1);
  cursor.toArray();
  expect(cursor.rowsRead).toBe(3);
});

sqlTest("the cursor class is exposed for instanceof but refuses construction", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  const cursor = sql.exec("SELECT id FROM things");
  expect(cursor).toBeInstanceOf(sql.Cursor);
  expect(() => new sql.Cursor()).toThrow(CURSOR_NOT_CONSTRUCTIBLE_MESSAGE);
});

// =======================================================================================
// databaseSize

sqlTest("databaseSize is the used page count times the page size", ({ sql, db }) => {
  const expected = (): number => {
    const size = db.run("SELECT * FROM pragma_page_size").rawRows[0]?.[0];
    const pages = db.run(
      "SELECT (SELECT * FROM pragma_page_count) - (SELECT * FROM pragma_freelist_count)",
    ).rawRows[0]?.[0];
    return Number(size) * Number(pages);
  };

  expect(sql.databaseSize).toBe(0);
  sql.exec("CREATE TABLE things (id INTEGER, payload BLOB)");
  sql.exec("INSERT INTO things VALUES (1, ?)", new Uint8Array(4096).fill(7));
  expect(sql.databaseSize).toBe(expected());
  expect(sql.databaseSize).toBeGreaterThan(0);
});

sqlTest("databaseSize excludes pages on the freelist", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER, payload BLOB)");
  for (let row = 0; row < 40; row++) {
    sql.exec("INSERT INTO things VALUES (?, ?)", row, new Uint8Array(4096).fill(7));
  }
  const full = sql.databaseSize;
  sql.exec("DELETE FROM things");
  // Without the freelist subtraction the file has not shrunk, so this reads unchanged.
  expect(sql.databaseSize).toBeLessThan(full);
});

// =======================================================================================
// SqlStorageRegulator

sqlTest("transaction control from SQL is refused, with upstream's message", ({ sql }) => {
  for (const statement of [
    "BEGIN TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT foo",
    "RELEASE foo",
  ]) {
    expect(() => sql.exec(statement), statement).toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
  }
});

sqlTest("a refused transaction statement never reaches the database", ({ sql, db }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  expect(() => sql.exec("BEGIN")).toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
  // If BEGIN had run, the savepoint stack below would refuse to open.
  expect(() => db.run("SAVEPOINT probe")).not.toThrow();
  db.run("RELEASE probe");
});

sqlTest("transaction control is refused anywhere in a statement batch", ({ sql }) => {
  expect(() => sql.exec("CREATE TABLE things (id INTEGER); BEGIN; SELECT 1"))
    .toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
  expect(() => sql.exec("SELECT 1; SAVEPOINT hidden; SELECT 2"))
    .toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
});

sqlTest("a statement naming the reserved _cf_ prefix is refused", ({ sql }) => {
  for (const statement of [
    "SELECT * FROM _cf_KV",
    "CREATE TABLE _cf_KV (k TEXT)",
    "DROP TABLE _cf_METADATA",
    "INSERT INTO _cf_KV VALUES ('k', 'v')",
    // Case-insensitive, which is the direction upstream's autogate is moving.
    "SELECT * FROM _CF_kv",
  ]) {
    expect(() => sql.exec(statement), statement).toThrow(SQL_RESERVED_PREFIX_MESSAGE);
  }
});

sqlTest("a quoted identifier is still an identifier", ({ sql }) => {
  // The delimiters are stripped, not the word: `"_cf_KV"` names the same table `_cf_KV` does.
  expect(() => sql.exec('CREATE TABLE "_cf_KV" (k TEXT)')).toThrow(SQL_RESERVED_PREFIX_MESSAGE);
  expect(() => sql.exec("CREATE TABLE `_cf_KV` (k TEXT)")).toThrow(SQL_RESERVED_PREFIX_MESSAGE);
});

sqlTest("the token as data is allowed, because upstream allows it", ({ sql }) => {
  // The authorizer sees resolved identifiers, so a literal is not one — measured on real
  // workerd, `conformance/suite/sql.spec.ts`. The vendored `agents` package ships exactly
  // this statement in its schema migration, and refusing it broke every agent's constructor.
  sql.exec("CREATE TABLE notes (callback TEXT)");
  sql.exec("INSERT INTO notes VALUES ('_cf_keepAliveHeartbeat')");
  expect(sql.exec("DELETE FROM notes WHERE callback = '_cf_keepAliveHeartbeat'").rowsWritten).toBe(
    1,
  );
  expect(sql.exec("SELECT '_cf_ is data' AS note").one()).toEqual({ note: "_cf_ is data" });
  // A doubled quote inside the literal does not end it, so the identifier scan must not
  // resume in the middle of one.
  expect(sql.exec("SELECT 'it''s _cf_ data' AS note").one()).toEqual({ note: "it's _cf_ data" });
});

sqlTest("a comment is not code either", ({ sql }) => {
  expect(sql.exec("SELECT 1 AS n -- _cf_KV lives here").one()).toEqual({ n: 1 });
  expect(sql.exec("SELECT /* _cf_KV */ 1 AS n").one()).toEqual({ n: 1 });
});

sqlTest("a name that merely contains the token is allowed", ({ sql }) => {
  // `isAllowedName` tests a prefix, so only a leading `_cf_` is reserved.
  sql.exec("CREATE TABLE my_cf_things (id INTEGER)");
  expect(sql.exec("SELECT count(*) AS n FROM my_cf_things").one()).toEqual({ n: 0 });
});

sqlTest("the reserved prefix does not block the trusted path", ({ sql, db }) => {
  // `SqliteKv` and `SqliteMetadata` write through `SqliteDatabase.run`, not through `exec`.
  sql.exec("CREATE TABLE things (id INTEGER)");
  db.run("CREATE TABLE _cf_probe (id INTEGER)");
  expect(db.run("SELECT count(*) AS n FROM _cf_probe").rawRows[0]?.[0]).toBe(0);
  expect(() => sql.exec("SELECT * FROM _cf_probe")).toThrow(SQL_RESERVED_PREFIX_MESSAGE);
});

test("the regulator's three callbacks are all ported", () => {
  expect(SqlStorageRegulator.isAllowedName("_cf_KV")).toBe(false);
  expect(SqlStorageRegulator.isAllowedName("_CF_KV")).toBe(false);
  expect(SqlStorageRegulator.isAllowedName("_cf_")).toBe(false);
  expect(SqlStorageRegulator.isAllowedName("_cf")).toBe(true);
  expect(SqlStorageRegulator.isAllowedName("things")).toBe(true);
  expect(SqlStorageRegulator.isAllowedName("my_cf_thing")).toBe(true);
  // Upstream's body is `return true`; it is a no-op there, not a blocked port.
  expect(SqlStorageRegulator.isAllowedTrigger("anything")).toBe(true);
  expect(() => SqlStorageRegulator.allowTransactions()).toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
});

// =======================================================================================
// Streaming ingestion

sqlTest("ingest executes complete statements and returns the incomplete tail", ({ sql }) => {
  const result = sql.ingest(
    "CREATE TABLE things (id INTEGER); " +
      "INSERT INTO things VALUES (1), (2); " +
      "SELECT * FROM things; INSERT INTO things",
  );
  expect(result).toEqual({
    remainder: " INSERT INTO things",
    rowsRead: 2,
    rowsWritten: 2,
    statementCount: 3,
  });
  expect(sql.exec("SELECT id FROM things ORDER BY id").toArray()).toEqual([{ id: 1 }, { id: 2 }]);
});

sqlTest("ingest with no complete statement changes nothing", ({ sql }) => {
  expect(sql.ingest("CREATE TABLE things (")).toEqual({
    remainder: "CREATE TABLE things (",
    rowsRead: 0,
    rowsWritten: 0,
    statementCount: 0,
  });
});

sqlTest("ingest uses the same regulator as exec", ({ sql }) => {
  expect(() => sql.ingest("CREATE TABLE _cf_private (id INTEGER);")).toThrow(
    SQL_RESERVED_PREFIX_MESSAGE,
  );
  expect(() => sql.ingest("BEGIN;")).toThrow(SQL_TRANSACTION_REFUSED_MESSAGE);
});

// =======================================================================================
// The enforcement point

test("exec with no input lock on the stack throws rather than running", async () => {
  const { sql, db } = await newFixture();
  expect(() => sql.exec("CREATE TABLE things (id INTEGER)")).toThrow(
    "no input lock available in this context",
  );
  expect(db.run("SELECT name FROM sqlite_master WHERE name='things'").rawRows).toEqual([]);
});

test("databaseSize with no input lock on the stack throws", async () => {
  const { sql } = await newFixture();
  expect(() => sql.databaseSize).toThrow("no input lock available in this context");
});

test("the throw names the operation, and comes from the one shared check", async () => {
  const { ctx } = await newFixture();
  expect(() => requireInputLock(ctx, "exec()")).toThrow(
    "exec(): no input lock available in this context",
  );
});

// =======================================================================================
// prepare()

sqlTest("a prepared statement is callable and runs the query", ({ sql }) => {
  sql.exec("CREATE TABLE things (id INTEGER)");
  sql.exec("INSERT INTO things VALUES (1), (2)");

  const statement = sql.prepare("SELECT id FROM things WHERE id = ?");
  expect(statement).toBeInstanceOf(sql.Statement);
  expect(statement(2).toArray()).toEqual([{ id: 2 }]);
  expect(statement(1).toArray()).toEqual([{ id: 1 }]);
});
