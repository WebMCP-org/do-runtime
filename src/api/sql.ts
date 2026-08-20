/**
 * ← workerd `src/workerd/api/sql.{h,c++}`
 *
 * `SqlStorage` and its two nested types. ~330 call sites depend on this — it is
 * the real storage layer, not KV.
 *
 * Four things about the translation, in descending order of how much they cost:
 *
 *  1. **The cursor is materialised, not live.** Upstream's `Cursor` owns a
 *     running `SqliteDatabase::Query` and pulls one row at a time; the backend
 *     seam this package chose (`SqlDatabase.exec` → `SqlResult`) has already
 *     collected every row before a cursor exists. Everything downstream of that
 *     follows: there is no statement cache, so `CachedStatement`, the 1 MiB LRU
 *     and `reusedCachedQueryForTest` are absent with it; there is no live
 *     statement to cancel, so `Cursor::canceled` and `selfRef` — both already
 *     dead upstream, written but never assigned — have nothing to guard; and
 *     `endQuery`'s job of returning a statement to the cache is nothing here, so
 *     the counters it saves off are simply the counters. What is kept is every
 *     observable: the position is shared across `next`/`toArray`/`one`/`raw`,
 *     and a drained cursor keeps yielding done.
 *  2. **`Cursor` and `Statement` must be constructible with no arguments**, or
 *     `SqlStorage` cannot satisfy workers-types without a cast: the interface
 *     types them `typeof SqlStorageCursor` / `typeof SqlStorageStatement`, and
 *     both are `abstract` there, so their construct signatures take none.
 *     Upstream's are unconstructible from JS for the same reason they are
 *     `abstract` in the types — JSG nested types have no JS constructor — so the
 *     faithful shape is a constructor that refuses. `sql.Cursor` exists for
 *     `instanceof`, which is all upstream exposes it for.
 *  3. **The regulator is ported whole; what is missing is the authorizer that
 *     calls it.** All three callbacks are here and none of them needed the
 *     authorizer to compute anything — `isAllowedName` is a prefix test,
 *     `isAllowedTrigger` is `return true`, `allowTransactions` throws. What the
 *     authorizer supplied was the *identifiers*, not the decisions. With no
 *     authorizer the statement text is the only source, so `exec` tokenizes it
 *     and runs `isAllowedName` over every identifier-shaped token. That is
 *     deliberately STRICTER than upstream — see `SQL_RESERVED_PREFIX_MESSAGE`.
 *  4. **`ingest` stays at upstream's SQLite seam.** `SqliteDatabase.ingest()`
 *     executes every complete statement and returns the partial tail, using the
 *     same compiled boundaries and regulator as `exec`.
 *
 * Spec: §1.4, §2.4 in docs/decisions.md.
 */

import { requireInputLock } from "../io/io-context";
import type { IoContext } from "../io/io-context";
import type { SqlIngestResult, SqliteDatabase, SqlValue } from "../util/sqlite";

/**
 * ← `SqlStorage::BindingValue`. JSG converts these public JavaScript values
 * to workerd's `Maybe<OneOf<Array<byte>, String, double>>` before C++ sees them;
 * `toSqlBindingValue()` is that conversion for this no-isolate runtime.
 */
export type BindingValue =
  | ArrayBuffer
  | ArrayBufferView
  | string
  | number
  | boolean
  | null
  | undefined;

/** ← the `SqlStorageValue` `JSG_TS_DEFINE` on `Cursor`. */
export type SqlRow = Record<string, SqlStorageValue>;

/** ← `SqlStorage::IngestResult`. */
export type SqlStorageIngestResult = SqlIngestResult;

/**
 * ← `SqlStorageRegulator::allowTransactions()`, copied verbatim. Users match on
 * it and it is the one regulator callback our substrate can still answer.
 */
export const SQL_TRANSACTION_REFUSED_MESSAGE =
  "To execute a transaction, please use the state.storage.transaction() or " +
  "state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT " +
  "statements. The JavaScript API is safer because it will automatically roll back on " +
  "exceptions, and because it interacts correctly with Durable Objects' automatic atomic " +
  "write coalescing.";

