/**
 * §1.4 — the SQL name authorizer.
 *
 * `SqlStorageRegulator::isAllowedName` is a four-character prefix test, and
 * upstream reaches it through the SQLite authorizer while a statement is being
 * compiled — so what it sees is a RESOLVED IDENTIFIER. `@mcp-b/do-runtime` has
 * no authorizer to hook and tokenizes the statement text instead, which is a
 * translation, and a translation is exactly the kind of thing this suite is for.
 */

import { expect, it } from "vitest";
import { host } from "conformance:host";

it("§1.4 `_cf_` is refused as an identifier and allowed as data", async () => {
  const probe = await host.spawn("reserved-names");
  expect(await probe.call("reservedNames")).toEqual({
    createTable: "refused",
    selectFrom: "refused",
    quotedIdentifier: "refused",
    stringLiteral: "allowed",
    containsToken: "allowed",
  });
});

it("§1.4 a SQL batch executes in order and returns the bound final statement", async () => {
  const probe = await host.spawn("sql-batch");
  expect(await probe.call("sqlBatch")).toEqual({
    columns: ["label"],
    row: { label: "one" },
  });
});

it("§1.4 DML with RETURNING reports the rows it wrote", async () => {
  const probe = await host.spawn("sql-returning-rows-written");
  expect(await probe.call("sqlReturningRowsWritten")).toEqual({
    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    rowsWritten: 3,
    selectRowsWritten: 0,
  });
});

it("§1.4 SQLite owns trigger-body boundaries in a SQL batch", async () => {
  const probe = await host.spawn("sql-trigger-batch");
  expect(await probe.call("sqlTriggerBatch")).toEqual({
    columns: ["value"],
    rows: [{ value: 2 }, { value: 99 }],
  });
});

it("§1.4 only the final SQL statement accepts exactly its compiled bindings", async () => {
  const probe = await host.spawn("sql-binding-errors");
  expect(await probe.call("sqlBindingErrors")).toEqual({
    prelude:
      "When executing multiple SQL statements in a single call, only the last statement can " +
      "have parameters.",
    missing: "Wrong number of parameter bindings for SQL query.",
    absent: "Wrong number of parameter bindings for SQL query.",
    extra: "Wrong number of parameter bindings for SQL query.",
  });
});

it("§1.4 public SQL values follow workerd's JSG conversion", async () => {
  const probe = await host.spawn("sql-value-semantics");
  expect(await probe.call("sqlValueSemantics")).toEqual({
    trueType: "text",
    trueValue: "true",
    falseType: "text",
    falseValue: "false",
    undefinedType: "null",
    undefinedValue: null,
    bytesHex: "010203",
    viewHex: "010203",
    bufferHex: "040506",
    bigint: "TypeError: Cannot convert a BigInt value to a number",
    maximumType: "number",
    maximum: "9223372036854776000",
    minimum: "-9223372036854776000",
  });
});

it("§1.4 SQLite strings and blobs are limited to 4 MiB", async () => {
  const probe = await host.spawn("sql-length-limit");
  expect(await probe.call("sqliteLengthLimit")).toEqual({
    allowed: 4_000_000,
    tooBig: "Error: string or blob too big: SQLITE_TOOBIG",
  });
});

it("§1.4 SQLite R*Tree virtual tables are available", async () => {
  const probe = await host.spawn("sql-rtree");
  expect(await probe.call("sqliteRtree")).toEqual({ ids: [{ id: 1 }], check: "ok" });
});
