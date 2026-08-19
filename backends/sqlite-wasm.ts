/**
 * ← workerd `NO upstream correspondence (storage-backend adaptation)`
 *
 * `SqlDatabaseProvider` over the browser's OPFS SAH pool.
 *
 * The pool is a parameter, not something this module goes and gets. Installing
 * the VFS is the host's job — `installOpfsSAHPoolVfs` decides the OPFS
 * directory, the pool capacity and whether to clear on init, all of which are
 * layout questions this package deliberately knows nothing about. What arrives
 * here is the already-installed pool, and with it the two things a backend
 * needs that a bare `sqlite3` module cannot give: a database constructor bound
 * to that VFS, and `unlink`, which is how `reset()` deletes a file that lives
 * inside the pool rather than in OPFS proper.
 *
 * The pool is structurally typed rather than imported from
 * `@sqlite.org/sqlite-wasm`, so this package takes no dependency on the driver
 * and the caller is free to pass a pool from any build of it. The shape below
 * is the subset of `SAHPoolUtil` and `oo1.DB` that is used, copied from the
 * driver's own `.d.mts`.
 *
 * NOT exercised by the unit lane: it needs OPFS, which means a browser. It is
 * exercised twice in the browser lane — by `sqlite-wasm.smoke.spec.ts`, which
 * drives this file directly, and by the conformance suite, which runs the whole
 * package over it.
 */

import {
  SQL_WRONG_BINDINGS_MESSAGE,
  type SqlDatabase,
  type SqlDatabaseProvider,
  type SqlDatabaseStatement,
  type SqlResult,
  type SqlValue,
} from "../src/util/sqlite";

/** ← `PreparedStatement`, the members used here. */
export interface SqliteWasmStatement {
  readonly columnCount: number;
  readonly parameterCount: number;
  bind(bindings: readonly (string | number | bigint | null | Uint8Array)[]): unknown;
  step(): boolean;
  get(index: number): unknown;
  getColumnNames(target?: string[]): string[];
  finalize(): number | undefined;
}

/** ← `oo1.DB` / `OpfsSAHPoolDatabase`, the members used here. */
export interface SqliteWasmDatabaseHandle {
  /** ← `oo1.DB.pointer`, which is absent once the handle is closed. */
  readonly pointer?: number | undefined;
  prepare(sql: string): SqliteWasmStatement;
  changes(total?: boolean, sixtyFour?: false): number;
  close(): void;
}

/** ← `SAHPoolUtil`, the members used here. */
export interface OpfsSahPool {
  /** Constructs a database inside this pool's VFS. Names are absolute, so they start with "/". */
  readonly OpfsSAHPoolDb: new (filename: string) => SqliteWasmDatabaseHandle;
  /** Disassociates a virtual file from the pool. Results are undefined if it is in active use. */
  unlink(filename: string): boolean;
}

/**
 * ← `Sqlite3Static["capi"]`, restricted to the one C function `oo1.DB` does not
 * wrap.
 *
 * Takes the pointer rather than the handle, even though upstream's `DbPtr`
 * accepts either: a structural subset of `oo1.DB` is not assignable to the
 * `Database` class, so asking for the handle would make the real `capi` fail to
 * satisfy this interface.
 */
export interface SqliteWasmCapi {
  sqlite3_complete(sql: string): 0 | 1;
  sqlite3_get_autocommit(db: number): number;
}

/**
 * What the host hands over: the pool it installed, and the C-API namespace it
 * already holds. Both come off the same `sqlite3` object the caller used to
 * call `installOpfsSAHPoolVfs`, so this asks for nothing it does not have.
 */
export interface SqliteWasmHost {
  readonly pool: OpfsSahPool;
  readonly capi: SqliteWasmCapi;
}

export type SqliteWasmProviderOptions = {
  /** Absolute path prefix inside the pool, e.g. `/actor-<id>`. Must start with "/". */
  prefix: string;
};

export function createSqliteWasmProvider(
  host: SqliteWasmHost,
  options: SqliteWasmProviderOptions,
): SqlDatabaseProvider {
  const { prefix } = options;
  if (!prefix.startsWith("/")) {
    throw new Error(`SAH pool names are absolute; prefix must start with "/": ${prefix}`);
  }
  return {
    async open(name: string): Promise<SqlDatabase> {
      // Names come from inside the package, so this is defence in depth — but
      // it is the one place a name becomes a pool file name.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(`Database name is not a safe file name: ${name}`);
      }
      return new SqliteWasmDatabase(host, `${prefix}.${name}.sqlite`);
    },
  };
}

