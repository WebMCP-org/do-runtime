/**
 * The platform pieces every worker in this lane needs: an OPFS SAH pool, a
 * `SqlDatabaseProvider` over it, and a clock.
 *
 * **One pool per worker, and that is forced.** `installOpfsSAHPoolVfs` takes an
 * exclusive `createSyncAccessHandle` on every file in its directory, so two
 * workers naming the same pool fight over it. Since this lane places one actor
 * TREE per worker, the pool name is derived from the root actor, and no worker in
 * a run is ever restarted — a respawn drops the containers and reopens the same
 * files rather than replacing the worker, exactly as the node lane reuses its
 * directory. That is what keeps the exclusive handle out of the test's timing.
 *
 * **One pool per actor TREE is what in-process facets changed here.** While
 * facets ran in workers of their own each one installed a pool of its own, so
 * every `facets.get()` for a name not yet placed paid an
 * `installOpfsSAHPoolVfs` — the only operation in this lane with unbounded
 * timing, since acquiring an exclusive sync access handle waits on whatever the
 * browser is doing with the file. Now the root's pool is installed once and every
 * facet is a further prefix inside it, so no placement after the first acquires a
 * handle at all.
 *
 * `clearOnInit` is safe for the same reason: it runs once, when the worker
 * installs its pool, and never again for the life of that actor. What it buys is
 * that a browser profile carrying pool files from an earlier run cannot make a
 * later one pass or fail for reasons the run itself did not create.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmProvider, type SqliteWasmHost } from "../../backends/sqlite-wasm";
import type { SqlDatabase, SqlDatabaseProvider, Timer } from "../../src/index";

/**
 * ← the namespace's configured `uniqueKey`. One constant for the whole lane, for
 * the obligation the option documents: an id is derived from it and names the
 * actor's storage, so a lane that minted a fresh one per spawn would lose every
 * actor's data at `respawn` and never say why.
 */
export const UNIQUE_KEY = "do-runtime-conformance-browser";

/**
 * The pool's file-level operations, which `SqlDatabaseProvider` does not model
 * and `backends/sqlite-wasm.ts` therefore does not declare: a database is a
 * connection there, and these three are about the bytes underneath one.
 * `FacetHost.copyStorage` is the caller — see `LaneStorage.copyFrom`.
 */
export type PoolFiles = {
  /** Every virtual file the pool holds, under the absolute names `OpfsSAHPoolDb` takes. */
  getFileNames(): string[];
  exportFile(filename: string): Promise<Uint8Array>;
  importDb(name: string, data: Uint8Array): Promise<number>;
};

/** The pool, the one C-API function `oo1.DB` does not wrap, and the file operations. */
export type LanePool = SqliteWasmHost & { readonly files: PoolFiles };

export async function installPool(name: string): Promise<LanePool> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name,
    clearOnInit: true,
    // One pool now holds the whole actor tree: the root's own database, the facet
    // tree index, one database per facet placed, and a rollback journal beside
    // each of those as a further file. The default of six is enough only until it
    // is not, so this is sized for the deepest tree the suite builds with room
    // over it, not for the tightest fit.
    //
    // **What running out actually looks like, measured at capacity 3.** The pool
    // names it itself, on the console, and names the file it could not create:
    // `SAH pool is full. Cannot create file /facet-1.root.sqlite-journal`. What
    // the caller gets is the driver's `SQLITE_CANTOPEN: sqlite3 result code 14`,
    // and three of the four §1.10 rows fail on it promptly. So this is nameable
    // after all — the 8c report called it an unnameable `SQLITE_FULL` from inside
    // a commit and that was wrong on both halves. What it does not name is this
    // line, which is the knob.
    //
    // A headroom check in `LaneStorage.open` was tried and is NOT here, because
    // it measured worse at the time. Refusing before the facet's database opens
    // at all — rather than later, when its journal does — fails the placement
    // inside `createActorContainer`, and the lane wedged on that: the rows timed
    // out at 15s and the refusal reached neither the test nor the console. A
    // failure the caller can see beats a better-worded one it cannot.
    //
    // A placement failure now reaches the first call on the facet's stub, so the
    // check would no longer be silent. It still does not come back. Its only job
    // was to reword a failure the pool already names on the console and in the
    // driver's own `SQLITE_CANTOPEN`, and this line is the knob that actually
    // decides whether the tree fits.
    initialCapacity: 64,
  });
  return { pool, capi: sqlite3.capi, files: pool };
}

/**
 * The provider one container is built over, plus the two lifecycle operations a
 * pooled file needs and a Node connection does not.
 *
 * **Why `close()`, stated as what it actually is.** A first draft of this comment
 * claimed the §1.7.1 rows depend on it: that the replacement container reuses one
 * handle per file, so an implicit transaction the dead container left open would
 * still be open, and closing is what discards it. **Measured, and that is wrong on
 * both halves.** Deleting the `close()` and re-running `transactions.spec.ts`
 * leaves all four rows green, because nothing forces the replacement to reuse the
 * handle — it opens a second connection, exactly as the node lane's replacement
 * does, and SQLite's isolation shows it the last committed state while the dead
 * connection's `BEGIN` stays invisible. (`ActorSqlite` does not roll back on
 * abort: `broken` is what tells its transaction classes to skip that.)
 *
 * So this is hygiene the suite cannot see, kept deliberately rather than because
 * a row asks for it. The SAH pool takes an exclusive sync access handle per file
 * and is built on owning what it opens; leaving a connection behind on every
 * respawn and every facet abort accumulates concurrent writers on one file inside
 * a VFS that does not expect any. The failure that would eventually produce is
 * corruption, which is the class this repo's fail-closed tenet exists to prevent
 * and precisely the class a green suite does not rule out.
 */