/** See translation 2 in the header: the class is exposed for `instanceof` only. */
export const CURSOR_NOT_CONSTRUCTIBLE_MESSAGE =
  "Illegal invocation: SqlStorage.Cursor cannot be constructed directly. Use sql.exec().";

/** Same, for the prepared-statement compatibility shim. */
export const STATEMENT_NOT_CONSTRUCTIBLE_MESSAGE =
  "Illegal invocation: SqlStorage.Statement cannot be constructed directly. Use sql.prepare().";

/**
 * ← SQLite's own denial text, with the reason appended.
 *
 * There is no upstream string to copy here: `SqlStorageRegulator::onError` just
 * rethrows whatever SQLite produced, and SQLite produces `not authorized` for an
 * authorizer denial (`access to X.Y is prohibited` for the column-read case,
 * which needs a resolved identifier we do not have). The prefix is kept so that
 * anything matching upstream still matches; the rest is here because a bare
 * `not authorized` is not debuggable.
 */
export const SQL_RESERVED_PREFIX_MESSAGE =
  "not authorized: a SQL statement may not name the reserved _cf_ prefix, which is where this " +
  "Durable Object keeps its own KV and metadata tables.";

/**
 * ← the five transaction-control forms `sqlite3_stmt_readonly()` reports
 * read-only and the authorizer reports as `SQLITE_TRANSACTION` /
 * `SQLITE_SAVEPOINT`. The same set `util/sqlite.ts` classifies, read here from
 * the leading keyword because the untrusted path has to refuse them before the
 * trusted one applies them.
 */
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Cheap pre-test, so the tokenizer below runs only on a statement that could fail it. */
const RESERVED_PREFIX_HINT = /_cf_/i;

/** A SQL identifier. Double-quoted and bracketed forms are still identifiers, so only the
 * delimiters are stripped and the word inside is scanned like any other. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_$]*/g;

/**
 * Everything in a statement an identifier cannot come from: single-quoted string
 * literals (SQLite escapes an embedded quote by doubling it), `--` line comments,
 * and `/* *\/` block comments. Replaced with a space before tokenizing, so what is
 * left is code.
 *
 * Backtick-quoted names are NOT here: MySQL-compatible quoting produces an
 * identifier, exactly as the double-quoted form does.
 */
const NOT_CODE = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * ← `SqlStorageRegulator` (`sql.h:15-22`, `sql.c++:143-173`), whole.
 *
 * Upstream reaches these through the SQLite authorizer while a statement is
 * being compiled. `exec` calls them from the statement text instead, which is
 * the same translation Section 3 made for the write classifier and for
 * transaction state.
 */
export const SqlStorageRegulator = {
  /**
   * Upstream's body is `return !name.startsWith("_cf_")`, with an autogate that
   * makes the comparison case-insensitive and logs a warning until it lands. The
   * case-insensitive form is taken here: it is the direction upstream is moving,
   * and there is no logger for the warning half.
   */
  isAllowedName(name: string): boolean {
    return name.length < 4 || name.slice(0, 4).toLowerCase() !== "_cf_";
  },

  /** Upstream's body is `return true`. */
  isAllowedTrigger(_name: string): boolean {
    return true;
  },

  /** Upstream's body is a `JSG_FAIL_REQUIRE` with this message. */
  allowTransactions(): never {
    throw new Error(SQL_TRANSACTION_REFUSED_MESSAGE);
  },

  /** "Bill for queries executed from JavaScript." Nothing reads it — `SqliteObserver` has no port. */
  shouldAddQueryStats(): boolean {
    return true;
  },
};

