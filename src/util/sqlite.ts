/**
 * ← workerd `src/workerd/util/sqlite.{h,c++}`
 *
 * The SQL backend port. Upstream's seam is the same one: `server.c++` opens
 * `<actor-id>.<facetId>.sqlite` and hands `ActorSqlite` a `SqliteDatabase`.
 *
 * Almost none of upstream's 3,768 lines are ours. `sqlite.{h,c++}` is workerd's
 * binding to the SQLite C API — statement caching, the VFS, regulators, the
 * authorizer, the memory-metering allocator. Underneath us that role is played
 * by `node:sqlite` and sqlite-wasm, which is the storage-backend adaptation the
 * design record sanctions: `io-gate.h` knows nothing about SQLite, `ActorSqlite`
 * calls into it, and that seam is upstream's rather than ours.
 *
 * So this file is two things stacked:
 *
 *  1. `SqlDatabase` / `SqlDatabaseProvider` — the backend seam. `backends/`
 *     implements it, and nothing above `util/` ever sees a driver type.
 *  2. `SqliteDatabase` — the small part of upstream's class that is genuinely
 *     ours, because the layers above call into it and a stateless exec interface
 *     cannot express it: `onRollback`, the transaction/savepoint stack it needs,
 *     `reset()` and its `ResetListener` notification, all three of which
 *     `sqlite-kv.c++` and `sqlite-metadata.c++` reach for; plus `onWrite`,
 *     `notifyWrite` and `onCriticalError`, which only `io/actor-sqlite.ts`
 *     reaches for. That last trio lives here rather than one directory up
 *     because it lives here upstream (`sqlite.h:240`, `:248`, `:267`): a
 *     callback slot is not actor knowledge, and a reader who finds `onWrite` in
 *     `sqlite.h` has to find it in this file too. Every consumer takes a
 *     `SqliteDatabase`, exactly as upstream's take a `SqliteDatabase&`.
 *
 * `transactionSync` is NOT here — it lives in `io/actor-sqlite.ts` as
 * SAVEPOINT/RELEASE with a depth counter, exactly as upstream has it. Today
 * both browser and Node adapters duplicate `BEGIN IMMEDIATE`, which is why a
 * nested call is a live SQLite error (§2.4). Moving it inward fixes that.
 *
 * Not ported, because the substrate has no equivalent: the `Regulator` /
 * authorizer machinery (there is no untrusted-SQL path in `util/`, and
 * `api/sql.ts` owns that question); `SqliteObserver` row-count billing, whose
 * counters are libsql `STMTSTATUS` extensions neither backend exposes;
 * `sqlite-metering.{h,c++}`, which swaps SQLite's process-wide allocator to
 * meter per-database memory — a C-API facility with no JS analogue; `ingestSql`
 * and the point-in-time-recovery APIs, both named substrate boundaries in the
 * package README.
 *
 * Spec: §1.4, §2.4 in docs/decisions.md.
 */

/** The four values SQLite itself accepts after public JSG-style conversion. */
export type SqlValue = string | number | null | Uint8Array;

export type SqlResult = {
  readonly columnNames: readonly string[];
  readonly rawRows: readonly (readonly unknown[])[];
  /** Rows changed by this statement, including DML with `RETURNING`. */
  readonly rowsWritten: number;
};

/**
 * One SQLite-compiled statement from the front of a SQL string.
 *
 * `sql` is the exact prefix SQLite consumed, including trigger bodies. Keeping
 * that boundary on the backend is what prevents JavaScript from inventing a
 * second, subtly different SQL grammar.
 */
export interface SqlDatabaseStatement {
  readonly sql: string;
  readonly parameterCount: number;
  execute(params: readonly SqlValue[]): SqlResult;
  close(): void;
}

export const SQL_WRONG_BINDINGS_MESSAGE = "Wrong number of parameter bindings for SQL query.";

export const SQL_PRELUDE_BINDINGS_MESSAGE =
  "When executing multiple SQL statements in a single call, only the last statement can have " +
  "parameters.";

