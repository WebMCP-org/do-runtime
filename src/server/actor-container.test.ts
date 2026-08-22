/**
 * ← workerd `NO upstream test file` — `server.c++` has none.
 *
 * The unit lane's rule is that a module without an upstream test file takes its
 * coverage from conformance, and most of this one does: every observable facet
 * and gate behaviour is asserted against real workerd in `conformance/suite/`.
 * What is here is what conformance cannot reach — the limits, the tear-down
 * bookkeeping, `deleteAll()`'s cascade, and `clone()`, which has no oracle at
 * all because it has no upstream body.
 */

import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { DurableObjectClass } from "../api/actor";
import { FACET_TREE_MAX_DEPTH } from "../api/actor-state";
import type { AlarmInvocationInfo } from "../api/global-scope";
import type { Timer } from "../io/io-context";
import type { SqlDatabase, SqlDatabaseProvider } from "../util/sqlite";
import { FacetDeletionReceiptStore } from "./facet-deletion";
import type { ActorClassChannel } from "../io/io-channels";
import type { IsolateChannelFactory } from "../api/worker-loader";
import { FacetTreeIndex } from "./facet-tree-index";
import type {
  ActorContainer,
  ActorContainerOptions,
  ActorEntry,
  FacetHandle,
  FacetHost,
  FacetId,
  FacetStartRequest,
  FacetTree,
} from "./actor-container";
import {
  createActorContainer,
  FACET_ALARM_UNIMPLEMENTED_MESSAGE,
  newDatabaseIndexFile,
} from "./actor-container";

const UNIQUE_KEY = "actor-container-test";

/** Placement order is the host's business, so every assertion on a set of ids sorts first. */
const ascending = (a: number, b: number): number => a - b;

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle));
    }),
};

/** Records everything the container asks of the placement substrate. */
class RecordingFacetHost implements FacetHost {
  readonly started: FacetStartRequest[] = [];
  readonly invoked: FacetId[] = [];
  readonly aborted: { id: FacetId; reason?: string }[] = [];
  readonly deleted: { id: FacetId; subtree: readonly FacetId[] }[] = [];
  readonly copied: { src: FacetId; dst: FacetId }[] = [];
  readonly breaks = new Map<FacetId, (exception: unknown) => void>();
  /**
   * Names whose NEXT placement fails, which is what a host that cannot open a
   * facet's storage does. Consumed on use, so a retry after a failure places for
   * real — which is the behaviour workerd was measured to have.
   */
  readonly failNextStart = new Set<string>();
  /**
   * The facets this host is RUNNING — the ones it has finished placing and has
   * not been told to tear down.
   *
   * The honest half of the fake, and the half `aborted` cannot be. A host can
   * only tear down a placement it has finished, so an `abort` that arrives while
   * one is still in flight removes nothing: it names an id the placement map has
   * no entry for yet. `aborted` records the call either way; this records the
   * effect, which is what "a running facet nobody holds" means.
   */
  readonly running = new Set<FacetId>();
  /**
   * Every placement event in the order the host saw it: `start:id` when it is
   * asked to place, `placed:id` when that placement lands, `abort:id` when it is
   * told to tear one down.
   *
   * The arrays above record WHAT was asked; this records WHEN, which for an
   * ordering contract is the only thing that can be asserted. `start:1
   * abort:1 placed:1` and `start:1 placed:1 abort:1` agree on every other
   * recorder and disagree on the only thing that matters.
   */
  readonly trace: string[] = [];
  /** Placements held open by `deferStart`, by name. */
  readonly #deferred = new Map<string, { begun: () => void; landing: Promise<void> }>();

  /**
   * Hold `name`'s next placement open. `begun` resolves when the host is asked
   * to place it, and `land` finishes the placement.
   *
   * A host whose `stub` is already resolved when `start` returns has no
   * placement window at all, so nothing that happens inside one is expressible
   * against it — which is why every earlier tear-down test passes without
   * noticing this. Placing costs a database open and a constructor, and this is
   * that turn. Consumed on use, like `failNextStart`.
   *
   * `begun` is what makes a test on the window deterministic rather than a race
   * against a microtask count: the window is open from there until `land`.
   */
  deferStart(name: string): { begun: Promise<void>; land: () => void } {
    const started = Promise.withResolvers<void>();
    const landing = Promise.withResolvers<void>();
    this.#deferred.set(name, { begun: started.resolve, landing: landing.promise });
    return { begun: started.promise, land: landing.resolve };
  }

  start(request: FacetStartRequest): FacetHandle {
    this.started.push(request);
    this.trace.push(`start:${request.id}`);
    const { promise, reject } = Promise.withResolvers<never>();
    void promise.catch(() => {});
    this.breaks.set(request.id, reject);
    if (this.failNextStart.delete(request.name)) {
      // The handle is real and the placement is not: `start` is synchronous, so this is the only
      // shape a host that fails asynchronously can have.
      const failed = Promise.reject<object>(
        new Error("SQLITE_CANTOPEN: unable to open database file"),
      );
      return { stub: failed, broken: promise };
    }
    const placed = {
      ping: () => {
        this.invoked.push(request.id);
        return Promise.resolve(`pong:${request.id}`);
      },
    };
    const held = this.#deferred.get(request.name);
    this.#deferred.delete(request.name);
    held?.begun();
    const stub = held === undefined ? Promise.resolve(placed) : held.landing.then(() => placed);
    void stub.then(() => {
      this.trace.push(`placed:${request.id}`);
      this.running.add(request.id);
    });
    return { stub, broken: promise };
  }

  abort(id: FacetId, reason?: string): void {
    this.aborted.push(reason === undefined ? { id } : { id, reason });
    this.trace.push(`abort:${id}`);
    // No-op on an id whose placement has not landed, exactly as a real host's is.
    this.running.delete(id);
  }

  async deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void> {
    this.trace.push(`delete:${id}`);
    this.deleted.push({ id, subtree: [...subtree] });
  }

  async copyStorage(src: FacetId, dst: FacetId): Promise<void> {
    this.copied.push({ src, dst });
  }
}

const alarms = { scheduleRun: (): Promise<void> => Promise.resolve() };

