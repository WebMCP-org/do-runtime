/**
 * Package-original (no workerd counterpart — see the module header). What is
 * pinned here is the contract every future migration step inherits: stamp on
 * first open, skip when current, refuse newer, run the pending chain in order,
 * leave the file untouched when a step fails — and what `deleteAll()` does to
 * a stamp, which is where the idempotence rule in the module header comes from.
 */

import { describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import type { DurableObjectState } from "../api/actor-state";
import type { Timer } from "../io/io-context";
import type { ActorContainer } from "../server/actor-container";
import { createActorContainer, noFacets } from "../server/actor-container";
import { AlarmScheduler } from "../server/alarm-scheduler";
import type { SqlDatabase } from "./sqlite";
import { ensureRuntimeStorageVersion, RUNTIME_STORAGE_VERSION } from "./sqlite-migrations";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle));
    }),
};

async function openDatabase(): Promise<SqlDatabase> {
  return await createNodeSqlProvider().open("foo");
}

function storedVersion(db: SqlDatabase): number {
  return Number(db.exec("PRAGMA user_version", []).rawRows[0]?.[0]);
}

/**
 * A backend whose `PRAGMA user_version` answers with no row at all. No real
 * SQLite does — the pragma always returns exactly one — but the result type
 * says a row may be missing, and the one thing that must not happen there is a
 * silent read of 0, which would re-run the whole chain over a file that may
 * already be current.
 */
function withoutPragmaRows(db: SqlDatabase): SqlDatabase {
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql, params) =>
      sql === "PRAGMA user_version"
        ? { columnNames: [], rawRows: [], rowsWritten: 0 }
        : db.exec(sql, params),
    get databaseSize() {
      return db.databaseSize;
    },
    get inTransaction() {
      return db.inTransaction;
    },
    reset: () => db.reset(),
    close: () => db.close(),
  };
}

function tableNames(db: SqlDatabase): string[] {
  return db
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])
    .rawRows.map((row) => String(row[0]));
}

/** A root container whose databases the test can still reach after the open. */
async function capturingContainer(): Promise<{
  container: ActorContainer;
  opened: Map<string, SqlDatabase>;
}> {
  const provider = createNodeSqlProvider();
  const opened = new Map<string, SqlDatabase>();
  const container = await createActorContainer({
    id: "actor",
    uniqueKey: "sqlite-migrations-test",
    exports: {},
    env: {},
    ports: {
      sql: {
        open: async (name: string): Promise<SqlDatabase> => {
          const db = await provider.open(name);
          opened.set(name, db);
          return db;
        },
      },
      alarms: { scheduleRun: () => Promise.resolve() },
      facets: noFacets,
      timer,
    },
  });
  return { container, opened };
}

/** The whole of the app class this file needs: one `deleteAll()`. */
class Wipe {
  constructor(private readonly ctx: DurableObjectState) {}
  wipe(): Promise<void> {
    return this.ctx.storage.deleteAll();
  }
}