/**
 * One open database. Synchronous exec, matching every substrate we have: in a
 * SQLite-backed Durable Object reads return a value rather than a promise
 * (§1.4), which is what makes the input gate cheap.
 */
export interface SqlDatabase {
  /** Compile exactly the first statement, using SQLite's own statement boundary. */
  prepare(sql: string): SqlDatabaseStatement;
  exec(sql: string, params: readonly SqlValue[]): SqlResult;
  readonly databaseSize: number;
  /**
   * ← `sqlite3_get_autocommit(db) == 0`, which is how upstream's
   * `handleCriticalError` learns that SQLite rolled a transaction back on its
   * own (`sqlite.c++:669-691`).
   *
   * SQLite auto-rolls-back on `SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_NOMEM` and
   * `SQLITE_INTERRUPT`. Nothing announces it, so without this the savepoint
   * stack above would keep believing a transaction is open and the rollback
   * callbacks would never fire — a stale cache with nothing thrown, which is
   * the one failure this layer must never produce.
   */
  readonly inTransaction: boolean;
  /**
   * ← `SqliteDatabase::reset()` — "delete the underlying database file and
   * create a new one in its place", which is how upstream implements
   * `deleteAll()`.
   *
   * On the backend rather than above it because only the backend knows how to
   * recreate its own file, and because the alternative — enumerating and
   * dropping every table — is the fragile dance today's `storage.ts` performs,
   * complete with an FTS5 shadow-table ordering hazard its comment documents.
   * The `SqlDatabase` reference stays valid across the call; what changes is
   * the file behind it.
   */
  reset(): void;
  close(): void;
}

/**
 * Opens databases within ONE actor's storage scope. The package derives the
 * names (`"root"`, `` `facet-${facetId}` ``); the host maps them onto files.
 * OPFS layout knowledge stays with the host — this package never reaches for
 * `navigator.storage`.
 */
export interface SqlDatabaseProvider {
  open(name: string): Promise<SqlDatabase>;
}

/**
 * ← `SqliteDatabase::QueryOptions`. The C++ regulator pointer is narrowed to
 * a callback over the exact SQL source SQLite compiled; `api/sql.ts` owns the
 * policy because this backend seam owns no public-API knowledge.
 *
 * `allowUnconfirmed`'s only destination is `onWrite(bool allowUnconfirmed)`,
 * which fires *before* the statement executes so the automatic transaction
 * opens first — see `isWrite` below for how a statement is known to be a write
 * without the compiled plan upstream reads it from.
 */
export type QueryOptions = {
  allowUnconfirmed?: boolean;
  /** The public SQL regulator, run once against each SQLite-compiled statement. */
  regulate?: (sql: string) => void;
};

/**
 * ← the state `SqliteDatabase::onCriticalError` reports and
 * `observedCriticalError()` latches.
 *
 * Raised when SQLite has rolled back an open transaction on its own. Upstream
 * hands this to `ActorSqlite`, which treats it as fatal; §1.6 is why — a
 * storage failure this severe destroys the object rather than being survived.
 * Until `io/actor-sqlite.ts` wires it to `onBroken`, latching it and refusing
 * every subsequent statement is what keeps a caller from reading through a
 * cache that is knowingly wrong.
 */
export class SqliteCriticalError extends Error {
  override readonly name = "SqliteCriticalError";
}

/**
 * ← `SqliteDatabase::ResetListener`.
 *
 * Upstream's is a base class whose constructor registers and whose destructor
 * unregisters. JS has neither, so registration is the explicit
 * `db.addResetListener(this)` call — the same translation Section 1 applied to
 * every kj destructor.
 */
export interface ResetListener {
  /** Called before the database is actually reset. */
  beforeSqliteReset(): void;
}

/** ← `SqliteDatabase::Query::isNull(uint column)`. */
export function isNull(row: readonly unknown[], column: number): boolean {
  return row[column] === null || row[column] === undefined;
}

/** ← `SqliteDatabase::Query::getBlob(uint column)`. Fails closed on any other column type. */
export function getBlob(row: readonly unknown[], column: number): Uint8Array {
  const value = row[column];
  if (value instanceof Uint8Array) return value;
  throw new Error(`Expected a BLOB in column ${column}, got ${describe(value)}.`);
}

