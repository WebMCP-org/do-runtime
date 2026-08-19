/**
 * ← workerd `src/workerd/api/actor-state-test.c++`,
 * `actor-state-iocontext-test.c++`, and the three behavioural JS suites in
 * `api/tests/` that drive exactly this surface: `actor-kv-test.js`,
 * `actor-alarms-test.js`, `actor-alarms-delete-test.js`.
 *
 * The six `KJ_TEST`s are all about the V8 value codec — the wire version tag,
 * backwards-compatible deserialization, and the error a corrupt row produces.
 * Five of them assert facts about V8's serializer that do not survive the
 * recorded JSON-codec divergence and have nothing to stand in for them; the
 * sixth does, and it is ported: a value that will not decode reports the key
 * rather than returning something wrong.
 *
 * The JS suites translate almost line for line, because they are written
 * against `ctx.storage` rather than against workerd internals. What they cannot
 * bring with them is alarm *delivery* — `server/alarm-scheduler.ts`'s, not this
 * file's — so their alarm-handler cases are driven through
 * `ActorSqlite.armAlarmHandler` here, which is the seam delivery will use.
 *
 * The remaining groups have no upstream test at all and are the claims this
 * section owes: the facet limits and `clone()`, the substrate-boundary
 * messages, the `allowConcurrency` branch, and §1.7.1 seen from the JS surface
 * rather than from `ActorSqlite`.
 */

import { expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { SqliteDatabase } from "../util/sqlite";
import type { SqliteKv } from "../util/sqlite-kv";
import { InputGate, OutputGate } from "../io/io-gate";
import { type Actor, IoContext, type Timer } from "../io/io-context";
import type {
  ActorCacheTransaction,
  DeleteAllOptions,
  DeleteAllResults,
  GetResultList,
  Key,
  KeyValuePair,
  ReadOptions,
  Value,
  WriteOptions,
} from "../io/actor-cache";
import { PITR_UNIMPLEMENTED_MESSAGE, REPLICATION_UNIMPLEMENTED_MESSAGE } from "../io/actor-cache";
import { ActorSqlite } from "../io/actor-sqlite";
import { asFacetStub, type FacetManager, type FacetStartInfo } from "../io/worker";
import type { ActorClassChannel } from "../io/io-channels";
import type { ActorId, ActorIdFactory } from "../io/actor-id";
import { DurableObjectClass, DurableObjectNamespace } from "./actor";
import { ActorGlobalScope, FOREIGN_SLICE_MESSAGE, actorScopeBindings } from "./global-scope";
import {
  LoopbackColoLocalActorNamespace,
  LoopbackDurableObjectClass,
  LoopbackDurableObjectNamespace,
  asLoopbackColoLocalActorNamespace,
  asLoopbackDurableObjectClass,
  asLoopbackDurableObjectNamespace,
} from "./export-loopback";
import {
  DurableObjectState,
  DurableObjectStorage,
  FACET_CLASS_UNSUPPORTED_MESSAGE,
  FACET_NAME_MAX_LENGTH,
  FACET_TREE_MAX_DEPTH,
  HIBERNATION_UNIMPLEMENTED_MESSAGE,
  type StorageCache,
} from "./actor-state";

/** The `ctx.exports` value a facet start-up callback hands back, once per call site. */
function testClass(): DurableObjectClass {
  return new DurableObjectClass({ className: "Child", requireAllowsTransfer: () => {} });
}

// =======================================================================================
// Harness

class TestActor implements Actor {
  readonly inputGate = new InputGate();
  readonly outputGate = new OutputGate();
  canSetAlarm: string | undefined;

  getInputGate(): InputGate {
    return this.inputGate;
  }
  getOutputGate(): OutputGate {
    return this.outputGate;
  }
  shutdownActorCache(reason: unknown): void {
    this.shutdownReasons.push(reason);
  }
  assertCanSetAlarm(): void {
    if (this.canSetAlarm !== undefined) throw new Error(this.canSetAlarm);
  }
  readonly shutdownReasons: unknown[] = [];
}

class TestId implements DurableObjectId {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
  equals(other: DurableObjectId): boolean {
    return other.toString() === this.value;
  }
}

type FacetCall =
  | { readonly kind: "get"; readonly name: string }
  | { readonly kind: "abort"; readonly name: string; readonly reason: unknown }
  | { readonly kind: "delete"; readonly name: string }
  | { readonly kind: "clone"; readonly src: string; readonly dst: string };

class FakeFacetManager implements FacetManager {
  depth = 0;
  readonly calls: FacetCall[] = [];
  lastStartInfo: (() => Promise<FacetStartInfo>) | undefined;

  getDepth(): number {
    return this.depth;
  }
  getFacet<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name: string,
    getStartInfo: () => Promise<FacetStartInfo>,
  ): Fetcher<T> {
    this.calls.push({ kind: "get", name });
    this.lastStartInfo = getStartInfo;
    return stubFetcher<T>();
  }
  abortFacet(name: string, reason: unknown): void {
    this.calls.push({ kind: "abort", name, reason });
  }
  deleteFacet(name: string): void {
    this.calls.push({ kind: "delete", name });
  }
  cloneFacet(src: string, dst: string): void {
    this.calls.push({ kind: "clone", src, dst });
  }
}

/** Enough of an `ActorIdFactory` for the two namespaces the class switch has to recognise. */
function fakeIdFactory(): ActorIdFactory {
  const id: ActorId = {
    toString: () => "fake",
    getName: () => undefined,
    getJurisdiction: () => undefined,
    equals: (other) => other.toString() === "fake",
  };
  return {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    matchesJurisdiction: () => true,
    cloneWithJurisdiction: () => fakeIdFactory(),
  };
}

/** A `Fetcher`-shaped stub, since §1.10's `facets.get` returns a Fetcher and not a stub with an id. */
function stubFetcher<T extends Rpc.DurableObjectBranded | undefined = undefined>(): Fetcher<T> {
  const stub: Fetcher = {
    fetch: (): Promise<Response> => Promise.reject(new Error("no transport in this lane")),
    connect: (): never => {
      throw new Error("no transport in this lane");
    },
  };
  return asFacetStub<T>(stub);
}

