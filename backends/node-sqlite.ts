/**
 * ← workerd `NO upstream correspondence (storage-backend adaptation)`
 *
 * `SqlDatabaseProvider` over `node:sqlite`. Promoted out of
 * `host/fixtures/storage-node.ts`, which is already this adapter.
 *
 * Upstream's equivalent is `SqliteDatabase`'s binding to the SQLite C API plus
 * its kj-filesystem VFS — 3,768 lines this package deliberately does not port,
 * because `node:sqlite` and sqlite-wasm play that role underneath us. What has
 * to match is the layer above: the SQL that `sqlite-kv` and `sqlite-metadata`
 * write, and the four operations they need from a database.
 *
 * This is the substrate the unit lane runs on. It is also decision 11's Node
 * conformance lane, and `fixtures/storage-node.ts` already proves the seam
 * across 20 of the extension's 24 Node-lane test files.
 */

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  requireSqliteLength,
  SQL_WRONG_BINDINGS_MESSAGE,
  type SqlDatabase,
  type SqlDatabaseProvider,
  type SqlDatabaseStatement,
  type SqlResult,
  type SqlValue,
} from "../src/util/sqlite";

export type NodeSqlProviderOptions = {
  /**
   * Directory the actor's database files live in. Omit for in-memory
   * databases, which is what the unit lane uses and what upstream's own tests
   * get from `kj::newInMemoryDirectory`.
   */
  directory?: string;
};

export function createNodeSqlProvider(options: NodeSqlProviderOptions = {}): SqlDatabaseProvider {
  const directory = options.directory;
  return {
    async open(name: string): Promise<SqlDatabase> {
      assertSafeName(name);
      const path = directory === undefined ? ":memory:" : `${directory}/${name}.sqlite`;
      return new NodeSqlDatabase(path);
    },
  };
}

export class NodeSqlDatabase implements SqlDatabase {
  readonly #path: string;
  #database: DatabaseSync;

  constructor(path: string) {
    this.#path = path;
    this.#database = new DatabaseSync(path);
  }

  prepare(sql: string): SqlDatabaseStatement {
    const statement = this.#database.prepare(sql);
    const source = statement.sourceSQL;
    return new NodeSqlStatement(statement, source, parameterLayout(source), () =>
      this.#totalChanges(),
    );
  }

  exec(sql: string, params: readonly SqlValue[]): SqlResult {
    const statement = this.prepare(sql);
    try {
      return statement.execute(params);
    } finally {
      statement.close();
    }
  }

  get databaseSize(): number {
    const pageCount = this.#pragma("page_count");
    const pageSize = this.#pragma("page_size");
    return pageCount * pageSize;
  }

  /** `node:sqlite`'s own name for `sqlite3_get_autocommit(db) == 0`. */
  get inTransaction(): boolean {
    return this.#database.isTransaction;
  }

  reset(): void {
    this.#database.close();
    if (this.#path !== ":memory:") {
      // The journal and WAL sidecars are part of the database; leaving one
      // behind would have the reopened file replay a transaction from the
      // database that was just deleted.
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        rmSync(`${this.#path}${suffix}`, { force: true });
      }
    }
    this.#database = new DatabaseSync(this.#path);
  }

  close(): void {
    this.#database.close();
  }

  #pragma(name: string): number {
    const row = this.#database.prepare(`PRAGMA ${name}`).get();
    const value = row?.[name];
    if (typeof value !== "number") {
      throw new Error(`PRAGMA ${name} did not return a number.`);
    }
    return value;
  }

  #totalChanges(): number {
    const row = this.#database.prepare("SELECT total_changes() AS value").get();
    const value = row?.value;
    if (typeof value !== "number" && typeof value !== "bigint") {
      throw new Error("total_changes() did not return a number.");
    }
    return Number(value);
  }
}

type ParameterLayout = {
  readonly count: number;
  readonly namesByIndex: ReadonlyMap<number, string>;
};

class NodeSqlStatement implements SqlDatabaseStatement {
  readonly #statement: StatementSync;
  readonly #layout: ParameterLayout;

  constructor(
    statement: StatementSync,
    readonly sql: string,
    layout: ParameterLayout,
    private readonly totalChanges: () => number,
  ) {
    this.#statement = statement;
    this.#layout = layout;
  }

  get parameterCount(): number {
    return this.#layout.count;
  }

