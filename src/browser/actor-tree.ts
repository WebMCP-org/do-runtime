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

type Attachment = Pick<ActorContainerOptions, "id" | "uniqueKey" | "gateHooks"> & {
  readonly tree: FacetTree;
  readonly ports: Pick<ActorPorts, "timer" | "fetch">;
};

class Scope<Context> implements BrowserFacetScope<Context> {
  container: ActorContainer | undefined;
  context: Context | undefined;
  readonly globals = actorScopeBindings(() => {
    if (!this.container) throw new Error(`${this.key} has no live actor scope`);
    return this.container.globals;
  });
  #resources = new DisposableStack();

  begin(): void {
    this.context = undefined;
    this.#resources = new DisposableStack();
  }

  constructor(readonly key: string) {}

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
    const resources = this.#resources;
    resources.dispose();
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
  readonly #live = new Map<
    FacetId,
    BrowserFacetPlacement & { storage: Storage; mirror: HibernationMirror }
  >();
  readonly #scopes = new Map<FacetId, Scope<Context>>();
  readonly #scopeNamespace = `actor-tree-${nextScopeNamespace++}`;
  readonly #starting = new Map<FacetId, { cancelled: boolean; handle: FacetHandle }>();
  #attachment: Attachment | undefined;
  #restoring = new Map<FacetId, BrowserFacetSnapshot>();

  constructor(
    private readonly options: {
      storage(id: FacetId): Storage;
      load(
        request: FacetStartRequest,
        scope: BrowserFacetScope<Context>,
      ): Promise<BrowserFacetDefinition>;
      /** Observe the whole tree using the runtime's event/lease activity owner. */
      activityChanged?(): void;
    },
  ) {}

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
      const next = prior.handle.stub.catch(() => {}).then(() => this.start(request));
      const broken = next.then((handle) => handle.broken);
      void broken.catch(() => {});
      return {
        stub: next.then((handle) => handle.stub),
        broken,
      };
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
    const { promise: stub, resolve, reject: fail } = Promise.withResolvers<object>();
    const { promise: broken, reject } = Promise.withResolvers<never>();
    void broken.catch(() => {});
    const operation = { cancelled: false, handle: { stub, broken } };
    this.#starting.set(request.id, operation);
    const started = (async () => {
      let storage: Storage | undefined;
      let container: ActorContainer | undefined;
      try {
        // load may acquire and register placement capabilities before it imports
        // the bundle. Its captured scope survives abort; its resources do not.
        const definition = await this.options.load(request, binding);
        if (operation.cancelled) throw new Error(`Facet ${request.id} placement was aborted`);
        storage = this.options.storage(request.id);
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
        if (operation.cancelled) throw new Error(`Facet ${request.id} placement was aborted`);
        binding.container = container;
        if (this.options.activityChanged) {
          const stop = container.onActivityChange(this.options.activityChanged);
          binding.use({ [Symbol.dispose]: stop });
        }
        const instance = await container.start(definition.construct);
        if (operation.cancelled) throw new Error(`Facet ${request.id} placement was aborted`);
        const placement = {
          request: { ...request },
          container,
          storage,
          mirror,
          entry: container.entry(instance),
        };
        this.#live.set(request.id, placement);
        this.#restoring.delete(request.id);
        this.#activityChanged();
        return placement;
      } catch (error) {
        try {
          container?.abort(error);
        } finally {
          try {
            storage?.close();
          } finally {
            binding.release();
          }
        }
        throw error;
      } finally {
        if (this.#starting.get(request.id) === operation) this.#starting.delete(request.id);
        this.#activityChanged();
      }
    })();
    void started.then(({ container, entry }) => {
      void container.onBroken.catch(reject);
      resolve(entry);
    }, fail);
    return operation.handle;
  }

  abort(id: FacetId, reason?: string): void {
    const starting = this.#starting.get(id);
    if (starting) starting.cancelled = true;
    const placement = this.#live.get(id);
    this.#live.delete(id);
    try {
      const container = placement?.container ?? this.#scopes.get(id)?.container;
      container?.abort(new Error(reason ?? "Facet placement closed"));
    } finally {
      try {
        placement?.storage.close();
      } finally {
        this.#scopes.get(id)?.release();
      }
    }
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

  async restore(): Promise<void> {
    await Promise.all([...this.#restoring.values()].map(({ request }) => this.start(request).stub));
  }

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
      this.options.activityChanged?.();
    } catch (error) {
      // Match IoContext observers: reporting an observer failure must not
      // invalidate an admitted placement or abandon its finalizer.
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  #storage(id: FacetId): Storage {
    return this.#live.get(id)?.storage ?? this.options.storage(id);
  }
}

/** Observe outside actor entry/await transforms, so the probe cannot count itself. */
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
