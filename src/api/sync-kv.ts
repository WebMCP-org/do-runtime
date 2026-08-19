/**
 * ← workerd `src/workerd/api/sync-kv.{h,c++}`
 *
 * "Synchronous KV storage. Available as ctx.storage.kv on SQLite-backed DOs."
 *
 * This module is not in Section 5's brief and exists because
 * `DurableObjectStorage` cannot satisfy workers-types without it: the interface
 * declares `kv: SyncKvStorage` unconditionally, and §2.4's rule is that the
 * surface is verified by the type system rather than by a cast. It is also a
 * genuine part of the contract — a whole KV surface that skips the promise
 * wrapper, over the same `SqliteKv` `DurableObjectStorage` writes through, with
 * the same codec.
 *
 * Two things upstream has that are absent, both already absent below this file:
 * the trace spans every method opens, and the billing counters. What is kept is
 * the whole of the behaviour, including the one error that is neither of those:
 * a `list()` iterator invalidated by a second `list()` says so rather than
 * silently ending, which is `SqliteKv::ListCursor::wasCanceled()`.
 *
 * Spec: §2.4 in docs/decisions.md.
 */

import type { IoContext } from "../io/io-context";
import { requireInputLock } from "../io/io-context";
import type { SqliteKv, SqliteKvListCursor } from "../util/sqlite-kv";
import { compileListOptions, deserializeValue, serializeValue } from "./actor-state";

/**
 * ← the `jsg::Ref<DurableObjectStorage>` `SyncKvStorage` holds, narrowed to the
 * one member it reaches through (`SyncKvStorage::getSqliteKv`).
 */
export interface SyncKvStorageOwner {
  getSqliteKv(): SqliteKv;
}

/** ← `SyncKvStorage::ListOptions`, which is `ListOptions` minus the two gate flags. */
export type SyncKvListOptions = {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
};

export class SyncKvStorage implements globalThis.SyncKvStorage {
  readonly #ctx: IoContext;
  readonly #owner: SyncKvStorageOwner;

  constructor(ctx: IoContext, owner: SyncKvStorageOwner) {
    this.#ctx = ctx;
    this.#owner = owner;
  }

  get<T = unknown>(key: string): T | undefined {
    requireInputLock(this.#ctx, "kv.get()");
    const value = this.#owner.getSqliteKv().get(key);
    if (value === undefined) return undefined;
    return deserializeValue(key, value) as T;
  }

  /**
   * ← `SyncKvStorage::list`, which reuses `compileListOptions` — "This is public
   * so that SyncKvStorage can reuse it."
   */
  list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> {
    requireInputLock(this.#ctx, "kv.list()");
    const compiled = compileListOptions(options);
    if (compiled === undefined) {
      // Key range is empty. Upstream allocates a cursor over a null query for exactly this.
      return { [Symbol.iterator]: () => emptyIterator<T>() };
    }

    const cursor = this.#owner
      .getSqliteKv()
      .list(compiled.start, compiled.end, compiled.limit, compiled.reverse ? "REVERSE" : "FORWARD");
    return { [Symbol.iterator]: () => listIterator<T>(cursor) };
  }

  put<T>(key: string, value: T): void {
    requireInputLock(this.#ctx, "kv.put()");
    this.#owner.getSqliteKv().put(key, serializeValue(key, value));
  }

  delete(key: string): boolean {
    requireInputLock(this.#ctx, "kv.delete()");
    return this.#owner.getSqliteKv().delete(key);
  }
}

/** ← `SyncKvStorage::listNext`, whose cancellation branch is the reason it is not a plain loop. */
function listIterator<T>(cursor: SqliteKvListCursor): IterableIterator<[string, T]> {
  const iterator: IterableIterator<[string, T]> = {
    [Symbol.iterator]: () => iterator,
    next: (): IteratorResult<[string, T]> => {
      const pair = cursor.next();
      if (pair !== undefined) {
        return { done: false, value: [pair.key, deserializeValue(pair.key, pair.value) as T] };
      }
      if (cursor.wasCanceled()) {
        throw new Error(
          "kv.list() iterator was invalidated because a new call to kv.list() was started. " +
            "Only one kv.list() iterator can exist at a time.",
        );
      }
      return { done: true, value: undefined };
    },
  };
  return iterator;
}

function emptyIterator<T>(): IterableIterator<[string, T]> {
  const iterator: IterableIterator<[string, T]> = {
    [Symbol.iterator]: () => iterator,
    next: (): IteratorResult<[string, T]> => ({ done: true, value: undefined }),
  };
  return iterator;
}
