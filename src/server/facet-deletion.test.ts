/**
 * ← workerd `NO upstream test file` — `server.c++` has none, and the module
 * under test has no upstream twin at all (see its header).
 *
 * So these are this section's own, and they are aimed at the three things the
 * conformance suite cannot reach from outside: what a receipt survives, what the
 * generation fences, and what the queue serialises. Everything observable from
 * an application — that `ctx.facets.delete()` removes the storage — is asserted
 * in `conformance/suite/facets.spec.ts` against workerd instead.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import type { SqlDatabase } from "../util/sqlite";
import {
  FacetDeletionController,
  FacetDeletionReceiptStore,
  FacetReferenceEpochs,
  SerializedSubtreeDeletionQueue,
} from "./facet-deletion";

async function newDatabase(): Promise<SqlDatabase> {
  return await createNodeSqlProvider().open("facets");
}

/** A promise plus the two handles a test needs to decide when it settles. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (exception: unknown) => void;
} {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  return { promise, resolve, reject };
}

describe("FacetDeletionReceiptStore", () => {
  let store: FacetDeletionReceiptStore;

  beforeEach(async () => {
    store = new FacetDeletionReceiptStore(await newDatabase());
  });

  test("refuses an incompatible present table without changing it", async () => {
    const db = await newDatabase();
    db.exec("CREATE TABLE _cf_FACET_DELETIONS (sentinel INTEGER)", []);
    const before = db.exec(
      "SELECT sql FROM sqlite_master WHERE name = '_cf_FACET_DELETIONS'",
      [],
    ).rawRows;

    expect(() => new FacetDeletionReceiptStore(db)).toThrow(
      "Incompatible @mcp-b/do-runtime storage schema",
    );
    expect(
      db.exec("SELECT sql FROM sqlite_master WHERE name = '_cf_FACET_DELETIONS'", []).rawRows,
    ).toEqual(before);
  });

  test("records a first receipt at generation 1", () => {
    expect(store.record(7)).toEqual({ id: 7, generation: 1 });
  });

  test("bumps the generation per facet, independently", () => {
    expect(store.record(7).generation).toBe(1);
    expect(store.record(7).generation).toBe(2);
    expect(store.record(9).generation).toBe(1);
    expect(store.record(7).generation).toBe(3);
  });

  test("reads back the current receipt, and nothing for a facet with none", () => {
    store.record(4);
    store.record(4);
    expect(store.read(4)).toEqual({ id: 4, generation: 2 });
    expect(store.read(5)).toBeUndefined();
  });

  test("lists every outstanding receipt in facet order", () => {
    store.record(9);
    store.record(2);
    store.record(9);
    expect(store.list()).toEqual([
      { id: 2, generation: 1 },
      { id: 9, generation: 2 },
    ]);
  });

  test("clear removes the receipt it was issued for", () => {
    const receipt = store.record(3);
    expect(store.clear(receipt)).toBe(true);
    expect(store.read(3)).toBeUndefined();
  });

  test("clear refuses a receipt a newer request has superseded", () => {
    const stale = store.record(3);
    const current = store.record(3);
    // THE fence. Without it, the first deletion finishing would erase the record of the second
    // request, and the facet would be left half-deleted with nothing saying so.
    expect(store.clear(stale)).toBe(false);
    expect(store.read(3)).toEqual(current);
    expect(store.clear(current)).toBe(true);
  });

  test("a receipt survives a new store over the same database", async () => {
    const db = await newDatabase();
    new FacetDeletionReceiptStore(db).record(11);
    // The point of the whole module: the record outlives the session that made it.
    expect(new FacetDeletionReceiptStore(db).read(11)).toEqual({ id: 11, generation: 1 });
  });

  test("refuses a facet id that cannot name a facet", () => {
    // Zero is the root, which is not a facet and cannot be deleted.
    expect(() => store.record(0)).toThrow("is not one");
    expect(() => store.record(-1)).toThrow("is not one");
    expect(() => store.record(1.5)).toThrow("is not one");
    expect(() => store.read(0)).toThrow("is not one");
  });

  test("refuses a row a foreign writer corrupted", async () => {
    const db = await newDatabase();
    const store2 = new FacetDeletionReceiptStore(db);
    store2.record(6);
    db.exec("UPDATE _cf_FACET_DELETIONS SET generation = 0 WHERE facet_id = 6", []);
    expect(() => store2.read(6)).toThrow("invalid generation");
    expect(() => store2.list()).toThrow("invalid generation");
  });
});

describe("FacetDeletionController", () => {
  test("records, deletes, then clears the receipt", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    const removed: number[] = [];
    const controller = new FacetDeletionController(store, async (receipt) => {
      // The receipt is still on disk while the deletion runs, which is what makes a crash here
      // replayable.
      expect(store.read(receipt.id)).toEqual(receipt);
      removed.push(receipt.id);
    });

    await controller.delete(5);
    expect(removed).toEqual([5]);
    expect(store.read(5)).toBeUndefined();
  });

  test("leaves the receipt behind when the deletion fails", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    const controller = new FacetDeletionController(store, () =>
      Promise.reject(new Error("storage is busy")),
    );

    await expect(controller.delete(5)).rejects.toThrow("storage is busy");
    expect(store.read(5)).toEqual({ id: 5, generation: 1 });
  });

  test("a second delete while the first is in flight runs after it, not with it", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    const gate = deferred();
    const order: string[] = [];
    let first = true;
    const controller = new FacetDeletionController(store, async () => {
      const mine = first;
      first = false;
      order.push(mine ? "first:enter" : "second:enter");
      if (mine) await gate.promise;
      order.push(mine ? "first:exit" : "second:exit");
    });

    const a = controller.delete(5);
    const b = controller.delete(5);
    expect(order).toEqual([]);
    await Promise.resolve();
    gate.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
    expect(store.read(5)).toBeUndefined();
  });

  test("a second delete at the same generation joins the in-flight one", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    const deleteSubtree = vi.fn(() => Promise.resolve());
    const controller = new FacetDeletionController(store, deleteSubtree);

    const receipt = store.record(5);
    // `flush` reads the receipt rather than recording a new one, so two concurrent flushes are
    // one deletion. Anything else would delete the same subtree twice.
    await Promise.all([controller.flush(receipt.id), controller.flush(receipt.id)]);
    expect(deleteSubtree).toHaveBeenCalledTimes(1);
  });

  test("a failed attempt does not stop the request that follows it", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    let attempts = 0;
    const controller = new FacetDeletionController(store, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first attempt fails");
    });

    const failing = controller.delete(5);
    const following = controller.delete(5);
    await expect(failing).rejects.toThrow("first attempt fails");
    await following;
    expect(attempts).toBe(2);
    expect(store.read(5)).toBeUndefined();
  });

  test("recoverAll replays every receipt a previous session left", async () => {
    const db = await newDatabase();
    new FacetDeletionReceiptStore(db).record(2);
    new FacetDeletionReceiptStore(db).record(8);

    const store = new FacetDeletionReceiptStore(db);
    const removed: number[] = [];
    await new FacetDeletionController(store, async (receipt) => {
      removed.push(receipt.id);
    }).recoverAll();

    expect(removed.sort((a, b) => a - b)).toEqual([2, 8]);
    expect(store.list()).toEqual([]);
  });

  test("flush retries until nothing is recorded, including a request made mid-flight", async () => {
    const store = new FacetDeletionReceiptStore(await newDatabase());
    let removals = 0;
    const controller = new FacetDeletionController(store, async () => {
      removals += 1;
      // A delete arriving while the first removal runs records a newer generation, so the
      // completing attempt cannot clear it and the flush loop has to come back round.
      if (removals === 1) store.record(5);
    });

    store.record(5);
    await controller.flush(5);
    expect(removals).toBe(2);
    expect(store.read(5)).toBeUndefined();
  });
});

describe("SerializedSubtreeDeletionQueue", () => {
  test("runs queued operations one at a time, in order", async () => {
    const queue = new SerializedSubtreeDeletionQueue();
    const gate = deferred();
    const order: string[] = [];

    const first = queue.run([1], async () => {
      order.push("first");
      await gate.promise;
    });
    const second = queue.run([2], async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("waitFor waits on an operation covering the id and not on one that does not", async () => {
    const queue = new SerializedSubtreeDeletionQueue();
    const gate = deferred();
    const running = queue.run([3, 4], () => gate.promise);

    let covered = false;
    void queue.waitFor(4).then(() => {
      covered = true;
    });
    let uncovered = false;
    void queue.waitFor(5).then(() => {
      uncovered = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(uncovered).toBe(true);
    expect(covered).toBe(false);

    gate.resolve();
    await running;
    await queue.waitFor(4);
    expect(covered).toBe(true);
  });

  test("a failed operation neither cancels the queue nor rejects a waiter", async () => {
    const queue = new SerializedSubtreeDeletionQueue();
    const failing = queue.run([1], () => Promise.reject(new Error("removal failed")));
    const following = queue.run([2], () => Promise.resolve());

    // The caller of the failing deletion still hears about it...
    await expect(failing).rejects.toThrow("removal failed");
    // ...and nobody else does.
    await expect(queue.waitFor(1)).resolves.toBeUndefined();
    await expect(following).resolves.toBeUndefined();
  });

  test("waitFor resolves once the covering operation is finished", async () => {
    const queue = new SerializedSubtreeDeletionQueue();
    await queue.run([9], () => Promise.resolve());
    await expect(queue.waitFor(9)).resolves.toBeUndefined();
  });
});

describe("FacetReferenceEpochs", () => {
  test("a capture stays current until something invalidates it", () => {
    const epochs = new FacetReferenceEpochs();
    const epoch = epochs.capture(3);
    expect(epochs.isCurrent(3, epoch)).toBe(true);
    epochs.invalidate(3);
    expect(epochs.isCurrent(3, epoch)).toBe(false);
    expect(epochs.isCurrent(3, epochs.capture(3))).toBe(true);
  });

  test("invalidating a root invalidates the subtree it was given", () => {
    const epochs = new FacetReferenceEpochs();
    const root = epochs.capture(1);
    const child = epochs.capture(2);
    const stranger = epochs.capture(3);

    epochs.invalidate(1, [2]);

    expect(epochs.isCurrent(1, root)).toBe(false);
    expect(epochs.isCurrent(2, child)).toBe(false);
    // Ancestry is not derivable from an id, so anything not named stays current — which is why
    // every caller passes the subtree it computed from the index.
    expect(epochs.isCurrent(3, stranger)).toBe(true);
  });

  test("a never-captured id reads as epoch zero and is invalidated all the same", () => {
    const epochs = new FacetReferenceEpochs();
    expect(epochs.isCurrent(42, 0)).toBe(true);
    epochs.invalidate(42);
    expect(epochs.isCurrent(42, 0)).toBe(false);
  });

  test("repeated invalidation keeps moving forward", () => {
    const epochs = new FacetReferenceEpochs();
    const first = epochs.capture(1);
    epochs.invalidate(1);
    const second = epochs.capture(1);
    epochs.invalidate(1);
    expect(epochs.isCurrent(1, first)).toBe(false);
    expect(epochs.isCurrent(1, second)).toBe(false);
    expect(second).toBe(first + 1);
  });
});
