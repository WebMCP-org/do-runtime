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
      snapshot: {
        openRefusal: string;
        restored: readonly (readonly unknown[])[];
        replica: readonly (readonly unknown[])[];
      };
      exhaustion: {
        capacity: number;
        fullError: string;
        filesAfterFailure: readonly string[];
        recovered: boolean;
      };
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

  const snapshotProvider = createSqliteWasmProvider(host, { prefix: "/smoke-snapshot" });
  const snapshotDb = await snapshotProvider.open("root");
  snapshotDb.exec("CREATE TABLE state (value TEXT)", []);
  snapshotDb.exec("INSERT INTO state VALUES ('before')", []);
  let openRefusal = "allowed";
  try {
    await snapshotProvider.exportSnapshot();
  } catch (error) {
    openRefusal = error instanceof Error ? error.message : String(error);
  }
  snapshotProvider.close();
  const snapshot = await snapshotProvider.exportSnapshot();
  const changedDb = await snapshotProvider.open("root");
  changedDb.exec("UPDATE state SET value = 'after'", []);
  snapshotProvider.close();
  await snapshotProvider.importSnapshot(snapshot);
  const restoredDb = await snapshotProvider.open("root");
  const restored = restoredDb.exec("SELECT value FROM state", []).rawRows;
  snapshotProvider.close();

  const replicaProvider = createSqliteWasmProvider(host, { prefix: "/smoke-replica" });
  await replicaProvider.importSnapshot(snapshot);
  const replicaDb = await replicaProvider.open("root");
  const replica = replicaDb.exec("SELECT value FROM state", []).rawRows;
  replicaProvider.close();

  const capacity = pool.getCapacity();
  const fillerImage = await pool.exportFile("/smoke-snapshot.root.sqlite");
  let filler = "";
  for (let index = 0; pool.getFileNames().length < capacity; index += 1) {
    filler = `/capacity-${index}.sqlite`;
    await pool.importDb(filler, fillerImage);
  }
  if (filler === "") throw new Error("the smoke pool had no free slot to exhaust");

  const overflowProvider = createSqliteWasmProvider(host, { prefix: "/overflow" });
  let fullError = "allowed";
  try {
    (await overflowProvider.open("root")).close();
  } catch (error) {
    fullError = error instanceof Error ? error.message : String(error);
  }
  const filesAfterFailure = pool.getFileNames();
  if (!pool.unlink(filler)) throw new Error(`the smoke pool did not release ${filler}`);
  const recoveredDb = await overflowProvider.open("root");
  const recovered = recoveredDb.exec("SELECT 1", []).rawRows[0]?.[0] === 1;
  recoveredDb.close();

  return {
    ok: true,
    roundTrip: {
      rowsWritten: written.rowsWritten,
      columnNames: read.columnNames,
      rawRows: read.rawRows,
    },
    members: { before, inside, after, databaseSize },
    reset: { tablesAfterReset },
    snapshot: { openRefusal, restored, replica },
    exhaustion: { capacity, fullError, filesAfterFailure, recovered },
  };
}

run().then(
  (report) => self.postMessage(report),
  (error: unknown) => self.postMessage({ ok: false, error: String(error) } satisfies SmokeReport),
);
