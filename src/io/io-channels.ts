/**
 * ← workerd `src/workerd/io/io-channels.h` — `IoChannelFactory::ActorClassChannel`,
 * `ResourceLimits`, `WorkerStubChannel` and `DynamicWorkerSource`.
 *
 * **A partial port, and deliberately so.** `io-channels.h` is 492 lines and
 * almost all of it is outgoing I/O: `SubrequestChannel`, `CacheClient`,
 * `TimerChannel`, logfwdr and channel tokens. Every one of those is either a
 * substrate boundary or a transport concern, and none of them is reachable from
 * the files this module exists to serve. What IS reachable is four types. One is
 * the token `DurableObjectClass` holds and
 * `Worker::Actor::FacetManager::StartInfo` carries, which has to live in `io/`
 * because `io/worker.ts` names it and `io/` may not see `api/`. The other three
 * are the dynamic-worker half `api/worker-loader.ts` consumes; an earlier
 * revision of this header deferred them to Section 7, which is where they landed.
 *
 * Two things upstream has here that this package does not, both for the same
 * reason. `IoChannelFactory` itself is absent because **there is no numbered
 * channel table**: upstream resolves a binding to a `uint` at configuration time
 * and every channel method takes that number, while here a binding is a property
 * of the `env` object the consumer supplies. So every `kj::OneOf<uint,
 * IoOwn<...>>` in `api/actor.ts` keeps only its object arm — which is upstream's
 * own alternative, offered on `DurableObjectNamespace` for exactly the case
 * where a namespace "is constructed dynamically within an execution context,
 * rather than being a long-lived binding". And `ActorChannel` is absent because
 * its one method returns a `WorkerInterface`, capnp dispatch with no port; the
 * JS-visible product of an actor channel is a `Fetcher`, so the two collapse —
 * the same collapse `io/worker.ts`'s `FacetManager.getFacet` and
 * `server/actor-container.ts`'s `FacetHandle.stub` already make. That collapse
 * reaches `SubrequestChannel` too, which is why `DynamicWorkerSource`'s outbound
 * and tail fields below are `Fetcher`s.
 *
 * Spec: §1.10, §1.11, decisions 14 and 15 in
 * docs/decisions.md.
 */

import type { WorkerSource } from "./worker-source";

/**
 * ← `IoChannelFactory::ActorClassChannel`. Upstream: "a reference to an actor
 * class in another worker. This class acts as a token which can be passed into
 * other interfaces that might use the actor class, particularly
 * `Worker::Actor::FacetManager`" and "This class has no functional methods, since
 * it serves as a token to be passed to other interfaces (namely the facets API)."
 *
 * Ours is the same token with the contents workerd keeps opaque made visible,
 * because they have to be: upstream's token is opaque precisely because the class
 * is in another isolate and only the supervisor can resolve it, whereas here the
 * container resolves it against the `ctx.exports` record the consumer handed in.
 * The class name is the host-visible value the container needs to resolve the
 * otherwise opaque token against `ctx.exports`.
 *
 * `requireAllowsTransfer()` is upstream's and is kept, because it is the one
 * behaviour on the token rather than data: it decides whether a stub over this
 * channel may be serialized, and `DurableObjectClass.serialize` calls it before
 * anything else.
 */
export interface ActorClassChannel {
  /** The `ctx.exports` key the container resolves this class under. */
  readonly className: string;

  /**
   * ← `requireAllowsTransfer()`. "Throws a JSG error if a Fetcher backed by this
   * channel should not be serialized and passed to other workers."
   */
  requireAllowsTransfer(): void;
}

// =======================================================================================
// The dynamic-worker half (§1.11)

/**
 * ← `ResourceLimits` (`io-channels.h:375-386`). "provides a means to control the
 * resource allocation for a worker stage via a set of optionally overridden
 * parameters."
 *
 * **It is a no-op in workerd and it is a no-op here.** The bag is accepted by
 * `WorkerLoader.load`, by `WorkerStub.getEntrypoint`/`getDurableObjectClass`, and
 * by both `WorkerStubChannel` methods; the one implementation that receives it —
 * `Server::WorkerLoaderNamespace::WorkerStubImpl::getEntrypointResolved` and
 * `::getActorClassResolved` (`server.c++:4359`, `:4364`) — names the parameter
 * and never reads it. `DynamicWorkerSource.limits` is likewise written by
 * `toDynamicWorkerSource` (`worker-loader.c++:165`) and read by nothing in the
 * open-source tree. So local development never reproduces limit enforcement on
 * either runtime, and a reader who assumes otherwise is reading a field that is
 * carried to production and dropped in workerd. `clone()` is absent for the
 * reason `io/worker-source.ts`'s header gives.
 */
export type ResourceLimits = {
  readonly cpuMs?: number;
  readonly subRequests?: number;
};

/**
 * ← `CompatibilityDateValidation` (`io/compatibility-date.h:12-32`). How far into
 * the future a dynamic Worker's `compatibilityDate` may be, which upstream says
 * "will differ between workerd vs. production".
 */
