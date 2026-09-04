/**
 * ← workerd `src/workerd/api/actor.{h,c++}`
 *
 * Upstream's own opening comment is the best summary of why this file is named
 * what it is: "'Actors' are the internal name for Durable Objects, because they
 * implement a sort of actor model. We ended up not calling the product 'Actors'
 * publicly because we found that people who were familiar with actor-model
 * programming were more confused than helped by it."
 *
 * Five classes and three outgoing factories. The five are here:
 * `ColoLocalActorNamespace` (`actor.h:25`), `DurableObjectId` (`:42`),
 * `DurableObject` (`:87`), `DurableObjectNamespace` (`:142`) and
 * `DurableObjectClass` (`:367`). The three factories — `GlobalActorOutgoingFactory`
 * (`:293`), `LocalActorOutgoingFactory` (`:331`) and `ReplicaActorOutgoingFactory`
 * (`:352`) — are **not**, and their absence is the whole of this file's seam:
 * every one of them is a bag of addressing data plus a lazily-created actor
 * channel, and `newSingleUseClient` returns a `WorkerInterface`, which is capnp
 * dispatch with no port. `ActorChannelFactory` and `ColoLocalActorChannelFactory`
 * below are the shape they plug into, holding exactly the fields the two
 * reachable factories' constructors capture.
 * `ActorRetryRequestMetadata` stays on that same omitted transport seam:
 * upstream passes it from an outgoing factory to `ActorChannel`, while the
 * host-provided `Fetcher` here already owns retry policy and exposes no metadata.
 *
 * **`ColoLocalActorNamespace` is ported, not treated as a substrate boundary**,
 * and the reason is worth stating because the opposite call is easy to defend
 * badly. It is the pre-SQLite, non-durable actor namespace, and this host cannot
 * host one — there is no storage-less actor kind here, and `createActorContainer`
 * requires a `SqlDatabaseProvider`. But *hosting* is not in this file. What is in
 * this file is the JS-facing half: one argument check and one outgoing-stub
 * request, which has precisely the same substrate needs as
 * `DurableObjectNamespace.get()`, which nobody proposes cutting. The boundary, if
 * there is one, sits in `server/` at the point something has to place an
 * ephemeral actor — so there is nothing here to cut, and cutting it would be the
 * feature subset the package README forbids.
 *
 * It is also not idle, though an earlier revision of this comment gave the wrong
 * reason. It claimed `ctx.exports` surfaces a storage-less actor class as a
 * `LoopbackColoLocalActorNamespace`; upstream's own comment
 * (`api/export-loopback.h:111-115`) says that case is a
 * `LoopbackDurableObjectClass`. `LoopbackColoLocalActorNamespace` is "for
 * colo-local (ephemeral) actor namespaces" (`:191`) and is built from a
 * *configured* binding, `Global::LoopbackEphemeralActorNamespace`
 * (`server/workerd-api.c++:666-670`) — reachable through configuration rather
 * than through a bare export. The conclusion stands; the path to it is that one.
 *
 * Two things are absent because there is nothing to resolve them against:
 *
 *  - **The numbered-channel arm of every binding.** Each of upstream's
 *    `kj::OneOf<uint, IoOwn<...>>` keeps only its object arm. Upstream resolves a
 *    binding to a `uint` at configuration time; here a binding is a property of
 *    the `env` object the consumer supplies, and there is no channel table for a
 *    number to index. The object arm is upstream's own alternative, offered on
 *    `DurableObjectNamespace` for the case where one "is constructed dynamically
 *    within an execution context, rather than being a long-lived binding" — which
 *    is every binding here.
 *  - **Compatibility flags.** `getEnableVersionApi`, `getReplicaRouting`,
 *    `getDurableObjectGetExisting` and `getDurableObjectFetchRequiresSchemeAuthority`
 *    are read four times in `actor.c++`. A runtime with no deployed history takes
 *    the current behaviour, which is the same judgment `deleteAll()`'s
 *    `deleteAllDeletesAlarm` row already records. The one that is not a flag
 *    decision is `enableReplicaRouting`, which is `false` because replication is a
 *    named substrate boundary in `io/actor-cache.ts`.
 *
 * `serialize`/`deserialize` on `DurableObjectClass` are a boundary of their own:
 * they are built on `jsg::Serializer`, `Frankenvalue`, capnp `rpc::JsValue::External`
 * and channel tokens, none of which has a port. Both throw one named message.
 *
 * Spec: §1.10, §1.11 in docs/decisions.md.
 */

import type { ActorGetMode, ActorId, ActorIdFactory, ActorRoutingMode, ActorVersion } from "../io/actor-id";
import type { ActorClassChannel } from "../io/io-channels";

