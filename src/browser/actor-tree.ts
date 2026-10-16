import { actorScopeBindings, type ActorScopeBindings } from "../api/global-scope";
import type { DurableObjectState } from "../api/actor-state";
import type { RehydratedWebSocket } from "../api/web-socket";
import {
  createActorContainer,
  type ActorContainer,
  type ActorContainerOptions,
  type ActorEntry,
  type ActorPorts,
  type FacetHandle,
  type FacetHost,
  type FacetId,
  type FacetStartRequest,
  type FacetTree,
} from "../server/actor-container";
import { HibernationMirror, type HibernationAutoResponse } from "../server/hibernation-mirror";
import { DEFAULT_ALARM_OUTLET } from "../io/actor-sqlite";
import type { SqlDatabaseProvider } from "../util/sqlite";

/** A backend owns every database belonging to one facet, including unopened files. */
export interface FacetStorage<Storage> extends SqlDatabaseProvider {
  close(): void;
  deleteAll(): void;
  copyFrom(source: Storage): Promise<void>;
}

/** One bundle's stable bindings, reused when its facet is placed again. */
export interface BrowserFacetScope<Context> {
  readonly key: string;
  readonly container: ActorContainer | undefined;
  readonly globals: ActorScopeBindings;
  /** Application capabilities for this placement; cleared when placement ends. */
  context: Context | undefined;
  /** Own a placement capability before evaluating the module that reads it. */
  use<T extends Disposable>(resource: T): T;
}

export interface BrowserFacetDefinition {
  construct(ctx: DurableObjectState, env: unknown): object;
  env: unknown;
  exports: Record<string, unknown>;
}

export type BrowserFacetSnapshot = {
  readonly request: FacetStartRequest;
  readonly sockets: readonly RehydratedWebSocket[];
  readonly autoResponse: HibernationAutoResponse | null;
};

export type BrowserFacetPlacement = {
  readonly request: FacetStartRequest;
  readonly container: ActorContainer;
  readonly entry: ActorEntry<object>;
};

export type BrowserActorTreeOptions<Storage, Context> = {
  storage(id: FacetId): Storage;
  load(
    request: FacetStartRequest,
    scope: BrowserFacetScope<Context>,
  ): Promise<BrowserFacetDefinition>;
  /** Observe the whole tree using the runtime's event/lease activity owner. */
  activityChanged?(): void;
  /** A placed facet's container broke (including an abort); its work is gone. */
  broken?(request: FacetStartRequest, reason: unknown): void;
};

type Attachment = Pick<ActorContainerOptions, "id" | "uniqueKey" | "gateHooks"> & {
  readonly tree: FacetTree;
  readonly ports: Pick<ActorPorts, "timer" | "fetch">;
};

type LivePlacement<Storage> = BrowserFacetPlacement & {
  readonly storage: Storage;
  readonly mirror: HibernationMirror;
};

class Scope<Context> implements BrowserFacetScope<Context> {
  container: ActorContainer | undefined;
  context: Context | undefined;
  readonly globals = actorScopeBindings(() => {
    if (!this.container) throw new Error(`${this.key} has no live actor scope`);
    return this.container.globals;
  });
  #resources = new DisposableStack();

  constructor(readonly key: string) {}

  begin(): void {
    this.context = undefined;
    this.#resources = new DisposableStack();
  }

  use<T extends Disposable>(resource: T): T {
    if (this.#resources.disposed) {
      resource[Symbol.dispose]();
      throw new Error(`${this.key} placement was aborted`);
    }
    return this.#resources.use(resource);
  }

  release(): void {
    this.container = undefined;
    this.context = undefined;
    this.#resources.dispose();
  }
}

let nextScopeNamespace = 0;

/**
 * Same-realm browser facet placement. The root supplies its canonical tree;
 * this host owns child containers, bundle scopes and physical storage lifetimes.
 * Naming, deletion receipts, epochs and recursive clone remain ActorContainer's.
 */
export class BrowserActorTree<
  Storage extends FacetStorage<Storage>,
  Context = undefined,