class FakeTimer implements Timer {
  current = 0;
  now(): number {
    return this.current;
  }
  afterDelay(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

class Harness {
  readonly gate = new OutputGate();
  readonly actor = new TestActor();
  readonly timer = new FakeTimer();
  readonly db: SqliteDatabase;
  readonly cache: ActorSqlite;
  readonly ctx: IoContext;
  readonly facets = new FakeFacetManager();
  readonly storage: DurableObjectStorage;
  readonly globals: ActorGlobalScope;
  readonly state: DurableObjectState;
  readonly scheduled: Array<number | null> = [];
  commits = 0;

  constructor(db: SqliteDatabase, wrapCache?: (cache: ActorSqlite) => StorageCache) {
    this.db = db;
    this.cache = new ActorSqlite(
      db,
      this.gate,
      () => {
        this.commits += 1;
        return Promise.resolve();
      },
      {
        scheduleRun: (scheduledTime) => {
          this.scheduled.push(scheduledTime);
          return Promise.resolve();
        },
      },
    );
    this.ctx = new IoContext(this.actor, this.timer);
    this.storage = new DurableObjectStorage(
      this.ctx,
      wrapCache === undefined ? this.cache : wrapCache(this.cache),
    );
    this.globals = new ActorGlobalScope(this.ctx);
    this.state = new DurableObjectState(this.ctx, {
      id: new TestId("test-actor"),
      exports: { Thing: class {} },
      props: { hello: "world" },
      storage: this.storage,
      facets: this.facets,
      globals: actorScopeBindings(() => this.globals),
    });
    // Nothing else takes it, and an unobserved break would surface as an unhandled rejection.
    void this.gate.onBroken().catch(() => {});
  }

  /** One gated invocation, then the hand-offs that carry its commit and release. */
  async run<T>(body: () => T | PromiseLike<T>): Promise<T> {
    const result = await this.ctx.run(body);
    await quiesce();
    return result;
  }
}

async function quiesce(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function newHarness(wrapCache?: (cache: ActorSqlite) => StorageCache): Promise<Harness> {
  const db = new SqliteDatabase(await createNodeSqlProvider().open("actor-state-test"));
  return new Harness(db, wrapCache);
}

/** Most cases are one gated invocation over a fresh actor. */
function apiTest(name: string, body: (h: Harness) => void | Promise<void>): void {
  test(name, async () => {
    const h = await newHarness();
    await h.run(() => body(h));
  });
}

// =======================================================================================
// ← tests/actor-kv-test.js — the whole KV surface, exercised end to end

apiTest("put/get a single key round-trips", async ({ storage }) => {
  await storage.put("testKey1", "testValue");
  expect(await storage.get("testKey1")).toBe("testValue");
});

apiTest("get of an absent key is undefined", async ({ storage }) => {
  expect(await storage.get("testKey2")).toBeUndefined();
});

apiTest("put of an entries object writes them all", async ({ storage }) => {
  await storage.put({ foo1: "bar1", foo2: "bar2", foo3: "bar3", foo4: "bar4" });
  expect(await storage.get(["foo1", "foo3"])).toEqual(
    new Map([
      ["foo1", "bar1"],
      ["foo3", "bar3"],
    ]),
  );
});

apiTest("get of multiple keys returns a Map, omitting absent keys", async ({ storage }) => {
  await storage.put("testKey1", "testValue");
  expect(await storage.get(["testKey1", "testKey2"])).toEqual(new Map([["testKey1", "testValue"]]));
});

apiTest("delete reports whether the key was present", async ({ storage }) => {
  await storage.put("testKey1", "testValue");
  expect(await storage.delete("testKey1")).toBe(true);
  expect(await storage.delete("testKey1")).toBe(false);
});

apiTest("delete of multiple keys reports how many were present", async ({ storage }) => {
  await storage.put({ a: 1, b: 2 });
  expect(await storage.delete(["a", "b", "c"])).toBe(2);
});

apiTest("list returns every key in order", async ({ storage }) => {
  await storage.put({ b: 2, a: 1, c: 3 });
  expect([...(await storage.list()).keys()]).toEqual(["a", "b", "c"]);
});

apiTest("deleteAll empties the store", async ({ storage }) => {
  await storage.put({ a: 1, b: 2 });
  await storage.deleteAll();
  expect((await storage.list()).size).toBe(0);
});

apiTest("setAlarm/getAlarm/deleteAlarm round-trip", async ({ storage }) => {
  await storage.setAlarm(50);
  expect(await storage.getAlarm()).toBe(50);
  await storage.deleteAlarm();
  expect(await storage.getAlarm()).toBeNull();
});

apiTest("transaction returns the callback's value", async ({ storage }) => {
  expect(await storage.transaction(() => Promise.resolve("test"))).toBe("test");
});

apiTest("sync resolves once outstanding writes have flushed", async ({ storage }) => {
  await storage.put("a", 1);
  await storage.sync();
});

// =======================================================================================
// ← tests/actor-alarms-test.js and tests/actor-alarms-delete-test.js
//
// Delivery is `server/alarm-scheduler.ts`'s; what these assert is the storage-side contract the
// handler runs against, driven through the same `armAlarmHandler` seam delivery will use.

apiTest("getAlarm returns null inside a running alarm handler", async ({ storage, cache }) => {
  await storage.setAlarm(50);
  expect(await storage.getAlarm()).toBe(50);

  const armed = cache.armAlarmHandler(50, 0);
  expect(armed.kind).toBe("run");
  expect(await storage.getAlarm()).toBeNull();
});

apiTest("the alarm time is cleared when the handler ends", async ({ storage, cache }) => {
  await storage.setAlarm(50);
  const armed = cache.armAlarmHandler(50, 0);
  if (armed.kind !== "run") throw new Error("expected the handler to run");
  armed.run.deferredDelete.drop();
  expect(await storage.getAlarm()).toBeNull();
});

apiTest("setting a new alarm inside the handler survives the handler ending", async ({
  storage,
  cache,
}) => {
  await storage.setAlarm(50);
  const armed = cache.armAlarmHandler(50, 0);
  if (armed.kind !== "run") throw new Error("expected the handler to run");

  await storage.setAlarm(500);
  armed.run.deferredDelete.drop();
  expect(await storage.getAlarm()).toBe(500);
});

apiTest("deleting a queued alarm from inside the handler leaves none", async ({
  storage,
  cache,
}) => {
  await storage.setAlarm(50);
  const armed = cache.armAlarmHandler(50, 0);
  if (armed.kind !== "run") throw new Error("expected the handler to run");

  // "Deleting an alarm inside `alarm()` will not have any effect, unless there's another queued
  // alarm already." Then: queue one, delete it, and end with nothing scheduled.
  await storage.deleteAlarm();
  await storage.setAlarm(500);
  await storage.deleteAlarm();
  armed.run.deferredDelete.drop();
  expect(await storage.getAlarm()).toBeNull();
});

apiTest("an alarm set and deleted before it fires leaves nothing", async ({ storage }) => {
  await storage.setAlarm(500);
  await storage.deleteAlarm();
  expect(await storage.getAlarm()).toBeNull();
});

// =======================================================================================
// DurableObjectStorageOperations — the argument checks upstream states with JSG_REQUIRE

apiTest("put with an undefined value is refused", ({ storage }) => {
  expect(() => storage.put("key", undefined)).toThrow("put() called with undefined value.");
});

apiTest("putting an entries object silently drops undefined fields", async ({ storage }) => {
  await storage.put({ kept: 1, dropped: undefined });
  expect(await storage.get("kept")).toBe(1);
  expect(await storage.get("dropped")).toBeUndefined();
});

apiTest("setAlarm refuses a time at or before the epoch", ({ storage }) => {
  expect(() => storage.setAlarm(0)).toThrow("setAlarm() cannot be called with an alarm time <= 0");
});

apiTest("setAlarm accepts a Date", async ({ storage }) => {
  await storage.setAlarm(new Date(1234));
  expect(await storage.getAlarm()).toBe(1234);
});

test("setAlarm clamps a time in the past up to now", async () => {
  const h = await newHarness();
  h.timer.current = 1000;
  await h.run(async () => {
    await h.storage.setAlarm(50);
    expect(await h.storage.getAlarm()).toBe(1000);
  });
});

test("setAlarm asks the actor whether it may, and propagates the refusal", async () => {
  const h = await newHarness();
  h.actor.canSetAlarm = "Your Durable Object class must have an alarm() handler in order to call setAlarm()";
  await h.run(() => {
    expect(() => h.storage.setAlarm(50)).toThrow("must have an alarm() handler");
  });
  expect(await h.run(() => h.storage.getAlarm())).toBeNull();
});

// =======================================================================================
// compileListOptions — ported from actor-state.c++:314-417

apiTest("list refuses both start and startAfter", ({ storage }) => {
  expect(() => storage.list({ start: "a", startAfter: "b" })).toThrow(
    "list() cannot be called with both start and startAfter values.",
  );
});

apiTest("list refuses a non-positive limit", ({ storage }) => {
  expect(() => storage.list({ limit: 0 })).toThrow("List limit must be positive.");
});

apiTest("list start is inclusive and end is exclusive", async ({ storage }) => {
  await storage.put({ a: 1, b: 2, c: 3, d: 4 });
  expect([...(await storage.list({ start: "b", end: "d" })).keys()]).toEqual(["b", "c"]);
});

apiTest("list startAfter is exclusive", async ({ storage }) => {
  await storage.put({ a: 1, b: 2, c: 3 });
  expect([...(await storage.list({ startAfter: "a" })).keys()]).toEqual(["b", "c"]);
});

apiTest("list with an end at or before the start is empty", async ({ storage }) => {
  await storage.put({ a: 1, b: 2 });
  expect((await storage.list({ start: "b", end: "b" })).size).toBe(0);
  expect((await storage.list({ start: "b", end: "a" })).size).toBe(0);
});

apiTest("list clamps to a prefix", async ({ storage }) => {
  await storage.put({ "a:1": 1, "a:2": 2, "b:1": 3 });
  expect([...(await storage.list({ prefix: "a:" })).keys()]).toEqual(["a:1", "a:2"]);
});

apiTest("a prefix and a start outside it list nothing", async ({ storage }) => {
  await storage.put({ "a:1": 1, "b:1": 2 });
  expect((await storage.list({ prefix: "a:", start: "b" })).size).toBe(0);
});

apiTest("a prefix moves a start that falls before it", async ({ storage }) => {
  await storage.put({ "a:1": 1, "b:1": 2 });
  expect([...(await storage.list({ prefix: "b:", start: "a" })).keys()]).toEqual(["b:1"]);
});

apiTest("a prefix and an end at or before it list nothing", async ({ storage }) => {
  await storage.put({ "b:1": 1 });
  expect((await storage.list({ prefix: "b:", end: "b" })).size).toBe(0);
});

apiTest("list honours reverse and limit", async ({ storage }) => {
  await storage.put({ a: 1, b: 2, c: 3 });
  expect([...(await storage.list({ reverse: true, limit: 2 })).keys()]).toEqual(["c", "b"]);
});

// =======================================================================================
// DurableObjectTransaction

apiTest("a transaction commits what its callback wrote", async ({ storage }) => {
  await storage.transaction(async (txn) => {
    await txn.put("a", 1);
  });
  expect(await storage.get("a")).toBe(1);
});

apiTest("a throwing transaction callback rolls back and rethrows", async ({ storage }) => {
  await storage.put("a", "before");
  await expect(
    storage.transaction(async (txn) => {
      await txn.put("a", "after");
      throw new Error("a_transaction_failure");
    }),
  ).rejects.toThrow("a_transaction_failure");
  expect(await storage.get("a")).toBe("before");
});

apiTest("txn.rollback discards the transaction's writes", async ({ storage }) => {
  await storage.put("a", "before");
  await storage.transaction(async (txn) => {
    await txn.put("a", "after");
    txn.rollback();
  });
  expect(await storage.get("a")).toBe("before");
});

apiTest("txn.rollback may be called more than once", async ({ storage }) => {
  await storage.transaction(async (txn) => {
    txn.rollback();
    txn.rollback();
  });
});

apiTest("deleteAll inside a transaction is refused", async ({ storage }) => {
  await storage.transaction(async (txn) => {
    expect(() => txn.deleteAll()).toThrow("Cannot call deleteAll() within a transaction");
  });
});

apiTest("storage.deleteAll inside a transaction is refused too", async ({ storage }) => {
  await expect(
    storage.transaction(async () => {
      await storage.deleteAll();
    }),
  ).rejects.toThrow("Cannot call deleteAll() within a transaction");
});

apiTest("a rolled back transaction refuses further operations", async ({ storage }) => {
  let escaped: DurableObjectTransaction | undefined;
  await storage.transaction(async (txn) => {
    txn.rollback();
    escaped = txn;
  });
  expect(() => escaped?.get("a")).toThrow("Cannot get() on rolled back transaction");
});

apiTest("a committed transaction refuses further operations", async ({ storage }) => {
  let escaped: DurableObjectTransaction | undefined;
  await storage.transaction(async (txn) => {
    escaped = txn;
  });
  expect(() => escaped?.get("a")).toThrow(
    "Cannot call get() on transaction that has already committed: " +
      "did you move `txn` outside of the closure?",
  );
});

// =======================================================================================
// The value codec — a recorded divergence, so the assertions pin it in both directions

apiTest("JSON-representable values round-trip", async ({ storage }) => {
  const value = { n: 1, s: "two", b: true, nil: null, arr: [1, 2], nested: { deep: true } };
  await storage.put("k", value);
  expect(await storage.get("k")).toEqual(value);
});

/**
 * Decision 16. Real Durable Object storage V8-serializes these and hands them back unchanged;
 * through JSON a `Date` returns as an ISO string and the rest as `{}`. Both are silent, so they
 * are refused at the write instead — the conformance suite asserts both halves out loud.
 */
apiTest("every type JSON cannot round-trip is refused, naming the key and the type", ({
  storage,
}) => {
  const cases: [label: string, value: unknown][] = [
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["ArrayBuffer", new ArrayBuffer(4)],
    ["Uint8Array", new Uint8Array([1, 2, 3])],
    ["DataView", new DataView(new ArrayBuffer(4))],
    // `RegExp` and `Error` have the same silent shape as the rest — JSON turns both into `{}`,
    // because nothing that makes them what they are is an own enumerable property.
    ["RegExp", /pattern/g],
    ["Error", new Error("boom")],
    // Reported by `name`, so the message says what to fix rather than just "Error".
    ["TypeError", new TypeError("boom")],
  ];
  for (const [label, value] of cases) {
    expect(() => storage.put("k", value), label).toThrow(
      `Durable Object storage cannot round-trip a ${label}: key = k, at <value>.`,
    );
  }
});

apiTest("the shape that makes RegExp and Error worth refusing", ({ storage }) => {
  // Both survive real Durable Object storage; through JSON they are indistinguishable from `{}`,
  // so a read returns a plausible-looking empty object rather than failing.
  expect(JSON.stringify({ re: /x/, err: new Error("boom") })).toBe('{"re":{},"err":{}}');
  expect(() => storage.put("k", { retry: { cause: new Error("boom") } })).toThrow(
    "Durable Object storage cannot round-trip a Error: key = k, at <value>.retry.cause.",
  );
});

apiTest("a nested unsupported value is refused, naming its path", ({ storage }) => {
  expect(() => storage.put("config", { retry: { after: new Date(0) } })).toThrow(
    "Durable Object storage cannot round-trip a Date: key = config, at <value>.retry.after.",
  );
  expect(() => storage.put("list", [{ when: new Date(0) }])).toThrow(
    "Durable Object storage cannot round-trip a Date: key = list, at <value>[0].when.",
  );
});

apiTest("an entries-object put names the offending entry's own key", ({ storage }) => {
  expect(() => storage.put({ fine: 1, broken: new Date(0) })).toThrow(
    "Durable Object storage cannot round-trip a Date: key = broken, at <value>.",
  );
});

apiTest("kv.put refuses them through the same codec", ({ storage }) => {
  expect(() => storage.kv.put("k", { at: new Date(0) })).toThrow(
    "Durable Object storage cannot round-trip a Date: key = k, at <value>.at.",
  );
});

apiTest("nothing is written when a value is refused", async ({ storage }) => {
  expect(() => storage.put("k", new Date(0))).toThrow();
  expect(await storage.get("k")).toBeUndefined();
});

apiTest("a value JSON cannot represent is refused rather than stored wrong", ({ storage }) => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => storage.put("k", cyclic)).toThrow();
});

/**
 * Synchronously, not as a rejection: §1.4 makes the SQLite path take
 * `transformCacheResult`'s value arm, so the decoder runs inside `get()` before its promise
 * exists — which is also where upstream's `KJ_FAIL_ASSERT` lands.
 */
apiTest("a stored value that will not decode names the key", async ({ storage, db }) => {
  await storage.put("k", 1);
  db.run("UPDATE _cf_KV SET value = ? WHERE key = ?", new Uint8Array([0x7b, 0x7b]), "k");
  expect(() => storage.get("k")).toThrow(/actor storage deserialization failed.*key = k/s);
});

apiTest("a stored value of zero bytes is refused", async ({ storage, db }) => {
  await storage.put("k", 1);
  db.run("UPDATE _cf_KV SET value = ? WHERE key = ?", new Uint8Array(0), "k");
  expect(() => storage.get("k")).toThrow("unexpectedly empty value buffer");
});

// =======================================================================================
// Bookmarks and replication

apiTest("getCurrentBookmark returns the local-development counter", async ({ storage }) => {
  const first = await storage.getCurrentBookmark();
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-0{32}$/);
  expect(await storage.getCurrentBookmark() > first).toBe(true);
});

