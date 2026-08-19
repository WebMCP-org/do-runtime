/**
 * How long does one synchronous `sql.exec` block the loop, over the real
 * message store?
 *
 * **This is a measurement, not a lane and not a conformance row.** Facets are
 * in-process, so one event loop serves an entire actor tree and a
 * long synchronous statement in any facet blocks every facet under that root.
 * Workerd shares that property, so a conformance row asserting it would pass
 * everywhere and settle nothing; the open question is a latency budget on THIS
 * host. Nothing here is included by any lane's `test.include` — see
 * `vitest.browser.config.ts` beside this file for how to run it — and nothing
 * here asserts a timing threshold, because a perf number wired into the CI
 * fan-in is a flake with no reproduction.
 *
 * **What is replayed.** The statements below are the real ones, copied from the
 * vendored session provider that the extension's Think agent runs
 * (`vendor/agents/packages/agents/src/experimental/memory/session/providers/agent.ts`)
 * rather than invented for the benchmark: the five statements one
 * `appendMessage` issues, the four a history load issues, the three an
 * `updateMessage` issues, and the FTS match a search issues. `session_id` is the
 * empty string because `forSession()` is never called in this app — per-actor
 * isolation is a separate database file, not a column.
 *
 * **Row size is the parameter, because in this app one conversational turn
 * persists as one row.** A codemode turn is a single assistant message carrying
 * its whole tool output, and the store's own cap is `ROW_MAX_BYTES = 1_800_000`
 * (`vendor/agents/packages/agents/src/chat/sanitize.ts`). The FTS text is
 * carried separately from the row size, because `indexFTS` tokenizes only the
 * message's TEXT parts — a 1.8 MB codemode row whose bulk is a tool-output part
 * costs the tokenizer nothing, and a 1.8 MB row that is all prose costs it
 * everything. Both are scenarios below.
 *
 * **What the span numbers mean.** A percentile over single statements is not
 * what a heartbeat sees. What blocks the loop is the contiguous synchronous run
 * of statements plus the JS between them, so each phase also reports a `span`:
 * the wall time from the first statement of an append (or a history load) to the
 * last. That is the quantity to hold against a liveness budget.
 */

import type { SqlDatabase } from "../../src/util/sqlite";

// ── The store, verbatim ────────────────────────────────────────────────────

/** `AgentSessionProvider.ensureTable()`, minus the two tables no statement here touches. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent ON assistant_messages(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages(session_id)`,
  `CREATE TABLE IF NOT EXISTS assistant_compactions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    from_message_id TEXT NOT NULL,
    to_message_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS assistant_fts
    USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')`,
] as const;

const SQL = {
  existsProbe: `SELECT id FROM assistant_messages WHERE id = ? AND session_id = ?`,
  insert: `INSERT INTO assistant_messages (id, session_id, parent_id, role, content)
    VALUES (?, ?, ?, ?, ?)`,
  update: `UPDATE assistant_messages SET content = ? WHERE id = ? AND session_id = ?`,
  ftsRowidProbe: `SELECT rowid FROM assistant_fts WHERE id = ? AND session_id = ?`,
  ftsDelete: `DELETE FROM assistant_fts WHERE rowid = ?`,
  ftsInsert: `INSERT INTO assistant_fts (id, session_id, role, content) VALUES (?, ?, ?, ?)`,
  ftsMatch: `SELECT f.id, f.role, f.content FROM assistant_fts f
    INNER JOIN assistant_messages m ON m.id = f.id AND m.session_id = f.session_id
    WHERE assistant_fts MATCH ? AND f.session_id = ?
    ORDER BY rank LIMIT ?`,
  latestLeafCold: `SELECT m.id FROM assistant_messages m
    LEFT JOIN assistant_messages c ON c.parent_id = m.id AND c.session_id = ?
    WHERE c.id IS NULL AND m.session_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
  pathRowStats: `WITH RECURSIVE path(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM assistant_messages WHERE id = ?
      UNION ALL
      SELECT m.id, m.parent_id, p.depth + 1 FROM assistant_messages m
      JOIN path p ON m.id = p.parent_id
      WHERE m.session_id = ? AND p.depth < 10000
    )
    SELECT path.id AS id, am.role AS role, LENGTH(CAST(am.content AS BLOB)) AS bytes
    FROM path JOIN assistant_messages am ON am.id = path.id
    ORDER BY path.depth DESC`,
  contentChunk: `SELECT id, content FROM assistant_messages
    WHERE session_id = ?
      AND id IN (SELECT value FROM json_each(?))`,
  compactions: `SELECT * FROM assistant_compactions WHERE session_id = ? ORDER BY created_at ASC`,
} as const;

/** `HISTORY_CONTENT_CHUNK_SIZE` / `HISTORY_CONTENT_CHUNK_BYTES` from the same provider. */
const CHUNK_ROWS = 50;
const CHUNK_BYTES = 4 * 1024 * 1024;

