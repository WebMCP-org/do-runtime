/**
 * Six databases in a pool installed with room for three: six facets' worth of
 * files, opened concurrently and all kept open as placed facets stay, then a write
 * transaction open on every one at once, so six rollback journals need a slot
 * beside six files.
 *
 * Each database reports its outcome rather than throwing, so a pool that did
 * not grow fails the spec with the driver's own error per database.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { installSqliteWasmHost, SqliteWasmActorStorage } from "../../backends/sqlite-wasm";
import type { SqlDatabase } from "../../src/index";

export type GrowthBoot = { readonly poolName: string };

export type GrowthReport =
  | {
      readonly kind: "grown";
      readonly capacity: { readonly installed: number; readonly grown: number };
      /** Per database: "committed", or the error its open or write failed with. */
      readonly writes: readonly string[];
      /** Per database, after every connection closed and reopened: its rows, or the error. */
      readonly reread: readonly (readonly (readonly unknown[])[] | string)[];
    }
  | { readonly kind: "error"; readonly error: string };

self.addEventListener("message", (event: MessageEvent<GrowthBoot>) => {
  void run(event.data).then(
    (report) => self.postMessage(report),
    (error: unknown) =>
      self.postMessage({ kind: "error", error: message(error) } satisfies GrowthReport),
  );
});

async function run({ poolName }: GrowthBoot): Promise<GrowthReport> {
  const host = await installSqliteWasmHost(await sqlite3InitModule(), {
    name: poolName,
    clearOnInit: true,
    initialCapacity: 3,
  });
  const installed = host.pool.getCapacity();
  const storages = Array.from(
    { length: 6 },
    (_, index) => new SqliteWasmActorStorage(host, `/facet-${index + 1}`),
  );

  // All at once, so the backend's per-pool queue has to order the real driver's reservations.
  const opened: (SqlDatabase | string)[] = await Promise.all(
    storages.map((storage) => storage.open("root").catch(message)),
  );
  const writing = opened.map((db, index) =>
    typeof db === "string"
      ? db
      : attempt(() => {
          db.exec("BEGIN", []);
          db.exec("CREATE TABLE t (v TEXT)", []);
          db.exec("INSERT INTO t VALUES (?)", [`row-${index + 1}`]);
          return db;
        }),
  );
  const writes = writing.map((db) =>
    typeof db === "string"
      ? db
      : attempt(() => {
          db.exec("COMMIT", []);
          return "committed";
        }),
  );
  const grown = host.pool.getCapacity();

  for (const storage of storages) storage.close();
  const reread: (readonly (readonly unknown[])[] | string)[] = [];
  for (const storage of storages) {
    reread.push(
      await storage
        .open("root")
        .then((db) => db.exec("SELECT v FROM t", []).rawRows)
        .catch(message),
    );
  }
  for (const storage of storages) storage.close();
  return { kind: "grown", capacity: { installed, grown }, writes, reread };
}

function attempt<T>(step: () => T): T | string {
  try {
    return step();
  } catch (error) {
    return message(error);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