apiTest("waitForBookmark resolves", async ({ storage }) => {
  await storage.waitForBookmark("00000000-00000000-00000000-" + "0".repeat(32));
});

apiTest("getBookmarkForTime is a named substrate boundary", async ({ storage }) => {
  await expect(storage.getBookmarkForTime(0)).rejects.toThrow(PITR_UNIMPLEMENTED_MESSAGE);
});

apiTest("onNextSessionRestoreBookmark is a named substrate boundary", async ({ storage }) => {
  await expect(storage.onNextSessionRestoreBookmark("x")).rejects.toThrow(
    PITR_UNIMPLEMENTED_MESSAGE,
  );
});

apiTest("replication is a named substrate boundary", async ({ storage, state }) => {
  expect(() => storage.ensureReplicas()).toThrow(REPLICATION_UNIMPLEMENTED_MESSAGE);
  expect(() => storage.disableReplicas()).toThrow(REPLICATION_UNIMPLEMENTED_MESSAGE);
  await expect(state.configureReadReplication({ mode: "auto" })).rejects.toThrow(
    REPLICATION_UNIMPLEMENTED_MESSAGE,
  );
});

apiTest("this object is never a replica", ({ storage }) => {
  expect(storage.isReplica()).toBe(false);
  expect(storage.getPrimary()).toBeUndefined();
});

