import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import {
  createSqliteWasmProvider,
  type SqliteWasmHost,
} from "@mcp-b/do-runtime/backends/sqlite-wasm";
import type { SqlDatabase, SqlDatabaseProvider } from "@mcp-b/do-runtime";

/** sqlite-wasm documents and implements the retry flag but omits it from its declaration. */
export type RetryablePoolOptions = Parameters<Sqlite3Static["installOpfsSAHPoolVfs"]>[0] & {
  forceReinitIfPreviouslyFailed?: boolean;
};

/** Track the handles a host opens so a broken or replaced container can release them. */
export class TrackedSqliteWasmProvider implements SqlDatabaseProvider {
  readonly #provider: SqlDatabaseProvider;
  readonly #open: SqlDatabase[] = [];

  constructor(host: SqliteWasmHost, prefix: string) {
    this.#provider = createSqliteWasmProvider(host, { prefix });
  }

  async open(name: string): Promise<SqlDatabase> {
    const database = await this.#provider.open(name);
    this.#open.push(database);
    return database;
  }

  close(): void {
    for (const database of this.#open.splice(0)) database.close();
  }
}