/**
 * The text-level stand-in for the authorizer's `isAllowedName` calls — see
 * `SQL_RESERVED_PREFIX_MESSAGE` and the README row.
 *
 * Upstream refuses a *resolved identifier* that starts with `_cf_`, because it
 * reaches `isAllowedName` through the SQLite authorizer while the statement is
 * being compiled. There is no authorizer here, so this tokenizes the statement
 * text instead, over everything that is not a string literal or a comment —
 * which is the same set of characters an identifier can come from.
 *
 * **The literals were once refused too, and that was wrong.** The first draft
 * scanned the whole statement on the reasoning that no legitimate consumer
 * statement contains the token, so being stricter than upstream was the safe
 * direction. A retained conformance case uses `_cf_keepAliveHeartbeat` as a
 * bound value: real workerd accepts it, so this parser must distinguish data
 * from identifiers. `conformance/suite/sql.spec.ts` pins the rule: refused as a
 * table name and as a quoted identifier, allowed as data.
 *
 * A name that merely CONTAINS the token — `my_cf_thing` — stays allowed, because
 * `isAllowedName` tests a prefix.
 */
function requireAllowedNames(query: string): void {
  if (!RESERVED_PREFIX_HINT.test(query)) return;
  const code = query.replace(NOT_CODE, " ");
  for (const [token] of code.matchAll(IDENTIFIER)) {
    if (!SqlStorageRegulator.isAllowedName(token)) throw new Error(SQL_RESERVED_PREFIX_MESSAGE);
  }
}

/** Refuse transaction control against one SQLite-decided statement boundary. */
function refuseTransactionControl(statement: string): void {
  const code = statement.replace(NOT_CODE, " ");
  if (TRANSACTION_CONTROL.test(code)) SqlStorageRegulator.allowTransactions();
}

/**
 * ← the `jsg::Ref<DurableObjectStorage>` `SqlStorage` holds, narrowed to the one
 * member it reaches through (`SqlStorage::getDb`). `DurableObjectStorage`
 * satisfies it; narrowing is what keeps this file free of a value-level import
 * cycle, which upstream tolerates because C++ headers do not have one.
 */
export interface SqlStorageOwner {
  /** ← `DurableObjectStorage::getSqliteDb`. Throws if not SQLite-backed. */
  getSqliteDb(): SqliteDatabase;
}

/** The rows a cursor walks, plus the counters that outlive them. */
type CursorState = {
  readonly columnNames: string[];
  readonly rawRows: readonly (readonly SqlStorageValue[])[];
  readonly rowsWritten: number;
};

/**
 * ← `SqlStorage::Cursor`.
 *
 * `rowsRead` is the one counter that is not upstream's. Upstream reads
 * `Query::getRowsRead()`, a billing counter sourced from libsql's
 * `STMTSTATUS_ROWS_READ` that counts index rows and that neither backend
 * exposes — the same absence the README already records for `SqlResult`. The
 * interface requires a number, so this returns the rows the cursor has yielded,
 * which is what today's browser host returns and what its tests assert. It
 * undercounts any query that scans more rows than it returns.
 */
export class Cursor<T extends SqlRow = SqlRow> implements SqlStorageCursor<T> {
  readonly columnNames: string[];
  readonly #rawRows: readonly (readonly SqlStorageValue[])[];
  readonly #rowsWritten: number;
  #position = 0;

  constructor(state?: CursorState) {
    if (state === undefined) throw new Error(CURSOR_NOT_CONSTRUCTIBLE_MESSAGE);
    this.columnNames = state.columnNames;
    this.#rawRows = state.rawRows;
    this.#rowsWritten = state.rowsWritten;
  }

  /** ← `Cursor::next`, whose `RowIterator::Next` is this exact shape. */
  next(): { done?: false; value: T } | { done: true; value?: never } {
    const row = this.#nextRow();
    if (row === undefined) return { done: true };
    return { done: false, value: row };
  }

  /** ← `Cursor::toArray`, which drains from the current position. */
  toArray(): T[] {
    const rows: T[] = [];
    for (;;) {
      const row = this.#nextRow();
      if (row === undefined) return rows;
      rows.push(row);
    }
  }

  /** ← `Cursor::one`. Both messages are upstream's, verbatim. */
  one(): T {
    const row = this.#nextRow();
    if (row === undefined) {
      throw new Error("Expected exactly one result from SQL query, but got no results.");
    }
    if (this.#position < this.#rawRows.length) {
      // Upstream drops the query here before throwing, so the statement cannot be reused.
      this.#position = this.#rawRows.length;
      throw new Error("Expected exactly one result from SQL query, but got multiple results.");
    }
    return row;
  }