/** ← `SqliteDatabase::Query::getText(uint column)`. Fails closed on any other column type. */
export function getText(row: readonly unknown[], column: number): string {
  const value = row[column];
  if (typeof value === "string") return value;
  throw new Error(`Expected TEXT in column ${column}, got ${describe(value)}.`);
}

/**
 * ← `SqliteDatabase::Query::getInt64(uint column)`.
 *
 * Narrowed to a safe integer rather than upstream's `int64_t`: a JS number
 * cannot carry the full range, and a silently-rounded row id or alarm time is
 * exactly the kind of corruption this layer must not produce.
 */
export function getInt64(row: readonly unknown[], column: number): number {
  const value = row[column];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const narrowed = Number(value);
    if (Number.isSafeInteger(narrowed) && BigInt(narrowed) === value) return narrowed;
  }
  throw new Error(`Expected a safe integer in column ${column}, got ${describe(value)}.`);
}

function describe(value: unknown): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array) return "a BLOB";
  return `${typeof value} ${String(value)}`;
}

type Savepoint = {
  name: string;
  /** Size of `rollbackCallbacks` when this savepoint was created. */
  rollbackCallbackIndex: number;
};

/**
 * ← `SqliteDatabase`, restricted to the members `sqlite-kv` and
 * `sqlite-metadata` actually call.
 *
 * The one piece of real machinery here is the transaction/savepoint stack that
 * `onRollback()` needs. Upstream learns of a `BEGIN` / `SAVEPOINT` / `COMMIT` /
 * `RELEASE` / `ROLLBACK` from the SQLite authorizer while the statement is
 * being compiled (`prepareSql` fills a `ParseContext::stateChange`); we have no
 * authorizer, so the statement text is the only source. `applyChange` below is
 * a line-for-line port of upstream's; only where the `StateChange` comes from
 * differs.
 */
export class SqliteDatabase {
  readonly #backend: SqlDatabase;
  readonly #resetListeners = new Set<ResetListener>();

  /** Callbacks registered with onRollback that haven't been committed nor rolled back yet. */
  #rollbackCallbacks: (() => void)[] = [];
  /** Savepoints that haven't been committed nor rolled back yet. */
  #savepoints: Savepoint[] = [];
  /** True if in a BEGIN TRANSACTION transaction. */
  #inTransaction = false;
  /** ← `criticalErrorOccurred`, holding the exception rather than a bool. */
  #criticalError: SqliteCriticalError | undefined;
  /** ← `onWriteCallback`. */
  #onWriteCallback: ((allowUnconfirmed: boolean) => void) | undefined;
  /** ← `onCriticalErrorCallback`. */
  #onCriticalErrorCallback: ((exception: SqliteCriticalError) => void) | undefined;

  constructor(backend: SqlDatabase) {
    this.#backend = backend;
  }

  /**
   * Invokes the given callback whenever a query begins which may write to the
   * database. The callback is called just before executing the query.
   *
   * Durable Objects uses this to automatically begin a transaction and close the
   * output gate.
   *
   * Note that the write callback is NOT called before (or at any point during) a
   * `reset()`. Use the `ResetListener` mechanism for that case.
   */
  onWrite(callback: (allowUnconfirmed: boolean) => void): void {
    this.#onWriteCallback = callback;
  }

  /**
   * Invokes the given callback when a "critical error" causes an automatic
   * rollback during a transaction.
   *
   * See: https://www.sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction
   *
   * Upstream passes `(errorMessage, maybeException)` and lets the caller build
   * the exception; `#checkForAutoRollback` has already built one by the time it
   * can tell a rollback happened, so the callback receives that.
   */
  onCriticalError(callback: (exception: SqliteCriticalError) => void): void {
    this.#onCriticalErrorCallback = callback;
  }