// =======================================================================================
// DurableObjectFacets — decision 14

apiTest("facets.get forwards to the manager and returns its stub", ({ state, facets }) => {
  const stub = state.facets.get("child", () => ({ class: testClass() }));
  expect(facets.calls).toEqual([{ kind: "get", name: "child" }]);
  expect(stub).toBeDefined();
});

apiTest("facets.abort forwards the name and the reason", ({ state, facets }) => {
  state.facets.abort("child", "because");
  expect(facets.calls).toEqual([{ kind: "abort", name: "child", reason: "because" }]);
});

apiTest("facets.delete forwards the name", ({ state, facets }) => {
  state.facets.delete("child");
  expect(facets.calls).toEqual([{ kind: "delete", name: "child" }]);
});

apiTest("facets.clone forwards both names", ({ state, facets }) => {
  state.facets.clone("src", "dst");
  expect(facets.calls).toEqual([{ kind: "clone", src: "src", dst: "dst" }]);
});

apiTest("a facet name of exactly the maximum length is allowed", ({ state, facets }) => {
  const name = "n".repeat(FACET_NAME_MAX_LENGTH);
  state.facets.delete(name);
  expect(facets.calls).toEqual([{ kind: "delete", name }]);
});

apiTest("every facet method refuses a name one character too long", ({ state, facets }) => {
  const name = "n".repeat(FACET_NAME_MAX_LENGTH + 1);
  const message = `Facet name is too long (max ${FACET_NAME_MAX_LENGTH} characters).`;
  expect(() => state.facets.get(name, () => ({ class: testClass() }))).toThrow(message);
  expect(() => state.facets.abort(name, "x")).toThrow(message);
  expect(() => state.facets.delete(name)).toThrow(message);
  expect(() => state.facets.clone(name, "dst")).toThrow(message);
  expect(() => state.facets.clone("src", name)).toThrow(message);
  expect(facets.calls).toEqual([]);
});