// =======================================================================================
// Constants

/**
 * ← the `[1, 2048]` bound in `ColoLocalActorNamespace::get`.
 *
 * Upstream compares `actorId.size()`, which for a `kj::String` is **bytes**, so
 * this is measured in UTF-8 bytes rather than in UTF-16 code units. That costs
 * one `TextEncoder` pass and buys an exact match on a bound a caller can hit.
 */
export const MAX_COLO_LOCAL_ACTOR_ID_BYTES = 2048;

/**
 * Upstream never faces this: JSG unwraps a `jsg::Ref<DurableObjectId>` parameter
 * and throws a `TypeError` before the method body runs, so `getInner()` cannot be
 * reached on something that is not one. Here the parameter type is
 * workers-types' structural `DurableObjectId` interface, which any object with a
 * `toString` and an `equals` satisfies — so the unwrap has to be written, and it
 * fails closed rather than guessing at the string form.
 */
export const FOREIGN_ACTOR_ID_MESSAGE =
  "This DurableObjectId was not created by this runtime, so its underlying actor id cannot be " +
  "read. Ids must come from newUniqueId(), idFromName() or idFromString() on a " +
  "DurableObjectNamespace.";

/** Substrate boundary: `jsg::Serializer`, `Frankenvalue` and channel tokens have no port. */
export const ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE =
  "DurableObjectClass cannot be serialized in this runtime: upstream writes a channel token " +
  "through jsg::Serializer and Frankenvalue, and neither the token nor the serializer has an " +
  "equivalent here.";

/**
 * Replication is a named substrate boundary (`io/actor-cache.ts`), so no request
 * this file builds asks for replica routing. Upstream reads
 * `FeatureFlags::get(js).getReplicaRouting()` here.
 */
const ENABLE_REPLICA_ROUTING = false;

// =======================================================================================
// The outgoing seam — the shape the three factories plug into

/**
 * ← what `GlobalActorOutgoingFactory`'s constructor captures (`actor.h:297-303`),
 * one field per constructor parameter minus the channel number.
 */
export type GlobalActorRequest = {
  readonly id: ActorId;
  readonly locationHint: string | undefined;
  readonly mode: ActorGetMode;
  readonly enableReplicaRouting: boolean;
  readonly routingMode: ActorRoutingMode;
  readonly version: ActorVersion | undefined;
};

/**
 * ← `DurableObjectNamespace::ActorChannelFactory` (`actor.h:147-157`) composed
 * with `IoChannelFactory::getGlobalActor`, which is what its one implementation
 * forwards to.
 *
 * The composition is not a shortcut. Upstream's `getGlobalActor` returns an
 * `ActorChannel`, and the only thing done with one is `startRequest(...)` →
 * `WorkerInterface`, which the `Fetcher` then drives. `WorkerInterface` has no
 * port and `Fetcher` construction is `api/http.{h,c++}`'s, which is not ported,
 * so the channel and the stub it produces are one object here — the same collapse
 * `io/worker.ts`'s `FacetManager.getFacet` and `server/actor-container.ts`'s
 * `FacetHandle.stub` already make.
 *
 * Section 7 implements this. The laziness upstream's factory has — "Lazily
 * initialize actorChannel" — belongs to the implementation, not to the interface,
 * because upstream's own laziness is per-`newSingleUseClient` and there is no
 * per-request client here to be lazy about.
 */
export interface ActorChannelFactory {
  getGlobalActor(request: GlobalActorRequest): Fetcher;
}

/** ← what `LocalActorOutgoingFactory`'s constructor captures (`actor.h:333-335`). */
export type ColoLocalActorRequest = {
  readonly actorId: string;
};

/**
 * ← `IoChannelFactory::getColoLocalActor`, reached through
 * `LocalActorOutgoingFactory`.
 *
 * Upstream gives `ColoLocalActorNamespace` only the numbered-channel arm, because
 * an ephemeral namespace is always a configured binding there. With no channel
 * table the factory arm is the only one available, so this is the same
 * substitution upstream itself offers `DurableObjectNamespace` — applied to the
 * one constructor that did not already have it.
 */
export interface ColoLocalActorChannelFactory {
  getColoLocalActor(request: ColoLocalActorRequest): Fetcher;
}

// =======================================================================================
// ColoLocalActorNamespace

/**
 * ← `ColoLocalActorNamespace` (`actor.h:25-37`). "A capability to an ephemeral
 * Actor namespace."
 */
export class ColoLocalActorNamespace implements globalThis.ColoLocalActorNamespace {
  readonly #channel: ColoLocalActorChannelFactory;

