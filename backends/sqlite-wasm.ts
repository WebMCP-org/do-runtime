/**
 * ← workerd `NO upstream correspondence (storage-backend adaptation)`
 *
 * `SqlDatabaseProvider` over the browser's OPFS SAH pool.
 *
 * The pool is a parameter, not something this module goes and gets. The host
 * decides the OPFS directory, the pool capacity and whether to clear on init,
 * all of which are layout questions this package deliberately knows nothing
 * about; it installs the pool through `installSqliteWasmHost`, which corrects
 * two driver behaviours a terminated worker turns into data loss. What arrives
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
 * The unit lane runs this file over fake pools and the real engine; only the
 * OPFS pool itself needs a browser. The pool is exercised twice in the browser
 * lane — by `sqlite-wasm.smoke.spec.ts`, which drives this file directly, and
 * by the conformance suite, which runs the whole package over it.
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
import { requireImportableRuntimeStorage } from "../src/util/sqlite-migrations";

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
 * already holds. Both come off the same `sqlite3` object the caller passed to
 * `installSqliteWasmHost`, which returns exactly this.
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
 * The four `installOpfsSAHPoolVfs` options this module supports: `name`,
 * `directory`, `clearOnInit` and `initialCapacity`.
 */
export type SqliteWasmPoolOptions = {
  /** The VFS name. The driver's default is "opfs-sahpool". */
  readonly name?: string;
  /** The pool's OPFS directory. The driver's default is `.${name}`. */
  readonly directory?: string;
  readonly clearOnInit?: boolean;
  readonly initialCapacity?: number;
};

/** ← `Sqlite3Static`, the members `installSqliteWasmHost` reads. */
export interface SqliteWasmModule<Pool extends OpfsSahPool> {
  readonly capi: SqliteWasmCapi & { sqlite3_vfs_find(name: string): number };
  /** Read by the lock patch; see `rollBackHotJournals`. */
  readonly wasm: object;
  installOpfsSAHPoolVfs(options: SqliteWasmPoolOptions): Promise<Pool>;
}

/**
 * Installs an OPFS SAH pool for this backend through the driver's
 * `installOpfsSAHPoolVfs`, returning the host `createSqliteWasmProvider` takes.
 * Install every pool through it; both of its additions are load-bearing for a
 * worker the browser can terminate:
 *
 * - It waits, up to 10 s, until no file in the pool is still held by a previous
 *   owner, then rejects with a `NoModificationAllowedError` DOMException. A
 *   failed install runs the driver's `removeVfs()`, which deletes the pool
 *   directory, and a worker terminated mid-slice keeps its handles for about
 *   2 s: retrying the install across that release lost the whole pool in 3 of 24
 *   measured recoveries.
 * - It makes SQLite roll back the hot journal a terminated worker left. The
 *   driver reports a reserved lock on every file, so the journal was never
 *   replayed: 284 of 2304 acknowledged rows reopened overwritten by the
 *   transaction the worker died in.
 *
 * Concurrent calls for one pool share one install, and a later call for a pool
 * this worker has installed returns it at once.
 */
export function installSqliteWasmHost<Pool extends OpfsSahPool>(
  sqlite3: SqliteWasmModule<Pool>,
  options: SqliteWasmPoolOptions = {},
): Promise<SqliteWasmHost & { readonly pool: Pool }> {
  const name = options.name || "opfs-sahpool";
  const flights = installing.get(sqlite3) ?? new Map<string, Promise<unknown>>();
  installing.set(sqlite3, flights);
  // One `sqlite3` instance's install of one pool name always yields that instance's pool type.
  const current = flights.get(name) as Promise<SqliteWasmHost & { readonly pool: Pool }> | undefined;
  if (current !== undefined) return current;
  const flight = install(sqlite3, name, options);
  flights.set(name, flight);
  const land = (): void => {
    flights.delete(name);
  };
  void flight.then(land, land);
  return flight;
}

/** Installs in flight, per `sqlite3` instance and pool name. */
const installing = new WeakMap<object, Map<string, Promise<unknown>>>();

async function install<Pool extends OpfsSahPool>(
  sqlite3: SqliteWasmModule<Pool>,
  name: string,
  options: SqliteWasmPoolOptions,
): Promise<SqliteWasmHost & { readonly pool: Pool }> {
  const installed = sqlite3.capi.sqlite3_vfs_find(name) !== 0;
  if (!installed) await released(options.directory || `.${name}`);
  const pool = await sqlite3.installOpfsSAHPoolVfs(options);
  if (!installed) rollBackHotJournals(sqlite3, name);
  return { pool, capi: sqlite3.capi };
}