/** `forSession()` is never called in this app, so every row carries the empty session. */
const SESSION_ID = "";

// ── Scenarios ──────────────────────────────────────────────────────────────

export type Scenario = {
  readonly name: string;
  /** Messages on the active branch. Compaction inserts an overlay row; it never deletes one. */
  readonly messages: number;
  /** Serialized bytes of `content` for an ordinary turn. */
  readonly rowBytes: number;
  /** Serialized bytes of `content` for a big turn, and how often one occurs (1-in-N; 0 = never). */
  readonly bigRowBytes: number;
  readonly bigEvery: number;
  /** Bytes of TEXT parts inside a big row — what `indexFTS` actually tokenizes. */
  readonly bigTextBytes: number;
  /** History loads to sample. Each one is a full `getHistory()` worth of statements. */
  readonly historyLoads: number;
  /** `updateMessage` calls to sample. */
  readonly updates: number;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    // A long ordinary conversation: prose turns, nothing enormous.
    name: "typical-200x8KiB",
    messages: 200,
    rowBytes: 8 * 1024,
    bigRowBytes: 0,
    bigEvery: 0,
    bigTextBytes: 0,
    historyLoads: 100,
    updates: 100,
  },
  {
    // "One turn is one message": every tenth turn is a codemode turn carrying its
    // whole tool output. The bulk is a tool part, so the FTS text stays small.
    name: "codemode-mixed-200",
    messages: 200,
    rowBytes: 8 * 1024,
    bigRowBytes: 1_500_000,
    bigEvery: 10,
    bigTextBytes: 20 * 1024,
    historyLoads: 60,
    updates: 60,
  },
  {
    // Every turn at the store's own cap, tool-shaped.
    name: "codemode-cap-40x1.8MB",
    messages: 40,
    rowBytes: 1_800_000,
    bigRowBytes: 1_800_000,
    bigEvery: 1,
    bigTextBytes: 20 * 1024,
    historyLoads: 40,
    updates: 40,
  },
  {
    // Same cap, but all prose — the tokenizer's worst case rather than the
    // storage layer's.
    name: "text-cap-40x1.8MB",
    messages: 40,
    rowBytes: 1_800_000,
    bigRowBytes: 1_800_000,
    bigEvery: 1,
    bigTextBytes: 1_750_000,
    historyLoads: 40,
    updates: 40,
  },
];

// ── Sampling ───────────────────────────────────────────────────────────────

class Samples {
  readonly #values: number[] = [];

  add(ms: number): void {
    this.#values.push(ms);
  }

  report(): Stat {
    const sorted = [...this.#values].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
      total: sorted.reduce((sum, value) => sum + value, 0),
    };
  }
}

export type Stat = {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly total: number;
};

/** Nearest-rank, so every reported number is a value that was actually observed. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export type ScenarioReport = {
  readonly scenario: string;
  readonly messages: number;
  readonly storedBytes: number;
  readonly databaseSize: number;
  readonly buildMs: number;
  readonly statements: Readonly<Record<string, Stat>>;
};

export type BenchReport =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly substrate: string;
      readonly treeDepth: number;
      readonly clockResolutionMs: number;
      readonly scenarios: readonly ScenarioReport[];
    };

// ── Payload ────────────────────────────────────────────────────────────────

/**
 * Word-shaped filler, so `tokenize='porter unicode61'` does the work it does in
 * production. Random base64 would be one enormous token and would make the FTS
 * numbers a fiction.
 */
const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray",
  "running", "connected", "storage", "message", "browser", "session", "worker",
];