  /**
   * Invoke the onWrite() callback.
   *
   * "This is useful when the caller is about to execute a statement which SQLite
   * considers read-only, but needs to be considered a write for our purposes. In
   * particular, we use the onWrite callback to start automatic transactions, and
   * we use the SAVEPOINT statement to implement explicit transactions. For
   * synchronous transactions, the explicit transaction needs to be nested inside
   * the automatic transaction, so we need to force an auto-transaction to start
   * before the SAVEPOINT."
   */
  notifyWrite(allowUnconfirmed = false): void {
    this.#onWriteCallback?.(allowUnconfirmed);
  }

  /** ← `SqliteDatabase::run`, in both its bare and its `QueryOptions` form. */
  run(sql: string, ...bindings: SqlValue[]): SqlResult;
  run(options: QueryOptions, sql: string, ...bindings: SqlValue[]): SqlResult;
  run(first: string | QueryOptions, ...rest: SqlValue[]): SqlResult {
    if (typeof first === "string") return this.#exec(first, rest, false);

    const [sql, ...bindings] = rest;
    if (typeof sql !== "string") throw new Error("run(options, sql, ...) takes a SQL string.");
    return this.#exec(sql, bindings, first.allowUnconfirmed ?? false, first.regulate);
  }

  #exec(
    sql: string,
    bindings: readonly SqlValue[],
    allowUnconfirmed: boolean,
    regulate?: (sql: string) => void,
  ): SqlResult {
    this.assertUsable();

    let remaining = sql;
    let result: SqlResult | undefined;
    while (hasSqlStatement(remaining)) {
      const statement = this.#backend.prepare(remaining);
      const tail = remaining.slice(statement.sql.length);
      const isFinal = !hasSqlStatement(tail);
      try {
        regulate?.(statement.sql);
        if (!isFinal && statement.parameterCount !== 0) {
          throw new Error(SQL_PRELUDE_BINDINGS_MESSAGE);
        }
        if (isFinal && statement.parameterCount !== bindings.length) {
          throw new Error(SQL_WRONG_BINDINGS_MESSAGE);
        }
        result = this.#execStatement(
          statement,
          isFinal ? bindings : [],
          isFinal ? allowUnconfirmed : false,
        );
      } finally {
        statement.close();
      }
      remaining = tail;
    }
    if (result === undefined) throw new Error("Expected at least one SQL statement.");
    return result;
  }

  /** Execute one statement from `run()`'s batch; bindings and results belong to the last one. */
  #execStatement(
    statement: SqlDatabaseStatement,
    bindings: readonly SqlValue[],
    allowUnconfirmed: boolean,
  ): SqlResult {
    const { sql } = statement;
    const change = classify(sql);

    // Before the statement runs, as upstream's `Query::checkRequirements` does: the callback opens
    // the transaction this statement is about to write into, and it is also allowed to refuse the
    // statement outright when whatever owns the transaction is already broken.
    if (isWrite(sql)) this.notifyWrite(allowUnconfirmed);

    let result: SqlResult;
    try {
      result = statement.execute(bindings);
    } catch (error) {
      this.#checkForAutoRollback(error);
      throw error;
    }
    // Upstream applies the effect on the statement's first step, i.e. after it
    // has actually run, so a statement that throws changes nothing.
    this.#applyChange(change);
    return result;
  }

  /**
   * ← `SqliteDatabase::handleCriticalError`, which reaches the same conclusion
   * from the error code plus `sqlite3_get_autocommit`. We do not see the error
   * code — the backend has already turned it into a JS exception — so the
   * disagreement between our stack and the backend's is the whole signal, and
   * it is enough: we only ask after a statement has failed, and the only thing
   * that closes a transaction without going through `run()` is SQLite itself.
   *
   * The callbacks are DISCARDED rather than invoked, which looks wrong for two
   * lines and is not. Invoking them is only correct when a rollback actually
   * happened, and the branch above is the sole case where that is knowable; in
   * the ordinary case — a constraint violation, which does not roll anything
   * back — firing them would restore a cache the database has moved past, which
   * is corruption in the other direction. Upstream does not fire them here
   * either. It makes the actor fatal instead, and so does this: the caches are
   * knowingly stale, so the database is finished rather than repaired.
   */
  #checkForAutoRollback(cause: unknown): void {
    if (!this.#inTransaction && this.#savepoints.length === 0) return;
    if (this.#backend.inTransaction) return;

    this.#inTransaction = false;
    this.#savepoints = [];
    this.#rollbackCallbacks = [];
    const critical = new SqliteCriticalError(
      "SQLite rolled back the open transaction in response to a critical error, so every " +
        "in-memory view of this database is now stale and it can no longer be used.",
      { cause },
    );
    this.#criticalError = critical;
    this.#onCriticalErrorCallback?.(critical);
    throw critical;
  }

  /**
   * ← `SqliteDatabase::observedCriticalError()`. The named state
   * `io/actor-sqlite.ts` wires to `onBroken`, so it does not have to re-derive
   * the condition from an exception it caught.
   */
  observedCriticalError(): SqliteCriticalError | undefined {
    return this.#criticalError;
  }

  /**
   * The guard for any read this package serves from a cache rather than from a
   * statement. Those are the only paths a latched critical error would not
   * already stop, and they are exactly the paths whose answer is wrong once
   * SQLite has rolled back underneath them.
   */
  assertUsable(): void {
    if (this.#criticalError !== undefined) throw this.#criticalError;
  }

  get databaseSize(): number {
    return this.#backend.databaseSize;
  }

  /**
   * ← `SqliteDatabase::onRollback`.
   *
   * "Register a callback which shall be called if the current transaction is
   * rolled back. If the current transaction commits, then the callback is
   * discarded without invoking it. [...] When a rollback occurs, callbacks are
   * invoked in the reverse of the order in which they were registered."
   *
   * With nothing open there is nothing that can roll back, so the callback is
   * dropped — upstream's `if (inTransaction || !savepoints.empty())`.
   */
  onRollback(callback: () => void): void {
    if (this.#inTransaction || this.#savepoints.length > 0) {
      this.#rollbackCallbacks.push(callback);
    }
  }

  addResetListener(listener: ResetListener): void {
    this.#resetListeners.add(listener);
  }

  removeResetListener(listener: ResetListener): void {
    this.#resetListeners.delete(listener);
  }

  /** ← `SqliteDatabase::reset()`. */
  reset(): void {
    // Refused for the same reason `run()` is: the listeners below read their own
    // state on the way out, and after a critical error that state is stale.
    this.assertUsable();
    // "If transactions are open during reset(), whatever had the transaction
    // open is going to get confused at best, or lose data at worst."
    if (this.#inTransaction || this.#savepoints.length > 0) {
      throw new Error("can't reset() a database during a transaction");
    }
    for (const listener of this.#resetListeners) {
      listener.beforeSqliteReset();
    }
    this.#backend.reset();
  }

  close(): void {
    this.#backend.close();
  }

  /** ← `SqliteDatabase::applyChange`, ported statement for statement. */
  #applyChange(change: StateChange): void {
    switch (change.kind) {
      case "none":
        break;

      case "begin":
        if (change.savepointName !== null) {
          this.#savepoints.push({
            name: change.savepointName,
            rollbackCallbackIndex: this.#rollbackCallbacks.length,
          });
        } else {
          assert(
            this.#savepoints.length === 0,
            "BEGIN TRANSACTION should have failed when savepoints are present?",
          );
          assert(
            !this.#inTransaction,
            "BEGIN TRANSACTION should have failed when already in a transaction?",
          );
          assert(
            this.#rollbackCallbacks.length === 0,
            "we shouldn't have been keeping rollback callbacks with no transaction open!",
          );
          this.#inTransaction = true;
        }
        break;

      case "commit":
        if (change.savepointName !== null) {
          // Per https://www.sqlite.org/lang_savepoint.html, releasing a savepoint also releases
          // all later savepoints.
          for (;;) {
            const savepoint = this.#savepoints.pop();
            assert(savepoint !== undefined, "released a savepoint that didn't exist?");
            if (savepoint.name === change.savepointName) break;
          }
        } else {
          assert(this.#inTransaction, "COMMIT TRANSACTION without BEGIN TRANSACTION?");
          // Since BEGIN TRANSACTION cannot be nested within a savepoint, this must have released
          // all savepoints implicitly.
          this.#savepoints = [];
          this.#inTransaction = false;
        }
        if (this.#savepoints.length === 0 && !this.#inTransaction) {
          this.#rollbackCallbacks = [];
        }
        break;

      case "rollback":
        if (change.savepointName !== null) {
          for (;;) {
            const savepoint = this.#savepoints[this.#savepoints.length - 1];
            assert(savepoint !== undefined, "released a savepoint that didn't exist?");
            if (savepoint.name === change.savepointName) {
              this.#runRollbackCallbacksDownTo(savepoint.rollbackCallbackIndex);
              // Rolling back to a savepoint does not release it, so it stays on the stack and
              // must be released separately.
              break;
            }
            this.#savepoints.pop();
          }
        } else {
          assert(this.#inTransaction, "ROLLBACK TRANSACTION without BEGIN TRANSACTION?");
          this.#savepoints = [];
          this.#inTransaction = false;
          this.#runRollbackCallbacksDownTo(0);
        }
        break;
    }
  }

  #runRollbackCallbacksDownTo(index: number): void {
    assert(this.#rollbackCallbacks.length >= index, "rollback callback stack shrank?");
    while (this.#rollbackCallbacks.length > index) {
      // Upstream pops first and then invokes, so a callback that throws does not leave itself on
      // the stack to be invoked a second time by the next rollback.
      const callback = this.#rollbackCallbacks.pop();
      assert(callback !== undefined, "rollback callback stack shrank?");
      callback();
    }
  }
}