function options(overrides: Partial<ActorContainerOptions> = {}): ActorContainerOptions {
  return {
    id: "actor",
    uniqueKey: UNIQUE_KEY,
    exports: {},
    env: {},
    ports: {
      sql: createNodeSqlProvider(),
      alarms,
      facets: new RecordingFacetHost(),
      timer,
    },
    ...overrides,
  };
}

/**
 * A provider that hands back the same database for a name twice, and records
 * which names were asked for. The default one mints a fresh `:memory:` database
 * per call, which is right for an isolated container and wrong for a test that
 * has to seed one before the container opens it.
 */
function sharedProvider(): { provider: SqlDatabaseProvider; opened: string[] } {
  const databases = new Map<string, Promise<SqlDatabase>>();
  const opened: string[] = [];
  const inner = createNodeSqlProvider();
  return {
    opened,
    provider: {
      open(name) {
        opened.push(name);
        let database = databases.get(name);
        if (database === undefined) {
          database = inner.open(name);
          databases.set(name, database);
        }
        return database;
      },
    },
  };
}

/** The root's tree, which a facet container must be handed to have facets of its own. */
function treeOf(container: ActorContainer): FacetTree {
  return container.facetTree;
}

/** A `ctx.exports` entry good enough for `facets.get`'s class switch. */
function actorClass(className: string): DurableObjectClass {
  const channel: ActorClassChannel = { className, requireAllowsTransfer: () => {} };
  return new DurableObjectClass(channel);
}

class Counter {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: unknown,
  ) {}

  async bump(): Promise<number> {
    const next = (((await this.ctx.storage.get<number>("n")) ?? 0) as number) + 1;
    await this.ctx.storage.put("n", next);
    return next;
  }

  facet(name: string, className = "Child"): unknown {
    return this.ctx.facets.get(name, () => ({ class: actorClass(className) }));
  }

  deleteFacet(name: string): void {
    this.ctx.facets.delete(name);
  }

  abortFacet(name: string): void {
    this.ctx.facets.abort(name, new Error("test abort"));
  }

  cloneFacet(src: string, dst: string): void {
    this.ctx.facets.clone(src, dst);
  }

  /** Both in one slice, so the tear-down lands while the placement is still in flight. */
  getThenDelete(name: string): void {
    this.facet(name);
    this.ctx.facets.delete(name);
  }

  getThenAbort(name: string): void {
    this.facet(name);
    this.ctx.facets.abort(name, new Error("test abort"));
  }

  wipe(): Promise<void> {
    return this.ctx.storage.deleteAll();
  }

  arm(at: number): Promise<void> {
    return this.ctx.storage.setAlarm(at);
  }

  armThenPing(at: number, name: string): Promise<unknown> {
    void this.ctx.storage.setAlarm(at);
    const child = this.ctx.facets.get(name, () => ({ class: actorClass("Child") })) as unknown as {
      ping(): Promise<string>;
    };
    return child.ping();
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const runs = (((await this.ctx.storage.get<number>("runs")) ?? 0) as number) + 1;
    await this.ctx.storage.put("runs", runs);
    this.alarmInfo.push(info);
  }

  /** What every `alarm()` invocation was handed, in order. */
  readonly alarmInfo: (AlarmInvocationInfo | undefined)[] = [];
}

/** No `alarm()` method, which is what `assertCanSetAlarm` refuses. */
class Alarmless {
  constructor(
    readonly ctx: DurableObjectState,
    armAt?: number,
  ) {
    // `assertCanSetAlarm`'s `Initializing` arm allows this even without a handler, which is the
    // only way an alarm can exist on a class that cannot answer it.
    if (armAt !== undefined) void ctx.storage.setAlarm(armAt);
  }

  arm(at: number): Promise<void> {
    return this.ctx.storage.setAlarm(at);
  }
}

/**
 * `facets.get` returns its stub before the startup callback has run — upstream
 * hands back an `ActorChannelImpl` over a promise for the same reason — so a
 * test that wants the placement to have happened has to call something on it.
 */
async function openFacet(stub: ActorEntry<Counter>, name: string): Promise<string> {
  const facet = (await stub.facet(name)) as { ping(): Promise<string> };
  return await facet.ping();
}

async function counterContainer(
  overrides: Partial<ActorContainerOptions> = {},
): Promise<{ container: ActorContainer; instance: Counter; stub: ActorEntry<Counter> }> {
  const container = await createActorContainer(options(overrides));
  const instance = await container.start((ctx, env) => new Counter(ctx, env));
  return { container, instance, stub: container.entry(instance) };
}

// =======================================================================================

describe("newDatabaseIndexFile", () => {
  test("refuses an incompatible present table without changing it", async () => {
    const db = await createNodeSqlProvider().open("facets");
    db.exec("CREATE TABLE _cf_FACET_INDEX (sentinel INTEGER)", []);
    const before = db.exec(
      "SELECT sql FROM sqlite_master WHERE name = '_cf_FACET_INDEX'",
      [],
    ).rawRows;

    expect(() => newDatabaseIndexFile(db)).toThrow("Incompatible @mcp-b/do-runtime storage schema");
    expect(
      db.exec("SELECT sql FROM sqlite_master WHERE name = '_cf_FACET_INDEX'", []).rawRows,
    ).toEqual(before);
  });

  test("is a kj::File as far as FacetTreeIndex can tell", async () => {
    const file = newDatabaseIndexFile(await createNodeSqlProvider().open("facets"));
    expect(file.readAllBytes()).toEqual(new Uint8Array(0));

    file.write(0, new Uint8Array([1, 2, 3]));
    expect(file.readAllBytes()).toEqual(new Uint8Array([1, 2, 3]));

    // kj's file grows on a write past the end and zero-fills the gap.
    file.write(5, new Uint8Array([9]));
    expect(file.readAllBytes()).toEqual(new Uint8Array([1, 2, 3, 0, 0, 9]));

    file.truncate(2);
    expect(file.readAllBytes()).toEqual(new Uint8Array([1, 2]));

    // Truncating upward zero-extends, which is what the corrupted-tail path never does but
    // `kj::File::truncate` is specified to.
    file.truncate(4);
    expect(file.readAllBytes()).toEqual(new Uint8Array([1, 2, 0, 0]));

    file.datasync();
    expect(file.readAllBytes()).toEqual(new Uint8Array([1, 2, 0, 0]));
  });

  test("an index over it survives being reopened", async () => {
    const db = await createNodeSqlProvider().open("facets");
    const first = new FacetTreeIndex(newDatabaseIndexFile(db));
    expect(first.getId(0, "a")).toBe(1);
    expect(first.getId(0, "b")).toBe(2);

    // The whole reason the index is not a table in the actor's own database: it has to outlive
    // the session that wrote it, and `deleteAll()` resets that one.
    const second = new FacetTreeIndex(newDatabaseIndexFile(db));
    expect(second.getId(0, "b")).toBe(2);
    expect(second.getId(0, "c")).toBe(3);
  });
});