  constructor(channel: ColoLocalActorChannelFactory) {
    this.#channel = channel;
  }

  /** ← `ColoLocalActorNamespace::get` (`actor.c++:116-129`). */
  get(actorId: string): Fetcher {
    const bytes = utf8Length(actorId);
    if (!(bytes > 0 && bytes <= MAX_COLO_LOCAL_ACTOR_ID_BYTES)) {
      throw new TypeError(
        `Actor ID length must be in the range [1, ${MAX_COLO_LOCAL_ACTOR_ID_BYTES}].`,
      );
    }
    return this.#channel.getColoLocalActor({ actorId });
  }
}

const textEncoder = new TextEncoder();

/** `kj::String::size()` is bytes; `String.prototype.length` is UTF-16 code units. */
function utf8Length(value: string): number {
  return textEncoder.encode(value).length;
}

// =======================================================================================
// DurableObjectId

/**
 * ← `DurableObjectId` (`actor.h:42-84`). "DurableObjectId type seen by
 * JavaScript."
 *
 * `name` and `jurisdiction` are read from the inner id **once, at construction**,
 * where upstream's are `JSG_READONLY_INSTANCE_PROPERTY`s that re-read it on every
 * access. That is not a preference: `@cloudflare/workers-types` declares both
 * `readonly name?: string`, and under `exactOptionalPropertyTypes` a getter
 * returning `string | undefined` does not satisfy an optional `string`. An own
 * property assigned only when the value exists does, and it is what keeps this
 * class assignable to the interface with no cast (§2.4). The one behaviour lost
 * is `ActorIdImpl::clearName()` (`server/actor-id-impl.h`) taking effect on an
 * already-wrapped id — a `server/`-internal that runs before the id reaches JS.
 */
export class DurableObjectId implements globalThis.DurableObjectId {
  readonly #id: ActorId;
  readonly name?: string;
  readonly jurisdiction?: string;

  constructor(id: ActorId) {
    this.#id = id;
    const name = id.getName();
    if (name !== undefined) this.name = name;
    const jurisdiction = id.getJurisdiction();
    if (jurisdiction !== undefined) this.jurisdiction = jurisdiction;
  }

  /** ← `getInner()`. Not JS-visible upstream either; the outgoing factories take it. */
  getInner(): ActorId {
    return this.#id;
  }

  /** "Converts to a string which can be passed back to the constructor to reproduce the same ID." */
  toString(): string {
    return this.#id.toString();
  }

  equals(other: globalThis.DurableObjectId): boolean {
    return this.#id.equals(requireDurableObjectId(other).getInner());
  }
}

/** The unwrap JSG performs for a `jsg::Ref<DurableObjectId>` parameter. */
function requireDurableObjectId(id: globalThis.DurableObjectId): DurableObjectId {
  if (id instanceof DurableObjectId) return id;
  throw new TypeError(FOREIGN_ACTOR_ID_MESSAGE);
}

// =======================================================================================
// The DurableObject stub

/**
 * ← `DurableObject` (`actor.h:87-139`). "Stub object used to send messages to a
 * remote durable object."
 *
 * Upstream's carries its whole behaviour by `JSG_INHERIT(Fetcher)` and adds
 * exactly two readonly properties. So does this: the `Fetcher` is the transport's
 * and everything except `id` and `name` belongs to it. `asDurableObjectStub`
 * below is where the inheritance goes.
 */
export class DurableObject {
  readonly #id: DurableObjectId;
  readonly #fetcher: Fetcher;

  constructor(id: DurableObjectId, fetcher: Fetcher) {
    this.#id = id;
    this.#fetcher = fetcher;
  }

  /** ← `JSG_READONLY_INSTANCE_PROPERTY(id, getId)`. */
  getId(): DurableObjectId {
    return this.#id;
  }

  /** ← `JSG_READONLY_INSTANCE_PROPERTY(name, getName)`. */
  getName(): string | undefined {
    return this.#id.name;
  }

  /** The `Fetcher` upstream inherits from rather than holds. */
  getFetcher(): Fetcher {
    return this.#fetcher;
  }
}

