import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  createSqliteWasmProvider,
  installSqliteWasmHost,
  exportSqliteWasmPoolSnapshot,
  importSqliteWasmPoolSnapshot
} from "../../backends/sqlite-wasm";

async function run() {
  const sqlite3 = await sqlite3InitModule();
  const host = await installSqliteWasmHost(sqlite3, {
    name: `pool-snapshot-${crypto.randomUUID()}`,
    clearOnInit: true,
    initialCapacity: 0
  });
  try {
    for (const prefix of ["/actor", "/facet-1"]) {
      const provider = createSqliteWasmProvider(host, { prefix });
      const database = await provider.open("root");
      database.exec("CREATE TABLE state(value)", []);
      database.exec("INSERT INTO state VALUES ('before')", []);
      provider.close();
    }
    const snapshot = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
    const changed = createSqliteWasmProvider(host, { prefix: "/actor" });
    const database = await changed.open("root");
    database.exec("INSERT INTO state VALUES (zeroblob(1048576))", []);
    changed.close();
    const orphan = createSqliteWasmProvider(host, { prefix: "/facet-2" });
    const orphanDatabase = await orphan.open("root");
    orphanDatabase.exec("CREATE TABLE obsolete(value TEXT)", []);
    orphan.close();
    const beforeFailure = await exportSqliteWasmPoolSnapshot(
      sqlite3,
      host.pool
    );
    const broken = {
      version: 1,
      files: snapshot.files.map((file, index) => ({
        ...file,
        image:
          index === 1 ? new Uint8Array(file.image.byteLength + 1) : file.image
      }))
    } as const;
    let invalidRefused = false;
    try {
      await importSqliteWasmPoolSnapshot(sqlite3, host.pool, broken);
    } catch {
      invalidRefused = true;
    }
    const afterFailure = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
    const equal = (left: typeof snapshot, right: typeof snapshot) =>
      left.files.length === right.files.length &&
      left.files.every((file, index) => {
        const other = right.files[index];
        return (
          other !== undefined &&
          file.name === other.name &&
          file.image.length === other.image.length &&
          file.image.every((byte, i) => byte === other.image[i])
        );
      });
    await importSqliteWasmPoolSnapshot(sqlite3, host.pool, snapshot);
    const restored = await exportSqliteWasmPoolSnapshot(sqlite3, host.pool);
    return {
      names: restored.files.map(({ name }) => name),
      invalidRefused,
      preservedOnFailure: equal(beforeFailure, afterFailure),
      exactRestoration: equal(snapshot, restored)
    };
  } finally {
    await host.pool.removeVfs();
  }
}

run().then(
  (result) => postMessage({ ok: true, result }),
  (error: unknown) => postMessage({ ok: false, error: String(error) })
);