apiTest("a facet name is measured in UTF-8 bytes, as kj::StringPtr::size() is", ({ state }) => {
  // ← `requireValidFacetName` (`actor-state.c++:949-951`) compares `name.size()`, which on a
  // `kj::StringPtr` is bytes. 86 code units, 258 bytes: inside the UTF-16 limit, outside the
  // byte limit, so upstream refuses a name this host used to accept.
  const wide = "中".repeat(86);
  expect(wide.length).toBeLessThanOrEqual(FACET_NAME_MAX_LENGTH);
  expect(() => state.facets.delete(wide)).toThrow(
    `Facet name is too long (max ${FACET_NAME_MAX_LENGTH} characters).`,
  );
});

apiTest("a non-ASCII facet name of exactly the maximum byte length is allowed", ({
  state,
  facets,
}) => {
  // 85 × 3 bytes + one ASCII byte = 256.
  const name = `${"中".repeat(85)}a`;
  state.facets.delete(name);
  expect(facets.calls).toEqual([{ kind: "delete", name }]);
});

apiTest("a facet one level below the deepest allowed parent still starts", ({ state, facets }) => {
  facets.depth = FACET_TREE_MAX_DEPTH - 2;
  state.facets.get("child", () => ({ class: testClass() }));
  expect(facets.calls).toEqual([{ kind: "get", name: "child" }]);
});

apiTest("a facet below the deepest allowed parent is refused", ({ state, facets }) => {
  facets.depth = FACET_TREE_MAX_DEPTH - 1;
  expect(() => state.facets.get("child", () => ({ class: testClass() }))).toThrow(
    "Facet nesting depth limit exceeded. The maximum depth including the root Durable Object is " +
      `${FACET_TREE_MAX_DEPTH}.`,
  );
  expect(facets.calls).toEqual([]);
});

test("an actor with no facet manager says so", async () => {
  const h = await newHarness();
  const state = new DurableObjectState(h.ctx, {
    id: new TestId("no-facets"),
    exports: {},
    props: undefined,
    storage: h.storage,
    globals: actorScopeBindings(() => h.globals),
  });
  await h.run(() => {
    expect(() => state.facets.get("child", () => ({ class: testClass() }))).toThrow(
      "This Durable Object does not support creating facets.",
    );
  });
});

// NO upstream test file: `ctx.globals` has no upstream referent, because a
// `ServiceWorkerGlobalScope` IS the isolate's global object there. Here it is
// the reference an actor's class holds instead of reading a global one realm
// cannot bind to a single actor.
test("ctx.globals is this actor's own gated scope and refuses another actor's slice", async () => {
  const mine = await newHarness();
  const theirs = await newHarness();

  // Arming from inside my own slice goes through my gate.
  const armed = await mine.run(() => mine.state.globals.setTimeout(() => {}, 5));
  expect(typeof armed).toBe("number");

  // The same object, reached while a DIFFERENT actor's body is on the stack, is
  // the mistake `installActorScope` could not detect on a shared global. Here
  // the reference names its actor, so the tripwire fires.
  await theirs.run(() => {
    expect(() => mine.state.globals.setTimeout(() => {}, 5)).toThrow(FOREIGN_SLICE_MESSAGE);
  });

  mine.state.globals.clearTimeout(armed);
});

test("the startup callback resolves the class to its channel and defaults the id to the parent's", async () => {
  const h = await newHarness();
  const channel: ActorClassChannel = { className: "Child", requireAllowsTransfer: () => {} };
  await h.run(() => {
    h.state.facets.get("child", () => ({ class: new DurableObjectClass(channel) }));
  });

  const getStartInfo = h.facets.lastStartInfo;
  if (getStartInfo === undefined) throw new Error("the manager was not given a startup callback");
  expect(await getStartInfo()).toEqual({ actorClass: channel, id: "test-actor" });
});

test("the startup callback refuses a class this runtime did not mint", async () => {
  const h = await newHarness();
  await h.run(() => {
    h.state.facets.get("child", () => ({ class: {} }));
  });
  const getStartInfo = h.facets.lastStartInfo;
  if (getStartInfo === undefined) throw new Error("the manager was not given a startup callback");
  await expect(getStartInfo()).rejects.toThrow(FACET_CLASS_UNSUPPORTED_MESSAGE);
});

// ← the three arms of `DurableObjectFacets::get`'s class switch (`actor-state.c++:1029-1043`).
// The `ctx.exports` entry the vendored consumer hands back (`agents/src/index.ts:10857`) is the
// callable form of one of the latter two, so each arm is asserted through the façade as well as
// through the bare object.

function loopbackClass(): LoopbackDurableObjectClass {
  return new LoopbackDurableObjectClass({
    getActorClass: () => ({ className: "Child", requireAllowsTransfer: () => {} }),
  });
}

