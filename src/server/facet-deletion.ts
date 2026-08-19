/**
 * ← workerd `NO upstream correspondence`
 *
 * Generation-fenced deletion receipts, serialized subtree deletion, reference
 * epochs. Keyed by facet id, never by an app address.
 *
 * **Why there is no upstream twin.** `ActorContainer::deleteFacet`
 * (`server.c++:2642-2655`) aborts the child and then calls
 * `directory->remove(...)` — synchronous, in-process, on a real filesystem. It
 * cannot be interrupted between "the app asked" and "the bytes are gone", so it
 * needs no record that it was asked. Here the same call is
 * `FacetHost.deleteStorage`, which is asynchronous because it is the HOST's and a
 * host's storage removal is not required to be prompt: OPFS removal is
 * asynchronous in general, and the extension's supervisor crosses a worker to do
 * it. `ctx.facets.delete()` is synchronous and `void` regardless — so the app's
 * request outlives the process that has to carry it out. §2.7 records the browser
 * host's answer to that, generation-fenced receipts, as "a genuine improvement
 * over workerd, which has no equivalent because its facets are in-process". This
 * is that answer, moved down into the runtime and re-keyed.
 *
 * In-process facets do not remove this gap. What upstream gets from them is that
 * `kj::Directory::remove` is a synchronous call it can finish before returning.
 * The seam here is `Promise<void>` whoever implements it, so the gap between "the
 * app asked" and "the bytes are gone" is still real and still spans a possible
 * teardown. The two conformance lanes happen to close that gap promptly — one
 * through `rmSync`, one through the SAH pool's `unlink` — and the receipt is what
 * makes a host that cannot, such as the extension's supervisor, survivable.
 *
 * **What changed in the move, and it is the whole of the change.** The
 * extension's version (`offscreen/worker/host/facet-deletion.ts`) is keyed by an
 * `AgentWorkerAddress` — a root name plus a path of `{className, name}` steps —
 * and derives "is this address inside that subtree" by comparing path prefixes.
 * Here the key is a `FacetId`, the small integer `server/facet-tree-index.ts`
 * assigns, and ancestry is not derivable from it: id 7 says nothing about who its
 * parent is. So every operation that needs a subtree is *given* one, computed
 * from the index by the caller that already holds it, and this file has no
 * opinion about tree shape at all. That is a smaller module, not a larger one:
 * three of the extension's helpers — `isAgentAddressInTree`,
 * `isAgentStorageKeyInTree`, `isAgentStorageEntryInTree` — exist only to answer
 * the ancestry question from a string, and none of them has anything to do here.
 *
 * Storage is the facet-tree database rather than the actor's own, and that is
 * load bearing: `SqliteKv::deleteAll()` calls `db.reset()`
 * (`util/sqlite-kv.ts`), which replaces the actor's database file wholesale. A
 * receipt recorded there would be destroyed by the very `deleteAll()` whose
 * cascade it exists to make recoverable. It sits beside the tree index for the
 * same reason the index does — both are facts about the tree rather than about
 * any one actor's contents.
 *
 * Spec: §2.7, decision 14 in docs/decisions.md.
 */

import { hasCurrentSqliteTable, type SqlDatabase } from "../util/sqlite";
import type { FacetId } from "./actor-container";

/** The table the receipts live in, beside the tree index. */
const RECEIPTS_TABLE = "_cf_FACET_DELETIONS";
const CREATE_RECEIPTS_TABLE = `CREATE TABLE IF NOT EXISTS ${RECEIPTS_TABLE} (
  facet_id INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL
)`;

/**
 * One recorded intent to delete a facet's storage.
 *
 * `generation` is the fence. A receipt is cleared only if the row still carries
 * the generation this receipt was issued with, so a delete that was requested
 * again while the first deletion was in flight cannot have its second request
 * erased by the first request's completion.
 */
export type FacetDeletionReceipt = {
  readonly id: FacetId;
  readonly generation: number;
};

/**
 * Parent-owned durable receipts for the synchronous `ctx.facets.delete()`
 * boundary. The doomed child never owns its own deletion decision — it may not
 * be running, and if it is, it is the thing being destroyed.
 */
