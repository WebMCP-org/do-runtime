import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmProvider, type SqliteWasmHost } from "../../backends/sqlite-wasm";

export type CrashCommand = {
  readonly mode: "dirty" | "recover";
  readonly poolName: string;
};

export type CrashReport =
  | { readonly kind: "dirty" }
  | { readonly kind: "recovered"; readonly rows: readonly string[] }
  | { readonly kind: "error"; readonly error: string };

self.addEventListener("message", (event: MessageEvent<CrashCommand>) => {
  void run(event.data).catch((error: unknown) => {
    self.postMessage({ kind: "error", error: String(error) } satisfies CrashReport);
  });
});

async function run({ mode, poolName }: CrashCommand): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: poolName,
    clearOnInit: mode === "dirty",
    initialCapacity: 4,
  });
  const database = await createSqliteWasmProvider(
    { pool, capi: sqlite3.capi } satisfies SqliteWasmHost,
    { prefix: "/crash" },
  ).open("root");

  if (mode === "dirty") {
    database.exec("CREATE TABLE recovery (value TEXT NOT NULL)", []);
    database.exec("INSERT INTO recovery VALUES ('committed')", []);
    database.exec("BEGIN IMMEDIATE", []);
    database.exec("INSERT INTO recovery VALUES ('uncommitted')", []);
    self.postMessage({ kind: "dirty" } satisfies CrashReport);
    return;
  }

  const rows = database.exec("SELECT value FROM recovery ORDER BY rowid", []).rawRows.map((row) => {
    const value = row[0];
    if (typeof value !== "string") throw new Error("recovery row was not text");
    return value;
  });
  database.close();
  pool.pauseVfs();
  self.postMessage({ kind: "recovered", rows } satisfies CrashReport);
}