export class SqliteWasmDatabase implements SqlDatabase {
  readonly #host: SqliteWasmHost;
  readonly #filename: string;
  #database: SqliteWasmDatabaseHandle;

  constructor(host: SqliteWasmHost, filename: string) {
    this.#host = host;
    this.#filename = filename;
    this.#database = new host.pool.OpfsSAHPoolDb(filename);
  }

  prepare(sql: string): SqlDatabaseStatement {
    const source = firstCompleteStatement(this.#host.capi, sql);
    return new WasmSqlStatement(this.#database, this.#database.prepare(source), source);
  }

  exec(sql: string, params: readonly SqlValue[]): SqlResult {
    const statement = this.prepare(sql);
    try {
      return statement.execute(params);
    } finally {
      statement.close();
    }
  }

  get databaseSize(): number {
    const pageCount = this.#pragma("page_count");
    const pageSize = this.#pragma("page_size");
    return pageCount * pageSize;
  }

  /**
   * `oo1.DB` wraps no equivalent, so this is the one place the backend reaches
   * past it into the C API. `DbPtr` accepts the database object itself.
   */
  get inTransaction(): boolean {
    const pointer = this.#database.pointer;
    if (pointer === undefined) throw new Error("The database handle is closed.");
    return this.#host.capi.sqlite3_get_autocommit(pointer) === 0;
  }

  reset(): void {
    // The pool's files are not visible in OPFS under these names, so deleting
    // one goes through the pool rather than through the filesystem. The handle
    // has to be closed first: `unlink`'s results are undefined for a file in
    // active use.
    this.#database.close();
    if (!this.#host.pool.unlink(this.#filename)) {
      throw new Error(`SAH pool did not unlink ${this.#filename}`);
    }
    this.#database = new this.#host.pool.OpfsSAHPoolDb(this.#filename);
  }

  close(): void {
    this.#database.close();
  }

  #pragma(name: string): number {
    const row = this.exec(`PRAGMA ${name}`, []).rawRows[0];
    const value = row?.[0];
    if (typeof value !== "number") {
      throw new Error(`PRAGMA ${name} did not return a number.`);
    }
    return value;
  }
}

class WasmSqlStatement implements SqlDatabaseStatement {
  readonly #database: SqliteWasmDatabaseHandle;
  readonly #statement: SqliteWasmStatement;
  #closed = false;

  constructor(
    database: SqliteWasmDatabaseHandle,
    statement: SqliteWasmStatement,
    readonly sql: string,
  ) {
    this.#database = database;
    this.#statement = statement;
  }

  get parameterCount(): number {
    return this.#statement.parameterCount;
  }

  execute(params: readonly SqlValue[]): SqlResult {
    if (params.length !== this.parameterCount) throw new Error(SQL_WRONG_BINDINGS_MESSAGE);
    if (params.length > 0) this.#statement.bind(params);

    const columnCount = this.#statement.columnCount;
    if (columnCount === 0) {
      this.#statement.step();
      return { columnNames: [], rawRows: [], rowsWritten: this.#database.changes(false) };
    }

    const changesBefore = this.#database.changes(true);
    const columnNames = this.#statement.getColumnNames();
    const rawRows: unknown[][] = [];
    while (this.#statement.step()) {
      const row: unknown[] = [];
      for (let column = 0; column < columnCount; column += 1) {
        row.push(this.#statement.get(column));
      }
      rawRows.push(row);
    }
    // A SELECT leaves total_changes() untouched; DML RETURNING advances it.
    // The delta avoids a SQL classifier and matches the public cursor contract.
    return {
      columnNames,
      rawRows,
      rowsWritten: this.#database.changes(true) - changesBefore,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statement.finalize();
  }
}

/** Finds the first complete statement without reimplementing SQLite's trigger grammar. */
function firstCompleteStatement(capi: SqliteWasmCapi, sql: string): string {
  let semicolon = sql.indexOf(";");
  while (semicolon !== -1) {
    const candidate = sql.slice(0, semicolon + 1);
    if (capi.sqlite3_complete(candidate) === 1) return candidate;
    semicolon = sql.indexOf(";", semicolon + 1);
  }
  return sql;
}