describe("the composition", () => {
  test("entry types every method call as an asynchronous event", async () => {
    const container = await createActorContainer(options());
    const entry = container.entry({
      label: "counter",
      increment(value: number): number {
        return value + 1;
      },
    });

    expectTypeOf(entry.increment).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(entry.label).toEqualTypeOf<string>();
    expect(await entry.increment(1)).toBe(2);
  });

  test("isCurrentSlice identifies this container's synchronous body only", async () => {
    const first = await counterContainer();
    const second = await counterContainer();

    expect(first.container.isCurrentSlice()).toBe(false);
    const afterAwait = await first.container.run(async () => {
      expect(first.container.isCurrentSlice()).toBe(true);
      expect(second.container.isCurrentSlice()).toBe(false);
      await Promise.resolve();
      return first.container.isCurrentSlice();
    });
    expect(afterAwait).toBe(false);
    expect(first.container.isCurrentSlice()).toBe(false);
  });

  test("hasCurrent spans the checkpoint the slice's lock drains", async () => {
    // A checkpoint ends at the next macrotask; awaiting one is how a test
    // stands outside every drained lock.
    const checkpointEnd = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = await counterContainer();
    const second = await counterContainer();

    // No macrotask has passed since `start()`'s gated slice, so the boot lock
    // is still draining here — which is the whole claim.
    expect(first.container.hasCurrent()).toBe(true);
    await checkpointEnd();
    expect(first.container.hasCurrent()).toBe(false);

    const afterAwait = await first.container.run(async () => {
      expect(first.container.hasCurrent()).toBe(true);
      expect(second.container.hasCurrent()).toBe(false);
      await Promise.resolve();
      // The synchronous body has returned, so the slice is gone — but the lock
      // drains the whole microtask checkpoint, and this is the window where a
      // host stub still has a caller to route through `awaitIo`.
      expect(first.container.isCurrentSlice()).toBe(false);
      return first.container.hasCurrent();
    });
    expect(afterAwait).toBe(true);
    await checkpointEnd();
    expect(first.container.hasCurrent()).toBe(false);
  });

  test("a lost lock names where the gate was last engaged", async () => {
    const { container, instance } = await counterContainer();
    const foreign = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The production shape: a gated await succeeds, a foreign await then drops
    // the lock, and the next storage call throws — three layers from the cause.
    // The suffix must hand back the last gated site, and that capture's stack
    // has the actor method synchronously on it.
    const interior = container.entry({
      async loseAfterGatedAwait(): Promise<unknown> {
        await container.awaitIo(foreign());
        await foreign();
        return await instance.ctx.storage.get("k");
      },
    });
    const afterGated = await interior.loseAfterGatedAwait().then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    expect(afterGated).toContain("no input lock available in this context");
    expect(afterGated).toMatch(/the gate was last engaged by awaitIo \d+ms before this call, at:\n/);
    expect(afterGated).toContain("loseAfterGatedAwait");

    // The other shape: nothing gated ran after dispatch, so the freshest note
    // is the entry itself — the method name is the coordinate.
    const early = container.entry({
      async loseBeforeAnyStorage(): Promise<unknown> {
        await foreign();
        return await instance.ctx.storage.get("k");
      },
    });
    const beforeStorage = await early.loseBeforeAnyStorage().then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );
    expect(beforeStorage).toContain("the gate was last engaged by entry loseBeforeAnyStorage()");
  });

  test("currentExternalEntry identifies each external synchronous body only", async () => {
    const { container } = await counterContainer();
    const probe = container.entry({
      async capture() {
        const synchronous = container.globals.currentExternalEntry;
        await Promise.resolve();
        return { synchronous, afterAwait: container.globals.currentExternalEntry };
      },
    });

    expect(container.globals.currentExternalEntry).toBeUndefined();
    const first = await probe.capture();
    const second = await probe.capture();
    const run = await container.run(async () => {
      const synchronous = container.globals.currentExternalEntry;
      await Promise.resolve();
      return { synchronous, afterAwait: container.globals.currentExternalEntry };
    });

    expect(first.synchronous).toBeDefined();
    expect(second.synchronous).toBeDefined();
    expect(run.synchronous).toBeDefined();
    expect(new Set([first.synchronous, second.synchronous, run.synchronous]).size).toBe(3);
    expect(first.afterAwait).toBeUndefined();
    expect(second.afterAwait).toBeUndefined();
    expect(run.afterAwait).toBeUndefined();
    expect(container.globals.currentExternalEntry).toBeUndefined();
  });

  test("start constructs under a held input lock, so the ctor may touch storage", async () => {
    const container = await createActorContainer(options());
    const seen: unknown[] = [];
    const instance = await container.start((ctx) => {
      // `requireInputLock` would throw here if `start` did not hold one.
      seen.push(ctx.storage.get("nothing"));
      return { seen };
    });
    expect(instance.seen).toHaveLength(1);
  });

  test("entry gates each invocation and holds the reply for the output gate", async () => {
    const { stub } = await counterContainer();
    expect(await stub.bump()).toBe(1);
    expect(await stub.bump()).toBe(2);
  });

  test("ctx.id is derived from the name under the host's unique key", async () => {
    const a = await createActorContainer(options({ id: "alice" }));
    const b = await createActorContainer(options({ id: "alice" }));
    const c = await createActorContainer(options({ id: "bob" }));
    expect(a.state.id.toString()).toBe(b.state.id.toString());
    expect(a.state.id.toString()).not.toBe(c.state.id.toString());
    expect(a.state.id.name).toBe("alice");

    // The obligation the option documents: a different key is a different actor, and its storage
    // is somewhere else.
    const other = await createActorContainer(options({ id: "alice", uniqueKey: "other" }));
    expect(other.state.id.toString()).not.toBe(a.state.id.toString());
  });

  test("a root has an actor tree and reports it; the exports record is ctx.exports", async () => {
    const container = await createActorContainer(options({ exports: { Child: 1 } }));
    expect(container.facetTree).toBeDefined();
    expect(container.state.exports).toEqual({ Child: 1 });
  });
});

