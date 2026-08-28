/**
 * Runtime storage versioning. Package-original — workerd has no counterpart,
 * because Cloudflare upgrades workerd and its storage together. This package is
 * an npm dependency over data it does not control: OPFS files in a browser and
 * SQLite files on disk outlive any release, so the release that changes a
 * `_cf_` shape has to bring existing files forward itself.
 *
 * The mechanism is the Cloudflare Agents SDK's `_ensureSchema` pattern moved
 * one layer down: a stored schema version, a cumulative list of forward-only
 * idempotent migration steps, and a fast path that skips everything when the
 * stored version is current. Where an Agent runs this in its constructor
 * (before any event is delivered), the runtime runs it at database open —
 * `createActorContainer()` and `AlarmScheduler`'s constructor — which precedes
 * every event by construction, so no `blockConcurrencyWhile` is involved.
 *
 * The version lives in `PRAGMA user_version`: per database file, carried by
 * snapshots, transactional. Application SQL cannot reach it — `SqlStorage`
 * ports workerd's pragma allowlist (`util/sqlite.c++:539-563`), which does not
 * include `user_version` — so the value is runtime-owned by the same rule that
 * reserves `_cf_` names.
 *
 * Rules for a step, when the first real one is written:
 *
 *  - **Forward-only.** Never edit or reorder a shipped step; add the next one
 *    and bump `RUNTIME_STORAGE_VERSION`.
 *  - **Runtime tables only, guarded on existence.** Every database file holds
 *    a different subset of runtime tables (`_cf_KV`/`_cf_METADATA` in an actor
 *    database, the facet index and deletion receipts in the root's facet
 *    database, `_cf_ALARM` in a scheduler's), creation is lazy, and a database
 *    handed to `AlarmScheduler` is host-opened and may hold host tables beside
 *    the runtime's — a step must no-op where its table is absent and must
 *    never touch a table the runtime does not own.
 *  - **Idempotent against the current shape too** (`IF NOT EXISTS`, tolerate
 *    "duplicate column"): `deleteAll()` resets a file to version 0 while this
 *    release recreates its tables at the current shape, so a later chain run
 *    can meet already-current tables.
 *  - **No transaction control.** The chain and the stamp are one transaction;
 *    a step that issues `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` is refused by
 *    name below rather than silently splitting it.
 *
 * Spec: decision 19 in docs/decisions.md.
 */

import { getInt64, type SqlDatabase, type SqlDatabaseSnapshot } from "./sqlite";

/**
 * The shape of every runtime-owned table in this release. Bump together with
 * the step that upgrades the previous shape.
 */
export const RUNTIME_STORAGE_VERSION = 1;

export type RuntimeMigration = (db: SqlDatabase) => void;

/** `MIGRATIONS[i]` takes a database from storage version `i + 1` to `i + 2`. */
const MIGRATIONS: readonly RuntimeMigration[] = [];

/**
 * Bring one just-opened runtime database to `RUNTIME_STORAGE_VERSION`. Called
 * by every seam that opens a runtime database, before anything reads it, with
 * the database's own name so a refusal says which file it is about. The last
 * two parameters exist for the tests in this module's test file; every real
 * caller takes the shipped defaults.
 *
 * A version newer than this release refuses — the analogue of
 * `hasCurrentSqliteTable`'s refusal, with the one remedy named. A version 0
 * database is from before versioning existed (the same shape as version 1) or
 * a fresh file; both enter the chain at 1. Pending steps and the stamp commit
 * as one transaction, so a failed step leaves the file exactly as it was and
 * the container placement fails with the step's error.
 */
/**
 * Refuse a snapshot image stamped by a newer release at the import seam, where
 * the operation that brought the file in is the one that fails — instead of at
 * the next placement, far from the cause. `user_version` sits at byte 60 of
 * the SQLite header, big-endian (https://www.sqlite.org/fileformat2.html);
 * callers validate the header shape first (`requireValidSqlDatabaseSnapshot`).
 */
export function requireImportableRuntimeStorage(
  snapshot: SqlDatabaseSnapshot,
  current: number = RUNTIME_STORAGE_VERSION,
): void {
  for (const { name, image } of snapshot.databases) {
    const stored = new DataView(image.buffer, image.byteOffset, image.byteLength).getInt32(60);
    if (stored > current) {
      throw new Error(
        `Snapshot database ${JSON.stringify(name)} was written by a newer @mcp-b/do-runtime ` +
          `(storage version ${stored}; this release supports up to ${current}). ` +
          `Upgrade the package to import it.`,
      );
    }
  }
}

export function ensureRuntimeStorageVersion(
  db: SqlDatabase,
  name: string,
  current: number = RUNTIME_STORAGE_VERSION,
  migrations: readonly RuntimeMigration[] = MIGRATIONS,
): void {
  // `user_version` is a signed 32-bit field in the database header; a target
  // outside it would silently truncate on write.
  if (!Number.isSafeInteger(current) || current < 1 || current > 0x7fff_ffff) {
    throw new Error(`Runtime storage version must be a positive 32-bit integer, got ${current}.`);
  }
  const row = db.exec("PRAGMA user_version", []).rawRows[0];
  if (row === undefined) {
    throw new Error(`PRAGMA user_version returned no row for database ${JSON.stringify(name)}.`);
  }
  const stored = getInt64(row, 0);
  if (stored === current) return;
  if (stored > current) {
    throw new Error(
      `Runtime database ${JSON.stringify(name)} was written by a newer @mcp-b/do-runtime ` +
        `(storage version ${stored}; this release supports up to ${current}). ` +
        `Upgrade the package to open it.`,
    );
  }

  if (db.inTransaction) {
    throw new Error(
      `Runtime storage migration for database ${JSON.stringify(name)} began inside an open transaction.`,
    );
  }
  db.exec("BEGIN", []);
  try {
    // A negative stamp can only be a foreign file; it enters at 1 like a fresh
    // one, and `hasCurrentSqliteTable` afterwards refuses any foreign shape.
    for (let from = Math.max(stored, 1); from < current; from++) {
      const step = migrations[from - 1];
      if (step === undefined) {
        throw new Error(`Missing runtime storage migration from version ${from} to ${from + 1}.`);
      }
      step(db);
      if (!db.inTransaction) {
        // The step's own stray COMMIT already persisted its work; failing here
        // keeps the file unstamped so the next run retries the whole chain.
        throw new Error(
          `Runtime storage migration from version ${from} to ${from + 1} closed the migration ` +
            `transaction; a step must not issue BEGIN, COMMIT, ROLLBACK, or SAVEPOINT.`,
        );
      }
    }
    db.exec(`PRAGMA user_version = ${current}`, []);
    db.exec("COMMIT", []);
  } catch (error) {
    // SQLite may have rolled back on its own; roll back only what is still
    // open so nothing masks the step's error (§ SqlDatabase.inTransaction).
    if (db.inTransaction) db.exec("ROLLBACK", []);
    throw error;
  }
}