export class FacetDeletionReceiptStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
    hasCurrentSqliteTable(db, RECEIPTS_TABLE, CREATE_RECEIPTS_TABLE);
    this.#db.exec(CREATE_RECEIPTS_TABLE, []);
  }

  /** Bumps the generation for `id` and returns the receipt naming it. */
  record(id: FacetId): FacetDeletionReceipt {
    requireFacetId(id);
    // One statement, so it is one implicit SQLite transaction and is durable when it returns —
    // which is what lets `ctx.facets.delete()` stay synchronous and still be recoverable. The
    // extension's version wrapped the read and the write in `transactionSync`; a single upsert
    // that computes the next generation from the row it is replacing needs no transaction at all.
    const rows = this.#db.exec(
      `INSERT INTO ${RECEIPTS_TABLE} (facet_id, generation)
       VALUES (?, 1)
       ON CONFLICT(facet_id) DO UPDATE SET generation = generation + 1
       RETURNING generation`,
      [id],
    ).rawRows;
    const generation = rows[0]?.[0];
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`recording a facet deletion receipt for ${id} produced no generation`);
    }
    return { id, generation };
  }

  read(id: FacetId): FacetDeletionReceipt | undefined {
    requireFacetId(id);
    const rows = this.#db.exec(`SELECT generation FROM ${RECEIPTS_TABLE} WHERE facet_id = ?`, [
      id,
    ]).rawRows;
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id, generation: requireGeneration(id, row[0]) };
  }

  /**
   * Every outstanding receipt, oldest facet first, for boot-time replay.
   *
   * The `ORDER BY` cannot be shown to matter and is kept anyway: `facet_id` is
   * an `INTEGER PRIMARY KEY`, which is the rowid, so both backends scan the
   * table in that order with or without it. Removing it survives the whole
   * suite — a mutant that no test can kill, because killing it needs a SQLite
   * that returns rows out of rowid order, and nothing this package can reach
   * does. Relying on the scan order rather than saying so is the kind of thing
   * that is right until a schema change makes it silently wrong.
   */
  list(): FacetDeletionReceipt[] {
    return this.#db
      .exec(`SELECT facet_id, generation FROM ${RECEIPTS_TABLE} ORDER BY facet_id`, [])
      .rawRows.map((row) => {
        const id = row[0];
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error(`facet deletion receipt has an invalid facet id: ${String(id)}`);
        }
        return { id, generation: requireGeneration(id, row[1]) };
      });
  }

  /**
   * Clears the receipt if and only if it is still the one that was issued.
   * Returns false when a newer request has superseded it, which is the whole
   * point of the generation.
   */
  clear(receipt: FacetDeletionReceipt): boolean {
    return (
      this.#db.exec(`DELETE FROM ${RECEIPTS_TABLE} WHERE facet_id = ? AND generation = ?`, [
        receipt.id,
        receipt.generation,
      ]).rowsWritten > 0
    );
  }
}

function requireFacetId(id: FacetId): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`a facet deletion receipt names a facet, and ${id} is not one`);
  }
}

function requireGeneration(id: FacetId, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`facet deletion receipt for ${id} has an invalid generation`);
  }
  return value;
}

/**
 * Replays and generation-fences one parent's durable child-deletion receipts.
 *
 * Recording is synchronous — that is the boundary `ctx.facets.delete()` has to
 * hold — and only the physical deletion crosses an async boundary. A second
 * delete of the same facet while the first is in flight records a newer
 * generation and queues behind it rather than racing it, so a facet cannot be
 * half-deleted by two overlapping attempts.
 */
export class FacetDeletionController {
  readonly #receipts: FacetDeletionReceiptStore;
  readonly #deleteSubtree: (receipt: FacetDeletionReceipt) => Promise<void>;
  readonly #active = new Map<FacetId, { generation: number; promise: Promise<void> }>();

  constructor(
    receipts: FacetDeletionReceiptStore,
    deleteSubtree: (receipt: FacetDeletionReceipt) => Promise<void>,
  ) {
    this.#receipts = receipts;
    this.#deleteSubtree = deleteSubtree;
  }

  /**
   * Record the intent durably now, then carry it out after the caller's actor
   * ordering has settled. The record is synchronous even when the barrier is
   * still pending.
   */
  delete(id: FacetId, waitBeforeDelete: Promise<unknown> = Promise.resolve()): Promise<void> {
    return this.#run(this.#receipts.record(id), waitBeforeDelete);
  }