describe("assertCanSetAlarm", () => {
  test("refuses before the constructor has run", async () => {
    const container = await createActorContainer(options());
    await expect(
      container.run(() => container.state.storage.setAlarm(Date.now() + 1_000)),
    ).rejects.toThrow("setAlarm() invoked before Durable Object ctor");
  });

  test("allows it from inside the constructor, where the handler is not known yet", async () => {
    const container = await createActorContainer(options());
    // Upstream's `Initializing` arm: "We don't explicitly know if we have an alarm handler or
    // not, so just let it happen."
    await expect(
      container.start((ctx) => {
        void ctx.storage.setAlarm(Date.now() + 1_000);
        return {};
      }),
    ).resolves.toBeDefined();
  });

  test("refuses a class with no alarm handler", async () => {
    const container = await createActorContainer(options());
    const instance = await container.start((ctx) => new Alarmless(ctx));
    await expect(container.entry(instance).arm(Date.now() + 1_000)).rejects.toThrow(
      "must have an alarm() handler",
    );
  });

  test("rethrows the constructor's own exception once it has failed", async () => {
    const container = await createActorContainer(options());
    await expect(
      container.start(() => {
        throw new Error("ctor exploded");
      }),
    ).rejects.toThrow("ctor exploded");
    await expect(
      container.run(() => container.state.storage.setAlarm(Date.now() + 1_000)),
    ).rejects.toThrow("ctor exploded");
  });

  test("refuses on a facet, which has no alarm slot", async () => {
    const root = await createActorContainer(options());
    const facet = await createActorContainer(
      options({ facet: { depth: 1, id: 1, tree: treeOf(root) } }),
    );
    const instance = await facet.start((ctx, env) => new Counter(ctx, env));
    await expect(facet.entry(instance).arm(Date.now() + 1_000)).rejects.toThrow(
      FACET_ALARM_UNIMPLEMENTED_MESSAGE,
    );
  });
});

