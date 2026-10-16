import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  createSqliteWasmProvider,
  exportSqliteWasmPoolSnapshot,
  importSqliteWasmPoolSnapshot,
  installSqliteWasmHost,
  type SqliteWasmPoolSnapshot,
} from "../../backends/sqlite-wasm";

async function run() {
  const sqlite3 = await sqlite3InitModule();
  const host = await installSqliteWasmHost(sqlite3, {
    name: `pool-snapshot-${crypto.randomUUID()}`,
    clearOnInit: true,
    initialCapacity: 0,
  });
  const write = async (prefix: string, ...statements: string[]): Promise<void> => {
    const provider = createSqliteWasmProvider(host, { prefix });
    const database = await provider.open("root");
    for (const sql of statements) database.exec(sql, []);
    provider.close();
  };
  try {
    await write("/actor", "CREATE TABLE state(value)", "INSERT INTO state VALUES ('before')");
    await write("/facet-1", "CREATE TABLE state(value)", "INSERT INTO state VALUES ('before')");
    const snapshot = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);

    // A larger image to shrink back and an orphan database to remove.
    await write("/actor", "INSERT INTO state VALUES (zeroblob(1048576))");
    await write("/facet-2", "CREATE TABLE obsolete(value TEXT)");
    const beforeFailure = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
    const broken: SqliteWasmPoolSnapshot = {
      version: 1,
      files: snapshot.files.map((file, index) =>
        index === 1 ? { ...file, image: new Uint8Array(file.image.byteLength + 1) } : file,
      ),
    };
    const refusal = await importSqliteWasmPoolSnapshot(sqlite3, host.pool, broken).then(
      () => "imported",
      (error: unknown) => String(error),
    );
    const afterFailure = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);

    await importSqliteWasmPoolSnapshot(sqlite3, host.pool, snapshot);
    const restored = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
    return {
      names: restored.files.map(({ name }) => name),
      refusal,
      preservedOnFailure: same(beforeFailure, afterFailure),
      exactRestoration: same(snapshot, restored),
    };
  } finally {
    await host.pool.removeVfs();
  }
}

function same(left: SqliteWasmPoolSnapshot, right: SqliteWasmPoolSnapshot): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every(({ name, image }, index) => {
      const other = right.files[index];
      return (
        other?.name === name &&
        other.image.length === image.length &&
        image.every((byte, at) => byte === other.image[at])
      );
    })
  );
}

run().then(
  (result) => postMessage({ ok: true, result }),
  (error: unknown) => postMessage({ ok: false, error: String(error) }),
);
