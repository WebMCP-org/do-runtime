/**
 * ← workerd `src/workerd/util/sqlite-kv.{h,c++}`
 *
 * KV storage on top of SQLite, for Durable Object storage.
 *
 * The table is named `_cf_KV`. The naming is designed so that if the
 * application is allowed to perform direct SQL queries, we can block it from
 * accessing any table prefixed with `_cf_`.
 *
 * This layer is bytes in, bytes out, exactly as upstream is. The structured
 * value encoding happens above it, in `api/actor-state.ts`, which is where
 * upstream V8-serializes.
 *
 * Three translations, each of them forced:
 *
 *  - `get`'s callback exists upstream to avoid copying bytes out of a live
 *    sqlite row. Our backends have already materialised the row by the time we
 *    see it, so there is no copy to avoid and the value is returned.
 *  - `delete_` is spelled `delete` — the C++ name carries a trailing underscore
 *    only because `delete` is a keyword there.
 *  - Upstream's `Uninitialized` / `Initialized` pair exists solely to hold
 *    thirteen `SqliteDatabase::Statement`s. Prepared statements are not part of
 *    our backend seam (each `exec` prepares), so the pair collapses into the
 *    `tableCreated` flag it already sits beside. The statements survive as
 *    `STMT` below: same names, same order, SQL copied verbatim, so the
 *    correspondence a reader needs is intact.
 *
 * Not ported: `SqliteKvRegulator`. Its remaining job is `shouldAddQueryStats`,
 * which is row-count billing; neither backend exposes those counters.
 *
 * Spec: §2.4 in docs/decisions.md.
 */

import {
  getBlob,
  getInt64,
  getText,
  hasCurrentSqliteTable,
  type ResetListener,
  type SqliteDatabase,
} from "./sqlite";

export type KeyPtr = string;
export type ValuePtr = Uint8Array;

/** ← `SqliteKv::Order`. */
export type Order = "FORWARD" | "REVERSE";

/** ← `SqliteKv::WriteOptions`. */
export type WriteOptions = {
  allowUnconfirmed?: boolean;
};

/** ← `SqliteKv::ListCursor::KeyValuePair`, and the shape `put(pairs)` iterates. */
export type KeyValuePair = {
  key: KeyPtr;
  value: ValuePtr;
};

/** ← the `Initialized` statement bundle, verbatim. */
const STMT = {
  get: `
      SELECT value FROM _cf_KV WHERE key = ?
    `,
  put: `
      INSERT INTO _cf_KV VALUES(?, ?)
        ON CONFLICT DO UPDATE SET value = excluded.value
    `,
  delete: `
      DELETE FROM _cf_KV WHERE key = ?
    `,
  list: `
      SELECT * FROM _cf_KV
      WHERE key >= ?
      ORDER BY key
    `,
  listEnd: `
      SELECT * FROM _cf_KV
      WHERE key >= ? AND key < ?
      ORDER BY key
    `,
  listLimit: `
      SELECT * FROM _cf_KV
      WHERE key >= ?
      ORDER BY key
      LIMIT ?
    `,
  listEndLimit: `
      SELECT * FROM _cf_KV
      WHERE key >= ? AND key < ?
      ORDER BY key
      LIMIT ?
    `,
  listReverse: `
      SELECT * FROM _cf_KV
      WHERE key >= ?
      ORDER BY key DESC
    `,
  listEndReverse: `
      SELECT * FROM _cf_KV
      WHERE key >= ? AND key < ?
      ORDER BY key DESC
    `,
  listLimitReverse: `
      SELECT * FROM _cf_KV
      WHERE key >= ?
      ORDER BY key DESC
      LIMIT ?
    `,
  listEndLimitReverse: `
      SELECT * FROM _cf_KV
      WHERE key >= ? AND key < ?
      ORDER BY key DESC
      LIMIT ?
    `,
  countKeys: `
      SELECT count(*) FROM _cf_KV
    `,
  multiPutSavepoint: `
      SAVEPOINT _cf_put_multiple_savepoint
    `,
  multiPutRelease: `
      RELEASE _cf_put_multiple_savepoint
    `,
} as const;

const CREATE_TABLE = `
      CREATE TABLE IF NOT EXISTS _cf_KV (
        key TEXT PRIMARY KEY,
        value BLOB
      ) WITHOUT ROWID
    `;

export class SqliteKv implements ResetListener {
  readonly #db: SqliteDatabase;

  /**
   * Has the `_cf_KV` table been created? Separate from the statement bundle
   * upstream, since it has to be repeated after a reset.
   */
  #tableCreated = false;