describe("facets", () => {
  test("holds a facet invocation behind the caller's output gate", async () => {
    const projection = Promise.withResolvers<void>();
    const scheduleRun = vi.fn(() => projection.promise);
    const host = new RecordingFacetHost();
    const { stub } = await counterContainer({
      ports: {
        sql: createNodeSqlProvider(),
        alarms: { scheduleRun },
        facets: host,
        timer,
      },
    });

    const answer = stub.armThenPing(Date.now() + 1_000, "child");
    await vi.waitFor(() => expect(scheduleRun).toHaveBeenCalledOnce());
    expect(host.invoked).toEqual([]);

    projection.resolve();
    await expect(answer).resolves.toBe("pong:1");
    expect(host.invoked).toEqual([1]);
  });

  test("starts a facet once and reuses it, carrying name, id and depth", async () => {
    const host = new RecordingFacetHost();
    const { stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    expect(await openFacet(stub, "child")).toBe("pong:1");
    expect(await openFacet(stub, "child")).toBe("pong:1");

    expect(host.started).toHaveLength(1);
    expect(host.started[0]).toMatchObject({ id: 1, name: "child", className: "Child", depth: 1 });
    // The child inherited the parent's id, so nothing was routed.
    expect(host.started[0]?.routedId).toBeUndefined();
  });

  test("refuses a facet name over the platform's byte limit", async () => {
    const { stub } = await counterContainer();
    await expect(stub.facet("x".repeat(257))).rejects.toThrow("Facet name is too long");
    // Bytes, not code units: 128 astral characters are 512 bytes.
    await expect(stub.facet("\u{1F600}".repeat(128))).rejects.toThrow("Facet name is too long");
  });

  test("refuses a facet below the tree depth ceiling", async () => {
    const root = await createActorContainer(options());
    const tree = treeOf(root);

    // Root is depth 0, so the deepest facet allowed to have children of its own is at
    // FACET_TREE_MAX_DEPTH - 2 and the one below it is refused.
    const middle = tree.getId(0, "middle");
    const deepest = tree.getId(middle, "deepest");

    const allowed = await createActorContainer(
      options({ facet: { depth: FACET_TREE_MAX_DEPTH - 2, id: middle, tree } }),
    );
    const allowedStub = allowed.entry(await allowed.start((ctx, env) => new Counter(ctx, env)));
    await expect(allowedStub.facet("ok")).resolves.toBeDefined();

    const tooDeep = await createActorContainer(
      options({ facet: { depth: FACET_TREE_MAX_DEPTH - 1, id: deepest, tree } }),
    );
    const tooDeepStub = tooDeep.entry(await tooDeep.start((ctx, env) => new Counter(ctx, env)));
    await expect(tooDeepStub.facet("nope")).rejects.toThrow("nesting depth limit exceeded");
  });

  test("abort tears the instance down and the next get starts a fresh one at the same id", async () => {
    const host = new RecordingFacetHost();
    const { stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await openFacet(stub, "child");
    await stub.abortFacet("child");
    await openFacet(stub, "child");

    expect(host.aborted).toEqual([{ id: 1, reason: "test abort" }]);
    // Same id: ids are stable, which is what makes the storage survive the abort.
    expect(host.started.map((request) => request.id)).toEqual([1, 1]);
    expect(host.deleted).toEqual([]);
  });

  test("delete aborts first, then removes the subtree deepest-first", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    // Build root -> child -> grandchild through the index, so the subtree is real.
    const tree = treeOf(container);
    await openFacet(stub, "child");
    const grandchild = tree.getId(1, "grandchild");
    tree.getId(grandchild, "great");

    await stub.deleteFacet("child");
    await container.drainWaitUntil();

    expect(host.aborted).toEqual([{ id: 1, reason: "Facet was deleted." }]);
    expect(host.deleted).toEqual([
      { id: 1, subtree: [tree.getId(grandchild, "great"), grandchild] },
    ]);
  });

  test("a deleted name recreated later gets the same id back", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await openFacet(stub, "a");
    await openFacet(stub, "b");
    await stub.deleteFacet("a");
    await container.drainWaitUntil();
    await openFacet(stub, "a");

    // Decision 14's "stable ids across delete-and-recreate".
    expect(host.started.map((request) => `${request.name}:${request.id}`)).toEqual([
      "a:1",
      "b:2",
      "a:1",
    ]);
  });

  test("a facet re-created while its deletion is in flight waits for it", async () => {
    const host = new RecordingFacetHost();
    const gate = Promise.withResolvers<void>();
    host.deleteStorage = () => gate.promise;

    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });
    await openFacet(stub, "child");
    await stub.deleteFacet("child");

    const recreated = openFacet(stub, "child");
    // A macrotask, not a microtask: the startup callback is a reentry callback and takes several
    // turns of its own, so a shorter wait would pass whether or not the deletion was waited for.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The second placement must not open the database the first one's files are still being
    // removed from.
    expect(host.started).toHaveLength(1);

    gate.resolve();
    await recreated;
    await container.drainWaitUntil();
    expect(host.started).toHaveLength(2);
  });

  test("clone aborts dst, deletes its subtree, then copies src's subtree onto it", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    const tree = treeOf(container);
    await openFacet(stub, "src");
    await openFacet(stub, "dst");
    const srcId = tree.getId(0, "src");
    const dstId = tree.getId(0, "dst");
    const srcChild = tree.getId(srcId, "inner");

    await stub.cloneFacet("src", "dst");
    await container.drainWaitUntil();

    expect(host.aborted).toEqual([{ id: dstId, reason: "Facet was deleted." }]);
    expect(host.deleted).toEqual([{ id: dstId, subtree: [] }]);
    // The whole source subtree, with dst's matching child minted as it went.
    expect(host.copied).toEqual([
      { src: srcId, dst: dstId },
      { src: srcChild, dst: tree.getId(dstId, "inner") },
    ]);
  });

  test("clone refuses a facet onto itself", async () => {
    const { stub } = await counterContainer();
    await expect(stub.cloneFacet("same", "same")).rejects.toThrow(
      "cannot clone a facet onto itself",
    );
  });

  test("a facet deleted while its placement is in flight is never placed", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await stub.getThenDelete("child");
    await container.drainWaitUntil();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The reference epoch is what carries the tear-down across the startup callback's own awaits.
    // Without it the facet is placed after its storage has already been removed, and nothing is
    // left to remove it again.
    expect(host.started).toEqual([]);
    expect(host.deleted).toEqual([{ id: 1, subtree: [] }]);
  });

  test("delete records immediately but waits for an accepted placement to land and abort", async () => {
    const host = new RecordingFacetHost();
    const placement = host.deferStart("child");
    const { provider } = sharedProvider();
    const { container, stub } = await counterContainer({
      ports: { sql: provider, alarms, facets: host, timer },
    });

    const opening = openFacet(stub, "child");
    await placement.begun;
    await stub.deleteFacet("child");

    const receipts = new FacetDeletionReceiptStore(await provider.open("facets"));
    expect(receipts.read(1)).toEqual({ id: 1, generation: 1 });
    expect(host.trace).toEqual(["start:1"]);
    expect(host.deleted).toEqual([]);

    placement.land();
    await opening;
    await container.drainWaitUntil();

    expect(host.trace).toEqual(["start:1", "placed:1", "abort:1", "delete:1"]);
    expect(receipts.read(1)).toBeUndefined();
    expect([...host.running]).toEqual([]);
  });

  test("parent deletion waits for an accepted placement owned by a descendant manager", async () => {
    const host = new RecordingFacetHost();
    const { provider } = sharedProvider();
    const { container, stub } = await counterContainer({
      ports: { sql: provider, alarms, facets: host, timer },
    });
    await openFacet(stub, "parent");

    const tree = treeOf(container);
    const parentId = tree.getId(0, "parent");
    const parent = await createActorContainer(
      options({
        facet: { depth: 1, id: parentId, tree },
        ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
      }),
    );
    const parentStub = parent.entry(await parent.start((ctx, env) => new Counter(ctx, env)));
    const placement = host.deferStart("grandchild");
    const opening = openFacet(parentStub, "grandchild");
    await placement.begun;

    await stub.deleteFacet("parent");

    const receipts = new FacetDeletionReceiptStore(await provider.open("facets"));
    expect(receipts.read(parentId)).toEqual({ id: parentId, generation: 1 });
    expect(host.deleted).toEqual([]);

    placement.land();
    await opening;
    await container.drainWaitUntil();

    expect(host.deleted).toEqual([{ id: parentId, subtree: [tree.getId(parentId, "grandchild")] }]);
    expect(receipts.read(parentId)).toBeUndefined();
  });

  test("a facet aborted while its placement is in flight is aborted on arrival", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await stub.getThenAbort("child");
    await container.drainWaitUntil();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Abort leaves the storage alone, so unlike delete the placement still happens — and then
    // has to be torn down, or the actor keeps a facet nobody asked for.
    expect(host.started).toHaveLength(1);
    expect(host.aborted).toEqual([{ id: 1, reason: "test abort" }]);
  });

  test("a facet aborted while its placement is in flight is aborted after it lands", async () => {
    const host = new RecordingFacetHost();
    const placement = host.deferStart("child");
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await stub.getThenAbort("child");
    await placement.begun;
    await new Promise((resolve) => setTimeout(resolve, 5));

    // `start` returning is not the placement landing, so an abort delivered the moment
    // the handle exists names an id the host's placement map has no entry for — it removes nothing,
    // and the placement then completes behind it. Upstream gets the ordering for free:
    // `getFacetContainer` registers the container before its `kj::Promise<ClassAndId>` resolves
    // (`server.c++:2603-2620`), so `ActorContainer::abort` (`:2565-2589`) always has the object it
    // is aborting.
    expect(host.trace).toEqual(["start:1"]);

    placement.land();
    await container.drainWaitUntil();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(host.trace).toEqual(["start:1", "placed:1", "abort:1"]);
    expect(host.aborted).toEqual([{ id: 1, reason: "test abort" }]);
    // The consequence, and the whole reason the ordering matters: nothing is left running.
    expect([...host.running]).toEqual([]);
  });

  test("a placement that follows an abort is not torn down by it", async () => {
    const host = new RecordingFacetHost();
    const placement = host.deferStart("child");
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await stub.getThenAbort("child");
    await placement.begun;
    // The name is free again the moment the abort is recorded, and ids are stable across an abort,
    // so this second placement carries the SAME id the pending abort names.
    const reopened = openFacet(stub, "child");
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Ordering the abort against its own entry is not enough: it has to be ordered against the ID,
    // or an abort waiting on a placement that has not landed arrives after the NEXT placement has
    // and tears that one down instead. So the second placement may not BEGIN here — everything on
    // one id is one queue. Upstream never faces the question because its abort is effective the
    // moment it runs, so there is never a second container for a late one to arrive behind.
    expect(host.trace).toEqual(["start:1"]);

    placement.land();
    expect(await reopened).toBe("pong:1");
    await container.drainWaitUntil();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(host.trace).toEqual(["start:1", "placed:1", "abort:1", "start:1", "placed:1"]);
    expect([...host.running]).toEqual([1]);
  });

  test("a facet's ids are minted under its own id, not the root's", async () => {
    const root = await createActorContainer(options());
    const tree = treeOf(root);
    const parentId = tree.getId(0, "parent");

    const host = new RecordingFacetHost();
    const facet = await createActorContainer(
      options({
        facet: { depth: 1, id: parentId, tree },
        ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
      }),
    );
    const stub = facet.entry(await facet.start((ctx, env) => new Counter(ctx, env)));
    await openFacet(stub, "child");

    // Upstream's ids are sequential across the whole tree and name storage files in one flat
    // namespace, so the same name under two parents must not collide.
    expect(host.started[0]?.id).toBe(tree.getId(parentId, "child"));
    expect(tree.getId(parentId, "child")).not.toBe(tree.getId(0, "child"));
  });

  test("a facet container opens only its own database", async () => {
    const root = await createActorContainer(options());
    const { provider, opened } = sharedProvider();
    await createActorContainer(
      options({ ports: { sql: provider, alarms, facets: new RecordingFacetHost(), timer } }),
    );
    expect(opened).toEqual(["root", "facets"]);

    const facetOpened = sharedProvider();
    await createActorContainer(
      options({
        facet: { depth: 1, id: 1, tree: treeOf(root) },
        ports: {
          sql: facetOpened.provider,
          alarms,
          facets: new RecordingFacetHost(),
          timer,
        },
      }),
    );
    // "only 'root' may ensureFacetTreeIndex()" (`server.c++:2704`): a facet with an index of its
    // own would mint id 1 under every parent and collide the storage files.
    expect(facetOpened.opened).toEqual(["root"]);
  });

  test("boot carries out a deletion a previous session recorded", async () => {
    const host = new RecordingFacetHost();
    const { provider } = sharedProvider();
    new FacetDeletionReceiptStore(await provider.open("facets")).record(3);

    const container = await createActorContainer(
      options({ ports: { sql: provider, alarms, facets: host, timer } }),
    );
    await container.start((ctx, env) => new Counter(ctx, env));

    // The receipt is the whole point: a `ctx.facets.delete()` that was recorded and not finished
    // must not leave storage behind, and the app must not be able to see it first.
    expect(host.deleted).toEqual([{ id: 3, subtree: [] }]);
  });

  test("deleteAll cascades to every descendant facet's storage", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    await openFacet(stub, "a");
    await openFacet(stub, "b");
    await stub.bump();
    await stub.wipe();
    await container.drainWaitUntil();

    expect(host.deleted.map((entry) => entry.id).sort(ascending)).toEqual([1, 2]);
    // Upstream's `afterReset` only removes the files and its own comment admits the gap. A
    // running facet here holds an OPFS sync access handle, so the removal would fail rather than
    // quietly succeed — the abort is what makes the cascade mean the same thing on both.
    expect(host.aborted.map((entry) => entry.id).sort(ascending)).toEqual([1, 2]);
    // The parent's own storage is reset rather than removed, exactly as upstream's `afterReset`
    // leaves `selfId` alone and deletes only descendants.
    expect(await stub.bump()).toBe(1);
  });
});