  /** ← `Cursor::raw`, which shares this cursor's position rather than restarting. */
  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    const iterator: IterableIterator<U> = {
      [Symbol.iterator](): IterableIterator<U> {
        return iterator;
      },
      next: (): IteratorResult<U> => {
        const raw = this.#nextRaw();
        if (raw === undefined) return { done: true, value: undefined };
        const values: SqlStorageValue[] = [...raw];
        return { done: false, value: asRawRow<U>(values) };
      },
    };
    return iterator;
  }

  /** ← `JSG_ITERABLE(rows)`. */
  [Symbol.iterator](): IterableIterator<T> {
    const iterator: IterableIterator<T> = {
      [Symbol.iterator](): IterableIterator<T> {
        return iterator;
      },
      next: (): IteratorResult<T> => {
        const row = this.#nextRow();
        if (row === undefined) return { done: true, value: undefined };
        return { done: false, value: row };
      },
    };
    return iterator;
  }

  get rowsRead(): number {
    return this.#position;
  }

  /** ← `Cursor::getRowsWritten`, which is `SqlResult.rowsWritten` here. */
  get rowsWritten(): number {
    return this.#rowsWritten;
  }

  #nextRaw(): readonly SqlStorageValue[] | undefined {
    const raw = this.#rawRows[this.#position];
    if (raw === undefined) return undefined;
    this.#position += 1;
    return raw;
  }

  /** ← `Cursor::rowIteratorNext`: zip the column names onto the row. */
  #nextRow(): T | undefined {
    const raw = this.#nextRaw();
    if (raw === undefined) return undefined;
    const row: SqlRow = {};
    this.columnNames.forEach((name, index) => {
      row[name] = raw[index] ?? null;
    });
    return asRow<T>(row);
  }
}

/**
 * ← `SqlStorage::Statement`, which upstream describes as "supported only for
 * backwards compatibility ... it is actually just a wrapper around `exec()`".
 * `JSG_CALLABLE(run)` makes the object itself callable, so `prepare()` returns a
 * function wearing this prototype rather than an object with a `run` method.
 */
export class Statement {
  constructor() {
    throw new Error(STATEMENT_NOT_CONSTRUCTIBLE_MESSAGE);
  }
}

/** What `prepare()` hands back: `Statement::run`, reachable by calling it. */
export interface PreparedStatement {
  <T extends SqlRow = SqlRow>(...bindings: BindingValue[]): Cursor<T>;
}

export class SqlStorage implements globalThis.SqlStorage {
  readonly #ctx: IoContext;
  readonly #owner: SqlStorageOwner;
  /** ← `kj::Maybe<uint> pageSize`, memoized for the same reason. */
  #pageSize: number | undefined;

  constructor(ctx: IoContext, owner: SqlStorageOwner) {
    this.#ctx = ctx;
    this.#owner = owner;
  }