  execute(params: readonly SqlValue[]): SqlResult {
    if (params.length !== this.parameterCount) throw new Error(SQL_WRONG_BINDINGS_MESSAGE);
    // ponytail: node:sqlite exposes no sqlite3_limit(); guard JS inputs and outputs here,
    // and replace this with the native limit if Node exposes it.
    params.forEach(requireSqliteLength);

    const { named, anonymous } = bindParameters(params, this.#layout);
    const statement = this.#statement;
    const columns = statement.columns();

    if (columns.length === 0) {
      const { changes } =
        named === undefined ? statement.run(...anonymous) : statement.run(named, ...anonymous);
      return { columnNames: [], rawRows: [], rowsWritten: Number(changes) };
    }

    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const changesBefore = this.totalChanges();
    const rows: unknown[] =
      named === undefined ? statement.all(...anonymous) : statement.all(named, ...anonymous);
    return {
      columnNames: columns.map((column) => column.name),
      rawRows: rows.map(asRow),
      // `node:sqlite` exposes no sqlite3_stmt_readonly() or per-statement write
      // counter. The total-change delta distinguishes SELECT from DML RETURNING
      // without parsing SQL or executing the statement twice.
      rowsWritten: this.totalChanges() - changesBefore,
    };
  }

  close(): void {
    // `StatementSync` exposes no finalize operation. Its native handle follows
    // the lifetime of this short-lived object instead.
  }
}

function bindParameters(
  params: readonly SqlValue[],
  layout: ParameterLayout,
): {
  named: Record<string, SQLInputValue> | undefined;
  anonymous: SQLInputValue[];
} {
  let named: Record<string, SQLInputValue> | undefined;
  const anonymous: SQLInputValue[] = [];
  for (let index = 1; index <= layout.count; index += 1) {
    const value = params[index - 1];
    if (value === undefined) throw new Error(SQL_WRONG_BINDINGS_MESSAGE);
    const name = layout.namesByIndex.get(index);
    if (name === undefined) {
      anonymous.push(value);
    } else {
      named ??= {};
      named[name] = value;
    }
  }
  return { named, anonymous };
}

/**
 * `StatementSync` does not expose `sqlite3_bind_parameter_count()`. This is the
 * one lexical adaptation left in the Node backend: it recognizes only SQLite
 * parameter tokens and lets `DatabaseSync.prepare()` validate every other bit
 * of SQL, including statement boundaries.
 */
function parameterLayout(sql: string): ParameterLayout {
  let nextIndex = 1;
  const indexByName = new Map<string, number>();
  const namesByIndex = new Map<number, string>();

  for (let index = 0; index < sql.length; ) {
    const char = sql.charAt(index);
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(sql, index, char, true);
      continue;
    }
    if (char === "[") {
      index = skipQuoted(sql, index, "]", false);
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (char === "?") {
      let end = index + 1;
      while (isAsciiDigit(sql.charAt(end))) end += 1;
      if (end === index + 1) {
        nextIndex += 1;
      } else {
        const explicit = Number(sql.slice(index + 1, end));
        nextIndex = Math.max(nextIndex, explicit + 1);
      }
      index = end;
      continue;
    }
    if ((char === ":" || char === "@" || char === "$") && isParameterChar(sql.charAt(index + 1))) {
      const end = parameterNameEnd(sql, index);
      const name = sql.slice(index, end);
      let parameterIndex = indexByName.get(name);
      if (parameterIndex === undefined) {
        parameterIndex = nextIndex;
        nextIndex += 1;
        indexByName.set(name, parameterIndex);
        namesByIndex.set(parameterIndex, name);
      }
      index = end;
      continue;
    }
    index += 1;
  }

  return { count: nextIndex - 1, namesByIndex };
}

function parameterNameEnd(sql: string, start: number): number {
  let index = start + 1;
  while (isParameterChar(sql.charAt(index))) index += 1;

  // SQLite's `$name` form also accepts Tcl-style `::suffix` and `(suffix)`.
  if (sql[start] === "$") {
    while (sql.slice(index, index + 2) === "::" && isParameterChar(sql.charAt(index + 2))) {
      index += 2;
      while (isParameterChar(sql.charAt(index))) index += 1;
    }
    if (sql[index] === "(") {
      const close = sql.indexOf(")", index + 1);
      if (close !== -1) index = close + 1;
    }
  }
  return index;
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isParameterChar(char: string): boolean {
  return (
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    isAsciiDigit(char) ||
    char === "_" ||
    char.charCodeAt(0) >= 0x80
  );
}

function skipQuoted(sql: string, open: number, close: string, doubled: boolean): number {
  let index = open + 1;
  while (index < sql.length) {
    if (sql[index] === close) {
      if (doubled && sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * `setReturnArrays(true)` is what makes a row a `rawRow`, and the driver's types
 * describe the object shape either way. Checking rather than asserting keeps a
 * future driver that ignores the flag from handing objects to `getText`.
 */
function asRow(row: unknown): readonly unknown[] {
  if (Array.isArray(row)) {
    row.forEach(requireSqliteLength);
    return row.map(normalizeInteger);
  }
  throw new Error("node:sqlite returned a non-array row despite setReturnArrays(true).");
}

/** Preserve ordinary numeric rows while keeping the full int64 range until the public API. */
function normalizeInteger(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  return Number.isSafeInteger(number) && BigInt(number) === value ? number : value;
}

/**
 * Names come from inside the package (`"root"`, `` `facet-${facetId}` ``), so
 * this is defence in depth rather than input validation — but it is the one
 * place a name becomes a path, and a silent traversal here writes an actor's
 * storage somewhere nobody will look for it.
 */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Database name is not a safe file name: ${name}`);
  }
}