type SqliteSchemaDatabase = Pick<SqlDatabase, "exec"> | Pick<SqliteDatabase, "run">;

/**
 * Returns whether a runtime-owned table exists, and refuses any present shape
 * other than the one this release writes.
 */
export function hasCurrentSqliteTable(
  db: SqliteSchemaDatabase,
  name: string,
  createSql: string,
): boolean {
  // SQLite identifiers are ASCII case-insensitive, so schema validation must
  // find the same object that CREATE TABLE IF NOT EXISTS would collide with.
  const query = "SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE";
  const rows = "run" in db ? db.run(query, name).rawRows : db.exec(query, [name]).rawRows;
  const row = rows[0];
  if (row === undefined) return false;
  if (
    rows.length !== 1 ||
    row[0] !== "table" ||
    typeof row[1] !== "string" ||
    normalizeSchemaSql(row[1]) !== normalizeSchemaSql(createSql)
  ) {
    throw new Error(
      `Incompatible @mcp-b/do-runtime storage schema for table "${name}". ` +
        "This release accepts only the current schema and does not migrate stored runtime data.",
    );
  }
  return true;
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/;$/u, "")
    .toLowerCase();
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** ← `SqliteDatabase::StateChange`. */
type StateChange =
  | { kind: "none" }
  | { kind: "begin"; savepointName: string | null }
  | { kind: "commit"; savepointName: string | null }
  | { kind: "rollback"; savepointName: string | null };