  #currentCursor: SqliteKvListCursor | null = null;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#tableCreated = hasCurrentSqliteTable(db, "_cf_KV", CREATE_TABLE);
    db.addResetListener(this);
  }

  /**
   * Search for a match for the given key. Returns the value if found, undefined
   * if not.
   */
  get(key: KeyPtr): ValuePtr | undefined {
    // "No table, so no value" is answered from `#tableCreated` without a
    // statement, which is the one path a latched critical error would not
    // otherwise stop.
    this.#db.assertUsable();
    if (!this.#tableCreated) return undefined;

    const row = this.#db.run(STMT.get, key).rawRows[0];
    if (row === undefined) return undefined;
    return getBlob(row, 0);
  }

  /**
   * Search for all known keys and values in a range. `end` and `limit` can be
   * undefined to request no constraint be enforced.
   *
   * With a callback, calls it for each row seen and returns the count. Without
   * one, returns a cursor which can be iterated one at a time.
   */
  list(
    begin: KeyPtr,
    end: KeyPtr | undefined,
    limit: number | undefined,
    order: Order,
  ): SqliteKvListCursor;
  list(
    begin: KeyPtr,
    end: KeyPtr | undefined,
    limit: number | undefined,
    order: Order,
    callback: (key: KeyPtr, value: ValuePtr) => void,
  ): number;
  list(
    begin: KeyPtr,
    end: KeyPtr | undefined,
    limit: number | undefined,
    order: Order,
    callback?: (key: KeyPtr, value: ValuePtr) => void,
  ): SqliteKvListCursor | number {
    const cursor = this.#openCursor(begin, end, limit, order);
    return callback === undefined ? cursor : cursor.forEach(callback);
  }

  /** Store a value into the table, or atomically store multiple values. */
  put(key: KeyPtr, value: ValuePtr, options?: WriteOptions): void;
  put(pairs: Iterable<KeyValuePair>, options: WriteOptions): void;
  put(
    keyOrPairs: KeyPtr | Iterable<KeyValuePair>,
    valueOrOptions?: ValuePtr | WriteOptions,
    maybeOptions?: WriteOptions,
  ): void {
    // The two overloads share a parameter position, and narrowing it by test
    // rather than by cast is what keeps a caller who mixes them up from writing
    // an options object into the table as a value.
    if (typeof keyOrPairs === "string") {
      if (!(valueOrOptions instanceof Uint8Array)) {
        throw new Error("put(key, value) takes a Uint8Array value.");
      }
      const allowUnconfirmed = maybeOptions?.allowUnconfirmed ?? false;
      this.#ensureInitialized(allowUnconfirmed);
      this.#db.run({ allowUnconfirmed }, STMT.put, keyOrPairs, valueOrOptions);
      return;
    }
    if (valueOrOptions instanceof Uint8Array) {
      throw new Error("put(pairs, options) takes an options object.");
    }
    this.#putMultiple(keyOrPairs, valueOrOptions ?? {});
  }

  /** Delete the key and return whether it was matched. */
  delete(key: KeyPtr, options: WriteOptions = {}): boolean {
    const allowUnconfirmed = options.allowUnconfirmed ?? false;
    this.#ensureInitialized(allowUnconfirmed);
    return this.#db.run({ allowUnconfirmed }, STMT.delete, key).rowsWritten > 0;
  }

  deleteAll(): number {
    // Upstream's TODO(perf) applies verbatim: apps almost certainly don't care
    // about the return value, but historically we returned the count of keys
    // deleted, so now we're stuck counting the table size for no good reason.
    let count = 0;
    if (this.#tableCreated) {
      const row = this.#db.run(STMT.countKeys).rawRows[0];
      if (row === undefined) throw new Error("count(*) returned no row.");
      count = getInt64(row, 0);
    }
    this.#db.reset();
    return count;
  }

  /** ResetListener interface: we'll need to recreate the table on the next operation. */
  beforeSqliteReset(): void {
    this.#tableCreated = false;
    // Upstream's cursors are ResetListeners of their own and throw
    // "query canceled because reset()" afterwards. Ours hold a materialised
    // array that a reset cannot invalidate, so cancelling is what keeps a
    // cursor from outliving the data it was reading.
    this.#cancelCurrentCursor();
  }

  #openCursor(
    begin: KeyPtr,
    end: KeyPtr | undefined,
    limit: number | undefined,
    order: Order,
  ): SqliteKvListCursor {
    // Same cache-served early return as `get`.
    this.#db.assertUsable();
    if (!this.#tableCreated) return new SqliteKvListCursor(null, null);

    const [sql, params] = selectListStatement(begin, end, limit, order);
    this.#cancelCurrentCursor();
    const cursor = new SqliteKvListCursor(this, this.#db.run(sql, ...params).rawRows);
    this.#currentCursor = cursor;
    return cursor;
  }

  /** Called by a cursor that has run out of rows, mirroring `~ListCursor::State`. */
  releaseCursor(cursor: SqliteKvListCursor): void {
    if (this.#currentCursor === cursor) this.#currentCursor = null;
  }

  #cancelCurrentCursor(): void {
    const cursor = this.#currentCursor;
    if (cursor !== null) {
      cursor.cancel();
      this.#currentCursor = null;
    }
  }

  #putMultiple(pairs: Iterable<KeyValuePair>, options: WriteOptions): void {
    const allowUnconfirmed = options.allowUnconfirmed ?? false;
    this.#ensureInitialized(allowUnconfirmed);
    this.#db.run({ allowUnconfirmed }, STMT.multiPutSavepoint);

    try {
      for (const pair of pairs) {
        this.put(pair.key, pair.value, { allowUnconfirmed });
      }
    } catch (error) {
      // If any of the puts throw, roll the savepoint back and re-throw the
      // exception from the put that failed.
      this.#rollbackMultiPut(allowUnconfirmed, error);
      throw error;
    }
    this.#db.run({ allowUnconfirmed }, STMT.multiPutRelease);
  }

  /**
   * Upstream logs and swallows a failure here, on the grounds that it should be
   * rare. This repo has no logger and a storage layer that swallows an error
   * corrupts data silently, so a failed rollback is raised instead — carrying
   * the put failure as its cause, since that is the one the caller came for.
   * The normal path is unchanged: a rollback that succeeds re-throws the
   * original untouched.
   */
  #rollbackMultiPut(allowUnconfirmed: boolean, cause: unknown): void {
    try {
      // This should be rare, so we don't keep a statement for it.
      this.#db.run({ allowUnconfirmed }, "ROLLBACK TO _cf_put_multiple_savepoint");
      this.#db.run({ allowUnconfirmed }, STMT.multiPutRelease);
    } catch (rollbackError) {
      throw new Error(`Rolling back a multi-put failed: ${String(rollbackError)}`, { cause });
    }
  }

  /**
   * Make sure the KV table is created. Not called until the first write —
   * upstream's `ensureInitialized`, minus the statement bundle.
   */
  #ensureInitialized(allowUnconfirmed: boolean): void {
    if (this.#tableCreated) return;

    this.#db.run({ allowUnconfirmed }, CREATE_TABLE);
    this.#tableCreated = true;

    // If we're in a transaction and it gets rolled back, we better mark that
    // the table is actually not created anymore.
    this.#db.onRollback(() => {
      this.#tableCreated = false;
    });
  }
}