async function startInfoFor(actorClass: object): Promise<FacetStartInfo> {
  const h = await newHarness();
  await h.run(() => {
    h.state.facets.get("child", () => ({ class: actorClass }));
  });
  const getStartInfo = h.facets.lastStartInfo;
  if (getStartInfo === undefined) throw new Error("the manager was not given a startup callback");
  return await getStartInfo();
}

test("a LoopbackDurableObjectClass takes the bare arm, as JSG's OneOf order does", async () => {
  const cls = loopbackClass();
  expect((await startInfoFor(cls)).actorClass).toBe(cls.getChannel());
  expect((await startInfoFor(asLoopbackDurableObjectClass(cls))).actorClass).toBe(cls.getChannel());
});

test("a LoopbackDurableObjectNamespace is unwrapped through getClass()", async () => {
  const cls = loopbackClass();
  const ns = new LoopbackDurableObjectNamespace(
    { getGlobalActor: () => stubFetcher() },
    fakeIdFactory(),
    cls,
  );
  expect((await startInfoFor(ns)).actorClass).toBe(cls.getChannel());
  expect((await startInfoFor(asLoopbackDurableObjectNamespace(ns))).actorClass).toBe(
    cls.getChannel(),
  );
});

test("a LoopbackColoLocalActorNamespace is unwrapped through getClass()", async () => {
  const cls = loopbackClass();
  const ns = new LoopbackColoLocalActorNamespace({ getColoLocalActor: () => stubFetcher() }, cls);
  expect((await startInfoFor(ns)).actorClass).toBe(cls.getChannel());
  expect((await startInfoFor(asLoopbackColoLocalActorNamespace(ns))).actorClass).toBe(
    cls.getChannel(),
  );
});

test("a plain DurableObjectNamespace is still refused — only the loopback form carries a class", async () => {
  const ns = new DurableObjectNamespace({ getGlobalActor: () => stubFetcher() }, fakeIdFactory());
  await expect(startInfoFor(ns)).rejects.toThrow(FACET_CLASS_UNSUPPORTED_MESSAGE);
});

test("the startup callback honours an explicit id", async () => {
  const h = await newHarness();
  await h.run(() => {
    h.state.facets.get("child", () => ({ class: testClass(), id: new TestId("routed") }));
  });
  expect((await h.facets.lastStartInfo?.())?.id).toBe("routed");
});

test("the startup callback runs inside the critical section it was created in", async () => {
  // ← `makeReentryCallback` (`actor-state.c++:1011`): without it a facet started from inside
  // blockConcurrencyWhile() cannot start at all, because its callback queues behind the section.
  const h = await newHarness();
  let ran = false;
  await h.run(async () => {
    await h.ctx.blockConcurrencyWhile(async () => {
      h.state.facets.get("child", () => ({ class: testClass() }));
      const getStartInfo = h.facets.lastStartInfo;
      if (getStartInfo === undefined) throw new Error("no startup callback");
      await getStartInfo();
      ran = true;
    });
  });
  expect(ran).toBe(true);
});

// =======================================================================================
// blockConcurrencyWhile — decision 4, a one-line forward

apiTest("blockConcurrencyWhile returns the callback's value", async ({ state }) => {
  expect(await state.blockConcurrencyWhile(() => Promise.resolve("value"))).toBe("value");
});

test("blockConcurrencyWhile blocks a concurrent event", async () => {
  const h = await newHarness();
  let sectionEnded = false;
  let outsiderRanEarly = false;
  let outsider: Promise<void> | undefined;

  await h.run(async () => {
    await h.state.blockConcurrencyWhile(async () => {
      outsider = h.ctx.run(() => {
        if (!sectionEnded) outsiderRanEarly = true;
      });
      await h.ctx.awaitIo(Promise.resolve(undefined));
      sectionEnded = true;
    });
  });

  await outsider;
  expect(outsiderRanEarly).toBe(false);
});

test("blockConcurrencyWhile keeps storage available after held awaits and an immediate helper", async () => {
  const h = await newHarness();
  await h.run(() =>
    h.state.blockConcurrencyWhile(async () => {
      await h.storage.get("first");
      await h.storage.get("second");
      await (async () => undefined)();
      expect(h.storage.sql.exec("SELECT 1 AS value").one()).toEqual({ value: 1 });
    }),
  );
});

test("blockConcurrencyWhile outside a gated slice throws", async () => {
  const h = await newHarness();
  expect(() => h.state.blockConcurrencyWhile(() => Promise.resolve(1))).toThrow(
    "no input lock available in this context",
  );
});

// =======================================================================================
// Hibernatable WebSockets — the substrate boundary, asserted rather than skipped

apiTest("every hibernatable WebSocket method throws the named message", ({ state }) => {
  const socket = {} as WebSocket;
  expect(() => state.acceptWebSocket(socket)).toThrow(HIBERNATION_UNIMPLEMENTED_MESSAGE);
  expect(() => state.getWebSockets()).toThrow(HIBERNATION_UNIMPLEMENTED_MESSAGE);
  expect(() => state.setWebSocketAutoResponse()).toThrow(HIBERNATION_UNIMPLEMENTED_MESSAGE);
  expect(() => state.getWebSocketAutoResponse()).toThrow(HIBERNATION_UNIMPLEMENTED_MESSAGE);
  expect(() => state.getWebSocketAutoResponseTimestamp(socket)).toThrow(
    HIBERNATION_UNIMPLEMENTED_MESSAGE,
  );
  expect(() => state.setHibernatableWebSocketEventTimeout(1)).toThrow(
    HIBERNATION_UNIMPLEMENTED_MESSAGE,
  );
  expect(() => state.getHibernatableWebSocketEventTimeout()).toThrow(
    HIBERNATION_UNIMPLEMENTED_MESSAGE,
  );
  expect(() => state.getTags(socket)).toThrow(HIBERNATION_UNIMPLEMENTED_MESSAGE);
});

// =======================================================================================
// DurableObjectState — the rest

apiTest("state exposes id, props and exports", ({ state }) => {
  expect(state.id.toString()).toBe("test-actor");
  expect(state.props).toEqual({ hello: "world" });
  expect(Object.keys(state.exports)).toEqual(["Thing"]);
});

apiTest("waitUntil keeps the context busy until the promise settles", async ({ state, ctx }) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  state.waitUntil(promise);
  let drained = false;
  void ctx.drainWaitUntil().then(() => {
    drained = true;
  });
  await quiesce(2);
  expect(drained).toBe(false);
  resolve();
  await quiesce(2);
  expect(drained).toBe(true);
});