/**
 * ← §1.10's contract on `FacetHost.start`.
 *
 * The two conformance rows beside these assert the same contract against real
 * workerd, through a facet whose CONSTRUCTOR throws — the one cause of a failed
 * start every lane can express. What is here is the cause workerd has no way to
 * reach and this runtime met first: storage that cannot be opened, which fails
 * the placement inside the host rather than inside the class. It is the same
 * `stub` rejection either way, which is exactly why the rows cover both and only
 * this lane can name this one.
 */
describe("a facet whose placement fails", () => {
  test("reports at the first call on the stub, carrying the host's own message", async () => {
    const host = new RecordingFacetHost();
    host.failNextStart.add("child");
    const { stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    // `facets.get` itself still answers: the stub stands for a placement that has not finished,
    // and on workerd it is an `ActorChannelImpl` over an unresolved promise.
    const facet = (await stub.facet("child")) as { ping(): Promise<string> };
    await expect(facet.ping()).rejects.toThrow("SQLITE_CANTOPEN");
  });

  test("does not break the parent", async () => {
    const host = new RecordingFacetHost();
    host.failNextStart.add("child");
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });
    const broken = vi.fn();
    void container.onBroken.catch(broken);

    const facet = (await stub.facet("child")) as { ping(): Promise<string> };
    await expect(facet.ping()).rejects.toThrow("SQLITE_CANTOPEN");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // This is the assertion the hang was hiding: the parent used to be aborted here, and the
    // rejection above then could not travel back through the context it had to re-enter.
    expect(broken).not.toHaveBeenCalled();
    expect(await stub.bump()).toBe(1);
  });

  test("is retried under the same name, at the same id", async () => {
    const host = new RecordingFacetHost();
    host.failNextStart.add("child");
    const { stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    const failed = (await stub.facet("child")) as { ping(): Promise<string> };
    await expect(failed.ping()).rejects.toThrow("SQLITE_CANTOPEN");

    // ← §1.10: the startup callback runs only when the facet is not already running, and one that
    // failed to start is not running. Measured on workerd, where the retry may even carry a
    // different class. A cached entry would answer with the dead handle for the actor's lifetime.
    expect(await openFacet(stub, "child")).toBe("pong:1");
    expect(host.started.map((request) => `${request.name}:${request.id}`)).toEqual([
      "child:1",
      "child:1",
    ]);
  });

  test("does not need anyone to call the stub to stay handled", async () => {
    const host = new RecordingFacetHost();
    host.failNextStart.add("child");
    const { stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });

    // Nothing is ever called on this one. The runtime attaches to the placement itself, so the
    // rejection is observed rather than becoming an unhandled rejection nobody sees.
    await stub.facet("child");
    await new Promise((resolve) => setTimeout(resolve, 5));

    // And the name really was forgotten, so the next get is a fresh attempt.
    expect(await openFacet(stub, "child")).toBe("pong:1");
  });
});