function words(bytes: number, seed: number): string {
  let state = seed >>> 0;
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const word = WORDS[state % WORDS.length] ?? "alpha";
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

/**
 * One message row as the provider stores it: `JSON.stringify(message)` of a
 * `UIMessage`, where a codemode turn's bulk sits in a tool part and only the
 * text parts are tokenized.
 */
function makeContent(id: string, totalBytes: number, textBytes: number, seed: number): {
  readonly json: string;
  readonly text: string;
} {
  const text = words(Math.max(0, Math.min(textBytes, totalBytes - 256)), seed);
  const message = {
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      {
        type: "tool-codemode",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { code: "" },
        output: { stdout: "" },
      },
    ],
    createdAt: new Date(0).toISOString(),
  };
  // Grow the tool output until the serialized row hits the target, which is what
  // the size cap is measured against.
  const base = JSON.stringify(message).length;
  const filler = Math.max(0, totalBytes - base);
  message.parts[1]!.output = { stdout: words(filler, seed ^ 0x5f37) };
  return { json: JSON.stringify(message), text };
}

// ── The run ────────────────────────────────────────────────────────────────

/**
 * @param open Opens one database in the tree. Called `treeDepth + 1` times: the
 *   root plus one facet per level, all of them left open for the whole run,
 *   because they share a worker, an event loop, and — on the
 *   browser substrate — one OPFS SAH pool.
 */
export async function runMessageStoreBench(options: {
  readonly substrate: string;
  readonly treeDepth: number;
  readonly open: (name: string) => Promise<SqlDatabase>;
  readonly now: () => number;
  readonly scenarios?: readonly Scenario[];
}): Promise<BenchReport> {
  const { substrate, treeDepth, open, now } = options;
  const scenarios = options.scenarios ?? SCENARIOS;

  // The tree, loaded. Production depth is 4 (`MAX_FACET_TREE_DEPTH`), and the
  // conversation store lives in the deepest facet.
  const tree: SqlDatabase[] = [await open("root")];
  for (let level = 1; level <= treeDepth; level += 1) {
    const database = await open(`facet${level}`);
    tree.push(database);
  }
  const store = tree.at(-1)!;

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(runScenario(store, scenario, now));
  }

  return {
    ok: true,
    substrate,
    treeDepth,
    clockResolutionMs: clockResolution(now),
    scenarios: reports,
  };
}