  /** Carry out whatever is still recorded for `id`, until nothing is. */
  async flush(id: FacetId): Promise<void> {
    for (;;) {
      const receipt = this.#receipts.read(id);
      if (receipt === undefined) return;
      await this.#run(receipt);
    }
  }

  /** ← boot. Every receipt a previous session left behind is carried out before the actor runs. */
  async recoverAll(): Promise<void> {
    await Promise.all(this.#receipts.list().map((receipt) => this.flush(receipt.id)));
  }

  #run(
    receipt: FacetDeletionReceipt,
    waitBeforeDelete: Promise<unknown> = Promise.resolve(),
  ): Promise<void> {
    const active = this.#active.get(receipt.id);
    // An in-flight attempt at this generation or newer already covers this request.
    if (active !== undefined && active.generation >= receipt.generation) return active.promise;

    // A failed predecessor must not stop the successor; it has its own receipt and its own
    // caller to report to.
    const previous = active?.promise.catch(() => undefined) ?? Promise.resolve();
    const ready = Promise.all([previous, waitBeforeDelete.catch(() => undefined)]);
    const promise = ready.then(async () => {
      await this.#deleteSubtree(receipt);
      this.#receipts.clear(receipt);
    });
    const entry = { generation: receipt.generation, promise };
    this.#active.set(receipt.id, entry);
    void promise.then(
      () => this.#clearActive(receipt.id, entry),
      () => this.#clearActive(receipt.id, entry),
    );
    return promise;
  }

  #clearActive(id: FacetId, entry: { generation: number; promise: Promise<void> }): void {
    if (this.#active.get(id) === entry) this.#active.delete(id);
  }
}

/**
 * Serializes physical subtree deletion while retaining subtree-aware waits.
 *
 * Two deletions that overlap in the tree must not run at once: the inner one
 * would be removing files the outer one is walking. Serializing every deletion
 * is the simplest thing that is correct, and deletion is not on any hot path.
 * `waitFor` is the other half — anything about to *use* a facet has to wait for
 * a pending deletion that covers it, and the ids each pending operation covers
 * are recorded rather than derived, because a facet id does not encode its
 * ancestry.
 */
export class SerializedSubtreeDeletionQueue {
  readonly #pending = new Map<Promise<void>, ReadonlySet<FacetId>>();
  #tail: Promise<void> = Promise.resolve();

  /** Runs `operation` after every operation already queued, covering `ids`. */
  run(ids: Iterable<FacetId>, operation: () => Promise<void>): Promise<void> {
    const covered = new Set(ids);
    // The tail swallows failures so one failed deletion does not cancel every later one; the
    // returned promise still carries the failure to its own caller.
    const promise = this.#tail.then(operation);
    this.#tail = promise.catch(() => undefined);
    this.#pending.set(promise, covered);
    void this.#tail.then(() => {
      this.#pending.delete(promise);
    });
    return promise;
  }

  /** Resolves once no queued deletion covers `id`. Failures are not the waiter's to report. */
  async waitFor(id: FacetId): Promise<void> {
    const barriers: Promise<unknown>[] = [];
    for (const [promise, covered] of this.#pending) {
      if (covered.has(id)) barriers.push(promise.catch(() => undefined));
    }
    await Promise.all(barriers);
  }
}

/**
 * Epochs make every capability captured before an ancestor abort or delete
 * stale.
 *
 * The hazard this closes has no workerd equivalent for the same reason the
 * receipts do not: upstream's `abortFacet` erases the map entry and the stub
 * that was handed out is refcounted against a container that is now broken, so
 * a later call on it fails by itself. Here the stub is a value that outlives the
 * placement, so something has to be able to say "the thing you are holding was
 * torn down". Invalidation is by explicit subtree because a `FacetId` does not
 * encode ancestry.
 */
export class FacetReferenceEpochs {
  readonly #epochs = new Map<FacetId, number>();

  /** The epoch to remember alongside a capability. */
  capture(id: FacetId): number {
    const epoch = this.#epochs.get(id) ?? 0;
    this.#epochs.set(id, epoch);
    return epoch;
  }

  /** Bumps `root` and every id in `subtree`, so captures older than this call stop matching. */
  invalidate(root: FacetId, subtree: Iterable<FacetId> = []): void {
    const ids = new Set<FacetId>([root, ...subtree]);
    for (const id of ids) this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
  }

  isCurrent(id: FacetId, epoch: number): boolean {
    return (this.#epochs.get(id) ?? 0) === epoch;
  }
}
