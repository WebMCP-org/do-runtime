/**
 * ← workerd `src/workerd/util/sqlite-metadata-test.c++`, its one `KJ_TEST`.
 *
 * Times are milliseconds rather than upstream's nanoseconds, which is the
 * divergence `sqlite-metadata.ts` records: a JS number cannot hold nanoseconds
 * since the epoch. Upstream's "one nanosecond later" assertion becomes "one
 * millisecond later" — it is testing that a one-tick difference is a different
 * alarm, and a millisecond is our tick.
 */

import { describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SqliteMetadata } from "./sqlite-metadata";
import { SqliteDatabase } from "./sqlite";

async function openDatabase(): Promise<SqliteDatabase> {
  return new SqliteDatabase(await createNodeSqlProvider().open("foo"));
}

const anAlarmTime1 = 1_734_099_316_987;
const anAlarmTime2 = anAlarmTime1 + 1;

describe("SQLite-METADATA", () => {
  test("refuses an incompatible present table without changing it", async () => {
    const db = await openDatabase();
    db.run("CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value TEXT)");
    const before = db.run("SELECT sql FROM sqlite_master WHERE name = '_cf_METADATA'").rawRows;

    expect(() => new SqliteMetadata(db)).toThrow("Incompatible @mcp-b/do-runtime storage schema");
    expect(db.run("SELECT sql FROM sqlite_master WHERE name = '_cf_METADATA'").rawRows).toEqual(
      before,
    );
  });

  test("SQLite-METADATA", async () => {
    const db = await openDatabase();
    const metadata = new SqliteMetadata(db);

    // Initial state has empty alarm.
    expect(metadata.getAlarm()).toBeNull();

    // Can set alarm to an explicit time.
    metadata.setAlarm(anAlarmTime1, false);

    // Can get the set alarm time.
    expect(metadata.getAlarm()).toBe(anAlarmTime1);

    // Can overwrite the alarm time.
    metadata.setAlarm(anAlarmTime2, false);
    expect(metadata.getAlarm()).not.toBe(anAlarmTime1);
    expect(metadata.getAlarm()).toBe(anAlarmTime2);

    // Can clear alarm.
    metadata.setAlarm(null, false);
    expect(metadata.getAlarm()).toBeNull();

    // Zero alarm is distinct from unset (probably not important, but just checking).
    metadata.setAlarm(0, false);
    expect(metadata.getAlarm()).toBe(0);

    // Can recreate table after resetting database.
    metadata.setAlarm(anAlarmTime1, false);
    expect(metadata.getAlarm()).toBe(anAlarmTime1);
    db.reset();
    expect(metadata.getAlarm()).toBeNull();
    metadata.setAlarm(anAlarmTime2, false);
    expect(metadata.getAlarm()).toBe(anAlarmTime2);

    // Can invalidate cache after rolling back.
    metadata.setAlarm(anAlarmTime2, false);
    db.run("BEGIN TRANSACTION");
    metadata.setAlarm(anAlarmTime1, false);
    expect(metadata.getAlarm()).toBe(anAlarmTime1);
    db.run("ROLLBACK TRANSACTION");
    expect(metadata.getAlarm()).toBe(anAlarmTime2);
  });

  test("setAlarm reports whether the stored value changed", async () => {
    const metadata = new SqliteMetadata(await openDatabase());

    expect(metadata.setAlarm(anAlarmTime1, false)).toBe(true);
    expect(metadata.setAlarm(anAlarmTime1, false)).toBe(false);
    expect(metadata.setAlarm(anAlarmTime2, false)).toBe(true);
    expect(metadata.setAlarm(null, false)).toBe(true);
    expect(metadata.setAlarm(null, false)).toBe(false);
  });

  test("refuses metadata keys outside the current workerd shape", async () => {
    const db = await openDatabase();
    const metadata = new SqliteMetadata(db);
    metadata.setAlarm(anAlarmTime1, false);
    db.run("INSERT INTO _cf_METADATA (key, value) VALUES (3, 1)");

    expect(() => new SqliteMetadata(db)).toThrow("_cf_METADATA contains unsupported key 3");
  });

  /**
   * Ours. Upstream's `KJ_REQUIRE`s on the bookmark are the same two checks; the
   * upper bound is expressed as the range a JS number carries without rounding
   * rather than as `int64_t`'s.
   */
  test("the local development bookmark round-trips and rejects unrepresentable values", async () => {
    const metadata = new SqliteMetadata(await openDatabase());

    expect(metadata.getLocalDevelopmentBookmark()).toBeNull();
    metadata.setLocalDevelopmentBookmark(42);
    expect(metadata.getLocalDevelopmentBookmark()).toBe(42);

    expect(() => metadata.setLocalDevelopmentBookmark(-1)).toThrow(
      "not a non-negative safe integer",
    );
    expect(() => metadata.setLocalDevelopmentBookmark(2 ** 60)).toThrow(
      "not a non-negative safe integer",
    );
  });
});