test("abort shuts the storage down synchronously and aborts the context", async () => {
  const h = await newHarness();
  const message =
    "broken.outputGateBroken; jsg.Error: Application called abort() to reset Durable Object.";

  await h.run(() => {
    // Synchronously, so no write can complete between the abort and the gate breaking: the
    // storage refuses inside the same slice that called abort().
    h.state.abort();
    expect(() => h.storage.get("anything")).toThrow(message);
  });

  await expect(h.ctx.onAbort()).rejects.toThrow(message);
  // `IoContext::abort` shuts the actor's cache down as well, and then refuses re-entry.
  expect(h.actor.shutdownReasons).toHaveLength(1);
  await expect(h.ctx.run(() => 1)).rejects.toThrow(message);
});

test("abort carries the caller's reason", async () => {
  const h = await newHarness();
  await h.run(() => {
    h.state.abort("because I said so");
  });
  await expect(h.ctx.onAbort()).rejects.toThrow(
    "broken.outputGateBroken; jsg.Error: because I said so",
  );
});

// =======================================================================================
// Decision 2 — the allowConcurrency branch
//
// Its one reachable site: `deleteAll`'s backpressure promise. Every other `OneOf<T, Promise<T>>`
// upstream branches on collapsed to `T` in Section 4, because §1.4 measures that a SQLite-backed
// actor never takes the promise arm. Nothing in the system passes the flag, which is why it is
// exercised here deliberately rather than incidentally.

class BackpressureCache implements StorageCache {
  released = false;
  readonly #inner: ActorSqlite;
  readonly #backpressure: Promise<void>;

  constructor(inner: ActorSqlite, backpressure: Promise<void>) {
    this.#inner = inner;
    this.#backpressure = backpressure;
  }

  deleteAll(options: WriteOptions, deleteAllOptions?: DeleteAllOptions): DeleteAllResults {
    const result = this.#inner.deleteAll(options, deleteAllOptions);
    return { backpressure: this.#backpressure, count: result.count };
  }

  // Everything else is the real engine.
  get(key: Key, options: ReadOptions): Value | undefined {
    return this.#inner.get(key, options);
  }
  getMultiple(keys: readonly Key[], options: ReadOptions): GetResultList {
    return this.#inner.getMultiple(keys, options);
  }
  getAlarm(options: ReadOptions): number | null {
    return this.#inner.getAlarm(options);
  }
  list(begin: Key, end: Key | undefined, limit: number | undefined, o: ReadOptions): GetResultList {
    return this.#inner.list(begin, end, limit, o);
  }
  listReverse(
    begin: Key,
    end: Key | undefined,
    limit: number | undefined,
    o: ReadOptions,
  ): GetResultList {
    return this.#inner.listReverse(begin, end, limit, o);
  }
  put(key: Key, value: Value, options: WriteOptions): void {
    this.#inner.put(key, value, options);
  }
  putMultiple(pairs: readonly KeyValuePair[], options: WriteOptions): void {
    this.#inner.putMultiple(pairs, options);
  }
  delete(key: Key, options: WriteOptions): boolean {
    return this.#inner.delete(key, options);
  }
  deleteMultiple(keys: readonly Key[], options: WriteOptions): number {
    return this.#inner.deleteMultiple(keys, options);
  }
  setAlarm(newAlarmTime: number | null, options: WriteOptions): void {
    this.#inner.setAlarm(newAlarmTime, options);
  }
  startTransaction(): ActorCacheTransaction {
    return this.#inner.startTransaction();
  }
  evictStale(now: number): undefined {
    return this.#inner.evictStale(now);
  }
  shutdown(exception?: unknown): void {
    this.#inner.shutdown(exception);
  }
  armAlarmHandler(scheduledTime: number, currentTime: number): ReturnType<ActorSqlite["armAlarmHandler"]> {
    return this.#inner.armAlarmHandler(scheduledTime, currentTime);
  }
  cancelDeferredAlarmDeletion(): void {
    this.#inner.cancelDeferredAlarmDeletion();
  }
  abandonAlarm(scheduledTime: number): Promise<number | null> {
    return this.#inner.abandonAlarm(scheduledTime);
  }
  onNoPendingFlush(): Promise<void> {
    return this.#inner.onNoPendingFlush();
  }
  getCurrentBookmark(): Promise<string> {
    return this.#inner.getCurrentBookmark();
  }
  getBookmarkForTime(timestamp: number): Promise<string> {
    return this.#inner.getBookmarkForTime(timestamp);
  }
  onNextSessionRestoreBookmark(bookmark: string): Promise<string> {
    return this.#inner.onNextSessionRestoreBookmark(bookmark);
  }
  waitForBookmark(bookmark: string): Promise<void> {
    return this.#inner.waitForBookmark(bookmark);
  }
  ensureReplicas(): void {
    this.#inner.ensureReplicas();
  }
  disableReplicas(): void {
    this.#inner.disableReplicas();
  }
  configureReadReplication(enabled: boolean): Promise<void> {
    return this.#inner.configureReadReplication(enabled);
  }
  getSqliteDatabase(): SqliteDatabase {
    return this.#inner.getSqliteDatabase();
  }
  getSqliteKv(): SqliteKv {
    return this.#inner.getSqliteKv();
  }
  transactionSync<T>(callback: () => T): T {
    return this.#inner.transactionSync(callback);
  }
}

/**
 * Runs `deleteAll` with a backpressure promise nobody has resolved yet and reports whether a
 * concurrent event got in while it was outstanding. Holding the gate is the default; releasing it
 * is what `allowConcurrency` buys.
 */
async function backpressureAdmitsConcurrentEvent(allowConcurrency: boolean): Promise<boolean> {
  const backpressure = Promise.withResolvers<void>();
  let cache: BackpressureCache | undefined;
  const h = await newHarness((inner) => {
    cache = new BackpressureCache(inner, backpressure.promise);
    return cache;
  });

  let admitted = false;
  let pending: Promise<void> | undefined;
  let outsider: Promise<void> | undefined;

  await h.ctx.run(() => {
    pending = h.storage.deleteAll({ allowConcurrency });
    outsider = h.ctx.run(() => {
      admitted = true;
    });
  });
  await quiesce();

  const observed = admitted;
  backpressure.resolve();
  await pending;
  await outsider;
  return observed;
}

test("decision 2 the default holds the input gate across storage backpressure", async () => {
  expect(await backpressureAdmitsConcurrentEvent(false)).toBe(false);
});

test("decision 2 allowConcurrency releases the input gate across storage backpressure", async () => {
  expect(await backpressureAdmitsConcurrentEvent(true)).toBe(true);
});

// =======================================================================================
// §1.7.1 seen from the JS surface
//
// `ActorSqlite`'s own tests draw this line against `awaitIo`/`awaitIoWithInputLock` directly. What
// they cannot show is that it survives `DurableObjectStorage` — which is exactly the `async`
// wrapper §1.2's correction is about, and where a release at the first await would be invisible.

test("§1.7.1 awaiting storage between two puts keeps them in one transaction", async () => {
  const h = await newHarness();
  await h.run(async () => {
    await h.storage.put("p1", 1);
    await h.storage.get("p1");
    await h.storage.put("p2", 2);
  });
  expect(h.commits, "the two puts should be one transaction").toBe(1);
});

test("§1.7.1 awaiting a timer between two puts makes them two transactions", async () => {
  const h = await newHarness();
  await h.run(async () => {
    await h.storage.put("t1", 1);
    await h.ctx.awaitIo(Promise.resolve(undefined));
    await h.storage.put("t2", 2);
  });
  expect(h.commits, "the two puts should be two transactions").toBe(2);
});

test("§1.7.1 a put and a setAlarm across a storage await are one transaction", async () => {
  const h = await newHarness();
  await h.run(async () => {
    await h.storage.put("row", 1);
    await h.storage.get("row");
    await h.storage.setAlarm(50);
  });
  expect(h.commits).toBe(1);
  expect(await h.run(() => h.storage.getAlarm())).toBe(50);
});

// =======================================================================================
// The enforcement point

test("a storage read outside a gated slice throws rather than serving the value", async () => {
  const h = await newHarness();
  await h.run(() => h.storage.put("k", 1));
  expect(() => h.storage.get("k")).toThrow("no input lock available in this context");
});

test("every storage entry point refuses an empty invocation stack", async () => {
  const { storage } = await newHarness();
  const message = "no input lock available in this context";
  expect(() => storage.get("k")).toThrow(message);
  expect(() => storage.list()).toThrow(message);
  expect(() => storage.put("k", 1)).toThrow(message);
  expect(() => storage.delete("k")).toThrow(message);
  expect(() => storage.deleteAll()).toThrow(message);
  expect(() => storage.getAlarm()).toThrow(message);
  expect(() => storage.setAlarm(1)).toThrow(message);
  expect(() => storage.deleteAlarm()).toThrow(message);
  expect(() => storage.sync()).toThrow(message);
  expect(() => storage.transactionSync(() => 1)).toThrow(message);
  expect(() => storage.transaction(() => Promise.resolve(1))).toThrow(message);
  expect(() => storage.getCurrentBookmark()).toThrow(message);
  expect(() => storage.waitForBookmark("x")).toThrow(message);
  expect(() => storage.kv.get("k")).toThrow(message);
});

// =======================================================================================
// transactionSync — a one-line forward, like blockConcurrencyWhile

apiTest("transactionSync commits on return", async ({ storage }) => {
  expect(
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE things (id INTEGER)");
      return "kept";
    }),
  ).toBe("kept");
  expect(storage.sql.exec("SELECT count(*) AS n FROM things").one()).toEqual({ n: 0 });
});