export class LaneStorage implements SqlDatabaseProvider {
  readonly #host: LanePool;
  readonly #prefix: string;
  readonly #open = new Map<string, SqlDatabase>();
  readonly #names = new Set<string>();

  constructor(host: LanePool, prefix: string) {
    this.#host = host;
    this.#prefix = prefix;
  }

  async open(name: string): Promise<SqlDatabase> {
    const database = await createSqliteWasmProvider(this.#host, { prefix: this.#prefix }).open(
      name,
    );
    this.#open.set(name, database);
    this.#names.add(name);
    return database;
  }

  /** Drop every handle. Uncommitted transactions go with them. */
  close(): void {
    for (const database of this.#open.values()) database.close();
    this.#open.clear();
  }

  /**
   * Physical removal, for `FacetHost.deleteStorage`. The pool's files are not
   * visible in OPFS under these names, so this goes through the pool rather than
   * the filesystem — the same route `backends/sqlite-wasm.ts`'s `reset()` takes,
   * and for the same reason.
   */
  unlink(): void {
    this.close();
    for (const name of this.#ownedFiles()) this.#host.pool.unlink(name);
    this.#names.clear();
  }

  /**
   * Physical copy of every database another `LaneStorage` holds onto this one's
   * prefix, for `FacetHost.copyStorage`.
   *
   * **This is the one substrate operation in-process facets turned from a
   * refusal into four lines.** While a facet ran in a worker of its own the two
   * databases were in two pools, each holding exclusive sync access handles the
   * other worker cannot touch, so a copy meant `exportFile` in one worker,
   * capnweb carrying the bytes, `importDb` in the other, and placing a worker for
   * a destination that was never started. Both files are now in this worker's one
   * pool, so it is the pool's own export/import pair and nothing else.
   *
   * The file list comes from the pool rather than from what this session
   * happened to open, so a source placed in an earlier session and not yet
   * re-placed still copies. A source that was never placed has no files and
   * copies nothing, which is `cloneFacet`'s own reading of a `src` that was never
   * created: an empty subtree.
   *
   * No conformance row reaches this — `facets.clone()` has no body anywhere in
   * workerd (§1.10), so the suite cannot assert it against the oracle and does
   * not try.
   */
  async copyFrom(source: LaneStorage): Promise<void> {
    const files = source.#ownedFiles();
    const sidecar = files.find((file) => !file.endsWith(".sqlite"));
    if (sidecar !== undefined) {
      throw new Error(`Cannot clone actor storage with a SQLite recovery sidecar: ${sidecar}`);
    }
    this.unlink();
    for (const file of files) {
      const name = file.slice(source.#prefix.length + 1, -".sqlite".length);
      await this.#host.files.importDb(
        `${this.#prefix}.${name}.sqlite`,
        await this.#host.files.exportFile(file),
      );
      this.#names.add(name);
    }
  }

  /** Every file in the pool that belongs to this prefix, as the pool names them. */
  #ownedFiles(): string[] {
    return this.#host.files.getFileNames().filter((name) => name.startsWith(`${this.#prefix}.`));
  }
}

/**
 * Wall clock, and nothing else.
 *
 * This lane declares no `fake-time` capability, so there is no `advance()` to
 * pair with it: every alarm in the suite has to arrive on real elapsed time.
 * `AlarmScheduler` takes this timer, and a wake that only happens when a test
 * pokes it is not a platform.
 */
/**
 * Captured at module scope, and this module is imported before any worker
 * installs the runtime's globals — so `rawSetTimeout` is the platform's even
 * after `installActorScope` has replaced `globalThis.setTimeout`.
 *
 * Not a style choice. `container.globals.setTimeout` is built ON the `Timer`
 * below, so a `Timer` that reached the installed global would arm a timeout to
 * implement a timeout: `#arm` → `afterDelay` → `setTimeout` → `setTimeoutImpl`
 * → `#arm`. Measured as `RangeError: Maximum call stack size exceeded` the first
 * time the node lane was pointed at the runtime's own primitives, before its
 * timer was given the same treatment. Every substrate piece BELOW the runtime
 * has to keep the raw ones.
 */
const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);

export const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = rawSetTimeout(resolve, Math.max(0, ms));
      // Cancellation leaves the promise unsettled, which is what the node lane's
      // timer does and what kj's cancel-by-drop means: the waiter is gone.
      signal?.addEventListener("abort", () => {
        rawClearTimeout(handle);
      });
    }),
};

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => rawSetTimeout(resolve, Math.max(0, ms)));
