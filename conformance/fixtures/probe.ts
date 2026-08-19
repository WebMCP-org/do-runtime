/**
 * The probe Durable Object. Written against the platform surface only —
 * ctx.storage, ctx.facets, ctx.blockConcurrencyWhile, alarms, ctx.exports —
 * and importing nothing but `cloudflare:workers`.
 *
 * That import list is the point: it is what lets the workerd lane run with no
 * vendored-source aliases, so CI's filtered vendor install is irrelevant to
 * this suite.
 *
 * Each method performs ONE behaviour from Part 1 of the design record and
 * journals what it observed into its own storage, so post-crash assertions are
 * ordinary reads rather than anything the harness has to capture live.
 */

import { DurableObject } from "cloudflare:workers";

/** The facet implementation, loaded through the Worker Loader binding. */
const CHILD_SOURCE = `
import { DurableObject } from "cloudflare:workers";
export class Child extends DurableObject {
  local = 0;
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
  async slow(ms) { await scheduler.wait(ms); return "child-done"; }
  async callBack(parent) { return await parent.ping(); }
  async grandchildLocalBump() {
    const g = this.ctx.facets.get("g", () => ({ class: this.ctx.exports.Child }));
    return await g.localBump();
  }
  async localBump() { return ++this.local; }
  /**
   * The facet breaks ITSELF — the one way a running facet becomes broken without
   * its parent asking for it, and therefore the only shape in which "does a
   * broken facet break its parent?" can be asked at all. Everything else the
   * suite does to a facet is the parent's own doing.
   *
   * Nothing follows the abort, and that is not tidiness. workerd's abort calls
   * \`js.terminateExecutionNow()\` and this slice ends here; @mcp-b/do-runtime has
   * no isolate to terminate, so its slice runs on to the next await. A \`throw\`
   * on the line below would therefore be the rejection one lane's caller sees
   * and dead code on the other's — measured, and it is what this row failed on
   * first. With nothing there, both answer with the abort's own error.
   */
  async selfBreak() {
    this.ctx.abort("conformance: this facet broke itself");
  }
  /**
   * A facet of a facet — root, child, grandchild — which is depth 2 of the four
   * §1.10 says workerd allows. The class comes from this dynamic Worker's own
   * ctx.exports, the only handle a loaded module has on itself: a facet gets no
   * WorkerLoader binding, and a DurableObjectClass cannot cross an RPC boundary
   * (DurableObjectClass.serialize).
   */
  async nest() {
    const g = this.ctx.facets.get("g", () => ({ class: this.ctx.exports.Child }));
    return [await g.bump(), await g.bump(), await this.bump()];
  }
}
/**
 * A facet that cannot be constructed, for the two §1.10 start-failure rows.
 *
 * A constructor is the one cause of a failed start that every lane can express.
 * The cause this runtime actually met first was storage that could not be
 * opened, which workerd has no way to reach — it is the same placement, so the
 * rows cover it, but only the runtime's own unit tests can name it.
 */
export class Boom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("conformance: this facet refuses to start");
  }
  async bump() { return -1; }
}
export default { fetch() { return new Response("child"); } };
`;

export class Probe extends DurableObject<Record<string, unknown>> {
  marker = "init";
  trace: string[] = [];

