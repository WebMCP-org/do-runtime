/**
 * No upstream counterpart: `backends/` is the sanctioned storage-backend
 * adaptation, so these tests are ours. What they pin is the contract
 * `src/util/sqlite.ts` states and `sqlite-kv` / `sqlite-metadata` rely on —
 * every clause of it, since a second backend has to satisfy the same one and
 * the browser lane cannot run here.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "./node-sqlite";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "do-runtime-node-sqlite-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("node-sqlite backend", () => {
  test("a statement with result columns reports its columns and rows", async () => {
    const db = await createNodeSqlProvider().open("root");

    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, blob BLOB)", []);
    db.exec("INSERT INTO things VALUES (?, ?, ?)", [1, "one", new Uint8Array([1, 2, 3])]);

    const result = db.exec("SELECT id, name, blob FROM things", []);
    expect(result.columnNames).toEqual(["id", "name", "blob"]);
    expect(result.rawRows).toEqual([[1, "one", new Uint8Array([1, 2, 3])]]);
    // A read with columns writes nothing, including after an earlier write.
    expect(result.rowsWritten).toBe(0);
  });

  test("DML with RETURNING reports its changes", async () => {
    const db = await createNodeSqlProvider().open("root");
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);

    const inserted = db.exec("INSERT INTO things VALUES (1), (2), (3) RETURNING id", []);
    expect(inserted.rawRows).toEqual([[1], [2], [3]]);
    expect(inserted.rowsWritten).toBe(3);
    expect(db.exec("SELECT id FROM things", []).rowsWritten).toBe(0);
  });

  test("rowsWritten is changeCount, so a delete that matched nothing reports zero", async () => {
    const db = await createNodeSqlProvider().open("root");
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);

    expect(db.exec("INSERT INTO things VALUES (1)", []).rowsWritten).toBe(1);
    expect(db.exec("INSERT INTO things VALUES (2), (3)", []).rowsWritten).toBe(2);
    expect(db.exec("DELETE FROM things WHERE id = ?", [99]).rowsWritten).toBe(0);
    expect(db.exec("DELETE FROM things WHERE id = ?", [1]).rowsWritten).toBe(1);
    expect(db.exec("DELETE FROM things", []).rowsWritten).toBe(2);
  });

  test("the backend accepts only SQLite's four binding value kinds", async () => {
    const db = await createNodeSqlProvider().open("root");
    db.exec("CREATE TABLE things (text_value, number_value, null_value, blob_value)", []);
    db.exec("INSERT INTO things VALUES (?, ?, ?, ?)", [
      "text",
      7,
      null,
      new Uint8Array([1, 2, 3]),
    ]);

    expect(db.exec("SELECT * FROM things", []).rawRows).toEqual([
      ["text", 7, null, new Uint8Array([1, 2, 3])],
    ]);
  });

  test("full int64 results survive until the public API coerces them", async () => {
    const db = await createNodeSqlProvider().open("root");

    expect(
      db.exec("SELECT 1, 9223372036854775807, -9223372036854775808", []).rawRows,
    ).toEqual([[1, 9223372036854775807n, -9223372036854775808n]]);
  });

  test("SQLite supplies the first statement boundary, including a trigger body", async () => {
    const db = await createNodeSqlProvider().open("root");
    db.exec("CREATE TABLE things (value INTEGER)", []);
    const sql = `CREATE TRIGGER things_after_insert AFTER INSERT ON things BEGIN
      INSERT INTO things VALUES (new.value + 1);
      INSERT INTO things VALUES (new.value + 2);
    END; SELECT count(*) FROM things;`;

    const statement = db.prepare(sql);
    try {
      expect(statement.sql).toBe(sql.slice(0, sql.indexOf(" SELECT count")));
      expect(statement.parameterCount).toBe(0);
      statement.execute([]);
    } finally {
      statement.close();
    }

    db.exec("INSERT INTO things VALUES (1)", []);
    expect(db.exec("SELECT value FROM things ORDER BY value", []).rawRows).toEqual([[1], [2], [3]]);
  });

  test("compiled binding arity includes numbered and repeated named parameters", async () => {
    const db = await createNodeSqlProvider().open("root");
    const statement = db.prepare(
      "SELECT ?2, ?1, :name, :name, '?' AS literal /* ?3, :ignored */",
    );
    try {
      expect(statement.parameterCount).toBe(3);
      expect(() => statement.execute([11, 22])).toThrow(
        "Wrong number of parameter bindings for SQL query.",
      );
      expect(statement.execute([11, 22, 33]).rawRows).toEqual([[22, 11, 33, 33, "?"]]);
    } finally {
      statement.close();
    }
  });

  test("databaseSize grows with the data", async () => {
    const db = await createNodeSqlProvider().open("root");
    const empty = db.databaseSize;
    expect(empty).toBeGreaterThanOrEqual(0);

    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, payload TEXT)", []);
    for (let index = 0; index < 200; index += 1) {
      db.exec("INSERT INTO things VALUES (?, ?)", [index, "x".repeat(500)]);
    }
    expect(db.databaseSize).toBeGreaterThan(empty);
  });

  test("reset empties an in-memory database and leaves the handle usable", async () => {
    const db = await createNodeSqlProvider().open("root");
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);
    db.exec("INSERT INTO things VALUES (1)", []);

    db.reset();

    expect(() => db.exec("SELECT * FROM things", [])).toThrow(/no such table/);
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);
    expect(db.exec("SELECT count(*) FROM things", []).rawRows[0]?.[0]).toBe(0);
  });

  test("reset on disk deletes the file and its sidecars, and the data does not come back", async () => {
    const directory = temporaryDirectory();
    const provider = createNodeSqlProvider({ directory });

    const db = await provider.open("root");
    db.exec("PRAGMA journal_mode=WAL", []);
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);
    db.exec("INSERT INTO things VALUES (1)", []);
    expect(readdirSync(directory).length).toBeGreaterThan(0);

    db.reset();
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);
    expect(db.exec("SELECT count(*) FROM things", []).rawRows[0]?.[0]).toBe(0);
    db.close();

    // A fresh handle on the same file sees the reset database, not the old one.
    const reopened = await provider.open("root");
    expect(reopened.exec("SELECT count(*) FROM things", []).rawRows[0]?.[0]).toBe(0);
    reopened.close();
  });

  test("separate names are separate databases", async () => {
    const provider = createNodeSqlProvider({ directory: temporaryDirectory() });
    const root = await provider.open("root");
    const facet = await provider.open("facet-1");

    root.exec("CREATE TABLE things (id INTEGER PRIMARY KEY)", []);
    expect(() => facet.exec("SELECT * FROM things", [])).toThrow(/no such table/);

    root.close();
    facet.close();
  });

  test("a closed provider snapshot restores the whole actor and seeds another provider", async () => {
    const source = createNodeSqlProvider({ directory: temporaryDirectory() });
    const root = await source.open("root");
    const facet = await source.open("facet-1");
    root.exec("PRAGMA journal_mode=WAL", []);
    root.exec("CREATE TABLE state (value TEXT)", []);
    root.exec("INSERT INTO state VALUES ('before')", []);
    facet.exec("CREATE TABLE state (value TEXT)", []);
    facet.exec("INSERT INTO state VALUES ('child')", []);

    await expect(source.exportSnapshot()).rejects.toThrow("database handles are open");
    source.close();

    const snapshot = await source.exportSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.databases.map(({ name }) => name)).toEqual(["facet-1", "root"]);

    const changed = await source.open("root");
    changed.exec("UPDATE state SET value = 'after'", []);
    source.close();
    await source.importSnapshot(snapshot);
    const restored = await source.open("root");
    expect(restored.exec("SELECT value FROM state", []).rawRows).toEqual([["before"]]);
    source.close();

    const replica = createNodeSqlProvider({ directory: temporaryDirectory() });
    await replica.importSnapshot(snapshot);
    const replicaRoot = await replica.open("root");
    const replicaFacet = await replica.open("facet-1");
    expect(replicaRoot.exec("SELECT value FROM state", []).rawRows).toEqual([["before"]]);
    expect(replicaFacet.exec("SELECT value FROM state", []).rawRows).toEqual([["child"]]);
    replica.close();
  });

  test("snapshot import validates every image before replacing storage", async () => {
    const provider = createNodeSqlProvider({ directory: temporaryDirectory() });
    const db = await provider.open("root");
    db.exec("CREATE TABLE state (value TEXT)", []);
    db.exec("INSERT INTO state VALUES ('safe')", []);
    db.close();

    await expect(
      provider.importSnapshot({
        version: 1,
        databases: [{ name: "root", image: new Uint8Array([1, 2, 3]) }],
      }),
    ).rejects.toThrow("valid SQLite database image");

    const reopened = await provider.open("root");
    expect(reopened.exec("SELECT value FROM state", []).rawRows).toEqual([["safe"]]);
    reopened.close();
  });

  test("a name that is not a safe file name is refused", async () => {
    const provider = createNodeSqlProvider({ directory: temporaryDirectory() });
    await expect(provider.open("../escape")).rejects.toThrow("not a safe file name");
    await expect(provider.open("facet/1")).rejects.toThrow("not a safe file name");
  });
});
