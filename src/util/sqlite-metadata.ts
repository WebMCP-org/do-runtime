/**
 * ← workerd `src/workerd/util/sqlite-metadata.{h,c++}`
 *
 * A simple metadata kv storage and cache on top of SQLite. Currently used to
 * store:
 *
 *  - Durable Object alarm times (hardcoded as key = 1);
 *  - a local development bookmark used to simulate the getCurrentBookmark API
 *    used by D1 (hardcoded as key = 2), not used in production.
 *
 * The table is named `_cf_METADATA`. The naming is designed so that if the
 * application is allowed to perform direct SQL queries, we can block it from
 * accessing any table prefixed with `_cf_`.
 *
 * Times are milliseconds, not nanoseconds. Upstream stores
 * `(t - UNIX_EPOCH) / kj::NANOSECONDS` as an int64. A JS number runs out of
 * integer precision 104 days into the epoch at nanosecond scale, so storing
 * what upstream stores would silently round every alarm. Milliseconds are also
 * what every caller above this already uses.
 *
 * The local-development bookmark IS ported, which the package's bookmark
 * substrate boundary might seem to rule out. It does not: that boundary is
 * `getCurrentBookmark` / `getBookmarkForTime` / `onNextSessionRestoreBookmark`,
 * which need point-in-time recovery from the storage engine. Key 2 is an
 * integer in a row, and D1 uses it locally precisely because it needs nothing.
 *
 * Spec: §1.8, §2.6 in docs/decisions.md.
 */

import {
  getInt64,
  hasCurrentSqliteTable,
  isNull,
  type ResetListener,
  type SqliteDatabase,
} from "./sqlite";

/** ← the `Initialized` statement bundle. */
const STMT = {
  getAlarm: `
      SELECT value FROM _cf_METADATA WHERE key = 1
    `,
  setAlarm: `
      INSERT INTO _cf_METADATA VALUES(1, ?)
        ON CONFLICT DO UPDATE SET value = excluded.value
    `,
  getLocalDevelopmentBookmark: `
      SELECT value FROM _cf_METADATA WHERE key = 2
    `,
  setLocalDevelopmentBookmark: `
      INSERT INTO _cf_METADATA VALUES(2, ?)
        ON CONFLICT DO UPDATE SET value = excluded.value
    `,
} as const;

const CREATE_TABLE = `
      CREATE TABLE IF NOT EXISTS _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      )
    `;

/** ← `SqliteMetadata::Cache`. */
type Cache = {
  alarmTime: number | null;
};

export class SqliteMetadata implements ResetListener {
  readonly #db: SqliteDatabase;
  #tableCreated: boolean;
  #cache: Cache | undefined;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#tableCreated = hasCurrentSqliteTable(db, "_cf_METADATA", CREATE_TABLE);
    if (this.#tableCreated) {
      const unexpected = db.run("SELECT key FROM _cf_METADATA WHERE key NOT IN (1, 2) LIMIT 1")
        .rawRows[0];
      if (unexpected !== undefined) {
        throw new Error(
          `Incompatible @mcp-b/do-runtime storage data: _cf_METADATA contains unsupported key ${getInt64(unexpected, 0)}.`,
        );
      }
    }
    db.addResetListener(this);
  }

  /** Return currently set alarm time, or null. */
  getAlarm(): number | null {
    return this.#ensureCached().alarmTime;
  }

  /**
   * Sets current alarm time, or null. Returns true if the value changed, false
   * if it was already set to the same value.
   */
  setAlarm(currentTime: number | null, allowUnconfirmed: boolean): boolean {
    const cached = this.#cache;
    if (cached !== undefined && cached.alarmTime === currentTime) {
      return false;
    }
    this.#setAlarmUncached(currentTime, allowUnconfirmed);
    this.#db.onRollback(() => {
      this.#cache = cached;
    });
    this.#cache = { alarmTime: currentTime };
    return true;
  }

  /** Return the current local development bookmark, or null if none has been set. */
  getLocalDevelopmentBookmark(): number | null {
    this.#ensureInitialized(false);
    const row = this.#db.run(STMT.getLocalDevelopmentBookmark).rawRows[0];
    if (row === undefined || isNull(row, 0)) return null;

    const bookmark = getInt64(row, 0);
    if (bookmark < 0) throw new Error(`Local development bookmark is negative: ${bookmark}.`);
    return bookmark;
  }

  /** Set the current ersatz bookmark. */
  setLocalDevelopmentBookmark(bookmark: number): void {
    // Upstream's `uint64_t` parameter plus its `KJ_REQUIRE(bookmark <= maxValue)`, expressed in
    // the range a JS number can actually carry without rounding.
    if (!Number.isSafeInteger(bookmark) || bookmark < 0) {
      throw new Error(
        `Local development bookmark is not a non-negative safe integer: ${bookmark}.`,
      );
    }
    this.#ensureInitialized(false);
    this.#db.run(STMT.setLocalDevelopmentBookmark, bookmark);
  }

  /** ResetListener interface: we'll need to recreate the table on the next operation. */
  beforeSqliteReset(): void {
    this.#tableCreated = false;
    this.#cache = undefined;
  }

  #ensureCached(): Cache {
    // The only read in this class that can be answered without a statement, so
    // the only one a latched critical error would not already stop — and the
    // one whose answer SQLite may have rolled back underneath.
    this.#db.assertUsable();
    const cached = this.#cache;
    if (cached !== undefined) return cached;

    const populated: Cache = {
      alarmTime: this.#getAlarmUncached(),
    };
    this.#cache = populated;
    return populated;
  }

  #getAlarmUncached(): number | null {
    if (!this.#tableCreated) return null;

    const row = this.#db.run(STMT.getAlarm).rawRows[0];
    if (row === undefined || isNull(row, 0)) return null;
    return getInt64(row, 0);
  }

  #setAlarmUncached(currentTime: number | null, allowUnconfirmed: boolean): void {
    this.#ensureInitialized(allowUnconfirmed);
    // Our getter code also allows representing an empty alarm value as a
    // missing row or table, but a null-value row seems efficient and simple.
    this.#db.run({ allowUnconfirmed }, STMT.setAlarm, currentTime);
  }

  /**
   * Make sure the metadata table is created. Not called until the first write —
   * except by the bookmark getter, which is upstream's shape too.
   */
  #ensureInitialized(allowUnconfirmed: boolean): void {
    if (this.#tableCreated) return;

    this.#db.run({ allowUnconfirmed }, CREATE_TABLE);
    this.#tableCreated = true;
    this.#db.onRollback(() => {
      this.#tableCreated = false;
    });
  }
}