  /** ← `JSG_NESTED_TYPE(Cursor)`. Exposed so `instanceof` works, as upstream's is. */
  readonly Cursor = Cursor;
  /** ← `JSG_NESTED_TYPE(Statement)`. */
  readonly Statement = Statement;

  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: BindingValue[]): Cursor<T> {
    requireInputLock(this.#ctx, "sql.exec()");
    const db = this.#owner.getSqliteDb();
    const sqlBindings = bindings.map(toSqlBindingValue);

    // Name checks stay a preflight because the backend cannot return a compiled
    // statement for a missing reserved table. This text-level check is the
    // deliberately stricter authorizer substitute documented above.
    requireAllowedNames(query);

    // The backend supplies the same statement boundary SQLite compiled. That is
    // load-bearing for CREATE TRIGGER, whose body legitimately contains semicolons.
    const result = db.run({ regulate: refuseTransactionControl }, query, ...sqlBindings);
    return new Cursor<T>({
      columnNames: [...result.columnNames],
      rawRows: result.rawRows.map((row) => row.map(toSqlStorageValue)),
      rowsWritten: result.rowsWritten,
    });
  }

  /**
   * ← `SqlStorage::getDatabaseSize`.
   *
   * Upstream's second query is `PRAGMA page_size;`, which `sqlite3_stmt_readonly()`
   * reports read-only. With no such call the text is the only source and §1.7.1's
   * rule is write-unless-provably-a-read, so a bare `PRAGMA` would open a
   * transaction and take an output-gate lock to answer a size question. The
   * `pragma_page_size` table-valued function is the same value read through the
   * `SELECT` upstream already uses for the page count.
   */
  get databaseSize(): number {
    requireInputLock(this.#ctx, "sql.databaseSize");
    const db = this.#owner.getSqliteDb();
    const pages = db.run(
      "select (select * from pragma_page_count) - (select * from pragma_freelist_count);",
    );
    return readNumber(pages, "page count") * this.#getPageSize(db);
  }

  /** ← `SqlStorage::prepare`. Experimental and deprecated upstream; `exec` caches for you. */
  prepare(query: string): PreparedStatement {
    requireInputLock(this.#ctx, "sql.prepare()");
    const run = <T extends SqlRow = SqlRow>(...bindings: BindingValue[]): Cursor<T> =>
      this.exec<T>(query, ...bindings);
    Object.setPrototypeOf(run, Statement.prototype);
    return run;
  }

  /** ← `SqlStorage::ingest`. */
  ingest(query: string): SqlStorageIngestResult {
    requireInputLock(this.#ctx, "sql.ingest()");
    requireAllowedNames(query);
    return this.#owner.getSqliteDb().ingest(query, refuseTransactionControl);
  }

  /** ← `SqlStorage::setMaxPageCountForTest`, which is what its name says. */
  setMaxPageCountForTest(count: number): void {
    requireInputLock(this.#ctx, "sql.setMaxPageCountForTest()");
    this.#owner.getSqliteDb().run(`PRAGMA max_page_count = ${count}`);
  }

  /** ← `SqlStorage::getPageSize`. */
  #getPageSize(db: SqliteDatabase): number {
    const cached = this.#pageSize;
    if (cached !== undefined) return cached;
    const size = readNumber(db.run("select * from pragma_page_size;"), "page size");
    this.#pageSize = size;
    return size;
  }
}

function readNumber(result: { readonly rawRows: readonly (readonly unknown[])[] }, what: string): number {
  const value = result.rawRows[0]?.[0];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Expected a number for the database's ${what}.`);
}

/** ← JSG's conversion from JavaScript arguments to `SqlStorage::BindingValue`. */
function toSqlBindingValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") {
    throw new TypeError("Cannot convert a BigInt value to a number");
  }
  if (value instanceof ArrayBuffer) return copyBytes(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return copyBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError(`Cannot convert ${Object.prototype.toString.call(value)} to a SQL value`);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * ← `SqlStorage::wrapSqlValue` plus the `Query::getValue` switch above it.
 *
 * Upstream's int64 arm carries its own comment: "int64 will become BigInt, but
 * most applications won't want all their integers to be BigInt. We will coerce
 * to a double here." That coercion is kept rather than refused, because it is
 * the documented behaviour of `sql.exec` and a caller storing an id larger than
 * 2^53 has already lost on workerd.
 */
function toSqlStorageValue(value: unknown): SqlStorageValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) {
    const copy = new ArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(value);
    return copy;
  }
  throw new Error(`SQL returned a ${typeof value}, which is not a SqlStorageValue.`);
}

/**
 * The two narrowings a generic row type needs. `T` is the caller's claim about
 * the shape of a row SQLite produced at runtime, so no check can confirm it and
 * upstream does not try — its `Cursor<T>` is the same claim written in a
 * `JSG_TS_OVERRIDE`. Confined to these two functions so the claim is one place
 * rather than sprinkled through the cursor.
 */
function asRow<T extends SqlRow>(row: SqlRow): T {
  return row as T;
}

function asRawRow<U extends SqlStorageValue[]>(values: SqlStorageValue[]): U {
  return values as U;
}
