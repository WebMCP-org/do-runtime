import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { DEFAULT_ALARM_OUTLET } from "../io/actor-sqlite";
import {
  createActorContainer,
  noFacets,
  type ActorEntry,
  type FacetHost,
  type FacetStartRequest,
} from "../server/actor-container";
import { platformTimer } from "../api/platform";
import { BrowserActorTree, isActorQuiescent, type BrowserActorTreeOptions } from "./actor-tree";

class Storage {
  readonly provider;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.provider = createNodeSqlProvider({ directory });
  }
  open(name: string) {
    return this.provider.open(name);
  }
  close() {
    this.provider.close();
  }
  deleteAll() {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
  async copyFrom(source: Storage) {
    source.close();
    this.close();
    await this.provider.importSnapshot(await source.provider.exportSnapshot());
  }
}

const request: FacetStartRequest = { id: 1, depth: 1, className: "Child", name: "Child\0one" };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A root container on real SQLite in a scratch directory, removed on dispose. */
async function createRoot(uniqueKey: string, facets: FacetHost = noFacets, directory = scratch()) {
  const storage = new Storage(join(directory, "root"));
  const root = await createActorContainer({
    id: "root",
    uniqueKey,
    env: {},
    exports: {},
    ports: { sql: storage, facets, alarms: DEFAULT_ALARM_OUTLET, timer: platformTimer },
  });
  return {
    root,
    [Symbol.dispose]() {
      root.abort("finished");
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** A browser actor tree attached to its root, with each facet's storage beside the root's. */
async function createTree<Context = undefined>(
  uniqueKey: string,
  options: Omit<BrowserActorTreeOptions<Storage, Context>, "storage">,
) {
  const directory = scratch();
  const tree = new BrowserActorTree<Storage, Context>({
    ...options,
    storage: (id) => new Storage(join(directory, `facet-${id}`)),
  });
  const placed = await createRoot(uniqueKey, tree, directory);
  tree.attach({ id: "root", uniqueKey, tree: placed.root.facetTree, ports: { timer: platformTimer } });
  return {
    tree,
    root: placed.root,
    [Symbol.dispose]() {
      tree.closeAll();
      placed[Symbol.dispose]();
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "browser-actor-tree-"));
}

test("full events stay active while I/O releases the gate, and leases/background work notify their settlement", async () => {
  using placed = await createRoot("activity");
  const container = placed.root;
  const observed: boolean[] = [];
  const stopObserving = container.onActivityChange(() =>
    observed.push(isActorQuiescent(container)),
  );
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    const entry = container.entry({
      async wait() {
        started.resolve();
        await finish.promise;
        return "done";
      },
      peer() {
        return 42;
      },
    });
    const work = entry.wait();
    await started.promise;
    await vi.waitFor(() =>
      expect(container.quiescence()).toMatchObject({ pendingEvents: 1, inputLockHeld: false }),
    );
    expect(isActorQuiescent(container)).toBe(false);
    expect(await entry.peer()).toBe(42);
    const release = container.acquireActivity();
    finish.resolve();
    expect(await work).toBe("done");
    await vi.waitFor(() =>
      expect(container.quiescence()).toMatchObject({ pendingEvents: 0, activityLeases: 1 }),
    );
    release();
    release();
    await vi.waitFor(() => expect(isActorQuiescent(container)).toBe(true));

    const background = Promise.withResolvers<void>();
    await container.run(() => container.state.waitUntil(background.promise));
    await vi.waitFor(() =>
      expect(container.quiescence()).toMatchObject({ pendingEvents: 0, pendingWaitUntil: 1 }),
    );
    expect(isActorQuiescent(container)).toBe(false);
    background.resolve();
    await container.drainWaitUntil();
    expect(observed).toContain(false);
    await vi.waitFor(() => expect(observed.at(-1)).toBe(true));
  } finally {
    finish.resolve();
    stopObserving();
  }
});

test("queued admission cancellation releases activity without cancelling the admitted event", async () => {
  using placed = await createRoot("admission");
  const container = placed.root;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  let invoked = false;
  try {
    const held = container.run(() =>
      container.state.blockConcurrencyWhile(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const waiting = container
      .entry(
        {
          run() {
            invoked = true;
          },
        },
        abort.signal,
      )
      .run();
    expect(container.quiescence().pendingEvents).toBeGreaterThan(1);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(invoked).toBe(false);
    expect(isActorQuiescent(container)).toBe(false);
    release.resolve();
    await held;
    await container.drainWaitUntil();
    await vi.waitFor(() => expect(isActorQuiescent(container)).toBe(true));
  } finally {
    release.resolve();
  }
});

test("facet construction failure releases capabilities and storage; replacement reuses its bound scope", async () => {
  const released: number[] = [];
  let sequence = 0;
  let fail = true;
  let originalScope: object | undefined;
  using placed = await createTree<number>("tree", {
    async load(_request, scope) {
      originalScope ??= scope;
      expect(scope).toBe(originalScope);
      const identity = ++sequence;
      scope.use({
        [Symbol.dispose]() {
          released.push(identity);
        },
      });
      scope.context = identity;
      return {
        env: {},
        exports: {},
        construct(ctx) {
          ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS values_seen (value INTEGER)");
          if (fail) {
            fail = false;
            throw new Error("constructor refused");
          }
          return {
            identity() {
              return scope.context;
            },
            write(value: number) {
              ctx.storage.sql.exec("INSERT INTO values_seen VALUES (?)", value);
            },
            read() {
              return ctx.storage.sql.exec("SELECT value FROM values_seen").toArray();
            },
          };
        },
      };
    },
  });
  const { tree, root } = placed;
  type Child = { identity(): number; write(value: number): void; read(): { value: number }[] };
  await expect(tree.start(request).stub).rejects.toThrow("constructor refused");
  expect(released).toEqual([1]);
  expect(tree.placements()).toHaveLength(0);
  const entry = (await tree.start(request).stub) as ActorEntry<Child>;
  expect(await entry.identity()).toBe(2);
  await entry.write(7);
  tree.abort(request.id);
  expect(released).toEqual([1, 2]);
  const replaced = (await tree.start(request).stub) as ActorEntry<Child>;
  expect(await replaced.identity()).toBe(3);
  expect(await replaced.read()).toEqual([{ value: 7 }]);
  await root
    .entry({
      alive() {
        return "alive";
      },
    })
    .alive();
});

test.each(["load", "construct"])(
  "concurrent starts share admission and abort during %s never resurrects a placement or releases its replacement",
  async (phase) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const released: number[] = [];
    let loads = 0;
    using placed = await createTree("load", {
      async load(_request, scope) {
        const identity = ++loads;
        scope.use({
          [Symbol.dispose]() {
            released.push(identity);
          },
        });
        if (identity === 1 && phase === "load") {
          entered.resolve();
          await resume.promise;
        }
        return {
          env: {},
          exports: {},
          async construct() {
            if (identity === 1 && phase === "construct") {
              entered.resolve();
              await resume.promise;
            }
            return {
              identity() {
                return identity;
              },
            };
          },
        };
      },
    });
    const { tree } = placed;
    try {
      const first = tree.start(request);
      const duplicate = tree.start(request);
      expect(first).toBe(duplicate);
      await entered.promise;
      tree.abort(request.id);
      expect(released).toEqual([1]);
      const next = tree.start(request);
      resume.resolve();
      await expect(first.stub).rejects.toThrow("aborted");
      const entry = (await next.stub) as ActorEntry<{ identity(): number }>;
      expect(await entry.identity()).toBe(2);
      expect(released).toEqual([1]);
      expect(tree.placements()).toHaveLength(1);
      tree.abort(request.id);
      expect(released).toEqual([1, 2]);
    } finally {
      resume.resolve();
    }
  },
);

test("activity observer errors are reported without corrupting a successful facet placement", async () => {
  const errors: unknown[] = [];
  const nativeQueue = globalThis.queueMicrotask;
  // A platform error sink preserves real microtask scheduling while collecting
  // the observer exceptions the runtime deliberately reports outside the event.
  const errorSink = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) =>
    nativeQueue(() => {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }),
  );
  const observerError = new Error("activity observer failed");
  try {
    // Disposed inside the try: teardown reports observer errors to the sink too.
    using placed = await createTree("observer", {
      async load() {
        return {
          env: {},
          exports: {},
          construct: () => ({
            value() {
              return 42;
            },
          }),
        };
      },
      activityChanged() {
        throw observerError;
      },
    });
    const { tree } = placed;
    const entry = (await tree.start(request).stub) as ActorEntry<{ value(): number }>;
    expect(await entry.value()).toBe(42);
    await vi.waitFor(() => expect(tree.isQuiescent()).toBe(true));
    expect(tree.placements()).toHaveLength(1);
    expect(errors).toContain(observerError);
  } finally {
    await tick();
    errorSink.mockRestore();
  }
});

test("a placed facet whose container breaks reports its request and reason to the host", async () => {
  const broken: [FacetStartRequest, unknown][] = [];
  using placed = await createTree("broken", {
    async load() {
      return {
        env: {},
        exports: {},
        construct: (ctx) => ({
          crash() {
            ctx.abort("child crashed");
          },
        }),
      };
    },
    broken(request, reason) {
      broken.push([request, reason]);
    },
  });
  const handle = placed.tree.start(request);
  const entry = (await handle.stub) as ActorEntry<{ crash(): void }>;
  expect(broken).toEqual([]);
  await entry.crash().catch(() => {});
  await expect(handle.broken).rejects.toThrow("child crashed");
  expect(broken).toHaveLength(1);
  expect(broken[0]![0]).toEqual(request);
  expect(String(broken[0]![1])).toContain("child crashed");
});