const NO_CHANGE: StateChange = { kind: "none" };

/** SQLite savepoint names compare case-insensitively, so the stack stores them folded. */
function savepointName(raw: string): string {
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith("`") && raw.endsWith("`"))
      ? raw.slice(1, -1)
      : raw.startsWith("[") && raw.endsWith("]")
        ? raw.slice(1, -1)
        : raw;
  return unquoted.toLowerCase();
}

const NAME = String.raw`("[^"]*"|'[^']*'|\`[^\`]*\`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const BEGIN = new RegExp(
  String.raw`^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$`,
  "i",
);
const SAVEPOINT = new RegExp(String.raw`^SAVEPOINT\s+${NAME}$`, "i");
const COMMIT = new RegExp(String.raw`^(COMMIT|END)(\s+TRANSACTION)?$`, "i");
const RELEASE = new RegExp(String.raw`^RELEASE(\s+SAVEPOINT)?\s+${NAME}$`, "i");
const ROLLBACK = new RegExp(String.raw`^ROLLBACK(\s+TRANSACTION)?$`, "i");
const ROLLBACK_TO = new RegExp(
  String.raw`^ROLLBACK(\s+TRANSACTION)?\s+TO(\s+SAVEPOINT)?\s+${NAME}$`,
  "i",
);
const TRANSACTION_KEYWORD = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Every group referenced below is mandatory in its pattern, so an absent one is a broken pattern. */
function group(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`SQL pattern group ${index} did not match: ${match[0]}`);
  return value;
}

/**
 * Derives upstream's `StateChange` from the statement text.
 *
 * A statement that opens with a transaction keyword but does not match one of
 * the forms below throws rather than being classified as `NoChange`, since
 * guessing in that direction is what loses a rollback callback. `run()` asks
 * the backend to compile one native statement at a time and applies this state
 * change after each executes, matching workerd's `prepareMulti()` prelude.
 */
function classify(sql: string): StateChange {
  const statement = stripLeadingTrivia(sql).trim().replace(/;$/, "").trimEnd();

  const rollbackTo = ROLLBACK_TO.exec(statement);
  if (rollbackTo !== null) {
    return { kind: "rollback", savepointName: savepointName(group(rollbackTo, 3)) };
  }
  if (ROLLBACK.test(statement)) return { kind: "rollback", savepointName: null };

  const savepoint = SAVEPOINT.exec(statement);
  if (savepoint !== null) {
    return { kind: "begin", savepointName: savepointName(group(savepoint, 1)) };
  }
  if (BEGIN.test(statement)) return { kind: "begin", savepointName: null };

  const release = RELEASE.exec(statement);
  if (release !== null) {
    return { kind: "commit", savepointName: savepointName(group(release, 2)) };
  }
  if (COMMIT.test(statement)) return { kind: "commit", savepointName: null };

  if (TRANSACTION_KEYWORD.test(statement)) {
    throw new Error(`Unrecognized transaction-control statement: ${statement}`);
  }
  return NO_CHANGE;
}

/**
 * ← `!sqlite3_stmt_readonly(statement)`, the test upstream's `onWrite` gate is
 * written against (`sqlite.c++:1562-1568`).
 *
 * It is NOT the authorizer — the authorizer never sees this question, and the
 * distinction is load bearing: `sqlite3_stmt_readonly()` reports BEGIN, COMMIT,
 * ROLLBACK, SAVEPOINT and RELEASE as read-only, which is why `notifyWrite()`
 * exists at all and why an automatic transaction's own `BEGIN` does not recurse
 * into the callback that issued it.
 *
 * Neither backend exposes the compiled statement, so the text is the only
 * source, and it fails closed the way `classify` does: **a statement is a write
 * unless it provably is not.** The complete read set is `SELECT` and `EXPLAIN`
 * plus the five transaction-control forms. `WITH`, `PRAGMA` and anything
 * unrecognised are writes, which costs a read-only CTE a transaction and an
 * output-gate lock it does not need, and cannot cost atomicity — which is the
 * only error this classification is allowed to make.
 */
function isWrite(sql: string): boolean {
  return !NON_WRITE_KEYWORDS.has(leadingKeyword(sql));
}

const NON_WRITE_KEYWORDS = new Set([
  "SELECT",
  "EXPLAIN",
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/** The first bare word, skipping whitespace and both comment forms. */
function leadingKeyword(sql: string): string {
  return (/^[A-Za-z]+/.exec(stripLeadingTrivia(sql))?.[0] ?? "").toUpperCase();
}

function hasSqlStatement(sql: string): boolean {
  return stripLeadingTrivia(sql).trim().length > 0;
}

function stripLeadingTrivia(statement: string): string {
  let index = 0;
  for (;;) {
    while (index < statement.length && /\s/.test(statement.charAt(index))) index += 1;
    if (statement[index] === "-" && statement[index + 1] === "-") {
      const newline = statement.indexOf("\n", index);
      index = newline === -1 ? statement.length : newline + 1;
      continue;
    }
    if (statement[index] === "/" && statement[index + 1] === "*") {
      const close = statement.indexOf("*/", index + 2);
      index = close === -1 ? statement.length : close + 2;
      continue;
    }
    return statement.slice(index);
  }
}
