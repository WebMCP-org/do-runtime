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

type CapturedError = { name: string; message: string };

function captureError(action: () => unknown): CapturedError | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: typeof error, message: String(error) };
  }
}

function socketPair(): [WebSocket, WebSocket] {
  const pair = new WebSocketPair();
  return [pair[0], pair[1]];
}

/** The facet implementation, loaded through the Worker Loader binding. */
const CHILD_SOURCE = `
import { DurableObject } from "cloudflare:workers";
export class Child extends DurableObject {
  local = 0;
  clients = [];
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
  async slow(ms) { await scheduler.wait(ms); return "child-done"; }
  async scopedWait(value, ms) {
    await scheduler.wait(ms);
    await this.ctx.storage.put("afterWait", value);
    return await this.ctx.storage.get("afterWait");
  }
  async callBack(parent) { return await parent.ping(); }
  async grandchildLocalBump() {
    const g = this.ctx.facets.get("g", () => ({ class: this.ctx.exports.Child }));
    return await g.localBump();
  }
  async localBump() { return ++this.local; }
  openSocket() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["facet"]);
    pair[0].accept();
    this.clients.push(pair[0]);
    return this.ctx.getWebSockets().length;
  }
  socketCount() { return this.ctx.getWebSockets().length; }
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
  #clients = new Map<string, WebSocket>();
  #servers = new Map<string, WebSocket>();
  #clientMessages = new Map<string, (string | ArrayBuffer)[]>();
  #clientCloses = new Map<
    string,
    { code: number; reason: string; wasClean: boolean }[]
  >();
  #handlerEvents: Record<string, unknown>[] = [];
  #handlerTrace: string[] = [];
  #handlerTimes: { event: string; at: number }[] = [];
  #listenerMessages = 0;
  #latePair: [WebSocket, WebSocket] | undefined;
  #capacityClients: WebSocket[] = [];
  #throwNextMessage = false;

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
  /** Outbound Durable Object RPC. Measured: releases this actor while the target runs. */
  async gateViaActor(actorName: string): Promise<{ marker: string; target: number }> {
    this.marker = "A";
    this.trace.push("actor:enter");
    const namespace = (this.env as { PROBE: DurableObjectNamespace }).PROBE;
    const target = namespace.get(namespace.idFromName(actorName)) as unknown as {
      remoteBump(): Promise<number>;
    };
    const value = await target.remoteBump();
    await this.ctx.storage.put("crossActorResult", value);
    this.trace.push("actor:exit");
    return { marker: this.marker, target: value };
  }
  async remoteBump(): Promise<number> {
    await scheduler.wait(60);
    const next = (((await this.ctx.storage.get("remoteCount")) as number | undefined) ?? 0) + 1;
    await this.ctx.storage.put("remoteCount", next);
    return next;
  }
  async readRemoteCount(): Promise<number> {
    return ((await this.ctx.storage.get("remoteCount")) as number | undefined) ?? 0;
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
  async facetScopesSurviveOverlappingWaits(): Promise<unknown[]> {
    return await Promise.all([
      this.#child("scope-a").scopedWait("a" as never, 30 as never),
      this.#child("scope-b").scopedWait("b" as never, 10 as never),
    ]);
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

  /**
   * The pragma allowlist: `ALLOWED_PRAGMAS` and the `SQLITE_PRAGMA` authorizer
   * case (`util/sqlite.c++:539-563`, `:1194-1273`). Everything not listed —
   * `user_version`, `writable_schema`, `journal_mode`, `max_page_count` — is
   * denied. This is load-bearing for the runtime, not just fidelity:
   * `user_version` is where runtime storage versioning keeps its stamp, and
   * `writable_schema` would let application SQL rewrite `sqlite_master` out
   * from under the `_cf_` reservation.
   */
  sqlPragmas(): Record<string, string> {
    const attempt = (sql: string): string => {
      try {
        this.ctx.storage.sql.exec(sql);
        return "allowed";
      } catch (error) {
        return error instanceof Error && /not authorized/.test(error.message)
          ? "refused"
          : `refused otherwise: ${String(error)}`;
      }
    };
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pragma_probe(x INTEGER)");
    return {
      userVersionRead: attempt("PRAGMA user_version"),
      userVersionWrite: attempt("PRAGMA user_version = 7"),
      userVersionSchema: attempt("PRAGMA main.user_version"),
      userVersionFunction: attempt("SELECT * FROM pragma_user_version"),
      writableSchema: attempt("PRAGMA writable_schema = ON"),
      journalMode: attempt("PRAGMA journal_mode"),
      maxPageCount: attempt("PRAGMA max_page_count = 1"),
      schemaVersion: attempt("PRAGMA schema_version"),
      dataVersion: attempt("PRAGMA data_version"),
      dataVersionWithArg: attempt("PRAGMA data_version = 1"),
      foreignKeysRead: attempt("PRAGMA foreign_keys"),
      foreignKeysWrite: attempt("PRAGMA foreign_keys = ON"),
      tableList: attempt("PRAGMA table_list"),
      tableInfo: attempt("PRAGMA table_info(pragma_probe)"),
      tableInfoQuoted: attempt("PRAGMA table_info('pragma_probe')"),
      tableInfoFunction: attempt("SELECT name FROM pragma_table_info('pragma_probe')"),
      indexList: attempt("PRAGMA index_list(pragma_probe)"),
      foreignKeyCheck: attempt("PRAGMA foreign_key_check"),
      quickCheck: attempt("PRAGMA quick_check"),
      optimize: attempt("PRAGMA optimize"),
    };
  }

  /**
   * The observable shape of the cursor and its iterators. Upstream's
   * `JSG_ITERATOR` types (`jsg/iterator.h:1036-1050`) define `next` and
   * self-iterability on `%IteratorPrototype%` and nothing else — no `return`,
   * no `throw` (only the async variant registers `return_`, `:1069-1085`) — so
   * an early exit does NOT close a retained iterator, `next()` results are
   * `JSG_STRUCT(done, value)` in that key order (`iterator.h:706-710`), and
   * `Symbol.toStringTag` carries the resource-type name (`resource.h`).
   * `columnNames` is a prototype accessor (`sql.h:210`), so a cursor
   * JSON-stringifies to `{}`.
   */
  sqlCursorIteratorShape(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS shape_probe(id INTEGER, label TEXT)");
    sql.exec("DELETE FROM shape_probe");
    sql.exec("INSERT INTO shape_probe VALUES (1, 'one'), (2, 'two'), (3, 'three')");
    const query = "SELECT id, label FROM shape_probe ORDER BY id";

    const abandoned = sql.exec(query).raw();
    for (const row of abandoned) {
      void row;
      break;
    }
    const rows = sql.exec(query)[Symbol.iterator]();
    const [first] = rows;
    void first;

    const fresh = sql.exec(query).raw();
    const exhausted = sql.exec(query).raw();
    for (const row of exhausted) void row;
    const cursor = sql.exec(query);
    const drained = sql.exec(query);
    drained.toArray();
    return {
      breakThenNext: abandoned.next(),
      destructureThenNext: rows.next(),
      rawTag: Object.prototype.toString.call(fresh),
      rowsTag: Object.prototype.toString.call(sql.exec(query)[Symbol.iterator]()),
      cursorTag: Object.prototype.toString.call(cursor),
      nextKeys: Object.keys(fresh.next()),
      doneKeys: Object.keys(exhausted.next()),
      cursorDoneKeys: Object.keys(drained.next()),
      ownKeys: Object.getOwnPropertyNames(fresh),
      hasReturn: typeof fresh.return,
      hasThrow: typeof (fresh as { throw?: unknown }).throw,
      selfIterable: fresh[Symbol.iterator]() === fresh,
      cursorJson: JSON.stringify(cursor),
    };
  }

  /**
   * Cursor iterators inherit the ES iterator helpers, because upstream's jsg
   * iterator objects sit on `%IteratorPrototype%`. `raw().toArray()` is what
   * Drizzle's durable-sqlite driver calls on every `values` query, so a plain
   * `{ next() }` object here is an SDK-visible divergence, not a style choice.
   */
  sqlCursorIteratorHelpers(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS helper_probe(id INTEGER, label TEXT)");
    sql.exec("DELETE FROM helper_probe");
    sql.exec("INSERT INTO helper_probe VALUES (1, 'one'), (2, 'two')");
    const query = "SELECT id, label FROM helper_probe ORDER BY id";
    const raw = sql.exec(query).raw() as IterableIterator<unknown[]> & {
      toArray?(): unknown[][];
      map?(fn: (row: unknown[]) => unknown): IterableIterator<unknown>;
    };
    const rows = sql.exec(query)[Symbol.iterator]() as IterableIterator<unknown> & {
      toArray?(): unknown[];
    };
    const mapped = (sql.exec(query).raw() as typeof raw).map?.((row) => row[1]);
    return {
      rawToArray: raw.toArray?.(),
      rawMaps: mapped === undefined ? undefined : [...mapped],
      rowsToArray: rows.toArray?.(),
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

  /** Experimental compatibility wrapper: callable, reusable, and wearing `sql.Statement`. */
  sqlPrepare(): Record<string, unknown> {
    const sql = this.ctx.storage.sql as SqlStorage & {
      prepare(query: string): (
        ...bindings: unknown[]
      ) => SqlStorageCursor<Record<string, SqlStorageValue>>;
    };
    sql.exec("CREATE TABLE IF NOT EXISTS prepare_probe(id INTEGER)");
    sql.exec("DELETE FROM prepare_probe");
    sql.exec("INSERT INTO prepare_probe VALUES (1), (2)");
    const statement = sql.prepare("SELECT id FROM prepare_probe WHERE id = ?");
    return {
      instance: statement instanceof sql.Statement,
      first: statement(1).toArray(),
      second: statement(2).toArray(),
    };
  }

  /** `sql.ingest()` consumes complete statements and returns the partial input tail. */
  sqlIngest(): Record<string, unknown> {
    const sql = this.ctx.storage.sql as SqlStorage & {
      ingest(query: string): {
        remainder: string;
        rowsRead: number;
        rowsWritten: number;
        statementCount: number;
      };
    };
    const result = sql.ingest(
      "CREATE TABLE IF NOT EXISTS ingest_probe(id INTEGER); " +
        "DELETE FROM ingest_probe; INSERT INTO ingest_probe VALUES (1), (2); " +
        "SELECT id FROM ingest_probe ORDER BY id; SELECT",
    );
    return {
      remainder: result.remainder,
      statementCount: result.statementCount,
      countersAreNumbers:
        typeof result.rowsRead === "number" && typeof result.rowsWritten === "number",
      rows: sql.exec("SELECT id FROM ingest_probe ORDER BY id").toArray(),
    };
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

  /** Workerd caps every SQLite string or blob at 4 MiB. */
  sqliteLengthLimit(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    const allowed = sql.exec("SELECT length(?) AS length", "x".repeat(4_000_000)).one();
    try {
      sql.exec("SELECT length(?)", new Uint8Array(4 * 1024 * 1024 + 1));
      return { allowed: allowed.length, tooBig: "allowed" };
    } catch (error) {
      return { allowed: allowed.length, tooBig: String(error) };
    }
  }

  /** Workerd's SQL regulator allows the built-in R*Tree virtual-table module. */
  sqliteRtree(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    sql.exec("DROP TABLE IF EXISTS rtree_probe");
    sql.exec(
      "CREATE VIRTUAL TABLE rtree_probe USING rtree(id, minX, maxX, minY, maxY)",
    );
    sql.exec(
      "INSERT INTO rtree_probe VALUES (1, -1, 1, -1, 1), (2, 10, 12, 10, 12)",
    );
    return {
      ids: sql
        .exec(
          "SELECT id FROM rtree_probe WHERE minX <= 2 AND maxX >= -2 AND minY <= 2 AND maxY >= -2 ORDER BY id",
        )
        .toArray(),
      check: sql.exec("SELECT rtreecheck('rtree_probe') AS result").one().result,
    };
  }

  /**
   * The authorizer forms that consult no `SqlStorageRegulator` callback, so porting the regulator
   * did not carry them — this row is what makes every lane assert the refusal.
   *
   * ATTACH is also the isolation boundary: a backend that allows it reads another actor's file.
   * The two file paths name a directory that does not exist, so a regression fails loudly on the
   * refusal instead of quietly leaving a database in the working directory.
   */
  sqlAuthorizerRefusals(): Record<string, string> {
    const sql = this.ctx.storage.sql;
    // A trigger needs a real table: SQLite refuses one on a system table before the authorizer
    // is consulted, which would measure SQLite's own message rather than the refusal under test.
    sql.exec("CREATE TABLE base (x)");
    const attempt = (query: string): string => {
      try {
        sql.exec(query).toArray();
        return "allowed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    return {
      attach: attempt("ATTACH DATABASE '/nonexistent-dir/other.sqlite' AS other"),
      detach: attempt("DETACH DATABASE other"),
      tempTable: attempt("CREATE TEMP TABLE t(x)"),
      tempTemporary: attempt("CREATE TEMPORARY TABLE t2(x)"),
      tempView: attempt("CREATE TEMP VIEW v AS SELECT 1"),
      tempTrigger: attempt("CREATE TEMP TRIGGER tg AFTER INSERT ON base BEGIN SELECT 1; END"),
      // The schema qualifier reaches upstream's `dbName == temp` rule rather than the
      // `SQLITE_CREATE_TEMP_*` action codes — the same refusal by its own path — and it takes
      // every quoting SQLite does, whitespace or none, single-quoted string included.
      tempQualifiedTable: attempt("CREATE TABLE temp.tq(x)"),
      tempQualifiedView: attempt("CREATE VIEW temp.vq AS SELECT 1"),
      noSpaceTempQualified: attempt('CREATE TABLE"temp".tq2(x)'),
      misquotedSchemaTemp: attempt("CREATE TABLE 'temp'.mq1(x)"),
      // A leading `;` is trivia: an empty first statement must not shift the leading keyword.
      // Classified rather than quoted, as `sqlPragmas` does, because this is the one form whose
      // MESSAGE legitimately differs by backend — workerd and `node:sqlite` compile the span and
      // reach the refusal, while sqlite-wasm cuts the input at the first `;` and rejects the
      // empty statement first. What has to hold on every lane is that it is refused at all.
      semicolonAttach:
        attempt(";ATTACH DATABASE '/nonexistent-dir/other.sqlite' AS other") === "allowed"
          ? "allowed"
          : "refused",
      batchAttach: attempt("SELECT 1; ATTACH DATABASE '/nonexistent-dir/o.sqlite' AS other"),
      vacuum: attempt("VACUUM"),
      vacuumInto: attempt("VACUUM INTO '/nonexistent-dir/exfil.sqlite'"),
      // Upstream allows exactly four virtual-table modules; `dbstat` would enumerate the
      // runtime's own `_cf_` tables without the statement naming them. All four are pinned on
      // the allowed side — `fts5vocab` reads the `ft` table the `fts5` entry created.
      rtree: attempt("CREATE VIRTUAL TABLE rt USING rtree(id, minX, maxX)"),
      rtreeI32: attempt("CREATE VIRTUAL TABLE rt32 USING rtree_i32(id, x1, x2)"),
      fts5: attempt("CREATE VIRTUAL TABLE ft USING fts5(body)"),
      fts5vocab: attempt("CREATE VIRTUAL TABLE ftv USING fts5vocab('ft', 'row')"),
      dbstat: attempt("CREATE VIRTUAL TABLE d USING dbstat"),
      // The name and the module take every quoting SQLite does — a guessed name boundary is a
      // bypass in both directions, so the quoted forms are pinned on every lane.
      spaceyNameDbstat: attempt('CREATE VIRTUAL TABLE "my table" USING dbstat'),
      usingInsideName: attempt('CREATE VIRTUAL TABLE "a USING fts5 b" USING dbstat'),
      quotedModuleDbstat: attempt('CREATE VIRTUAL TABLE qd USING "dbstat"'),
      quotedNameFts5: attempt('CREATE VIRTUAL TABLE "my docs" USING fts5(body)'),
      // The refusals are leading-keyword only; an application name is not a keyword.
      applicationName: attempt("CREATE TABLE t_ok (attach TEXT, vacuum TEXT)"),
      // `page_size` is on upstream's allowlist for the R*Tree module's own internal read.
      pageSizeRead: attempt("PRAGMA page_size"),
      pageSizeAssign: attempt("PRAGMA page_size = 8192"),
    };
  }

  /** The synchronous and asynchronous KV surfaces share one ordered store and codec. */
  async syncKvInterop(): Promise<Record<string, unknown>> {
    const kv = this.ctx.storage.kv;
    kv.put("shared:sync", { from: "sync" });
    const asyncRead = await this.ctx.storage.get("shared:sync");
    await this.ctx.storage.put("shared:async", { from: "async" });
    const syncRead = kv.get("shared:async");
    kv.put("ordered:b", 2);
    kv.put("ordered:a", 1);
    const listed = [...kv.list({ prefix: "ordered:" })].map(([key]) => key);
    const deleted = kv.delete("shared:sync");
    return { asyncRead, syncRead, listed, deleted, missing: typeof kv.get("shared:sync") };
  }

  /** `deleteAll()` resets the actor database, including alarm metadata. */
  async deleteAllState(): Promise<Record<string, unknown>> {
    await this.ctx.storage.put("delete-me", "present");
    await this.ctx.storage.setAlarm(Date.now() + 600_000);
    await this.ctx.storage.deleteAll();
    return {
      value: (await this.ctx.storage.get("delete-me")) ?? null,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  // -- §2.4 the value codec --------------------------------------------------
  /** Rich values retain the same public structured-clone types in every lane. */
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

  /**
   * Which argument `put()` reads as a key and which as an entries object — the
   * `kj::OneOf<kj::String, jsg::Dict<...>>` unwrap. Anything `jsg::Dict` refuses is a coerced
   * KEY, not an empty entries object, and the difference is a silently dropped write. Once the
   * key HAS unwrapped as a Dict, the second argument is the options STRUCT: `null`, arrays and
   * functions all unwrap to default options — only a non-null primitive is the overload error.
   */
  async putKeyCoercion(): Promise<{ keys: string[]; symbol: string; overload: string }> {
    const storage = this.ctx.storage;
    await storage.put(123 as never, "number");
    await storage.put(null as never, "null");
    await storage.put(true as never, "boolean");
    await storage.put(10n as never, "bigint");
    await storage.put([["a", 1]] as never, "array");
    // A Map reaches the Dict alternative and has no own enumerable keys, so it writes nothing.
    await storage.put(new Map([["m", 1]]) as never);
    await storage.put(undefined as never, "undefined");
    // The struct wrapper reads `null` as default options, so this WRITES — measured upstream.
    await storage.put({ nulled: 9 } as never, null as never);
    let symbol = "allowed";
    try {
      await storage.put(Symbol.iterator as never, "v");
    } catch (error) {
      symbol = error instanceof Error ? error.message : String(error);
    }
    // A non-null primitive where the options bag belongs is the caller mixing the overloads.
    let overload = "allowed";
    try {
      await storage.put({ mixed: 1 } as never, "not-options" as never);
    } catch (error) {
      overload = error instanceof Error ? error.message : String(error);
    }
    return { keys: [...(await storage.list()).keys()].sort(), symbol, overload };
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

  // -- hibernatable WebSockets ------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("probe");
    }

    const [client, server] = socketPair();
    const tags = new URL(request.url).searchParams.getAll("tag");
    this.ctx.acceptWebSocket(server, tags);
    WebSocket.prototype.serializeAttachment.call(server, {
      id: tags[0] ?? "external",
      tags,
      marker: "attachment-survived",
    });
    const connects = (((await this.ctx.storage.get("wsConnects")) as number | undefined) ?? 0) + 1;
    await this.ctx.storage.put("wsConnects", connects);
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptanceSemantics(): Record<string, unknown> {
    const [, twice] = socketPair();
    this.ctx.acceptWebSocket(twice);
    const doubleHibernation = captureError(() => this.ctx.acceptWebSocket(twice));

    const [, classicFirst] = socketPair();
    classicFirst.accept();
    const classicThenHibernation = captureError(() => this.ctx.acceptWebSocket(classicFirst));

    const [, hibernationFirst] = socketPair();
    this.ctx.acceptWebSocket(hibernationFirst);
    const hibernationThenClassic = captureError(() => hibernationFirst.accept());

    const [client, server] = socketPair();
    this.ctx.acceptWebSocket(client, ["client-half"]);
    server.accept();

    const [usedPeer, usedServer] = socketPair();
    usedPeer.accept();
    const usedPair = captureError(() => this.ctx.acceptWebSocket(usedServer));

    return {
      doubleHibernation,
      classicThenHibernation,
      hibernationThenClassic,
      clientHalfAccepted: this.ctx.getTags(client),
      usedPair,
    };
  }

  async acceptAfterAwait(): Promise<string[]> {
    const [client, server] = socketPair();
    await Promise.resolve();
    this.ctx.acceptWebSocket(server, ["after-await"]);
    client.accept();
    this.#clients.set("after-await", client);
    return this.ctx.getTags(server);
  }

  stashSocketForLaterEvent(): void {
    this.#latePair = socketPair();
  }

  acceptSocketFromLaterEvent(): CapturedError | null {
    const pair = this.#latePair;
    if (pair === undefined) throw new Error("No late pair was stashed.");
    const error = captureError(() => this.ctx.acceptWebSocket(pair[1]));
    if (error === null) pair[0].accept();
    return error;
  }

  tagSemantics(): Record<string, unknown> {
    const make = (tags: unknown): WebSocket => {
      const [client, server] = socketPair();
      this.ctx.acceptWebSocket(server, tags as string[]);
      client.accept();
      this.#clients.set(`tags-${this.#clients.size}`, client);
      return server;
    };
    const normalized = make(["", 123, null, { a: 1 }, "dup", "dup"]);
    const tooMany = captureError(() => make(Array.from({ length: 11 }, (_, i) => `${i}`)));
    const longTag = "x".repeat(257);
    const tooLong = captureError(() => make([longTag]));
    const nonArray = captureError(() => make("tag"));
    return {
      normalized: this.ctx.getTags(normalized),
      tooMany,
      tooLong,
      nonArray,
    };
  }

  orderingSemantics(): Record<string, unknown> {
    const accept = (id: string, tags: string[]) => {
      const [client, server] = socketPair();
      Object.assign(server, { probeId: id });
      this.ctx.acceptWebSocket(server, tags);
      client.accept();
      this.#clients.set(`order-${id}`, client);
      return server;
    };
    const first = accept("first", ["shared", "ALPHA"]);
    const second = accept("second", ["shared"]);
    const third = accept("third", []);
    const ids = (sockets: WebSocket[]) =>
      sockets.map((socket) => (socket as WebSocket & { probeId: string }).probeId);
    const a = this.ctx.getWebSockets();
    const b = this.ctx.getWebSockets();
    return {
      all: ids(a),
      shared: ids(this.ctx.getWebSockets("shared")),
      alpha: ids(this.ctx.getWebSockets("ALPHA")),
      lower: ids(this.ctx.getWebSockets("alpha")),
      empty: ids(this.ctx.getWebSockets("")),
      nonString: ids(this.ctx.getWebSockets(1 as never)),
      freshArray: a !== b,
      sameObjects: a.includes(first) && a.includes(second) && a.includes(third),
    };
  }

  socketCapacity(): CapturedError | null {
    for (let i = 0; i < 32_768; i++) {
      const [client, server] = socketPair();
      this.ctx.acceptWebSocket(server);
      client.accept();
      this.#capacityClients.push(client);
    }
    const [, overflow] = socketPair();
    return captureError(() => this.ctx.acceptWebSocket(overflow));
  }

  attachmentSemantics(): Record<string, unknown> {
    const [client, socket] = socketPair();
    const attachment = { nested: { value: 1 } };
    socket.serializeAttachment(attachment);
    attachment.nested.value = 2;
    const first = socket.deserializeAttachment() as { nested: { value: number } };
    first.nested.value = 3;
    const second = socket.deserializeAttachment() as { nested: { value: number } };

    const [, neverSerialized] = socketPair();
    socket.serializeAttachment(undefined);
    const explicitUndefined = socket.deserializeAttachment();
    const zeroArgument = captureError(() =>
      Reflect.apply(WebSocket.prototype.serializeAttachment, socket, []),
    );

    const [, rich] = socketPair();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    rich.serializeAttachment({
      map: new Map([["k", 1]]),
      date: new Date(0),
      bigint: 1n,
      bytes: new Uint8Array([1, 2]),
      cyclic,
    });
    const richResult = rich.deserializeAttachment() as Record<string, unknown>;

    const [, invalid] = socketPair();
    const functionError = captureError(() => invalid.serializeAttachment(function foo() {}));
    const symbolError = captureError(() => invalid.serializeAttachment(Symbol("s")));

    const [, size] = socketPair();
    const pass = captureError(() => size.serializeAttachment("x".repeat(16_379)));
    const fail = captureError(() => size.serializeAttachment("x".repeat(16_380)));

    const [classicClient, classic] = socketPair();
    classic.accept();
    classic.serializeAttachment("classic");
    classicClient.serializeAttachment("client");
    classicClient.accept();
    classicClient.close(1000, "done");
    classicClient.serializeAttachment("closed");

    client.accept();
    return {
      snapshot: second.nested.value,
      freshClone: first !== second && first.nested !== second.nested,
      neverSerialized: neverSerialized.deserializeAttachment(),
      explicitUndefined: typeof explicitUndefined,
      zeroArgument,
      rich: {
        map: richResult.map instanceof Map,
        date: richResult.date instanceof Date,
        bigint: typeof richResult.bigint,
        bytes: richResult.bytes instanceof Uint8Array,
        cyclic:
          (richResult.cyclic as { self?: unknown }).self === (richResult.cyclic as { self?: unknown }),
      },
      functionError,
      symbolError,
      sizePass: pass,
      sizeFail: fail,
      classic: classic.deserializeAttachment(),
      client: classicClient.deserializeAttachment(),
    };
  }

  openSelfSocket(id: string, tags: string[] = []): void {
    const [client, server] = socketPair();
    server.addEventListener("message", () => {
      this.#listenerMessages += 1;
    });
    this.ctx.acceptWebSocket(server, tags);
    WebSocket.prototype.serializeAttachment.call(server, { id, tags });
    client.accept();
    const messages: (string | ArrayBuffer)[] = [];
    const closes: { code: number; reason: string; wasClean: boolean }[] = [];
    client.addEventListener("message", (event) => {
      messages.push(event.data as string | ArrayBuffer);
    });
    client.addEventListener("close", (event) => {
      closes.push({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    this.#clients.set(id, client);
    this.#servers.set(id, server);
    this.#clientMessages.set(id, messages);
    this.#clientCloses.set(id, closes);
  }

  sendSelf(id: string, message: string): void {
    this.#requireClient(id).send(message);
  }

  sendSelfBinary(id: string, bytes: number[]): void {
    this.#requireClient(id).send(new Uint8Array(bytes));
  }

  closeSelfClient(id: string, code: number, reason: string): void {
    this.#requireClient(id).close(code, reason);
  }

  closeSelfServer(id: string, code: number, reason: string): void {
    this.#requireServer(id).close(code, reason);
  }

  throwOnNextSocketMessage(): void {
    this.#throwNextMessage = true;
  }

  removeSocketMessageHandler(): void {
    Object.defineProperty(this, "webSocketMessage", { configurable: true, value: undefined });
  }

  restoreSocketMessageHandler(): void {
    Reflect.deleteProperty(this, "webSocketMessage");
  }

  socketJournal(): Record<string, unknown> {
    return {
      events: this.#handlerEvents,
      trace: this.#handlerTrace,
      times: this.#handlerTimes,
      listenerMessages: this.#listenerMessages,
      clients: Object.fromEntries(
        [...this.#clientMessages].map(([id, messages]) => [
          id,
          messages.map((message) =>
            message instanceof ArrayBuffer ? [...new Uint8Array(message)] : message,
          ),
        ]),
      ),
      closes: Object.fromEntries(this.#clientCloses),
      listed: this.ctx.getWebSockets().map((socket) => this.#socketId(socket)),
    };
  }

  sendAfterOwnClose(id: string): CapturedError | null {
    const socket = this.#requireServer(id);
    socket.close(4002, "server out");
    return captureError(() => socket.send("too late"));
  }

  closeValidation(): Record<string, CapturedError | null> {
    const attempt = (code: number, reason?: string): CapturedError | null => {
      const [client, server] = socketPair();
      this.ctx.acceptWebSocket(server);
      client.accept();
      return captureError(() => server.close(code, reason));
    };
    return {
      code999: attempt(999),
      code1005: attempt(1005),
      code1006: attempt(1006),
      code5000: attempt(5000),
      longReason: attempt(1000, "é".repeat(62)),
      code1000: attempt(1000),
      code3000: attempt(3000),
      code4999: attempt(4999),
    };
  }

  readyStateConstants(): Record<string, unknown> {
    const [client, server] = socketPair();
    const ctor = WebSocket as typeof WebSocket & Record<string, number>;
    const proto = WebSocket.prototype as WebSocket & Record<string, number>;
    return {
      fresh: [client.readyState, server.readyState],
      constructorValues: [
        ctor.READY_STATE_CONNECTING,
        ctor.READY_STATE_OPEN,
        ctor.READY_STATE_CLOSING,
        ctor.READY_STATE_CLOSED,
        ctor.CONNECTING,
        ctor.OPEN,
        ctor.CLOSING,
        ctor.CLOSED,
      ],
      prototype: [
        proto.READY_STATE_CONNECTING,
        proto.READY_STATE_OPEN,
        proto.READY_STATE_CLOSING,
        proto.READY_STATE_CLOSED,
        proto.CONNECTING,
        proto.OPEN,
        proto.CLOSING,
        proto.CLOSED,
      ],
    };
  }

  setAutoResponse(request: string, response: string): void {
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(request, response));
  }

  clearAutoResponse(): void {
    this.ctx.setWebSocketAutoResponse();
  }

  autoResponseSemantics(id: string): Record<string, unknown> {
    const first = this.ctx.getWebSocketAutoResponse();
    const second = this.ctx.getWebSocketAutoResponse();
    return {
      value: first === null ? null : { request: first.request, response: first.response },
      fresh: first !== second,
      timestamp: this.ctx.getWebSocketAutoResponseTimestamp(this.#requireServer(id))?.getTime() ?? null,
      unacceptedTimestamp: this.ctx.getWebSocketAutoResponseTimestamp(socketPair()[1]),
      badTimestamp: captureError(() =>
        this.ctx.getWebSocketAutoResponseTimestamp({} as WebSocket),
      ),
      nullSetter: captureError(() => this.ctx.setWebSocketAutoResponse(null as never)),
    };
  }

  autoResponseLimits(): Record<string, CapturedError | null> {
    return {
      request: captureError(() => {
        this.ctx.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair("x".repeat(2_049), "response"),
        );
      }),
      response: captureError(() => {
        this.ctx.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair("request", "x".repeat(2_049)),
        );
      }),
    };
  }

  timeoutSemantics(): Record<string, unknown> {
    const initial = this.ctx.getHibernatableWebSocketEventTimeout();
    this.ctx.setHibernatableWebSocketEventTimeout(1_000);
    const thousand = this.ctx.getHibernatableWebSocketEventTimeout();
    this.ctx.setHibernatableWebSocketEventTimeout(1.9);
    const truncated = this.ctx.getHibernatableWebSocketEventTimeout();
    this.ctx.setHibernatableWebSocketEventTimeout("42" as never);
    const coerced = this.ctx.getHibernatableWebSocketEventTimeout();
    const negative = captureError(() => this.ctx.setHibernatableWebSocketEventTimeout(-1));
    const outOfRange = captureError(() =>
      this.ctx.setHibernatableWebSocketEventTimeout(2 ** 32),
    );
    const sevenDays = captureError(() =>
      this.ctx.setHibernatableWebSocketEventTimeout(604_800_001),
    );
    const nan = captureError(() => this.ctx.setHibernatableWebSocketEventTimeout(Number.NaN));
    this.ctx.setHibernatableWebSocketEventTimeout(0);
    return {
      initial,
      thousand,
      truncated,
      coerced,
      negative,
      outOfRange,
      sevenDays,
      nan,
      cleared: this.ctx.getHibernatableWebSocketEventTimeout(),
    };
  }

  pairClassSemantics(): Record<string, unknown> {
    const pair = new WebSocketRequestResponsePair(123 as never, null as never);
    const requestDescriptor = Object.getOwnPropertyDescriptor(
      WebSocketRequestResponsePair.prototype,
      "request",
    );
    return {
      values: [pair.request, pair.response],
      json: JSON.stringify(pair),
      hasSetter: requestDescriptor?.set !== undefined,
      withoutNew: captureError(() =>
        Reflect.apply(WebSocketRequestResponsePair as unknown as () => unknown, undefined, ["a", "b"]),
      ),
      badCoercion: captureError(() =>
        new WebSocketRequestResponsePair(
          {
            toString(): never {
              throw new Error("coercion failed");
            },
          } as never,
          "b",
        ),
      ),
    };
  }

  getTagsSemantics(): Record<string, unknown> {
    const [, unaccepted] = socketPair();
    const [, classic] = socketPair();
    classic.accept();
    const [client, hibernatable] = socketPair();
    this.ctx.acceptWebSocket(hibernatable);
    client.accept();
    const first = this.ctx.getTags(hibernatable);
    const second = this.ctx.getTags(hibernatable);
    return {
      unaccepted: captureError(() => this.ctx.getTags(unaccepted)),
      classic: captureError(() => this.ctx.getTags(classic)),
      tags: first,
      fresh: first !== second,
    };
  }

  async facetSocketIsolation(): Promise<number[]> {
    const [client, server] = socketPair();
    this.ctx.acceptWebSocket(server, ["root"]);
    client.accept();
    this.#clients.set("root-facet-check", client);
    const child = this.#child("socket-isolation");
    const before = (await child.socketCount()) as number;
    const childCount = (await child.openSocket()) as number;
    return [this.ctx.getWebSockets().length, before, childCount];
  }

  setHibernationMarker(value: string): void {
    this.marker = value;
  }

  async readExternalObservation(): Promise<Record<string, unknown> | null> {
    return (
      ((await this.ctx.storage.get("externalObservation")) as Record<string, unknown> | undefined) ??
      null
    );
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.#throwNextMessage) {
      this.#throwNextMessage = false;
      throw new Error("conformance: socket handler threw");
    }

    const id = this.#socketId(ws);
    const description =
      typeof message === "string"
        ? { kind: "string", value: message }
        : { kind: "ArrayBuffer", value: [...new Uint8Array(message)] };
    this.#handlerEvents.push({ id, message: description });

    if (typeof message === "string" && message.startsWith("slow:")) {
      this.#handlerTrace.push(`start:${message}`);
      this.#handlerTimes.push({ event: `start:${message}`, at: Date.now() });
      await scheduler.wait(200);
      this.#handlerTrace.push(`end:${message}`);
      this.#handlerTimes.push({ event: `end:${message}`, at: Date.now() });
      return;
    }
    if (typeof message === "string" && message.startsWith("block:")) {
      this.#handlerTrace.push(`start:${message}`);
      this.#handlerTimes.push({ event: `start:${message}`, at: Date.now() });
      await this.ctx.blockConcurrencyWhile(async () => {
        await scheduler.wait(200);
      });
      this.#handlerTrace.push(`end:${message}`);
      this.#handlerTimes.push({ event: `end:${message}`, at: Date.now() });
      return;
    }
    if (message === "echo") ws.send("echoed");

    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS websocket_probe (id TEXT PRIMARY KEY, seen INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO websocket_probe (id, seen) VALUES (?, ?)",
      id,
      1,
    );
    await this.ctx.storage.put("externalObservation", {
      id,
      message: description,
      attachment: WebSocket.prototype.deserializeAttachment.call(ws),
      tags: this.ctx.getTags(ws),
      listed: this.ctx.getWebSockets().includes(ws),
      actorName: this.ctx.id.name,
      marker: this.marker,
      connects: ((await this.ctx.storage.get("wsConnects")) as number | undefined) ?? 0,
    });
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    const event: Record<string, unknown> = {
      id: this.#socketId(ws),
      close: { code, reason, wasClean },
      readyState: ws.readyState,
      listedDuringHandler: this.ctx.getWebSockets().includes(ws),
    };
    event.sendAfterPeerClose = captureError(() => ws.send("after-peer-close"));
    event.reciprocalClose = captureError(() => ws.close(code, reason));
    this.#handlerEvents.push(event);
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    this.#handlerEvents.push({
      id: this.#socketId(ws),
      error: error instanceof Error ? error.message : String(error),
      readyState: ws.readyState,
    });
  }

  #socketId(socket: WebSocket): string {
    const attachment = WebSocket.prototype.deserializeAttachment.call(socket) as
      | { id?: unknown }
      | null;
    return typeof attachment?.id === "string"
      ? attachment.id
      : ([...this.#servers].find(([, candidate]) => candidate === socket)?.[0] ?? "unknown");
  }

  #requireClient(id: string): WebSocket {
    const socket = this.#clients.get(id);
    if (socket === undefined) throw new Error(`No client socket ${id}.`);
    return socket;
  }

  #requireServer(id: string): WebSocket {
    const socket = this.#servers.get(id);
    if (socket === undefined) throw new Error(`No server socket ${id}.`);
    return socket;
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
