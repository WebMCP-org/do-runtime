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
 * to that VFS, plus the pool's file export/import/unlink operations used by
 * snapshots and `reset()`.
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
  requireSqliteLength,
  requireSafeDatabaseName,
  requireValidSqlDatabaseSnapshot,
  SQLITE_LENGTH_LIMIT,
  SQL_WRONG_BINDINGS_MESSAGE,
  type SqlDatabase,
  type SqlDatabaseProvider,
  type SqlDatabaseSnapshot,
  type SqlDatabaseSnapshotProvider,
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
  exportFile(filename: string): Uint8Array | Promise<Uint8Array>;
  importDb(filename: string, image: Uint8Array): number | Promise<number>;
  getFileNames(): string[];
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
  readonly SQLITE_LIMIT_LENGTH: number;
  sqlite3_complete(sql: string): 0 | 1;
  sqlite3_get_autocommit(db: number): number;
  sqlite3_limit(db: number, id: number, newValue: number): number;
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

/**
 * One actor's named databases and their file lifecycle inside an OPFS SAH pool.
 *
 * A root or facet container only needs the `SqlDatabaseProvider` surface. Its
 * host also has to close every connection when that placement dies, remove the
 * prefix on delete, and copy every database on clone. Those file operations
 * belong here because SAH-pool files are virtual and can only be reached through
 * the pool that owns them.
 */
export class SqliteWasmActorStorage implements SqlDatabaseProvider {
  readonly #host: SqliteWasmHost;
  readonly #prefix: string;
  readonly #provider: SqlDatabaseSnapshotProvider;

  constructor(host: SqliteWasmHost, prefix: string) {
    this.#host = host;
    this.#prefix = prefix;
    this.#provider = createSqliteWasmProvider(host, { prefix });
  }

  open(name: string): Promise<SqlDatabase> {
    return this.#provider.open(name);
  }

  /**
   * Drop every handle. Leaving one behind per respawn or facet abort would
   * accumulate concurrent writers inside a VFS that expects to own its files.
   */
  close(): void {
    this.#provider.close();
  }

  /** Close every handle, then physically remove every database under this prefix. */
  deleteAll(): void {
    this.close();
    for (const file of this.#ownedFiles()) {
      if (!this.#host.pool.unlink(file)) throw new Error(`SAH pool did not unlink ${file}`);
    }
  }

  /**
   * Replace this prefix with every database under `source`, including files
   * from an earlier placement that this session never opened.
   *
   * The source may still be running, so this uses the pool's file operations
   * rather than the snapshot API, which correctly refuses open handles. A
   * recovery sidecar means the bytes are not a stable database image and is
   * refused before the destination is touched.
   */
  async copyFrom(source: SqliteWasmActorStorage): Promise<void> {
    const files = source.#ownedFiles();
    const sidecar = files.find((file) => !file.endsWith(".sqlite"));
    if (sidecar !== undefined) {
      throw new Error(`Cannot clone actor storage with a SQLite recovery sidecar: ${sidecar}`);
    }
    this.deleteAll();
    for (const file of files) {
      const name = file.slice(source.#prefix.length + 1, -".sqlite".length);
      requireSafeDatabaseName(name);
      await this.#host.pool.importDb(
        `${this.#prefix}.${name}.sqlite`,
        new Uint8Array(await source.#host.pool.exportFile(file)),
      );
    }
  }

  #ownedFiles(): string[] {
    return this.#host.pool
      .getFileNames()
      .filter((name) => name.startsWith(`${this.#prefix}.`));
  }
}

export function createSqliteWasmProvider(
  host: SqliteWasmHost,
  options: SqliteWasmProviderOptions,
): SqlDatabaseSnapshotProvider {
  const { prefix } = options;
  if (!prefix.startsWith("/")) {
    throw new Error(`SAH pool names are absolute; prefix must start with "/": ${prefix}`);
  }
  const openDatabases = new Set<SqliteWasmDatabase>();
  const ownedFiles = (): string[] =>
    host.pool.getFileNames().filter((name) => name.startsWith(`${prefix}.`));
  return {
    async open(name: string): Promise<SqlDatabase> {
      // Names come from inside the package, so this is defence in depth — but
      // it is the one place a name becomes a pool file name.
      requireSafeDatabaseName(name);
      let database: SqliteWasmDatabase;
      database = new SqliteWasmDatabase(host, `${prefix}.${name}.sqlite`, () =>
        openDatabases.delete(database),
      );
      openDatabases.add(database);
      return database;
    },
    close(): void {
      for (const database of [...openDatabases]) database.close();
    },
    async exportSnapshot(): Promise<SqlDatabaseSnapshot> {
      requireClosed(openDatabases);
      const files = ownedFiles();
      requireNoRecoverySidecars(files);
      const databases = await Promise.all(
        files
          .filter((file) => file.endsWith(".sqlite"))
          .sort()
          .map(async (file) => {
            const name = file.slice(prefix.length + 1, -".sqlite".length);
            requireSafeDatabaseName(name);
            return { name, image: new Uint8Array(await host.pool.exportFile(file)) };
          }),
      );
      const snapshot: SqlDatabaseSnapshot = { version: 1, databases };
      requireValidSqlDatabaseSnapshot(snapshot);
      return snapshot;
    },
    async importSnapshot(snapshot: SqlDatabaseSnapshot): Promise<void> {
      requireClosed(openDatabases);
      requireValidSqlDatabaseSnapshot(snapshot);
      for (const file of ownedFiles()) host.pool.unlink(file);
      for (const { name, image } of snapshot.databases) {
        await host.pool.importDb(`${prefix}.${name}.sqlite`, new Uint8Array(image));
      }
    },
  };
}

export class SqliteWasmDatabase implements SqlDatabase {
  readonly #host: SqliteWasmHost;
  readonly #filename: string;
  #database: SqliteWasmDatabaseHandle;
  #closed = false;

  constructor(
    host: SqliteWasmHost,
    filename: string,
    private readonly onClose: () => void = () => {},
  ) {
    this.#host = host;
    this.#filename = filename;
    this.#database = new host.pool.OpfsSAHPoolDb(filename);
    this.#setLengthLimit();
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
    this.#setLengthLimit();
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
    this.onClose();
  }

  #setLengthLimit(): void {
    const pointer = this.#database.pointer;
    if (pointer === undefined) throw new Error("The database handle is closed.");
    this.#host.capi.sqlite3_limit(
      pointer,
      this.#host.capi.SQLITE_LIMIT_LENGTH,
      SQLITE_LENGTH_LIMIT,
    );
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

function requireClosed(openDatabases: ReadonlySet<SqliteWasmDatabase>): void {
  if (openDatabases.size > 0) {
    throw new Error("Cannot snapshot or restore while database handles are open.");
  }
}

function requireNoRecoverySidecars(files: readonly string[]): void {
  const sidecar = files.find((file) => !file.endsWith(".sqlite"));
  if (sidecar !== undefined) {
    throw new Error(`Cannot export a snapshot with a SQLite recovery sidecar: ${sidecar}`);
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
    params.forEach(requireSqliteLength);
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