apiTest("transactionSync rolls back on throw", ({ storage }) => {
  storage.sql.exec("CREATE TABLE things (id INTEGER)");
  expect(() =>
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO things VALUES (1)");
      throw new Error("a_transaction_failure");
    }),
  ).toThrow("a_transaction_failure");
  expect(storage.sql.exec("SELECT count(*) AS n FROM things").one()).toEqual({ n: 0 });
});

// =======================================================================================
// storage.kv — SyncKvStorage

apiTest("kv put/get/delete round-trip", ({ storage }) => {
  storage.kv.put("k", { a: 1 });
  expect(storage.kv.get("k")).toEqual({ a: 1 });
  expect(storage.kv.delete("k")).toBe(true);
  expect(storage.kv.get("k")).toBeUndefined();
  expect(storage.kv.delete("k")).toBe(false);
});

apiTest("kv list yields entries in key order", ({ storage }) => {
  storage.kv.put("b", 2);
  storage.kv.put("a", 1);
  expect([...storage.kv.list()]).toEqual([
    ["a", 1],
    ["b", 2],
  ]);
});

apiTest("kv list shares the async list's option compilation", ({ storage }) => {
  storage.kv.put("a:1", 1);
  storage.kv.put("a:2", 2);
  storage.kv.put("b:1", 3);
  expect([...storage.kv.list({ prefix: "a:", reverse: true })].map(([key]) => key)).toEqual([
    "a:2",
    "a:1",
  ]);
});

apiTest("kv list of an empty key range yields nothing", ({ storage }) => {
  storage.kv.put("a", 1);
  expect([...storage.kv.list({ start: "b", end: "a" })]).toEqual([]);
});

/**
 * A provably-empty range never reaches the database, which is the whole point of
 * `compileListOptions` returning nothing rather than a range: upstream builds its iterator over a
 * null query. `start === end` is the boundary — the SQL `key >= ? AND key < ?` would return no
 * rows either way, so the only observable difference is that a range which reached `SqliteKv`
 * would cancel the live cursor beside it.
 */
apiTest("an empty key range does not invalidate a live kv list iterator", ({ storage }) => {
  storage.kv.put("a", 1);
  storage.kv.put("b", 2);
  const live = storage.kv.list()[Symbol.iterator]();
  expect(live.next().value).toEqual(["a", 1]);

  expect([...storage.kv.list({ start: "b", end: "b" })]).toEqual([]);

  expect(live.next().value).toEqual(["b", 2]);
});

apiTest("a kv list iterator invalidated by a second list says so", ({ storage }) => {
  storage.kv.put("a", 1);
  storage.kv.put("b", 2);
  const first = storage.kv.list()[Symbol.iterator]();
  first.next();
  storage.kv.list();
  expect(() => first.next()).toThrow(
    "kv.list() iterator was invalidated because a new call to kv.list() was started. " +
      "Only one kv.list() iterator can exist at a time.",
  );
});

apiTest("the kv codec is the same one the async surface uses", async ({ storage }) => {
  await storage.put("k", { shared: true });
  expect(storage.kv.get("k")).toEqual({ shared: true });
  storage.kv.put("j", { also: true });
  expect(await storage.get("j")).toEqual({ also: true });
});
