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
 * later one pass or fail for reasons the run itself did not create. The restart
 * specs are the exception by design: their replacement worker reopens the pool a
 * terminated worker owned, with `clearOnInit: false`.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { installSqliteWasmHost, type SqliteWasmHost } from "../../backends/sqlite-wasm";
import { platformTimer } from "../../src/index";

/**
 * ← the namespace's configured `uniqueKey`. One constant for the whole lane, for
 * the obligation the option documents: an id is derived from it and names the
 * actor's storage, so a lane that minted a fresh one per spawn would lose every
 * actor's data at `respawn` and never say why.
 */
export const UNIQUE_KEY = "do-runtime-conformance-browser";

export async function installPool(
  name: string,
  { clearOnInit = true }: { readonly clearOnInit?: boolean } = {},
): Promise<SqliteWasmHost> {
  return await installSqliteWasmHost(await sqlite3InitModule(), {
    name,
    clearOnInit,
    // Only the starting size: the backend grows the pool on open to fit the tree.
    initialCapacity: 64,
  });
}

/**
 * Wall clock, and nothing else.
 *
 * This lane declares no `fake-time` capability, so there is no `advance()` to
 * pair with it: every alarm in the suite has to arrive on real elapsed time.
 * `AlarmScheduler` takes this timer, and a wake that only happens when a test
 * pokes it is not a platform.
 *
 * The package's `platformTimer`, captured before any worker installs the
 * runtime's globals. `container.globals.setTimeout` is built ON this timer, so
 * one that read the installed global would arm a timeout to implement a
 * timeout: `RangeError: Maximum call stack size exceeded`.
 */
export const timer = platformTimer;
