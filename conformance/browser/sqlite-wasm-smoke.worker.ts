/**
 * The smoke test's actual body, in a dedicated worker because it has to be.
 *
 * `installOpfsSAHPoolVfs` needs `FileSystemFileHandle.createSyncAccessHandle`,
 * which browsers expose in dedicated workers and nowhere else — the first
 * attempt at this spec ran on the page and failed with "Missing required OPFS
 * APIs" before reaching a single assertion. That is not a limitation of the
 * test: it is why the extension already runs sqlite-wasm in its own worker, and
 * it means the storage floor can never be exercised from a page context.
 *
 * Each check reports a value rather than asserting, so a failure surfaces in
 * the spec with the real expected/actual instead of a worker-side throw.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmProvider, type SqliteWasmHost } from "../../backends/sqlite-wasm";

export type SmokeReport =
  | { ok: false; error: string }
  | {
      ok: true;
      roundTrip: {
        rowsWritten: number;
        columnNames: readonly string[];
        rawRows: readonly (readonly unknown[])[];
      };
      members: { before: boolean; inside: boolean; after: boolean; databaseSize: number };
      reset: { tablesAfterReset: readonly (readonly unknown[])[] };
    };

async function run(): Promise<SmokeReport> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    clearOnInit: true,
    name: "do-runtime-smoke",
  });
  const host: SqliteWasmHost = { pool, capi: sqlite3.capi };

  const roundTripDb = await createSqliteWasmProvider(host, { prefix: "/smoke" }).open("root");
  roundTripDb.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", []);
  const written = roundTripDb.exec("INSERT INTO t VALUES (?, ?)", ["a", "1"]);
  const read = roundTripDb.exec("SELECT v FROM t WHERE k = ?", ["a"]);
  roundTripDb.close();

  // `inTransaction` is the one place the backend calls the C API directly, and
  // it is what the runtime's critical-error detection reads to decide whether
  // SQLite rolled a transaction back underneath us. A wrong answer is silent
  // corruption, not a crash. `databaseSize` multiplies two PRAGMAs that were
  // assumed to be table-valued here the way they are under node:sqlite.
  const membersDb = await createSqliteWasmProvider(host, { prefix: "/smoke-members" }).open("root");
  membersDb.exec("CREATE TABLE t (k TEXT)", []);
  const before = membersDb.inTransaction;
  membersDb.exec("BEGIN", []);
  const inside = membersDb.inTransaction;
  membersDb.exec("ROLLBACK", []);
  const after = membersDb.inTransaction;
  const databaseSize = membersDb.databaseSize;
  membersDb.close();

  // `reset()` closes, unlinks through the pool rather than through OPFS, then
  // reopens. The unlink is the step with no node:sqlite equivalent, because the
  // pool's files are not visible in OPFS under these names.
  const resetDb = await createSqliteWasmProvider(host, { prefix: "/smoke-reset" }).open("root");
  resetDb.exec("CREATE TABLE t (k TEXT)", []);
  resetDb.exec("INSERT INTO t VALUES ('x')", []);
  resetDb.reset();
  const tablesAfterReset = resetDb.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    [],
  ).rawRows;
  resetDb.close();

  return {
    ok: true,
    roundTrip: {
      rowsWritten: written.rowsWritten,
      columnNames: read.columnNames,
      rawRows: read.rawRows,
    },
    members: { before, inside, after, databaseSize },
    reset: { tablesAfterReset },
  };
}

run().then(
  (report) => self.postMessage(report),
  (error: unknown) => self.postMessage({ ok: false, error: String(error) } satisfies SmokeReport),
);