function runScenario(store: SqlDatabase, scenario: Scenario, now: () => number): ScenarioReport {
  for (const statement of SCHEMA) store.exec(statement, []);
  store.exec(`DELETE FROM assistant_messages`, []);
  store.exec(`DELETE FROM assistant_compactions`, []);
  store.exec(`DELETE FROM assistant_fts`, []);

  const samples: Record<string, Samples> = {
    "append/exists-probe": new Samples(),
    "append/parent-probe": new Samples(),
    "append/insert": new Samples(),
    "append/fts-rowid-probe": new Samples(),
    "append/fts-insert": new Samples(),
    "append/span": new Samples(),
    "history/latest-leaf-cold": new Samples(),
    "history/path-row-stats": new Samples(),
    "history/content-chunk": new Samples(),
    "history/compactions": new Samples(),
    "history/span": new Samples(),
    "update/update-content": new Samples(),
    "update/fts-rowid-probe": new Samples(),
    "update/fts-insert": new Samples(),
    "update/span": new Samples(),
    "search/fts-match": new Samples(),
  };
  const record = (key: string, start: number): void => {
    samples[key]!.add(now() - start);
  };

  // ── Build: every append is an `appendMessage` sample ──────────────────────
  const ids: string[] = [];
  let storedBytes = 0;
  const buildStart = now();
  for (let index = 0; index < scenario.messages; index += 1) {
    const id = `msg-${index.toString().padStart(6, "0")}`;
    const big = scenario.bigEvery > 0 && index % scenario.bigEvery === 0;
    const { json, text } = makeContent(
      id,
      big ? scenario.bigRowBytes : scenario.rowBytes,
      big ? scenario.bigTextBytes : scenario.rowBytes,
      index + 1,
    );
    const parent = ids.at(-1) ?? null;
    storedBytes += json.length;

    const spanStart = now();

    let start = now();
    store.exec(SQL.existsProbe, [id, SESSION_ID]);
    record("append/exists-probe", start);

    if (parent !== null) {
      start = now();
      store.exec(SQL.existsProbe, [parent, SESSION_ID]);
      record("append/parent-probe", start);
    }

    start = now();
    store.exec(SQL.insert, [id, SESSION_ID, parent, "assistant", json]);
    record("append/insert", start);

    start = now();
    const stale = store.exec(SQL.ftsRowidProbe, [id, SESSION_ID]);
    record("append/fts-rowid-probe", start);
    for (const row of stale.rawRows) store.exec(SQL.ftsDelete, [row[0] as number]);

    start = now();
    store.exec(SQL.ftsInsert, [id, SESSION_ID, "assistant", text]);
    record("append/fts-insert", start);

    record("append/span", spanStart);
    ids.push(id);
  }
  const buildMs = now() - buildStart;

  // ── History load: `getHistory()` on the active branch ─────────────────────
  for (let iteration = 0; iteration < scenario.historyLoads; iteration += 1) {
    const spanStart = now();

    let start = now();
    const leaf = store.exec(SQL.latestLeafCold, [SESSION_ID, SESSION_ID]);
    record("history/latest-leaf-cold", start);
    const leafId = leaf.rawRows[0]?.[0] as string | undefined;
    if (leafId === undefined) throw new Error("history load found no leaf");

    start = now();
    const stats = store.exec(SQL.pathRowStats, [leafId, SESSION_ID]);
    record("history/path-row-stats", start);

    // `messagesByPathStats`: bounded by both row count and cumulative bytes.
    let chunk: string[] = [];
    let chunkBytes = 0;
    const fetch = (): void => {
      const chunkStart = now();
      store.exec(SQL.contentChunk, [SESSION_ID, JSON.stringify(chunk)]);
      record("history/content-chunk", chunkStart);
    };
    for (const row of stats.rawRows) {
      const bytes = Number(row[2]);
      if (chunk.length > 0 && (chunk.length >= CHUNK_ROWS || chunkBytes + bytes > CHUNK_BYTES)) {
        fetch();
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(row[0] as string);
      chunkBytes += bytes;
    }
    if (chunk.length > 0) fetch();

    start = now();
    store.exec(SQL.compactions, [SESSION_ID]);
    record("history/compactions", start);

    record("history/span", spanStart);
  }

  // ── `updateMessage`: the finalize write plus its FTS reindex ──────────────
  for (let iteration = 0; iteration < scenario.updates; iteration += 1) {
    const id = ids[iteration % ids.length]!;
    const big = scenario.bigEvery > 0 && iteration % scenario.bigEvery === 0;
    const { json, text } = makeContent(
      id,
      big ? scenario.bigRowBytes : scenario.rowBytes,
      big ? scenario.bigTextBytes : scenario.rowBytes,
      iteration + 7919,
    );

    const spanStart = now();

    let start = now();
    store.exec(SQL.update, [json, id, SESSION_ID]);
    record("update/update-content", start);

    start = now();
    const stale = store.exec(SQL.ftsRowidProbe, [id, SESSION_ID]);
    record("update/fts-rowid-probe", start);
    for (const row of stale.rawRows) store.exec(SQL.ftsDelete, [row[0] as number]);

    start = now();
    store.exec(SQL.ftsInsert, [id, SESSION_ID, "assistant", text]);
    record("update/fts-insert", start);

    record("update/span", spanStart);
  }

  // ── `searchMessages` ──────────────────────────────────────────────────────
  for (let iteration = 0; iteration < scenario.historyLoads; iteration += 1) {
    const start = now();
    store.exec(SQL.ftsMatch, [`"${WORDS[iteration % WORDS.length]}"`, SESSION_ID, 20]);
    record("search/fts-match", start);
  }

  const statements: Record<string, Stat> = {};
  for (const [key, value] of Object.entries(samples)) {
    const stat = value.report();
    if (stat.n > 0) statements[key] = stat;
  }

  return {
    scenario: scenario.name,
    messages: scenario.messages,
    storedBytes,
    databaseSize: store.databaseSize,
    buildMs,
    statements,
  };
}

/**
 * The smallest non-zero gap this clock reports, so a reader can tell a real
 * sub-millisecond number from the timer's floor. Cross-origin-isolated pages get
 * 5 µs from `performance.now()`; a non-isolated one is coarsened to 100 µs.
 */
function clockResolution(now: () => number): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const start = now();
    let end = now();
    while (end === start) end = now();
    smallest = Math.min(smallest, end - start);
  }
  return smallest;
}