describe("ensureRuntimeStorageVersion", () => {
  test("stamps a fresh database without running any step", async () => {
    const db = await openDatabase();
    const ran: number[] = [];
    ensureRuntimeStorageVersion(db, "foo", 3, [() => ran.push(1), () => ran.push(2)]);
    // Version 0 is a fresh file: nothing exists that any step would migrate,
    // but the chain still runs so 0 and 1 stay one case (§ module header).
    expect(ran).toEqual([1, 2]);
    expect(storedVersion(db)).toBe(3);
  });

  test("does nothing when the stored version is current", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);
    let ran = false;
    ensureRuntimeStorageVersion(db, "foo", 2, [
      () => {
        ran = true;
      },
    ]);
    expect(ran).toBe(false);
    expect(storedVersion(db)).toBe(2);
  });

  test("refuses a database stamped by a newer release, naming it and the remedy", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 5, [() => {}, () => {}, () => {}, () => {}]);
    expect(() => ensureRuntimeStorageVersion(db, "foo", 2, [() => {}])).toThrowError(
      /database "foo".*storage version 5.*supports up to 2.*Upgrade the package/su,
    );
    expect(storedVersion(db)).toBe(5);
  });

  test("refuses a target version outside the 32-bit pragma range", async () => {
    const db = await openDatabase();
    const outside = [0, -1, 1.5, Number.NaN, 2 ** 31, Number.MAX_SAFE_INTEGER + 1];
    for (const current of outside) {
      expect(() => ensureRuntimeStorageVersion(db, "foo", current, [() => {}])).toThrowError(
        `Runtime storage version must be a positive 32-bit integer, got ${current}.`,
      );
    }
    // Refused before `BEGIN`, so nothing was written on the way out.
    expect(storedVersion(db)).toBe(0);
  });

  test("a version read that answers with no row fails rather than assuming 0", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);
    expect(() =>
      ensureRuntimeStorageVersion(withoutPragmaRows(db), "foo", 2, [() => {}]),
    ).toThrowError('PRAGMA user_version returned no row for database "foo".');
    expect(storedVersion(db)).toBe(2);
  });

  test("runs exactly the pending steps, in order", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);

    const ran: string[] = [];
    ensureRuntimeStorageVersion(db, "foo", 4, [
      () => ran.push("1->2"),
      (d) => {
        ran.push("2->3");
        d.exec("CREATE TABLE two_to_three (x)", []);
      },
      (d) => {
        ran.push("3->4");
        d.exec("CREATE TABLE three_to_four (x)", []);
      },
    ]);
    expect(ran).toEqual(["2->3", "3->4"]);
    expect(storedVersion(db)).toBe(4);
    expect(tableNames(db)).toEqual(["three_to_four", "two_to_three"]);
  });

  test("a failing step rolls back every pending step and the stamp", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);
    db.exec("CREATE TABLE existing (x)", []);

    expect(() =>
      ensureRuntimeStorageVersion(db, "foo", 4, [
        () => {},
        (d) => d.exec("CREATE TABLE two_to_three (x)", []),
        () => {
          throw new Error("step failed");
        },
      ]),
    ).toThrowError("step failed");

    expect(storedVersion(db)).toBe(2);
    expect(tableNames(db)).toEqual(["existing"]);

    // The connection is usable and the chain is retryable after the failure.
    ensureRuntimeStorageVersion(db, "foo", 4, [
      () => {},
      (d) => d.exec("CREATE TABLE two_to_three (x)", []),
      () => {},
    ]);
    expect(storedVersion(db)).toBe(4);
  });

  test("a step that closes the migration transaction is refused by name", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);

    expect(() =>
      ensureRuntimeStorageVersion(db, "foo", 4, [
        () => {},
        (d) => {
          d.exec("CREATE TABLE partial (x)", []);
          d.exec("COMMIT", []);
        },
        () => {
          throw new Error("must never run");
        },
      ]),
    ).toThrowError(
      "Runtime storage migration from version 2 to 3 closed the migration transaction; " +
        "a step must not issue BEGIN, COMMIT, ROLLBACK, or SAVEPOINT.",
    );

    // The stray COMMIT already persisted that step's own work — nothing can
    // undo that — but the file stays unstamped, so the next run retries the
    // chain and idempotent steps converge instead of silently skipping.
    expect(storedVersion(db)).toBe(2);
    expect(tableNames(db)).toEqual(["partial"]);
    ensureRuntimeStorageVersion(db, "foo", 4, [
      () => {},
      (d) => d.exec("CREATE TABLE IF NOT EXISTS partial (x)", []),
      () => {},
    ]);
    expect(storedVersion(db)).toBe(4);
  });

  test("a step that opens its own transaction fails closed", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);
    // SQLite refuses the nested `BEGIN` itself; the chain rolls back whole.
    expect(() =>
      ensureRuntimeStorageVersion(db, "foo", 3, [
        () => {},
        (d) => d.exec("BEGIN", []),
      ]),
    ).toThrowError(/transaction within a transaction/);
    expect(storedVersion(db)).toBe(2);
  });

  test("a chain must not start inside a transaction someone else opened", async () => {
    const db = await openDatabase();
    db.exec("BEGIN", []);
    expect(() => ensureRuntimeStorageVersion(db, "foo", 2, [() => {}])).toThrowError(
      'Runtime storage migration for database "foo" began inside an open transaction.',
    );
    db.exec("ROLLBACK", []);
    expect(storedVersion(db)).toBe(0);
  });

  test("a missing step is a named refusal, not a silent skip", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo", 2, [() => {}]);
    expect(() => ensureRuntimeStorageVersion(db, "foo", 3, [])).toThrowError(
      "Missing runtime storage migration from version 2 to 3.",
    );
    expect(storedVersion(db)).toBe(2);
  });

  test("the shipped step list covers the shipped version", async () => {
    const db = await openDatabase();
    ensureRuntimeStorageVersion(db, "foo");
    expect(storedVersion(db)).toBe(RUNTIME_STORAGE_VERSION);
    ensureRuntimeStorageVersion(db, "foo");
    expect(storedVersion(db)).toBe(RUNTIME_STORAGE_VERSION);
  });

  test("a host table sharing a runtime database survives the shipped chain", async () => {
    // `AlarmScheduler` is handed a host-opened database, and hosts do keep
    // their own tables beside `_cf_ALARM` in it (Rook stores its wake
    // projection there). The chain — today and under every future step —
    // touches only runtime-owned tables (§ module header).
    const db = await openDatabase();
    db.exec("CREATE TABLE host_projection (k TEXT PRIMARY KEY, v INTEGER)", []);
    db.exec("INSERT INTO host_projection VALUES ('wake', 7)", []);
    ensureRuntimeStorageVersion(db, "alarms");
    expect(storedVersion(db)).toBe(RUNTIME_STORAGE_VERSION);
    expect(db.exec("SELECT v FROM host_projection WHERE k = 'wake'", []).rawRows).toEqual([[7]]);
  });

  test("every database a container or scheduler opens comes out stamped", async () => {
    const { container, opened } = await capturingContainer();
    expect([...opened.keys()].sort()).toEqual(["facets", "root"]);
    for (const db of opened.values()) {
      expect(storedVersion(db)).toBe(RUNTIME_STORAGE_VERSION);
    }
    container.abort(new Error("test over"));

    const alarmDb = await openDatabase();
    new AlarmScheduler({
      timer,
      db: alarmDb,
      getActor: () => {
        throw new Error("no alarms are delivered in this test");
      },
      random: () => 0,
    });
    expect(storedVersion(alarmDb)).toBe(RUNTIME_STORAGE_VERSION);
  });

  test("deleteAll() drops the actor database's stamp, and the next open restores it", async () => {
    const { container, opened } = await capturingContainer();
    const root = opened.get("root");
    const facets = opened.get("facets");
    if (root === undefined || facets === undefined) throw new Error("both databases open at start");

    const instance = await container.start((ctx) => new Wipe(ctx));
    await container.entry(instance).wipe();

    // `deleteAll()` is `SqliteKv::deleteAll()` calling `db.reset()`, which
    // replaces the file rather than emptying it — so the stamp goes with it,
    // and nothing re-stamps the live handle, because versioning runs at open.
    expect(storedVersion(root)).toBe(0);
    // The facet index is a separate file for the reasons `FACET_DATABASE_NAME`
    // records, and a reset of the actor's file does not reach it.
    expect(storedVersion(facets)).toBe(RUNTIME_STORAGE_VERSION);
    container.abort(new Error("test over"));

    // This is the case the module header's "idempotent against the current
    // shape too" rule exists for: the next open runs the chain from 1 over
    // tables this release has already recreated at the current shape.
    ensureRuntimeStorageVersion(root, "root");
    expect(storedVersion(root)).toBe(RUNTIME_STORAGE_VERSION);
  });
});