/**
 * ← `js.alloc<DurableObject>(...)` plus `JSG_INHERIT(Fetcher)` plus the
 * `JSG_TS_OVERRIDE` that renames the resource type to `DurableObjectStub`.
 *
 * The named assertion is the same one `io/worker.ts`'s `asFacetStub` makes and
 * for the same reason: `DurableObjectStub<T>` is `Fetcher<T, …> & { id, name }`,
 * and `Fetcher<T>` for an unresolved `T` is `Rpc.Provider<T, …>`, a conditional
 * type TypeScript defers until `T` is known — where `T` is the caller's claim
 * about a class it named, which no value can confirm. Upstream is in the same
 * position and answers it the same way, with the parameter living only inside a
 * `JSG_TS_OVERRIDE`.
 *
 * The `Proxy` is what JSG inheritance costs in JS. Two properties have to answer
 * from the id and every other property — `fetch`, `connect`, and every RPC method
 * name, which are the whole point of a stub — has to reach the transport with
 * `this` still bound to it. Bound methods are memoised so `stub.foo === stub.foo`,
 * which upstream gets for free by there being one object rather than two.
 */
export function asDurableObjectStub<T extends Rpc.DurableObjectBranded | undefined>(
  object: DurableObject,
): DurableObjectStub<T> {
  const fetcher = object.getFetcher();
  const bound = new Map<string | symbol, unknown>();

  const stub = new Proxy(fetcher, {
    get(target, property): unknown {
      if (property === "id") return object.getId();
      if (property === "name") return object.getName();
      const cached = bound.get(property);
      if (cached !== undefined) return cached;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method: unknown = value.bind(target);
      bound.set(property, method);
      return method;
    },

    has(target, property): boolean {
      if (property === "id" || property === "name") return true;
      return Reflect.has(target, property);
    },

    ownKeys(target): ArrayLike<string | symbol> {
      const keys = Reflect.ownKeys(target).filter((key) => key !== "id" && key !== "name");
      return ["id", "name", ...keys];
    },

    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (property === "id" || property === "name") {
        return {
          value: property === "id" ? object.getId() : object.getName(),
          writable: false,
          enumerable: true,
          // Configurable, because the target does not have these keys and a Proxy may not
          // report a non-configurable descriptor for a property its target lacks.
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  return stub as DurableObjectStub<T>;
}

// =======================================================================================
// DurableObjectNamespace

/** ← `DurableObjectNamespace::NewUniqueIdOptions` (`actor.h:166-177`). */
export type NewUniqueIdOptions = {
  /** "Restricts the new unique ID to a set of colos within a jurisdiction." */
  readonly jurisdiction?: string | null;
};

/** ← `DurableObjectNamespace::GetDurableObjectOptions` (`actor.h:193-234`). */
export type GetDurableObjectOptions = {
  readonly locationHint?: string;
  /**
   * "`routingMode` may be be of interest to applications using Durable Objects
   * replicas. It can be one of the following options: none: the default,
   * indicates we will pick for the application. 'primary-only': guarantees we
   * route directly to the primary (skip any replicas)."
   */
  readonly routingMode?: string;
  readonly version?: { readonly cohort?: string };
};

/**
 * ← `DurableObjectNamespace` (`actor.h:142-291`). "Global durable object class
 * binding type."
 */
export class DurableObjectNamespace<T extends Rpc.DurableObjectBranded | undefined = undefined>
  implements globalThis.DurableObjectNamespace<T>
{
  readonly #channel: ActorChannelFactory;
  readonly #idFactory: ActorIdFactory;

  constructor(channel: ActorChannelFactory, idFactory: ActorIdFactory) {
    this.#channel = channel;
    this.#idFactory = idFactory;
  }

  /**
   * "Create a new unique ID for a durable object that will be allocated nearby
   * the calling colo."
   */
  newUniqueId(options?: NewUniqueIdOptions): DurableObjectId {
    return new DurableObjectId(this.#idFactory.newUniqueId(options?.jurisdiction ?? undefined));
  }

  /**
   * "Create a name-derived ID. Passing in the same `name` (to the same class)
   * will always produce the same ID."
   */
  idFromName(name: string): DurableObjectId {
    return new DurableObjectId(this.#idFactory.idFromName(name));
  }

  /**
   * "Create a DurableObjectId from the stringified form of the ID (as produced by
   * calling `toString()` on a durable object ID). Throws if the ID is not a
   * 64-digit hex number, or if the ID was not originally created for this class."
   */
  idFromString(id: string): DurableObjectId {
    return new DurableObjectId(this.#idFactory.idFromString(id));
  }

  /** "Gets a durable object by ID or creates it if it doesn't already exist." */
  get(id: globalThis.DurableObjectId, options?: GetDurableObjectOptions): DurableObjectStub<T> {
    return this.#getImpl("GET_OR_CREATE", id, options);
  }

  /**
   * "Gets a durable object by name or creates it if it doesn't already exist.
   * Short for `idFromName()` followed by `get()`."
   */
  getByName(name: string, options?: GetDurableObjectOptions): DurableObjectStub<T> {
    return this.#getImpl("GET_OR_CREATE", this.idFromName(name), options);
  }

  /**
   * "Experimental. Gets a durable object by ID if it already exists. Currently,
   * gated for use by cloudflare only."
   *
   * Upstream exposes it only when the `durableObjectGetExisting` compat flag is
   * on, and `@cloudflare/workers-types` 4.20260702.1 does not declare it. It is
   * exposed unconditionally here, which is the current-behaviour reading every
   * other compat flag in this file gets.
   */
  getExisting(
    id: globalThis.DurableObjectId,
    options?: GetDurableObjectOptions,
  ): DurableObjectStub<T> {
    return this.#getImpl("GET_EXISTING", id, options);
  }

  /**
   * "Creates a subnamespace with the jurisdiction hardcoded."
   *
   * The argument is optional because upstream's is a
   * `jsg::Optional<kj::Maybe<kj::String>>`, so both "omitted" and "null" mean the
   * same thing — `cloneWithJurisdiction(kj::none)`, a subnamespace with none.
   */
  jurisdiction(jurisdiction?: string | null): DurableObjectNamespace<T> {
    return new DurableObjectNamespace<T>(
      this.#channel,
      this.#idFactory.cloneWithJurisdiction(jurisdiction ?? undefined),
    );
  }

  /** ← `DurableObjectNamespace::getImpl` (`actor.c++:167-213`). */
  #getImpl(
    mode: ActorGetMode,
    id: globalThis.DurableObjectId,
    options: GetDurableObjectOptions | undefined,
  ): DurableObjectStub<T> {
    const durableObjectId = requireDurableObjectId(id);
    const inner = durableObjectId.getInner();
    if (!this.#idFactory.matchesJurisdiction(inner)) {
      throw new TypeError(
        "get called on jurisdictional subnamespace with an ID from a different jurisdiction",
      );
    }

    let routingMode: ActorRoutingMode = "DEFAULT";
    const requestedRoutingMode = options?.routingMode;
    if (requestedRoutingMode !== undefined) {
      if (requestedRoutingMode !== "primary-only") {
        throw new RangeError(`unknown routingMode: ${requestedRoutingMode}`);
      }
      routingMode = "PRIMARY_ONLY";
    }

    const fetcher = this.#channel.getGlobalActor({
      id: inner,
      locationHint: options?.locationHint,
      mode,
      enableReplicaRouting: ENABLE_REPLICA_ROUTING,
      routingMode,
      version: actorVersionOf(options?.version),
    });

    // The id handed to the stub is the one the caller passed, as upstream's `id.addRef()` is.
    return asDurableObjectStub<T>(new DurableObject(durableObjectId, fetcher));
  }
}

/**
 * ← `version = ActorVersion{.cohort = kj::mv(v.cohort)}` (`actor.c++:186-190`),
 * behind `FeatureFlags::get(js).getEnableVersionApi()` which this file reads as
 * on. A version with no cohort is still a version, which is why the empty object
 * is not collapsed to `undefined`.
 */
function actorVersionOf(version: { readonly cohort?: string } | undefined): ActorVersion | undefined {
  if (version === undefined) return undefined;
  return version.cohort === undefined ? {} : { cohort: version.cohort };
}

// =======================================================================================
// DurableObjectClass

/**
 * ← `DurableObjectClass` (`actor.h:367-393`). "DurableObjectClass represents a
 * binding to a Durable Object class that can be used as a facet. The only use of
 * this type is to pass to `ctx.facets.get()`."
 *
 * `getChannel()` takes no `IoContext` because the parameter existed to resolve the
 * numbered-channel arm, and there is no numbered-channel arm here.
 */
export class DurableObjectClass<_T extends Rpc.DurableObjectBranded | undefined = undefined>
  implements globalThis.DurableObjectClass<_T>
{
  readonly #channel: ActorClassChannel;

  constructor(channel: ActorClassChannel) {
    this.#channel = channel;
  }

  /** ← `DurableObjectClass::getChannel` (`actor.c++:232-242`). */
  getChannel(): ActorClassChannel {
    return this.#channel;
  }

  /**
   * ← `DurableObjectClass::serialize` (`actor.c++:244-306`). Substrate boundary.
   *
   * `requireAllowsTransfer()` runs first, exactly as upstream's does, so a class
   * that refuses transfer reports that rather than the boundary — the refusal is
   * the more specific answer and it is the one upstream would give too.
   */
  serialize(): never {
    this.#channel.requireAllowsTransfer();
    throw new Error(ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE);
  }

  /** ← `DurableObjectClass::deserialize` (`actor.c++:308-359`). Substrate boundary. */
  static deserialize(): never {
    throw new Error(ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE);
  }
}
