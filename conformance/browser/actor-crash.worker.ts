/**
 * An actor whose worker is terminated in the middle of a synchronous slice, and
 * the fresh worker that inspects its pool afterwards.
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

import { createActorContainer, DEFAULT_ALARM_OUTLET, noFacets } from "../../src/index";
import { createSqliteWasmProvider, SqliteWasmActorStorage } from "../../backends/sqlite-wasm";
import { installPool, timer, UNIQUE_KEY } from "./substrate";

export type CrashBoot = { readonly poolName: string; readonly phase: "crash" | "reopen" };

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
  | { readonly kind: "error"; readonly error: string };

/** One row per 8 KiB page, and more pages than the cache can hold dirty. */
const ROWS = 2_304;
const PAD = "x".repeat(7_000);
/** SQLite's rollback-journal magic, which only a synced (hot) journal header carries. */
const JOURNAL_MAGIC = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

class Ledger {
  constructor(private readonly ctx: DurableObjectState) {}

  acknowledge(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    for (let id = 1; id <= ROWS; id++) sql.exec("INSERT INTO ledger VALUES (?, ?)", id, `call-1${PAD}`);
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

async function run({ poolName, phase }: CrashBoot): Promise<void> {
  if (phase === "crash") {
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
    await ledger.acknowledge();
    self.postMessage({ kind: "acknowledged" } satisfies CrashReport);
    await ledger.crash();
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
  const rows = db.exec(
    "SELECT substr(value, 1, 6), count(*) FROM ledger GROUP BY 1 ORDER BY 1",
    [],
  ).rawRows;
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