export type CompatibilityDateValidation =
  /** "Allow dates up through the date specified by `supportedCompatibilityDate`." */
  | "codeVersion"
  /** "Allow dates up to through the current date. This should ONLY be used by Cloudflare." */
  | "currentDateForCloudflare"
  /** "Allow any future date. This should only be used to test `compileCompatibilityFlags` itself." */
  | "futureForTest";

/**
 * ← the arguments `compileCompatibilityFlags` takes
 * (`io/compatibility-date.h:38-44`), where upstream's `DynamicWorkerSource` holds
 * the compiled `CompatibilityFlags::Reader` it returns.
 *
 * **The compilation is a substrate boundary and this is the request that replaces
 * it.** `compileCompatibilityFlags` walks the capnp *schema* of
 * `CompatibilityFlags` reflectively — every flag's enable/disable names, its
 * default-on date and its experimental annotation are schema annotations
 * (`io/compatibility-date.c++:102-260`) — and this package has no
 * `compatibility-date.capnp`, no schema reflection and no `FeatureFlags`. It is
 * the same absence the four flags `api/actor.ts` meets already records. So the
 * inputs travel to whatever is on the far side of `loadIsolate`, which is the
 * layer that has an isolate to configure and therefore the only layer that could
 * validate them.
 */
export type CompatibilityFlagsRequest = {
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly allowExperimental: boolean;
  readonly dateValidation: CompatibilityDateValidation;
};

/**
 * ← the two arguments `WorkerStubChannel`'s methods take besides the entrypoint
 * name (`io-channels.h:397-406`).
 *
 * `props` is upstream's `Frankenvalue`, which is a JS value plus a cap table; here
 * it is the JS value, because there is no numbered channel table for a cap table
 * to index.
 */
export type EntrypointRequest = {
  /** `kj::none` selects the default entrypoint, as `"default"` does. */
  readonly name: string | undefined;
  readonly props: unknown;
  readonly limits: ResourceLimits | undefined;
};

/**
 * ← `WorkerStubChannel` (`io-channels.h:390-408`). "Represents a dynamically-loaded
 * Worker to which requests can be sent. This object is returned before the Worker
 * actually loads, so if any errors occur while loading, any requests sent to the
 * Worker will fail, propagating the exception."
 *
 * That last sentence is the contract `api/worker-loader.ts` depends on twice over:
 * it is why `WorkerLoader.get` can return a stub synchronously while its code
 * callback has not run, and it is why upstream's own tests assert a bad module
 * list from `worker.getEntrypoint().greet(...)` rather than from `get()`
 * (`api/tests/worker-loader-test.js:812`).
 *
 * Upstream splits each method in two — a non-virtual half that "waits for `props`
 * to resolve first" and a virtual `…Resolved` half. The waiting half resolves
 * `Frankenvalue` cap-table entries that are still promises; a JS value has no
 * unresolved arm, so the pair collapses to one method.
 */
export interface WorkerStubChannel {
  /** ← `getEntrypoint` / `getEntrypointResolved`, with `SubrequestChannel` collapsed. */
  getEntrypoint(request: EntrypointRequest): Fetcher;
  /** ← `getActorClass` / `getActorClassResolved`. */
  getActorClass(request: EntrypointRequest): ActorClassChannel;
}

/**
 * ← `DynamicWorkerSource` (`io-channels.h:411-455`). "Source code needed to
 * dynamically load a Worker."
 *
 * Field for field, with three departures, each recorded on the type it touches:
 * `compatibilityFlags` carries the request rather than the compiled reader
 * (`CompatibilityFlagsRequest` above), the three `SubrequestChannel` fields are
 * `Fetcher`s (this file's header), and `ownContent` / `ownContentIsRpcResponse` /
 * `clone()` / `ensureAllResolved()` are kj lifetime bookkeeping with nothing to
 * bookkeep (`io/worker-source.ts`'s header).
 */
export type DynamicWorkerSource = {
  readonly source: WorkerSource;
  readonly compatibilityFlags: CompatibilityFlagsRequest;
  readonly limits: ResourceLimits | undefined;
  /**
   * "`env` object to pass to the loaded worker. Can contain anything that can be
   * serialized to a `Frankenvalue`."
   */
  readonly env: unknown;
  /**
   * "Where should global fetch() (and connect()) be sent?"
   *
   * **`undefined` means blocked, and that is upstream's encoding rather than a
   * shorthand.** The JS-facing `globalOutbound` has three states — omitted, `null`,
   * a `Fetcher` — and `toDynamicWorkerSource` collapses them to two here:
   * `kj::none` is written only for the explicit `null`, while the omitted case is
   * resolved at that layer into the calling worker's own outbound
   * (`worker-loader.c++:122-139`). By the time a source exists, "inherit" is no
   * longer a state.
   */
  readonly globalOutbound: Fetcher | undefined;
  /** "Tail workers that should receive tail events for invocations of the dynamic worker." */
  readonly tails: readonly Fetcher[];
  readonly streamingTails: readonly Fetcher[];
};