/** How long a previous owner may hold the pool; a busy terminated worker measured about 2 s. */
const POOL_RELEASE_TIMEOUT_MS = 10_000;

/** Captured at import, because a host installs its actor scope over `setTimeout` afterwards. */
const platformSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Resolves once no file in the pool directory is held by another context, or at
 * once when the pool does not exist yet. Opening and closing a sync access
 * handle changes nothing, and a terminated worker never takes one back.
 */
async function released(directory: string): Promise<void> {
  let files = await navigator.storage.getDirectory();
  try {
    // The driver keeps a pool's files in `.opaque` under its directory.
    for (const part of [...directory.split("/"), ".opaque"]) {
      if (part !== "") files = await files.getDirectoryHandle(part);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  for (const deadline = Date.now() + POOL_RELEASE_TIMEOUT_MS; ; ) {
    try {
      for await (const file of files.values()) {
        if (file.kind === "file") (await file.createSyncAccessHandle()).close();
      }
      return;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NoModificationAllowedError")) {
        throw error;
      }
      if (Date.now() > deadline) {
        throw new DOMException(
          `OPFS SAH pool ${directory} is still held by another context.`,
          "NoModificationAllowedError",
        );
      }
      await new Promise((resolve) => platformSetTimeout(resolve, 20));
    }
  }
}

/**
 * The struct-binder and heap members the lock patch uses. The driver's
 * declarations omit the `$`-prefixed pointer members, so they are read here
 * rather than required of the host's `sqlite3` type.
 */
type WasmStruct = { installMethod(name: string, func: (...args: number[]) => number): unknown };
type SqliteWasmInternals = {
  readonly capi: {
    readonly sqlite3_vfs: new (pointer: number) => WasmStruct & { $xOpen: number };
    readonly sqlite3_io_methods: new (pointer: number) => WasmStruct;
    sqlite3_vfs_find(name: string): number;
  };
  readonly wasm: {
    functionEntry(pointer: number): ((...args: number[]) => number) | null | undefined;
    peekPtr(pointer: number): number;
    poke32(pointer: number, value: number): unknown;
  };
};

/**
 * Makes `xCheckReservedLock` report no reserved lock for every SAH pool in this
 * sqlite3 instance.
 *
 * The driver's `opfs-sahpool` reports one for every file, which tells SQLite
 * another connection is mid-write, so `hasHotJournal()` never replays a journal
 * a terminated worker left. The driver's other OPFS VFSes report none.
 *
 * The driver keeps one io-methods struct (`opfsIoMethods`) for every file of
 * every SAH pool in this sqlite3 instance, reachable only through an open file's
 * `pMethods`. So this pool's `xOpen` is wrapped until its first successful open,
 * which patches that shared struct before the connection's first read (where
 * SQLite checks for a hot journal) and restores `xOpen`.
 */
function rollBackHotJournals(
  sqlite3: { readonly capi: object; readonly wasm: object },
  vfsName: string,
): void {
  const { capi, wasm } = sqlite3 as unknown as SqliteWasmInternals;
  const pointer = capi.sqlite3_vfs_find(vfsName);
  // A paused pool the driver returned from its cache kept the hook it was installed with.
  if (pointer === 0) return;
  const vfs = new capi.sqlite3_vfs(pointer);
  const xOpen = vfs.$xOpen;
  const open = wasm.functionEntry(xOpen);
  if (!open) throw new Error(`The SAH pool VFS ${vfsName} has no xOpen.`);
  vfs.installMethod("xOpen", (pVfs, zName, pFile, flags, pOutFlags) => {
    const result = open(pVfs, zName, pFile, flags, pOutFlags);
    if (result !== 0) return result;
    // ponytail: every SAH pool in this sqlite3 instance now answers "none", which is exact
    // while each database file has one connection, do-runtime's contract. The driver tracks
    // each file's `lockType` only in private state; answer from it once upstream exposes it or
    // fixes `xCheckReservedLock`, or wrap `xLock`/`xUnlock` to track locks per path if a host
    // ever opens one file twice.
    new capi.sqlite3_io_methods(wasm.peekPtr(pFile)).installMethod(
      "xCheckReservedLock",
      (_file, pOut) => {
        wasm.poke32(pOut, 0);
        return 0;
      },
    );
    vfs.$xOpen = xOpen;
    return result;
  });
}

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
   * refused before the destination is touched. Every source image is also
   * exported before replacement starts, so a failed read preserves the target.
   */
  async copyFrom(source: SqliteWasmActorStorage): Promise<void> {
    const files = source.#ownedFiles();
    const sidecar = files.find((file) => !file.endsWith(".sqlite"));
    if (sidecar !== undefined) {
      throw new Error(`Cannot clone actor storage with a SQLite recovery sidecar: ${sidecar}`);
    }
    // Every export starts in the check's task, before a running source can open a journal.
    const images = await Promise.all(
      files.map(async (file) => {
        const name = file.slice(source.#prefix.length + 1, -".sqlite".length);
        requireSafeDatabaseName(name);
        return { name, image: new Uint8Array(await source.#host.pool.exportFile(file)) };
      }),
    );
    this.close();
    await replaceDatabases(this.#host.pool, this.#prefix, images);
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
      requireImportableRuntimeStorage(snapshot);
      await replaceDatabases(host.pool, prefix, snapshot.databases);
    },
  };
}

/** A failed rollback retains the original images so the host can recover to another prefix. */
export class SqliteWasmRestoreError extends AggregateError {
  constructor(errors: unknown[], readonly recoverySnapshot: SqlDatabaseSnapshot) {
    super(
      errors,
      "SQLite replacement and rollback failed; restore recoverySnapshot to an idle provider.",
    );
    this.name = "SqliteWasmRestoreError";
  }
}

async function replaceDatabases(
  pool: OpfsSahPool,
  prefix: string,
  databases: SqlDatabaseSnapshot["databases"],
): Promise<void> {
  const replacement = databases.map(({ name, image }) => ({ name, image: new Uint8Array(image) }));
  const ownedFiles = () => pool.getFileNames().filter((file) => file.startsWith(`${prefix}.`));
  const files = ownedFiles();
  requireNoRecoverySidecars(files);
  const original: Array<{ name: string; image: Uint8Array }> = [];
  for (const file of files) {
    const name = file.slice(prefix.length + 1, -".sqlite".length);
    requireSafeDatabaseName(name);
    original.push({ name, image: new Uint8Array(await pool.exportFile(file)) });
  }
  const touched = new Set<string>();
  try {
    for (const file of files) {
      // unlink can remove the pool's mapping before a backing-file write fails.
      touched.add(file);
      if (!pool.unlink(file)) throw new Error(`SAH pool did not unlink ${file}`);
    }
    for (const { name, image } of replacement) {
      const file = `${prefix}.${name}.sqlite`;
      touched.add(file);
      await pool.importDb(file, image);
    }
  } catch (error) {
    // ponytail: rollback lives in memory; use a fresh prefix and a host-owned switch
    // when replacement must survive the worker/process dying during import.
    const errors = [error];
    for (const file of ownedFiles()) {
      if (!touched.has(file)) continue;
      try {
        if (!pool.unlink(file)) throw new Error(`SAH pool did not unlink ${file}`);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    for (const { name, image } of original) {
      const file = `${prefix}.${name}.sqlite`;
      if (!touched.has(file)) continue;
      try {
        await pool.importDb(file, new Uint8Array(image));
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    if (errors.length > 1) {
      throw new SqliteWasmRestoreError(errors, { version: 1, databases: original });
    }
    throw error;
  }
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
    this.#database = this.#openDatabase();
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
    this.#database = this.#openDatabase();
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
    this.onClose();
  }

  /** ← `SqliteDatabase::init`: a failed setup still owns a handle that must close. */
  #openDatabase(): SqliteWasmDatabaseHandle {
    const database = new this.#host.pool.OpfsSAHPoolDb(this.#filename);
    try {
      const pointer = database.pointer;
      if (pointer === undefined) throw new Error("The database handle is closed.");
      this.#host.capi.sqlite3_limit(
        pointer,
        this.#host.capi.SQLITE_LIMIT_LENGTH,
        SQLITE_LENGTH_LIMIT,
      );
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
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
      // `changes(false)` survives a statement that writes nothing (DDL), so it counts only if
      // total_changes() moved. It excludes trigger and FTS5/R-Tree shadow-table writes.
      const before = this.#database.changes(true);
      this.#statement.step();
      const wrote = this.#database.changes(true) !== before;
      return { columnNames: [], rawRows: [], rowsWritten: wrote ? this.#database.changes(false) : 0 };
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
    // A SELECT leaves total_changes() untouched; DML RETURNING advances it, which avoids a
    // SQL classifier. `changes(false)` is then this statement's own count, as above.
    const wrote = this.#database.changes(true) !== changesBefore;
    return {
      columnNames,
      rawRows,
      rowsWritten: wrote ? this.#database.changes(false) : 0,
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