/**
 * ← `ActorContainer::abort` (`server.c++:2565-2589`) and `monitorOnBroken`
 * (`:2767-2800`), both of which loop `for (auto& facet: facets)` — a container's
 * OWN children — and neither of which tells anything above.
 *
 * The conformance suite asks the oracle the same question end to end, through a
 * facet that aborts itself; what is left here is the direction upstream does
 * have, which no lane can reach because it needs the host's own record of what
 * was torn down.
 */
describe("a break travels down", () => {
  test("a facet breaking on its own is torn down and its name can be recreated", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });
    const broken = vi.fn();
    void container.onBroken.catch(broken);

    await openFacet(stub, "child");
    await openFacet(stub, "sibling");
    host.breaks.get(1)?.(new Error("the facet died"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(broken).not.toHaveBeenCalled();
    // The parent and sibling live, but the broken placement is removed from the host as well as the
    // parent's name map.
    expect(await stub.bump()).toBe(1);
    expect(host.aborted).toEqual([{ id: 1, reason: "the facet died" }]);
    expect([...host.running]).toEqual([2]);

    expect(await openFacet(stub, "child")).toBe("pong:1");
    expect(host.started.map((request) => `${request.name}:${request.id}`)).toEqual([
      "child:1",
      "sibling:2",
      "child:1",
    ]);
    expect([...host.running].sort(ascending)).toEqual([1, 2]);
  });

  test("abort tears every facet down and refuses further entry", async () => {
    const host = new RecordingFacetHost();
    const { container, stub } = await counterContainer({
      ports: { sql: createNodeSqlProvider(), alarms, facets: host, timer },
    });
    await openFacet(stub, "a");
    await openFacet(stub, "b");

    container.abort(new Error("host says stop"));

    expect(host.aborted.map((entry) => entry.id).sort(ascending)).toEqual([1, 2]);
    await expect(stub.bump()).rejects.toThrow("host says stop");
  });
});

