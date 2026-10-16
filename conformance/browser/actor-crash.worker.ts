/**
 * An actor whose worker is terminated in the middle of a synchronous slice, and
 * the fresh worker that inspects, backs up or restores its pool afterwards.
 *
 * The crash slice rewrites every acknowledged row instead of appending rows,
 * which is measured rather than stylistic. SQLite can spill a page it appended
 * without syncing the journal, so an append-only slice leaves a journal whose
 * header was never synced, which SQLite ignores, and nothing to roll back. A
 * rewrite journals every page it touches, and once it dirties more pages than
 * the cache holds (`cache_spill` is 2026 pages of 8 KiB in this build) SQLite
 * syncs the journal header and writes uncommitted pages into the database
 * file. Only then does recovery depend on replaying the journal.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createActorContainer, DEFAULT_ALARM_OUTLET, noFacets } from "../../src/index";
import {
  createSqliteWasmProvider,
  exportSqliteWasmPoolSnapshot,
  importSqliteWasmPoolSnapshot,
  installSqliteWasmHost,
  SqliteWasmActorStorage,
  type SqliteWasmPoolSnapshot,
} from "../../backends/sqlite-wasm";
import { installPool, timer, UNIQUE_KEY } from "./substrate";

export type CrashBoot = { readonly poolName: string } & (
  | { readonly phase: "crash"; readonly acknowledged?: string }
  | { readonly phase: "reopen" }
  | { readonly phase: "backup" }
  | { readonly phase: "restore"; readonly snapshot: SqliteWasmPoolSnapshot }
);

type Files = { readonly files: readonly string[] };

export type CrashReport =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "started" }
  | {
      readonly kind: "reopened";
      readonly beforeReopen: Files & { readonly hotJournal: boolean; readonly exported: string };
      readonly afterReopen: Files & {
        readonly rows: readonly (readonly unknown[])[];
        readonly exported: string;
      };
    }
  | {
      readonly kind: "backedUp";
      readonly before: readonly string[];
      readonly after: readonly string[];
      readonly snapshot: SqliteWasmPoolSnapshot;
    }
  | {
      readonly kind: "restored";
      readonly before: readonly string[];
      readonly after: Files & { readonly rows: readonly (readonly unknown[])[] };
    }
  | { readonly kind: "error"; readonly error: string };

/** One row per 8 KiB page, and more pages than the cache can hold dirty. */
const ROWS = 2_304;
const PAD = "x".repeat(7_000);
/** Each acknowledged value and its row count. */
const LEDGER_ROWS = "SELECT substr(value, 1, 6), count(*) FROM ledger GROUP BY 1 ORDER BY 1";
/** SQLite's rollback-journal magic, which only a synced (hot) journal header carries. */
const JOURNAL_MAGIC = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

class Ledger {
  constructor(private readonly ctx: DurableObjectState) {}

  acknowledge(value: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    for (let id = 1; id <= ROWS; id++) sql.exec("INSERT INTO ledger VALUES (?, ?)", id, `${value}${PAD}`);
  }

  crash(): void {
    const sql = this.ctx.storage.sql;
    for (let id = 1; id <= ROWS; id++) {
      sql.exec("UPDATE ledger SET value = ? WHERE id = ?", `call-2${PAD}`, id);
    }
    self.postMessage({ kind: "started" } satisfies CrashReport);
    // The slice never ends, so its implicit transaction can end only with the worker.
    for (;;);
  }
}

self.addEventListener("message", (event: MessageEvent<CrashBoot>) => {
  void run(event.data).catch((error: unknown) => {
    self.postMessage({ kind: "error", error: String(error) } satisfies CrashReport);
  });
});

async function run(boot: CrashBoot): Promise<void> {
  const { poolName } = boot;
  if (boot.phase === "crash") {
    const container = await createActorContainer({
      id: "ledger",
      uniqueKey: UNIQUE_KEY,
      exports: {},
      env: {},
      ports: {
        sql: new SqliteWasmActorStorage(await installPool(poolName), "/actor"),
        alarms: DEFAULT_ALARM_OUTLET,
        facets: noFacets,
        timer,
      },
    });
    const ledger = container.entry(await container.start((ctx) => new Ledger(ctx)));
    // The entry answers only after the output gate releases, so this is a committed write.
    await ledger.acknowledge(boot.acknowledged ?? "call-1");
    self.postMessage({ kind: "acknowledged" } satisfies CrashReport);
    await ledger.crash();
    return;
  }

  if (boot.phase === "backup" || boot.phase === "restore") {
    // The whole-pool snapshot functions take the sqlite3 module, so this installs the pool itself.
    const sqlite3 = await sqlite3InitModule();
    const host = await installSqliteWasmHost(sqlite3, { name: poolName, initialCapacity: 64 });
    const files = (): string[] => host.pool.getFileNames().sort();
    const before = files();
    if (boot.phase === "backup") {
      const snapshot = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
      self.postMessage({
        kind: "backedUp",
        before,
        after: files(),
        snapshot,
      } satisfies CrashReport);
      return;
    }
    await importSqliteWasmPoolSnapshot(sqlite3, host.pool, boot.snapshot);
    const after = files();
    const provider = createSqliteWasmProvider(host, { prefix: "/actor" });
    const rows = (await provider.open("root")).exec(LEDGER_ROWS, []).rawRows;
    provider.close();
    self.postMessage({
      kind: "restored",
      before,
      after: { files: after, rows },
    } satisfies CrashReport);
    return;
  }

  const host = await installPool(poolName, { clearOnInit: false });
  const files = (): string[] => host.pool.getFileNames().sort();
  const provider = createSqliteWasmProvider(host, { prefix: "/actor" });
  const journal = await host.pool.exportFile("/actor.root.sqlite-journal");
  const beforeReopen = {
    files: files(),
    hotJournal: JOURNAL_MAGIC.every((byte, index) => journal[index] === byte),
    exported: await exported(provider),
  };
  const db = await provider.open("root");
  const rows = db.exec(LEDGER_ROWS, []).rawRows;
  provider.close();
  const afterReopen = { files: files(), rows, exported: await exported(provider) };
  self.postMessage({ kind: "reopened", beforeReopen, afterReopen } satisfies CrashReport);
}

/** The exported database names, or the refusal. */
async function exported(provider: ReturnType<typeof createSqliteWasmProvider>): Promise<string> {
  try {
    return (await provider.exportSnapshot()).databases.map(({ name }) => name).join(",");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