  #child(slot = "c", className = "Child"): Record<string, (...args: never[]) => Promise<unknown>> {
    const loader = (this.env as { LOADER: WorkerLoader }).LOADER;
    const loaded = loader.get("probe-child", async () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "child.js",
      modules: { "child.js": CHILD_SOURCE },
    }));
    return this.ctx.facets.get(slot, () => ({
      class: loaded.getDurableObjectClass(className),
    })) as never;
  }

  // -- §1.2 / §1.3 gate release points -------------------------------------
  async setMarker(): Promise<string> {
    this.trace.push("setMarker");
    this.marker = "B";
    return "set";
  }
  async readTrace(): Promise<string[]> {
    return this.trace;
  }
  /** Harness sentinel: `post().settled` must preserve this rejection. */
  failPostedEvent(): never {
    throw new Error("conformance: posted event failed");
  }
  /** Outbound facet RPC. Measured on workerd: RELEASES, so this returns "B". */
  async gateViaFacet(): Promise<string> {
    this.marker = "A";
    this.trace.push("facet:enter");
    await this.#child().slow(60 as never);
    this.trace.push("facet:exit");
    return this.marker;
  }
  /** Bare timer. Measured: RELEASES, so this returns "B". */
  async gateViaTimer(): Promise<string> {
    this.marker = "A";
    this.trace.push("timer:enter");
    await scheduler.wait(60);
    this.trace.push("timer:exit");
    return this.marker;
  }
  /** Outbound fetch. Measured: RELEASES, then both response awaits resume gated. */
  async gateViaFetch(): Promise<Record<string, unknown>> {
    this.marker = "A";
    this.trace.push("fetch:enter");
    const response = await fetch("https://conformance.invalid/fetch");
    await this.ctx.storage.put("fetchStatus", response.status);
    const body = await response.text();
    await this.ctx.storage.put("fetchBody", body);
    this.trace.push("fetch:exit");
    return { marker: this.marker, status: response.status, body };
  }
  /** Local storage. Measured: HOLDS, so this returns "A". */
  async gateViaStorage(): Promise<string> {
    this.marker = "A";
    await this.ctx.storage.put("probe", 1);
    await this.ctx.storage.get("probe");
    return this.marker;
  }

  // -- §1.2 host-provided async primitives resume gated ----------------------
  //
  // Every one of these is an io-context primitive upstream, so "the code after
  // it can touch storage" needs saying nowhere in workerd: there is no other
  // kind of await. These methods say it, because a runtime with no isolate hook
  // has to make each primitive gate itself, one at a time.
  //
  // None of them awaits a promise it built by hand — a `new Promise(resolve =>
  // setTimeout(resolve, …))` would be testing the harness's own ungated await
  // rather than the primitive's. Each arms something and returns; the assertion
  // reads what the callback wrote.

  /** The continuation after `scheduler.wait` holds a fresh input lock. */
  async storageAfterSchedulerWait(): Promise<string> {
    await scheduler.wait(10);
    await this.ctx.storage.put("afterWait", "ok");
    return ((await this.ctx.storage.get("afterWait")) as string) ?? "MISSING";
  }

  /**
   * The continuation after `crypto.subtle.digest` holds a fresh input lock.
   *
   * The row exists because this is the primitive that found the gap. On workerd
   * every host async API is an `IoContext` promise, so `crypto.subtle` gates
   * itself and nothing has to say so; here `globalThis.crypto` is the platform's
   * unless the actor's scope replaces it, and the vendored `agents` package
   * hashes inside a method that then writes — so an ungated `digest` made every
   * routine mutation in the product throw at its own `setState`.
   *
   * `digest` and not one of the key operations, because it is the one this
   * codebase actually awaits and it needs no key material to be meaningful.
   */
  async storageAfterDigest(): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("probe"));
    await this.ctx.storage.put("afterDigest", digest.byteLength);
    return `${((await this.ctx.storage.get("afterDigest")) as number) ?? "MISSING"}`;
  }

  /**
   * A `setTimeout` callback runs gated. Upstream captures the critical section
   * at the call and re-enters through `context.run(cb, cs)`
   * (`io-context.c++:758-760`) rather than through `awaitIo`, deliberately: the
   * timer has to stay cancellable, and `awaitIo` implicitly `addTask()`s.
   *
   * The write is not awaited, so nothing here depends on the callback's own
   * continuation — only on the callback body running under a lock.
   */
  armTimer(): string {
    setTimeout(() => {
      void this.ctx.storage.put("timerMark", "written-from-timer");
    }, 10);
    return "armed";
  }
  async readTimerMark(): Promise<string> {
    return ((await this.ctx.storage.get("timerMark")) as string) ?? "MISSING";
  }

  /**
   * The captured critical section, observed. A timer armed inside
   * `blockConcurrencyWhile` whose delay elapses before the section ends runs
   * INSIDE that section, because `cs` travelled with it. Without the capture it
   * would queue on the root gate behind the section and land after it.
   *
   * The storage write comes BEFORE the journal entry so the row discriminates
   * both ways: an ungated callback throws at the write and never journals, and a
   * callback that lost the section journals after `section-end`.
   */
  async timerInsideCriticalSection(): Promise<string[]> {
    const log: string[] = [];
    await this.ctx.blockConcurrencyWhile(async () => {
      setTimeout(() => {
        void this.ctx.storage.put("csTimer", "inside");
        log.push("timer");
      }, 10);
      await scheduler.wait(150);
      log.push("section-end");
    });
    return log;
  }

  /** `setInterval` repeats, each tick is gated, and `clearInterval` stops it. */
  #intervalTicks = 0;
  armInterval(): string {
    this.#intervalTicks = 0;
    const id = setInterval(() => {
      this.#intervalTicks += 1;
      void this.ctx.storage.put("ticks", this.#intervalTicks);
      if (this.#intervalTicks >= 3) clearInterval(id);
    }, 20);
    return "armed";
  }
  async readTicks(): Promise<number> {
    return ((await this.ctx.storage.get("ticks")) as number) ?? 0;
  }

  // -- §1.7.1 the transaction boundary is the gate boundary -----------------
  //
  // Writes here are deliberately un-awaited: the question is what survives when
  // the actor dies before the implicit transaction commits.
  /** Neither survives: one transaction spans the storage await. */
  async txAcrossStorageAwait(): Promise<never> {
    void this.ctx.storage.put("p1", 1);
    await this.ctx.storage.get("p1");
    void this.ctx.storage.put("p2", 2);
    this.ctx.abort("conformance: kill before commit");
    throw new Error("unreachable after conformance: kill before commit");
  }
  /** t1 only: the timer await committed it, t2 was lost. */
  async txAcrossTimerAwait(): Promise<never> {
    void this.ctx.storage.put("t1", 1);
    await scheduler.wait(1);
    void this.ctx.storage.put("t2", 2);
    this.ctx.abort("conformance: kill before commit");
    throw new Error("unreachable after conformance: kill before commit");
  }
  /** The upstream shape: INSERT, await, setAlarm. Neither survives. */
  async txInsertThenAlarm(): Promise<never> {
    void this.ctx.storage.put("row", "inserted");
    await this.ctx.storage.get("row");
    void this.ctx.storage.setAlarm(Date.now() + 600_000);
    this.ctx.abort("conformance: kill between row and alarm");
    throw new Error("unreachable after conformance: kill between row and alarm");
  }
  async readTx(): Promise<Record<string, unknown>> {
    return {
      p1: (await this.ctx.storage.get("p1")) ?? null,
      p2: (await this.ctx.storage.get("p2")) ?? null,
      t1: (await this.ctx.storage.get("t1")) ?? null,
      t2: (await this.ctx.storage.get("t2")) ?? null,
      row: (await this.ctx.storage.get("row")) ?? null,
    };
  }

  // -- §1.1 output gate ------------------------------------------------------
  /** Returns without awaiting the write; it must still be durable. */
  unawaitedPut(): string {
    // Deliberately not awaited — that is the behaviour under test. The output
    // gate must hold the reply until this write confirms.
    void this.ctx.storage.put("unawaited", "landed");
    return "returned-without-await";
  }
  async readUnawaited(): Promise<string> {
    return ((await this.ctx.storage.get("unawaited")) as string) ?? "MISSING";
  }

  // -- §1.5 critical sections ------------------------------------------------
  flag = "init";
  async setFlag(): Promise<string> {
    this.flag = "B";
    return "set";
  }
  /** Measured: genuinely blocks, so this returns "A". */
  async blockConcurrency(): Promise<string> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.flag = "A";
      await scheduler.wait(60);
    });
    return this.flag;
  }
  /** Measured: nests without deadlocking. */
  async nestedBlockConcurrency(): Promise<string> {
    return await this.ctx.blockConcurrencyWhile(async () =>
      this.ctx.blockConcurrencyWhile(async () => "nested-ok"),
    );
  }

  // -- §1.10 facets ----------------------------------------------------------
  async facetBump(): Promise<number[]> {
    const a = (await this.#child("bump").bump()) as number;
    const b = (await this.#child("bump").bump()) as number;
    return [a, b];
  }
  /** Measured: abort kills the instance, storage survives. */
  async facetSurvivesAbort(): Promise<number[]> {
    const before = (await this.#child("ab").bump()) as number;
    this.ctx.facets.abort("ab", new Error("conformance abort"));
    const after = (await this.#child("ab").bump()) as number;
    return [before, after];
  }
  /**
   * §1.10 — `facets.abort()` issued in the SAME slice as the `facets.get()` that
   * created the facet, so it lands while the startup is still in flight.
   *
   * `facets.get()` returns before the startup callback has run, so this is the
   * only shape in which an app can reach a facet that has not finished starting;
   * everything else the suite does awaits a call on the stub first. What is
   * asserted is the aftermath both sides can see — the name is usable again and
   * counts from 1 — because the in-flight window itself is not a shared
   * question. Upstream has nothing running to abort inside it: `getFacet` hands
   * back an `ActorChannelImpl` over a promise for a CLASS AND AN ID
   * (`server.c++:2603-2620`), and the actor is not constructed until a request
   * reaches `getActor()` (`:2519-2540`), which is the only caller of `start()`
   * (`:2854`).
   */
  async facetAbortDuringStart(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    // One slice, nothing awaited in between.
    this.#child("mid");
    this.ctx.facets.abort("mid", new Error("conformance abort mid-start"));
    out.first = await this.#child("mid").bump();
    out.second = await this.#child("mid").bump();
    return out;
  }

  async ping(): Promise<string> {
    this.trace.push("parent:ping");
    return "pong";
  }
  /**
   * Depth 2: the child creates a facet of its own and bumps it twice, then bumps
   * itself once. The grandchild counting from 1 while the child also counts from
   * 1 is what says the two have separate storage rather than one shared file.
   */
  async facetNesting(): Promise<number[]> {
    return (await this.#child("nest").nest()) as number[];
  }
  async facetDeleteCascades(): Promise<number[][]> {
    const before = (await this.#child("delete-tree").nest()) as number[];
    this.ctx.facets.delete("delete-tree");
    const after = (await this.#child("delete-tree").nest()) as number[];
    return [before, after];
  }
  /**
   * §1.10 — a facet whose construction FAILS. Measured on workerd
   * (1.20260722.1, via @cloudflare/vitest-pool-workers 0.18.8): `facets.get()`
   * returns a stub as usual, the failure arrives at the FIRST CALL on it
   * carrying the constructor's own message, and the parent is untouched — its
   * own storage answers and a sibling facet starts in the same event.
   */
  async facetStartFails(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    // `get` itself must not throw: the stub stands for a placement that has not finished.
    const stub = this.#child("boom", "Boom");
    out.got = typeof stub;
    try {
      out.call = await stub.bump();
    } catch (error) {
      out.call = String(error);
    }
    // The parent is not broken by a facet that never started.
    await this.ctx.storage.put("aliveAfterFailedFacet", 1);
    out.parentStorage = await this.ctx.storage.get("aliveAfterFailedFacet");
    out.sibling = await this.#child("boom-sibling").bump();
    return out;
  }

  /**
   * §1.10 — a failed start does not poison the name. Measured on workerd: the
   * facet is not running, so the next `facets.get()` runs the startup callback
   * again, and a working class starts under the very same name with no
   * intervening `abort()`. Storage the retry writes is that facet's own, from 1.
   */
  async facetStartRetries(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    try {
      out.first = await this.#child("retry", "Boom").bump();
    } catch (error) {
      out.first = String(error);
    }
    out.retry = await this.#child("retry").bump();
    return out;
  }

  /**
   * §1.10 — a RUNNING facet that breaks on its own. Breakage propagates DOWN and
   * never up: `ActorContainer::abort` (`server.c++:2565-2589`) and
   * `monitorOnBroken` (`:2767-2800`) each loop `for (auto& facet: facets)`, and
   * `monitorOnBroken` then erases the broken container from its PARENT's facet
   * map (`:2794-2798`) without touching the parent itself.
   *
   * So the parent keeps its own storage and its other facets. A sibling that was
   * already running before the break is what says the second half: a parent that
   * tore its whole facet map down on a break would still answer for itself.
   */
  async facetSelfBreak(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    // Both facets are RUNNING before anything breaks — a bump is a placement that landed and a
    // constructor that ran. Without this the row would also pass on a runtime where the break
    // happened to a facet that was never there.
    out.siblingBefore = await this.#child("break-sibling").bump();
    out.breakerBefore = await this.#child("breaker").bump();
    out.grandchildBefore = await this.#child("breaker").grandchildLocalBump();

    // The breaking call's OWN outcome is not asserted, and the reason is a divergence this row is
    // not about: workerd's `ctx.abort()` calls `js.terminateExecutionNow()`, so the slice ends
    // there and the caller sees a rejection carrying the abort's message, while @mcp-b/do-runtime
    // has no isolate to terminate — the method returns and, with no writes outstanding, the output
    // gate lets the reply through. Measured on both. `transactions.spec.ts`'s `killed()` tolerates
    // the same thing for the same reason.
    await this.#child("breaker")
      .selfBreak()
      .catch(() => undefined);

    // Neither half of the parent noticed: its own storage answers...
    await this.ctx.storage.put("aliveAfterFacetBreak", 1);
    out.parentStorage = await this.ctx.storage.get("aliveAfterFacetBreak");
    // ...and the sibling is still the same facet, counting on from where it was.
    out.siblingAfter = await this.#child("break-sibling").bump();
    // The broken name is a fresh placement at its stable id, so its durable count continues. Its
    // old child was aborted with it, so the grandchild's instance-local count starts over.
    out.breakerAfter = await this.#child("breaker").bump();
    out.grandchildAfter = await this.#child("breaker").grandchildLocalBump();
    return out;
  }

  /**
   * A facet calling back into its parent while the parent awaits it. Measured
   * on workerd: no deadlock. This is precisely the case a serialised event tail
   * cannot express, and the reason upstream published a facet RPC surface for
   * alternate-runtime adapters.
   */
  async facetReentrancy(): Promise<{ out: unknown; trace: string[] }> {
    this.trace = ["parent:enter"];
    const self = (this.env as { PROBE: DurableObjectNamespace }).PROBE;
    const stub = self.get(self.idFromName("reentry"));
    const out = await this.#child("re").callBack(stub as never);
    this.trace.push("parent:exit");
    return { out, trace: this.trace };
  }

  // -- §2.4 transactionSync --------------------------------------------------
  /** Measured: rolls back, including DDL issued inside the callback. */
  async transactionSyncRollback(): Promise<{ threw: string; count: number }> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS probe(x)");
    this.ctx.storage.sql.exec("INSERT INTO probe VALUES (0)");
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO probe VALUES (1)");
        this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS inner_ddl(y)");
        throw new Error("rollback me");
      });
    } catch (error) {
      const rows = [...this.ctx.storage.sql.exec("SELECT count(*) c FROM probe")];
      return { threw: String(error), count: (rows[0] as { c: number }).c };
    }
    return { threw: "none", count: -1 };
  }

  // -- §1.4 the SQL name authorizer ------------------------------------------
  /**
   * What `SqlStorageRegulator::isAllowedName` refuses, and — the half this row
   * exists for — what it does not.
   *
   * The authorizer sees resolved identifiers, so a `_cf_` prefix on a TABLE is
   * refused and the same characters inside a string LITERAL are ordinary data.
   * `@mcp-b/do-runtime` has no SQLite authorizer to hook, so it tokenizes the
   * statement text instead, and the first draft of that refused the literal too
   * — on the reasoning that no legitimate consumer statement contains the token.
   * The vendored `agents` package has one, in its schema migration:
   * `DELETE FROM cf_agents_schedules WHERE callback = '_cf_keepAliveHeartbeat'`.
   * So the reasoning was wrong, and this is the row that says what the rule
   * actually is instead of what it was assumed to be.
   */
  async reservedNames(): Promise<Record<string, string>> {
    const attempt = (sql: string): string => {
      try {
        this.ctx.storage.sql.exec(sql);
        return "allowed";
      } catch {
        return "refused";
      }
    };
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS names(callback TEXT)");
    return {
      // A reserved identifier, which is the whole point of the rule.
      createTable: attempt("CREATE TABLE IF NOT EXISTS _cf_probe(x)"),
      selectFrom: attempt("SELECT * FROM _cf_probe"),
      // A quoted identifier is still an identifier.
      quotedIdentifier: attempt('CREATE TABLE IF NOT EXISTS "_cf_quoted"(x)'),
      // Data. The `agents` statement above, with its own table name.
      stringLiteral: attempt("DELETE FROM names WHERE callback = '_cf_keepAliveHeartbeat'"),
      // A name that merely CONTAINS the token: `isAllowedName` tests a prefix.
      containsToken: attempt("CREATE TABLE IF NOT EXISTS my_cf_thing(x)"),
    };
  }

  /** `sql.exec()` runs each prelude in order; bindings and rows belong to the last statement. */
  async sqlBatch(): Promise<Record<string, unknown>> {
    const cursor = this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS batch_probe(id INTEGER, label TEXT);
       DELETE FROM batch_probe;
       INSERT INTO batch_probe VALUES (1, 'one');
       SELECT label FROM batch_probe WHERE id = ?;`,
      1,
    );
    return { columns: cursor.columnNames, row: cursor.one() };
  }

  /** A write that returns rows still reports that statement's writes. */
  async sqlReturningRowsWritten(): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS returning_probe(id INTEGER)");
    sql.exec("DELETE FROM returning_probe");
    const inserted = sql.exec(
      "INSERT INTO returning_probe VALUES (1), (2), (3) RETURNING id",
    );
    const rows = inserted.toArray();
    const selected = sql.exec("SELECT id FROM returning_probe ORDER BY id");
    selected.toArray();
    return {
      rows,
      rowsWritten: inserted.rowsWritten,
      selectRowsWritten: selected.rowsWritten,
    };
  }

  /** SQLite, not a JavaScript semicolon scanner, owns statement boundaries inside triggers. */
  async sqlTriggerBatch(): Promise<Record<string, unknown>> {
    const cursor = this.ctx.storage.sql.exec(
      `DROP TABLE IF EXISTS trigger_probe;
       CREATE TABLE trigger_probe(value INTEGER);
       DROP TRIGGER IF EXISTS trigger_probe_after_insert;
       CREATE TRIGGER trigger_probe_after_insert AFTER INSERT ON trigger_probe BEGIN
         INSERT INTO trigger_probe VALUES (new.value + 1);
         INSERT INTO trigger_probe VALUES (new.value + 98);
       END;
       INSERT INTO trigger_probe VALUES (1);
       SELECT value FROM trigger_probe WHERE value >= ? ORDER BY value;`,
      2,
    );
    return { columns: cursor.columnNames, rows: cursor.toArray() };
  }

  /** Multi-statement parameters belong exclusively, and exactly, to the final statement. */
  async sqlBindingErrors(): Promise<Record<string, string>> {
    const attempt = (query: string, ...bindings: number[]): string => {
      try {
        this.ctx.storage.sql.exec(query, ...bindings);
        return "allowed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    return {
      prelude: attempt("SELECT ? AS prelude; SELECT ? AS final", 1),
      missing: attempt("SELECT ? AS first, ? AS second", 1),
      absent: attempt("SELECT ? AS value"),
      extra: attempt("SELECT ? AS value", 1, 2),
    };
  }

  /** JSG binding conversion and int64 result coercion at the public SQL boundary. */
  async sqlValueSemantics(): Promise<Record<string, unknown>> {
    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    const bytes = new Uint8Array(backing.buffer, 1, 3);
    const view = new DataView(backing.buffer, 1, 3);
    const buffer = new Uint8Array([4, 5, 6]).buffer;
    const values = this.ctx.storage.sql
      .exec(
        `SELECT
           typeof(?) AS trueType, ? AS trueValue,
           typeof(?) AS falseType, ? AS falseValue,
           typeof(?) AS undefinedType, ? AS undefinedValue,
           hex(?) AS bytesHex, hex(?) AS viewHex, hex(?) AS bufferHex`,
        true,
        true,
        false,
        false,
        undefined,
        undefined,
        bytes,
        view,
        buffer,
      )
      .one();

    let bigint: string;
    try {
      this.ctx.storage.sql.exec("SELECT ?", 1n);
      bigint = "allowed";
    } catch (error) {
      bigint = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    const int64 = this.ctx.storage.sql
      .exec("SELECT 9223372036854775807 AS maximum, -9223372036854775808 AS minimum")
      .one();
    return {
      ...values,
      bigint,
      maximumType: typeof int64.maximum,
      maximum: String(int64.maximum),
      minimum: String(int64.minimum),
    };
  }

  // -- §2.4 / decision 16 the value codec ------------------------------------
  /**
   * workerd V8-serializes stored values, so all four come back as themselves.
   * `@mcp-b/do-runtime` stores JSON and refuses them at `put()` rather than
   * returning a `Date` as a string and the rest as `{}`.
   */
  async richValueRoundTrip(): Promise<Record<string, string>> {
    await this.ctx.storage.put("codec", {
      when: new Date(0),
      map: new Map([["k", 1]]),
      set: new Set([1]),
      bytes: new Uint8Array([1, 2, 3]).buffer,
      re: /pattern/g,
      err: new Error("boom"),
    });
    const read = (await this.ctx.storage.get("codec")) as Record<string, unknown>;
    return {
      when: read.when instanceof Date ? "Date" : typeof read.when,
      map: read.map instanceof Map ? "Map" : typeof read.map,
      set: read.set instanceof Set ? "Set" : typeof read.set,
      bytes: read.bytes instanceof ArrayBuffer ? "ArrayBuffer" : typeof read.bytes,
      re: read.re instanceof RegExp ? "RegExp" : typeof read.re,
      err: read.err instanceof Error ? "Error" : typeof read.err,
    };
  }

  // -- §1.8 alarms never overlap ---------------------------------------------
  async armAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 20);
  }
  async readAlarmLog(): Promise<string[]> {
    return ((await this.ctx.storage.get("alarmLog")) as string[]) ?? [];
  }

  // -- §1.8 a failed alarm is retried, and told how many times ---------------
  /**
   * Fails the first `failures` deliveries, then succeeds. The handler decides
   * from `AlarmInvocationInfo.retryCount` alone and journals only on success,
   * so nothing here depends on what a rolled-back handler's writes do.
   */
  async armFailingAlarm(failures: number): Promise<void> {
    await this.ctx.storage.put("alarmFailures", failures);
    await this.ctx.storage.setAlarm(Date.now() + 20);
  }
  async readAlarmRetry(): Promise<{ retryCount: number; isRetry: boolean } | null> {
    return (
      ((await this.ctx.storage.get("alarmRetry")) as {
        retryCount: number;
        isRetry: boolean;
      }) ?? null
    );
  }

  /** `getAlarm()` as an ordinary caller sees it, for the row that reads it mid-ladder. */
  async readAlarm(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const failures = (await this.ctx.storage.get("alarmFailures")) as number | undefined;
    if (failures !== undefined) {
      const retryCount = info?.retryCount ?? -1;
      if (retryCount < failures) {
        throw new Error("conformance: alarm handler failing on purpose");
      }
      await this.ctx.storage.put("alarmRetry", { retryCount, isRetry: info?.isRetry ?? false });
      return;
    }

    const depth = (((await this.ctx.storage.get("depth")) as number) ?? 0) + 1;
    await this.ctx.storage.put("depth", depth);
    const push = async (entry: string) => {
      const log = ((await this.ctx.storage.get("alarmLog")) as string[]) ?? [];
      log.push(entry);
      await this.ctx.storage.put("alarmLog", log);
    };
    await push(`enter:${depth}`);
    if (depth === 1) {
      await this.ctx.storage.setAlarm(Date.now());
      await scheduler.wait(150);
    }
    await push(`exit:${depth}`);
  }
}

export default {
  fetch(): Response {
    return new Response("probe");
  },
};