describe("alarms", () => {
  test("delivery runs the handler and is strictly serialised", async () => {
    const scheduledTimes: Array<number | null> = [];
    const { container, stub, instance } = await counterContainer({
      ports: {
        sql: createNodeSqlProvider(),
        alarms: {
          scheduleRun: (scheduledTime) => {
            scheduledTimes.push(scheduledTime);
            return Promise.resolve();
          },
        },
        facets: new RecordingFacetHost(),
        timer,
      },
    });

    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();
    expect(scheduledTimes.at(-1)).toBe(scheduled);

    const first = container.deliverAlarm(scheduled, 0);
    const second = container.deliverAlarm(scheduled, 0);
    await Promise.all([first, second]);

    // Two deliveries, never overlapping: `_cf_executingScheduleRowId` upstream is safe only
    // because of this (§1.8, §2.3).
    expect(await container.run(() => instance.ctx.storage.get<number>("runs"))).toBe(2);
  });

  test("a completed delivery reports success and no retry", async () => {
    // ← the `.then` after `alarm(...)` (`api/global-scope.c++:589-591`).
    const { container, stub } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    expect(await container.deliverAlarm(scheduled, 0)).toEqual({
      outcome: "ok",
      retry: false,
      retryCountsAgainstLimit: true,
    });
  });

  test("the handler is handed the scheduled time and the retry count", async () => {
    // ← `alarm(lock, js.alloc<AlarmInvocationInfo>(scheduledTime, retryCount))`
    // (`api/global-scope.c++:588`).
    const { container, stub, instance } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    await container.deliverAlarm(scheduled, 0);
    await stub.arm(scheduled);
    await container.waitOutputLocks();
    await container.deliverAlarm(scheduled, 4);

    expect(instance.alarmInfo.map((info) => info?.retryCount)).toEqual([0, 4]);
    expect(instance.alarmInfo.map((info) => info?.isRetry)).toEqual([false, true]);
    expect(instance.alarmInfo.map((info) => info?.scheduledTime)).toEqual([scheduled, scheduled]);
  });

  test("a delivery whose handler throws is retried, counted, and cancels the deferred deletion", async () => {
    // ← the `.catch_` (`api/global-scope.c++:593-641`):
    // `shouldRetryCountsAgainstLimits = !isOutputGateBroken() || isUserGeneratedError`,
    // and the gate is intact here, so a plain handler failure counts.
    const { container, stub, instance } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    vi.spyOn(instance, "alarm").mockRejectedValueOnce(new Error("handler failed"));
    const result = await container.deliverAlarm(scheduled, 0);
    expect(result.retry).toBe(true);
    expect(result.retryCountsAgainstLimit).toBe(true);
    expect(result.outcome).toBe("exception");
    expect(result.errorDescription).toContain("handler failed");

    // The alarm is still set, so the scheduler has something to retry.
    expect(await container.run(() => instance.ctx.storage.getAlarm())).toBe(scheduled);
  });

  test("a handler failure that reset the actor is retried WITHOUT counting against the limit", async () => {
    // The alarm of a broken actor must survive its restart. `ctx.abort()` would
    // be a user error, so this breaks the gate the way a storage failure does.
    const { container, stub, instance } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    vi.spyOn(instance, "alarm").mockImplementationOnce(async () => {
      breakOutputGate(container);
      throw new Error("handler failed while the actor was being reset");
    });
    const result = await container.deliverAlarm(scheduled, 0);
    expect(result.retry).toBe(true);
    expect(result.retryCountsAgainstLimit).toBe(false);
  });

  test("ctx.abort() from the handler counts against the limit even though it resets the actor", async () => {
    // ← `error.setDetail(jsg::EXCEPTION_IS_USER_ERROR, ...)` in
    // `DurableObjectState::abort` (`actor-state.c++:1143`), read back by
    // `isAlarmFailureUserError`'s first arm. Without it an app aborting from its
    // own alarm handler would be retried forever, destroying the actor each time.
    //
    // The un-awaited write is load bearing: `abort()` breaks the output gate only
    // by failing a scheduled flush — that is all it does upstream too
    // (`actor-state.c++:1133-1154`) — and without one the gate stays intact and
    // the assertion below would hold for a reason that has nothing to do with the
    // detail it is here to pin.
    const { container, stub, instance } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    vi.spyOn(instance, "alarm").mockImplementationOnce(async () => {
      void instance.ctx.storage.put("pending", 1);
      instance.ctx.abort("no thanks");
    });
    const result = await container.deliverAlarm(scheduled, 0);
    expect(container.state.storage).toBeDefined();
    expect(result.retry).toBe(true);
    expect(result.retryCountsAgainstLimit).toBe(true);
    expect(result.errorDescription).toContain("no thanks");
  });

  test("a class with no alarm handler reports script-not-found and is not retried", async () => {
    // ← "Attempted to run a scheduled alarm without a handler" (`global-scope.c++:543-549`),
    // which returns `{retry: false, outcome: SCRIPT_NOT_FOUND}` rather than throwing.
    //
    // Reachable exactly where upstream says it is: `assertCanSetAlarm`'s
    // `Initializing` arm lets a constructor arm an alarm because "we don't
    // explicitly know if we have an alarm handler or not, so just let it happen.
    // We'll handle it when we go to run the alarm."
    const scheduled = Date.now() + 5;
    const container = await createActorContainer(options());
    await container.start((ctx) => new Alarmless(ctx, scheduled));
    await container.waitOutputLocks();

    expect(await container.deliverAlarm(scheduled, 0)).toEqual({
      outcome: "script-not-found",
      retry: false,
      retryCountsAgainstLimit: true,
    });
    // SCRIPT_NOT_FOUND does not retry, so the deferred deleter cleared the alarm rather than
    // leaving one nothing can ever answer.
    expect(await container.run(() => container.state.storage.getAlarm())).toBe(null);
  });

  test("a cancelled arm is not a failure", async () => {
    // ← `CancelAlarmHandler` → `{retry: false, outcome: CANCELED}`
    // (`global-scope.c++:684-688`). Reached by delivering an alarm SQLite has
    // moved past, which asks the scheduler to reschedule and cancels this run.
    const { container, stub } = await counterContainer();
    const later = Date.now() + 600_000;
    await stub.arm(later);
    await container.waitOutputLocks();

    expect(await container.deliverAlarm(later - 1_000, 0)).toEqual({
      outcome: "canceled",
      retry: false,
      retryCountsAgainstLimit: true,
    });
  });

  test("abandonAlarm reaches the storage engine and reports the newer alarm", async () => {
    // ← `ActorSqlite::abandonAlarm` (`io/actor-sqlite.c++:1039-1060`), which the
    // scheduler needs when it gives up (`alarm-scheduler.c++:244`).
    const { container, stub } = await counterContainer();
    const scheduled = Date.now() + 5;
    await stub.arm(scheduled);
    await container.waitOutputLocks();

    // The actor has moved on: abandoning the old time must not clear the new one.
    const newer = scheduled + 60_000;
    await stub.arm(newer);
    await container.waitOutputLocks();
    expect(await container.abandonAlarm(scheduled)).toBe(newer);

    // Abandoning the alarm the actor actually holds clears it.
    expect(await container.abandonAlarm(newer)).toBe(null);
    expect(await container.run(() => stub.ctx.storage.getAlarm())).toBe(null);
  });
});

describe("the Worker Loader binding", () => {
  /**
   * ← `WorkerdApi::compileGlobals`'s `Global::WorkerLoader` arm
   * (`server/workerd-api.c++:748-752`). `api/worker-loader.ts` owns the loader's
   * behaviour and tests it; what is here is the one thing only the container can
   * answer — that the loader is bound to THIS container's `IoContext`, which is
   * what makes `makeReentryCallback` inherit the right critical section.
   */
  const namespace: IsolateChannelFactory = {
    loadIsolate: (request) => {
      void request.fetchSource().catch(() => {});
      return {
        getEntrypoint: () => {
          throw new Error("no transport in this lane");
        },
        getActorClass: () => ({ className: "Loaded", requireAllowsTransfer: () => {} }),
      };
    },
    getNullClientChannel: () => ({}) as unknown as Fetcher,
  };

  const loaderOptions = {
    compatDateValidation: "codeVersion",
    allowExperimentalFeatures: true,
  } as const;

  const source = {
    compatibilityDate: "2025-01-01",
    mainModule: "main.js",
    modules: { "main.js": "export default {}" },
  };

  test("the loader it builds runs inside the container's own gated slice", async () => {
    const container = await createActorContainer(options());
    const loader = container.workerLoader(namespace, loaderOptions);

    const stub = await container.run(() => loader.get("child", () => source));
    expect(stub.getDurableObjectClass("Loaded")).toBeInstanceOf(DurableObjectClass);
  });

  test("and refuses outside one, because a loader over a foreign context would not", async () => {
    const container = await createActorContainer(options());
    const loader = container.workerLoader(namespace, loaderOptions);

    expect(() => loader.load(source)).toThrow("load(): no input lock available in this context");
    await container.run(() => {
      expect(() => loader.load(source)).not.toThrow();
    });
  });
});

/**
 * Breaks the output gate the way a failed commit does — by closing the database
 * out from under an outstanding write — which is the only reset this runtime can
 * produce that is not a `ctx.abort()`.
 */
function breakOutputGate(container: ActorContainer): void {
  container.state.storage.put("gate", 1).catch(() => {});
  (container.state.storage as unknown as { getSqliteDb(): { close(): void } })
    .getSqliteDb()
    .close();
}
