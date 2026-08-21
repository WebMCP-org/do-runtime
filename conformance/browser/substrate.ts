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
import type { SqliteWasmHost } from "../../backends/sqlite-wasm";
import type { Timer } from "../../src/index";

/**
 * ← the namespace's configured `uniqueKey`. One constant for the whole lane, for
 * the obligation the option documents: an id is derived from it and names the
 * actor's storage, so a lane that minted a fresh one per spawn would lose every
 * actor's data at `respawn` and never say why.
 */
export const UNIQUE_KEY = "do-runtime-conformance-browser";

export async function installPool(name: string): Promise<SqliteWasmHost> {
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
    // A headroom check in `SqliteWasmActorStorage.open` was tried and is NOT
    // here, because it measured worse at the time. Refusing before the facet's
    // database opens at all — rather than later, when its journal does — fails
    // the placement inside `createActorContainer`, and the lane wedged on that:
    // the rows timed out at 15s and the refusal reached neither the test nor the
    // console. A failure the caller can see beats a better-worded one it cannot.
    //
    // A placement failure now reaches the first call on the facet's stub, so the
    // check would no longer be silent. It still does not come back. Its only job
    // was to reword a failure the pool already names on the console and in the
    // driver's own `SQLITE_CANTOPEN`, and this line is the knob that actually
    // decides whether the tree fits.
    initialCapacity: 64,
  });
  return { pool, capi: sqlite3.capi };
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
