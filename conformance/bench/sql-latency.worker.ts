/**
 * The production substrate: sqlite-wasm on an OPFS SAH pool, in a dedicated
 * worker because `createSyncAccessHandle` exists nowhere else — the same reason
 * `sqlite-wasm-smoke.worker.ts` is a worker and the same reason the extension
 * runs its agent in one.
 *
 * One pool holds the whole in-process tree: the root's database, one per facet
 * level, and a rollback journal
 * beside each. Capacity matches the browser lane's.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmProvider, type SqliteWasmHost } from "../../backends/sqlite-wasm";
import { runMessageStoreBench, type BenchReport } from "./message-store";

/** Production depth (`MAX_FACET_TREE_DEPTH`), since blocking is per tree. */
const TREE_DEPTH = 4;

async function run(): Promise<BenchReport> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: "do-runtime-bench",
    clearOnInit: true,
    initialCapacity: 64,
  });
  const host: SqliteWasmHost = { pool, capi: sqlite3.capi };
  const provider = createSqliteWasmProvider(host, { prefix: "/bench" });

  return await runMessageStoreBench({
    substrate: "sqlite-wasm 3.53.0-build1 on the OPFS SAH pool, headless Chromium, dedicated worker",
    treeDepth: TREE_DEPTH,
    open: (name) => provider.open(name),
    now: () => performance.now(),
  });
}

run().then(
  (report) => {
    self.postMessage(report);
  },
  (error: unknown) => {
    self.postMessage({ ok: false, error: String(error) } satisfies BenchReport);
  },
);