/**
 * ← `SqliteKv::ListCursor`.
 *
 * Upstream's iterates a live sqlite statement, which is why only one may be
 * open at a time and why a new `list()` cancels the previous cursor. Our rows
 * arrive materialised, so nothing forces that constraint — it is kept because
 * `wasCanceled()` is part of the contract above this layer, and a cursor whose
 * cancellation depended on the substrate would make the browser and Node lanes
 * disagree. What we do lose is streaming: an unbounded `list()` reads the whole
 * range into memory, where upstream reads a row at a time.
 */
export class SqliteKvListCursor {
  readonly #parent: SqliteKv | null;
  #rows: readonly (readonly unknown[])[] | null;
  #index = 0;
  #canceled = false;

  constructor(parent: SqliteKv | null, rows: readonly (readonly unknown[])[] | null) {
    this.#parent = parent;
    this.#rows = rows;
  }

  next(): KeyValuePair | undefined {
    const rows = this.#rows;
    if (rows === null) return undefined;

    const row = rows[this.#index];
    if (row === undefined) {
      this.#exhaust();
      return undefined;
    }
    this.#index += 1;
    return { key: getText(row, 0), value: getBlob(row, 1) };
  }

  forEach(callback: (key: KeyPtr, value: ValuePtr) => void): number {
    let count = 0;
    for (;;) {
      const pair = this.next();
      if (pair === undefined) return count;
      callback(pair.key, pair.value);
      count += 1;
    }
  }

  /**
   * If true, the cursor was canceled due to a new list() operation starting.
   * Only one list() is allowed at a time.
   */
  wasCanceled(): boolean {
    return this.#canceled;
  }

  /** Called by `SqliteKv` only. */
  cancel(): void {
    this.#rows = null;
    this.#canceled = true;
  }

  #exhaust(): void {
    this.#rows = null;
    this.#parent?.releaseCursor(this);
  }
}

/** ← the eight-way branch in `SqliteKv::list`, in the same order. */
function selectListStatement(
  begin: KeyPtr,
  end: KeyPtr | undefined,
  limit: number | undefined,
  order: Order,
): [sql: string, params: (string | number)[]] {
  if (order === "FORWARD") {
    if (end !== undefined) {
      if (limit !== undefined) return [STMT.listEndLimit, [begin, end, limit]];
      return [STMT.listEnd, [begin, end]];
    }
    if (limit !== undefined) return [STMT.listLimit, [begin, limit]];
    return [STMT.list, [begin]];
  }
  if (end !== undefined) {
    if (limit !== undefined) return [STMT.listEndLimitReverse, [begin, end, limit]];
    return [STMT.listEndReverse, [begin, end]];
  }
  if (limit !== undefined) return [STMT.listLimitReverse, [begin, limit]];
  return [STMT.listReverse, [begin]];
}
