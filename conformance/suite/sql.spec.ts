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

it("§1.4 PRAGMA follows workerd's allowlist", async () => {
  const probe = await host.spawn("sql-pragmas");
  expect(await probe.call("sqlPragmas")).toEqual({
    userVersionRead: "refused",
    userVersionWrite: "refused",
    userVersionSchema: "refused",
    userVersionFunction: "refused",
    writableSchema: "refused",
    journalMode: "refused",
    maxPageCount: "refused",
    schemaVersion: "refused",
    dataVersion: "allowed",
    dataVersionWithArg: "refused",
    foreignKeysRead: "allowed",
    foreignKeysWrite: "allowed",
    tableList: "allowed",
    tableInfo: "allowed",
    tableInfoQuoted: "allowed",
    tableInfoFunction: "allowed",
    indexList: "allowed",
    foreignKeyCheck: "allowed",
    quickCheck: "allowed",
    optimize: "allowed",
  });
});

it("§1.4 cursor iterators match workerd's observable shape", async () => {
  const probe = await host.spawn("sql-cursor-iterator-shape");
  expect(await probe.call("sqlCursorIteratorShape")).toEqual({
    // No `return()` means an early exit does not close a retained iterator.
    breakThenNext: { done: false, value: [2, "two"] },
    destructureThenNext: { done: false, value: { id: 2, label: "two" } },
    rawTag: "[object RawIterator]",
    rowsTag: "[object RowIterator]",
    cursorTag: "[object Cursor]",
    nextKeys: ["done", "value"],
    doneKeys: ["done", "value"],
    cursorDoneKeys: ["done", "value"],
    ownKeys: [],
    hasReturn: "undefined",
    hasThrow: "undefined",
    selfIterable: true,
    cursorJson: "{}",
  });
});

it("§1.4 cursor iterators carry the ES iterator helpers", async () => {
  const probe = await host.spawn("sql-cursor-iterator-helpers");
  expect(await probe.call("sqlCursorIteratorHelpers")).toEqual({
    rawToArray: [
      [1, "one"],
      [2, "two"],
    ],
    rawMaps: ["one", "two"],
    rowsToArray: [
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ],
  });
});

it("§1.4 a prepared SQL statement is callable and reusable", async () => {
  const probe = await host.spawn("sql-prepare");
  expect(await probe.call("sqlPrepare")).toEqual({
    instance: true,
    first: [{ id: 1 }],
    second: [{ id: 2 }],
  });
});

it("§1.4 SQL ingest consumes complete statements and returns the partial tail", async () => {
  const probe = await host.spawn("sql-ingest");
  expect(await probe.call("sqlIngest")).toEqual({
    remainder: " SELECT",
    statementCount: 4,
    countersAreNumbers: true,
    rows: [{ id: 1 }, { id: 2 }],
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

it("§1.4 the authorizer-only forms are refused, with workerd's own messages", async () => {
  // ATTACH, DETACH, the temp-schema creations and the virtual-table modules reach action codes
  // or the authorizer's `dbName == temp` rule, not regulator callbacks, so porting
  // `SqlStorageRegulator` whole did not carry them. ATTACH is the isolation boundary as well as
  // a fidelity row: a backend that allows it reads another actor's database. VACUUM carries
  // SQLite's message instead, because upstream refuses it by the transaction a Durable Object
  // always has open.
  //
  // The allowed side is pinned too. These are leading-keyword refusals, so the row has to show
  // where the keyword stops mattering — an application column named `attach`, and all four
  // virtual-table modules upstream keeps. The quoted spellings are pinned in both directions
  // because the module is read from past the table name, and both take every quoting SQLite
  // does, whitespace or none.
  const probe = await host.spawn("sql-authorizer");
  expect(await probe.call("sqlAuthorizerRefusals")).toEqual({
    attach: "not authorized: SQLITE_AUTH",
    detach: "not authorized: SQLITE_AUTH",
    tempTable: "not authorized: SQLITE_AUTH",
    tempTemporary: "not authorized: SQLITE_AUTH",
    tempView: "not authorized: SQLITE_AUTH",
    tempTrigger: "not authorized: SQLITE_AUTH",
    tempQualifiedTable: "not authorized: SQLITE_AUTH",
    tempQualifiedView: "not authorized: SQLITE_AUTH",
    noSpaceTempQualified: "not authorized: SQLITE_AUTH",
    misquotedSchemaTemp: "not authorized: SQLITE_AUTH",
    // Classified, not quoted: every lane must refuse a leading-`;` ATTACH, but the message is
    // the backend's own — workerd and `node:sqlite` compile the span and reach the authorizer
    // refusal, sqlite-wasm cuts at the first `;` and rejects the empty statement before that.
    semicolonAttach: "refused",
    batchAttach: "not authorized: SQLITE_AUTH",
    vacuum: "cannot VACUUM from within a transaction: SQLITE_ERROR",
    vacuumInto: "cannot VACUUM from within a transaction: SQLITE_ERROR",
    rtree: "allowed",
    rtreeI32: "allowed",
    fts5: "allowed",
    fts5vocab: "allowed",
    dbstat: "not authorized: SQLITE_AUTH",
    spaceyNameDbstat: "not authorized: SQLITE_AUTH",
    usingInsideName: "not authorized: SQLITE_AUTH",
    quotedModuleDbstat: "not authorized: SQLITE_AUTH",
    quotedNameFts5: "allowed",
    applicationName: "allowed",
    pageSizeRead: "allowed",
    pageSizeAssign: "not authorized: SQLITE_AUTH",
  });
});