> implements FacetHost {
  readonly #options: BrowserActorTreeOptions<Storage, Context>;
  readonly #live = new Map<FacetId, LivePlacement<Storage>>();
  readonly #scopes = new Map<FacetId, Scope<Context>>();
  readonly #scopeNamespace = `actor-tree-${nextScopeNamespace++}`;
  readonly #starting = new Map<FacetId, { cancelled: boolean; handle: FacetHandle }>();
  #attachment: Attachment | undefined;
  #restoring = new Map<FacetId, BrowserFacetSnapshot>();

  constructor(options: BrowserActorTreeOptions<Storage, Context>) {
    this.#options = options;
  }

  attach(attachment: Attachment, restoring: readonly BrowserFacetSnapshot[] = []): void {
    if (this.#live.size || this.#starting.size)
      throw new Error("Cannot replace a browser actor tree with live facets");
    this.#attachment = attachment;
    this.#restoring = new Map(restoring.map((snapshot) => [snapshot.request.id, snapshot]));
  }

  start(request: FacetStartRequest): FacetHandle {
    const current = this.#live.get(request.id);
    if (current)
      return { stub: Promise.resolve(current.entry), broken: current.container.onBroken };
    const prior = this.#starting.get(request.id);
    if (prior) {
      if (!prior.cancelled) return prior.handle;
      // An aborted start still owns its storage until it unwinds.
      const next = prior.handle.stub.catch(() => {}).then(() => this.start(request));
      const broken = next.then((handle) => handle.broken);
      void broken.catch(() => {});
      return { stub: next.then((handle) => handle.stub), broken };
    }
    const attachment = this.#attachment;
    if (!attachment) throw new Error("Browser actor tree reached before root attachment");
    let scope = this.#scopes.get(request.id);
    if (!scope) {
      scope = new Scope(`${this.#scopeNamespace}-facet-${request.id}`);
      this.#scopes.set(request.id, scope);
    }
    const binding = scope;
    binding.begin();
    const stub = Promise.withResolvers<object>();
    const broken = Promise.withResolvers<never>();
    void broken.promise.catch(() => {});
    const operation = {
      cancelled: false,
      handle: { stub: stub.promise, broken: broken.promise },
    };
    // Registered before `load` runs, so a re-entrant start shares this placement.
    this.#starting.set(request.id, operation);
    const throwIfAborted = (): void => {
      if (operation.cancelled) throw new Error(`Facet ${request.id} placement was aborted`);
    };
    const started = (async () => {
      let storage: Storage | undefined;
      let container: ActorContainer | undefined;
      try {
        // load may acquire and register placement capabilities before it imports
        // the bundle. Its captured scope survives abort; its resources do not.
        const definition = await this.#options.load(request, binding);
        throwIfAborted();
        storage = this.#options.storage(request.id);
        const restored = this.#restoring.get(request.id);
        if (restored) assertSameRequest(request, restored.request);
        const mirror = new HibernationMirror(restored?.sockets, restored?.autoResponse);
        container = await createActorContainer({
          id: request.routedId ?? attachment.id,
          uniqueKey: attachment.uniqueKey,
          env: definition.env,
          exports: definition.exports,
          ...(attachment.gateHooks && { gateHooks: attachment.gateHooks }),
          ports: {
            ...attachment.ports,
            sql: storage,
            alarms: DEFAULT_ALARM_OUTLET,
            facets: this,
            hibernation: mirror,
          },
          webSockets: mirror.snapshot(),
          facet: { depth: request.depth, id: request.id, tree: attachment.tree },
        });
        throwIfAborted();
        binding.container = container;
        if (this.#options.activityChanged) {
          const stop = container.onActivityChange(this.#options.activityChanged);
          binding.use({ [Symbol.dispose]: stop });
        }
        const instance = await container.start(definition.construct);
        throwIfAborted();
        const placement = {
          request: { ...request },
          container,
          storage,
          mirror,
          entry: container.entry(instance),
        };
        this.#live.set(request.id, placement);
        this.#restoring.delete(request.id);
        return placement;
      } catch (error) {
        // Disposes in reverse: the container, its storage, then the scope's resources.
        const cleanup = new DisposableStack();
        cleanup.defer(() => binding.release());
        cleanup.defer(() => storage?.close());
        cleanup.defer(() => container?.abort(error));
        cleanup.dispose();
        throw error;
      } finally {
        if (this.#starting.get(request.id) === operation) this.#starting.delete(request.id);
        this.#activityChanged();
      }
    })();
    void started.then(({ container, entry }) => {
      void container.onBroken.catch((reason: unknown) => {
        broken.reject(reason);
        this.#options.broken?.(request, reason);
      });
      stub.resolve(entry);
    }, stub.reject);
    return operation.handle;
  }

  abort(id: FacetId, reason?: string): void {
    const starting = this.#starting.get(id);
    if (starting) starting.cancelled = true;
    const placement = this.#live.get(id);
    this.#live.delete(id);
    const scope = this.#scopes.get(id);
    const container = placement?.container ?? scope?.container;
    // Disposes in reverse: the container, its storage, then the scope's resources.
    const cleanup = new DisposableStack();
    cleanup.defer(() => scope?.release());
    cleanup.defer(() => placement?.storage.close());
    cleanup.defer(() => container?.abort(new Error(reason ?? "Facet placement closed")));
    cleanup.dispose();
  }

  async deleteStorage(id: FacetId, subtree: readonly FacetId[]): Promise<void> {
    for (const target of [...subtree, id]) {
      const pending = this.#starting.get(target)?.handle.stub;
      const storage = this.#storage(target);
      this.abort(target);
      await pending?.catch(() => {});
      storage.deleteAll();
    }
  }

  async copyStorage(source: FacetId, target: FacetId): Promise<void> {
    await this.#storage(target).copyFrom(this.#storage(source));
  }

  placements(): readonly BrowserFacetPlacement[] {
    return [...this.#live.values()];
  }

  closeAll(): void {
    for (const id of new Set([...this.#live.keys(), ...this.#starting.keys()])) this.abort(id);
  }

  drainWaitUntil(): Promise<void[]> {
    return Promise.all([...this.#live.values()].map(({ container }) => container.drainWaitUntil()));
  }

  isQuiescent(): boolean {
    return (
      this.#starting.size === 0 &&
      [...this.#live.values()].every(({ container }) => isActorQuiescent(container))
    );
  }

  /** Start every facet supplied to `attach()` as hibernated. */
  async restore(): Promise<void> {
    await Promise.all([...this.#restoring.values()].map(({ request }) => this.start(request).stub));
  }

  /** The live facets holding hibernatable sockets or an auto-response. */
  snapshot(): BrowserFacetSnapshot[] {
    return [...this.#live.values()]
      .map(({ request, mirror }) => ({
        request: { ...request },
        sockets: mirror.snapshot(),
        autoResponse: mirror.autoResponsePair,
      }))
      .filter(({ sockets, autoResponse }) => sockets.length !== 0 || autoResponse !== null);
  }

  #activityChanged(): void {
    try {
      this.#options.activityChanged?.();
    } catch (error) {
      // Match IoContext observers: reporting an observer failure must not
      // invalidate an admitted placement or abandon its finalizer.
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  #storage(id: FacetId): Storage {
    return this.#live.get(id)?.storage ?? this.#options.storage(id);
  }
}

/**
 * No pending event, lease, timer or background work. Call it from outside the
 * actor: an event that asks counts itself.
 */
export function isActorQuiescent(container: ActorContainer): boolean {
  const state = container.quiescence();
  return (
    state.pendingEvents === 0 &&
    state.activityLeases === 0 &&
    state.armedTimers === 0 &&
    state.pendingWaitUntil === 0 &&
    !state.inputLockHeld &&
    !state.outputGateBroken
  );
}

function assertSameRequest(current: FacetStartRequest, restored: FacetStartRequest): void {
  if (
    current.id !== restored.id ||
    current.name !== restored.name ||
    current.className !== restored.className ||
    current.depth !== restored.depth ||
    current.routedId !== restored.routedId
  )
    throw new Error(`Hibernated facet ${restored.id} no longer matches its routed placement`);
}
