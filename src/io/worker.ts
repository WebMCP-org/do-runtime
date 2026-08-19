/**
 * ← workerd `src/workerd/io/worker.h` — `Worker::Actor::FacetManager` only
 * (`io/worker.h:901`).
 *
 * This file exists to settle a layering question the scaffolding got backwards.
 * The facet surface `api/actor-state.ts` consumes was declared in
 * `server/actor-container.ts`, which would give `api/` → `server/` a dependency
 * upstream does not have: `api/actor-state.c++` includes from `api/`, `io/` and
 * `jsg/` and from `server/` never, and the manager it reaches for is a nested
 * class of `Worker::Actor` in `io/worker.h`. Per the README's rule for a
 * legitimate upstream include crossing a wall, the reference widens to match
 * upstream rather than the files being reshuffled to avoid it.
 *
 * `FacetManager` is not the same interface as `server/actor-container.ts`'s
 * `FacetHost`, and conflating them is what produced the inverted dependency.
 * `FacetHost` is the substrate PLACEMENT port — where a facet runs, the callable
 * stub across that placement, and physical storage deletion — and it has no
 * upstream twin, because workerd's facets are in-process. `FacetManager` is the
 * package-owned layer above it that owns naming, ids, the limits, receipts and
 * `clone()` orchestration, and it is the only facet thing `api/` may see.
 * `server/` implements it on top of `FacetHost`.
 *
 * The rest of `worker.h` — `Worker`, `Worker::Isolate`, `Worker::Lock`,
 * `Worker::Actor` itself — is isolate machinery with no port. The three
 * `Worker::Actor` members `io/io-context.ts` reaches for are declared there, as
 * that file's own comment explains; `assertCanSetAlarm()` joins them because
 * `api/actor-state.c++` reaches for it through
 * `IoContext::current().getActorOrThrow()`.
 *
 * Spec: §1.10, decision 14 in docs/decisions.md.
 */

import type { ActorClassChannel } from "./io-channels";

/**
 * ← `Worker::Actor::FacetManager::StartInfo`.
 *
 * `actorClass` is upstream's own type — a resolved
 * `IoChannelFactory::ActorClassChannel`, which `io/io-channels.ts` ports and
 * `DurableObjectClass.getChannel()` produces. An earlier revision typed it as
 * `DurableObjectClass`, the `@cloudflare/workers-types` interface, which is
 * declared `interface DurableObjectClass<_T> {}` and therefore accepts any
 * object at all: it was `unknown` with a name, and it left `server/` with
 * nothing to resolve a class against. Upstream resolves it one step earlier —
 * `DurableObjectFacets::get` calls `actorClass.getChannel(ioCtx)` inside the
 * reentry callback (`actor-state.c++:1044`) — so `api/actor-state.ts` now does
 * the same and this field carries the resolved channel.
 *
 * `id` is upstream's `Worker::Actor::Id` as the string form of a
 * `DurableObjectId`, which is all a `DurableObjectId` is once it leaves this
 * package, since ids never cross the host boundary.
 */
export type FacetStartInfo = {
  readonly actorClass: ActorClassChannel;
  /** `ctx.id` for the child. Defaults to the parent's, as upstream's does. */
  readonly id: string;
};

/**
 * ← `Worker::Actor::FacetManager` (`io/worker.h:901-931`).
 *
 * Upstream's comment on the last three: "These methods are C++ equivalents of
 * the JavaScript ctx.facets API."
 *
 * `cloneFacet` is the fourth, and it is not in the vendored C++ snapshot — see
 * the note on `DurableObjectFacets.clone` in `api/actor-state.ts`.
 */
export interface FacetManager {
  /** Returns the nesting depth of this facet. Root = 0, direct child of root = 1, etc. */
  getDepth(): number;

  getFacet<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name: string,
    getStartInfo: () => Promise<FacetStartInfo>,
  ): Fetcher<T>;

  abortFacet(name: string, reason: unknown): void;

  deleteFacet(name: string): void;

  /** Aborts `dst`, deletes its storage, then copies the whole `src` subtree onto it. */
  cloneFacet(src: string, dst: string): void;
}

/**
 * The one type assertion the facet surface needs, in one named place so an
 * implementation does not have to reinvent it.
 *
 * `Fetcher<T>` for an unresolved `T` is `Rpc.Provider<T, …> & { fetch, connect }`
 * — a conditional type TypeScript defers until `T` is known, and `T` is the
 * caller's claim about the shape of a class it named. No value can confirm that
 * claim, so no value can be checked against it. Upstream is in exactly the same
 * position and answers it the same way: `DurableObjectFacets::get` returns a
 * plain `jsg::Ref<Fetcher>` and the type parameter exists only inside a
 * `JSG_TS_OVERRIDE`. What IS checked is the half that carries behaviour —
 * `fetch` and `connect` — because the argument is a `Fetcher` before it is
 * widened.
 */
export function asFacetStub<T extends Rpc.DurableObjectBranded | undefined>(
  stub: Fetcher,
): Fetcher<T> {
  return stub as Fetcher<T>;
}
