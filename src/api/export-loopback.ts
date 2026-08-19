/**
 * ← workerd `src/workerd/api/export-loopback.{h,c++}`
 *
 * The four types `ctx.exports` is made of. Upstream's own comment on the first
 * says what they all are: "the type of a property of `ctx.exports` which points
 * back at a … entrypoint of this Worker", specialized by *invoking* it.
 *
 *  - `LoopbackServiceStub` (`export-loopback.h:18`) — a stateless entrypoint. A
 *    `Fetcher` with empty props, callable to get one with props.
 *  - `LoopbackDurableObjectClass` (`:116`) — an actor class with **no storage
 *    configured**. A `DurableObjectClass`, callable to get a specialized one.
 *  - `LoopbackDurableObjectNamespace` (`:155`) — an actor class **with** storage:
 *    "we want a binding that behaves *both* like a LoopbackDurableObjectClass
 *    *and* like a DurableObjectNamespace binding."
 *  - `LoopbackColoLocalActorNamespace` (`:192`) — the same, for a colo-local
 *    (ephemeral) namespace binding.
 *
 * The third is why this file blocks `server/`. The vendored consumer reads
 * `ctx.exports[className]` and needs one value to answer both `idFromName`
 * (`vendor/agents/packages/agents/src/index.ts:10829`, `:10855`) and
 * `ctx.facets.get`'s class check (`:10857`) — namespace-shaped and class-shaped
 * at once, which is exactly what `LoopbackDurableObjectNamespace` is for.
 * Upstream's own `api/tests/worker-loader-test.js:449-450` pins the same pair.
 *
 * **`JSG_CALLABLE` becomes a `Proxy` with an `apply` trap.** A JS value can only
 * be invoked if it is a function, and a class instance is not one; the private
 * fields these classes inherit mean the callable cannot simply be a function
 * whose prototype is the instance, because an inherited method would then run
 * with `this` set to the function. So each class keeps its behaviour and an
 * `asLoopback…` function produces the JS-visible value — the same split, for the
 * same reason, that `asDurableObjectStub` already makes for `JSG_INHERIT`.
 * `getPrototypeOf` is what keeps `instanceof` answering, which is how
 * `DurableObjectFacets.get` discriminates the three arms of its class switch.
 *
 * **Two `IoChannelFactory` methods are declared here rather than in
 * `io/io-channels.ts`.** `getSubrequestChannel` and `getActorClass` are what
 * `export-loopback.c++` reaches for, and both take a channel *number* upstream —
 * which this package does not have (`io/io-channels.ts`'s header: there is no
 * numbered channel table). So each collapses into a factory taking an object
 * request, exactly as `api/actor.ts` already does for `IoChannelFactory`'s
 * `getGlobalActor` and `getColoLocalActor`, and each is declared beside its one
 * consumer for the same reason `ActorChannelFactory` is. Section 7 fills them.
 *
 * **Non-serializability survives, and Section 7b is where it is enforced.**
 * Upstream is explicit that `LoopbackServiceStub` is "intentionally NOT
 * serializable, unlike its parent class Fetcher", and
 * `api/tests/worker-loader-test.js:104` asserts the message;
 * `LoopbackDurableObjectClass` likewise declares no `JSG_SERIALIZABLE` where
 * `DurableObjectClass` (`actor.h:389`) does, and neither namespace type declares
 * one either — `JSG_INHERIT` does not carry serializability, which is what the
 * test's own comment says it is checking.
 *
 * An earlier revision of this paragraph said the refusal did not survive, and
 * named `src/transport/` as the layer that would have to make it. Both halves
 * were wrong about *where*: the test reaches the refusal through
 * `worker.getEntrypoint(name, {props})`, and `WorkerStub::getEntrypoint`'s first
 * act is `Frankenvalue::fromJs`, which runs `jsg::Serializer` inside
 * `api/worker-loader.c++`. So `api/worker-loader.ts`'s `requireSerializableProps`
 * refuses all four of these in `props` and in `env`, with upstream's message and
 * a `DataCloneError`. `DurableObjectClass.serialize` remains a separate named
 * substrate boundary that throws for every class, loopback or not.
 *
 * The version half of `LoopbackServiceStub` is present and `Options`, the
 * flag-off form, is not: `FeatureFlags::getEnableVersionApi()` is read as on
 * here, the same current-behaviour reading `api/actor.ts` gives the four
 * compatibility flags it meets. That makes this a superset of
 * `@cloudflare/workers-types` 4.20260702.1, which generated the flag-off
 * signature — the same relationship `DurableObjectNamespace.getExisting` has.
 *
 * Spec: §1.10, §1.11, decisions 14 and 16 in
 * docs/decisions.md.
 */

import type { ActorIdFactory } from "../io/actor-id";
import type { ActorClassChannel } from "../io/io-channels";
import {
  ColoLocalActorNamespace,
  DurableObjectClass,
  DurableObjectNamespace,
  type ActorChannelFactory,
  type ColoLocalActorChannelFactory,
} from "./actor";

// =======================================================================================
// Constants

/**
 * ← what JSG's struct unwrapper does with a value that is not an object
 * (`jsg/struct.h:246`). Undefined and null are **not** in that set: a struct
 * whose every field is optional — which both option structs here are — unwraps
 * from either as an empty struct (`jsg/struct.h:236-243`), so `ctx.exports.Foo()`
 * is upstream's own empty-options call and not an error.
 */
export const LOOPBACK_OPTIONS_NOT_AN_OBJECT_MESSAGE =
  "A ctx.exports binding is invoked with an options object: pass { props }, or nothing at all.";

/** ← what JSG does unwrapping a `jsg::JsRef<jsg::JsObject>` from a non-object. */
export const LOOPBACK_PROPS_NOT_AN_OBJECT_MESSAGE =
  "`props` must be an object. Upstream unwraps it as a jsg::JsObject, which refuses anything else.";

// =======================================================================================
// The outgoing seam — the two IoChannelFactory methods this file reaches

/** ← `IoChannelFactory::VersionRequest` (`io/io-channels.h:123-131`). */
export type VersionRequest = {
  /** "Request a version within the given cohort." */
  readonly cohort: string | undefined;
};

/**
 * ← the two arguments `IoChannelFactory::getSubrequestChannel` takes besides the
 * channel number (`io/io-channels.h:243-245`). Upstream: "`props` and
 * `versionRequest` can only be specified if this is a loopback channel (i.e.
 * from ctx.exports)."
 */
export type SubrequestChannelRequest = {
  /** ← `kj::Maybe<Frankenvalue> props`. */
  readonly props: unknown;
  readonly version: VersionRequest | undefined;
};

/**
 * ← `IoChannelFactory::getSubrequestChannel` composed with the `Fetcher` upstream
 * builds over the `SubrequestChannel` it returns.
 *
 * The composition is `api/actor.ts`'s: a `SubrequestChannel` is only ever driven
 * through `startRequest()` → `WorkerInterface`, which has no port, while the
 * JS-visible product is a `Fetcher` — so the channel and the stub it produces are
 * one object here.
 */
export interface SubrequestChannelFactory {
  getSubrequestChannel(request: SubrequestChannelRequest): Fetcher;
}

/** ← the `props` argument of `IoChannelFactory::getActorClass` (`io/io-channels.h:315`). */
export type ActorClassRequest = {
  readonly props: unknown;
};

/** ← `IoChannelFactory::getActorClass`, which returns the token `io/io-channels.ts` ports. */
export interface ActorClassChannelFactory {
  getActorClass(request: ActorClassRequest): ActorClassChannel;
}

// =======================================================================================
// The option structs

/** ← `LoopbackServiceStub::OptionsWithVersion::Version` (`export-loopback.h:32-36`). */
export type LoopbackServiceStubVersion = {
  /** `jsg::Optional<kj::Maybe<kj::String>>`: omitted and null are the same request. */
  readonly cohort?: string | null;
};

/** ← `LoopbackServiceStub::OptionsWithVersion` (`export-loopback.h:31-42`). */
export type LoopbackServiceStubOptions = {
  readonly props?: unknown;
  readonly version?: LoopbackServiceStubVersion;
};

/** ← `LoopbackDurableObjectClass::Options` (`export-loopback.h:120-124`). */
export type LoopbackDurableObjectClassOptions = {
  readonly props?: unknown;
};

// =======================================================================================
// LoopbackServiceStub

/**
 * ← `LoopbackServiceStub` (`export-loopback.h:18-109`).
 *
 * Upstream is a `Fetcher` on the loopback channel and holds the channel number a
 * second time so `callImpl` can re-specialize it. Here the `Fetcher` is the
 * transport's — `api/http.{h,c++}` is not ported — so the unspecialized stub is
 * what the factory returns for a request with no props and no version, and the
 * factory is the thing held twice over.
 */
export class LoopbackServiceStub {
  readonly #channel: SubrequestChannelFactory;
  readonly #fetcher: Fetcher;

  constructor(channel: SubrequestChannelFactory) {
    this.#channel = channel;
    this.#fetcher = channel.getSubrequestChannel({ props: undefined, version: undefined });
  }

  /** The `Fetcher` upstream inherits from rather than holds, as `DurableObject`'s is. */
  getFetcher(): Fetcher {
    return this.#fetcher;
  }

  /**
   * ← `LoopbackServiceStub::callImpl` (`export-loopback.c++:11-29`) reached
   * through `callWithVersion` (`export-loopback.h:53-55`), which is the callable
   * when `enableVersionApi` is on. "Create a specialized Fetcher which can be
   * passed over RPC."
   */
  callWithVersion(options: LoopbackServiceStubOptions): Fetcher {
    return this.#channel.getSubrequestChannel({
      props: requireProps(options.props),
      version: versionRequestOf(options.version),
    });
  }
}

/**
 * ← `js.alloc<LoopbackServiceStub>(…)` plus `JSG_CALLABLE(callWithVersion)`.
 *
 * The declared type is a superset of `@cloudflare/workers-types`' by exactly the
 * `version` field, for the reason in this module's header.
 */
export type LoopbackServiceStubValue<
  T extends Rpc.WorkerEntrypointBranded | undefined = undefined,
> = Fetcher<T> & ((options?: LoopbackServiceStubOptions) => Fetcher<T>);

export function asLoopbackServiceStub<
  T extends Rpc.WorkerEntrypointBranded | undefined = undefined,
>(stub: LoopbackServiceStub): LoopbackServiceStubValue<T> {
  return asCallable({
    properties: stub.getFetcher(),
    prototype: LoopbackServiceStub.prototype,
    call: (options) => stub.callWithVersion(requireOptions(options)),
  });
}

// =======================================================================================
// LoopbackDurableObjectClass

/**
 * ← `LoopbackDurableObjectClass` (`export-loopback.h:116-148`). "Similar to
 * LoopbackServiceStub, but for actor classes … this is used for actor classes
 * that do *not* have any storage configured. If you simply export a class
 * extending `DurableObject` but you don't configure storage for it, it shows up
 * in `ctx.exports` as this type. This can be used to create a Durable Object
 * facet."
 *
 * Upstream's base `DurableObjectClass` holds the channel *number*, and
 * `getChannel(ioctx)` resolves it lazily. There is no numbered arm here, so the
 * unspecialized channel is requested once, in the constructor — which is the same
 * value `getActorClass(channel)` with default props would have produced.
 */
export class LoopbackDurableObjectClass<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> extends DurableObjectClass<T> {
  readonly #channel: ActorClassChannelFactory;

  constructor(channel: ActorClassChannelFactory) {
    super(channel.getActorClass({ props: undefined }));
    this.#channel = channel;
  }

  /**
   * ← `LoopbackDurableObjectClass::call` (`export-loopback.c++:31-40`). "Create a
   * specialized DurableObjectClass which can be passed over RPC."
   *
   * The result is a plain `DurableObjectClass`, as `js.alloc<DurableObjectClass>`
   * is: specializing a loopback class does not produce another loopback class.
   */
  call(options: LoopbackDurableObjectClassOptions): DurableObjectClass<T> {
    return new DurableObjectClass<T>(
      this.#channel.getActorClass({ props: requireProps(options.props) }),
    );
  }
}

/** ← `js.alloc<LoopbackDurableObjectClass>(…)` plus `JSG_CALLABLE(call)`. */
export type LoopbackDurableObjectClassValue<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = DurableObjectClass<T> &
  ((options?: LoopbackDurableObjectClassOptions) => DurableObjectClass<T>);

export function asLoopbackDurableObjectClass<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(actorClass: LoopbackDurableObjectClass<T>): LoopbackDurableObjectClassValue<T> {
  return asCallable({
    properties: actorClass,
    prototype: Object.getPrototypeOf(actorClass),
    call: (options) => actorClass.call(requireOptions(options)),
  });
}

// =======================================================================================
// LoopbackDurableObjectNamespace

/**
 * ← `LoopbackDurableObjectNamespace` (`export-loopback.h:155-189`).
 *
 * Upstream: "used when the class has storage configured. In this case, we want a
 * binding that behaves *both* like a LoopbackDurableObjectClass *and* like a
 * DurableObjectNamespace binding. Easy enough, we'll inherit
 * DurableObjectNamespace, but also make the binding invokable as a function like
 * LoopbackDurableObjectClass."
 */
export class LoopbackDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> extends DurableObjectNamespace<T> {
  readonly #loopbackClass: LoopbackDurableObjectClass<T>;

  constructor(
    channel: ActorChannelFactory,
    idFactory: ActorIdFactory,
    loopbackClass: LoopbackDurableObjectClass<T>,
  ) {
    super(channel, idFactory);
    this.#loopbackClass = loopbackClass;
  }

  /** ← `getClass()`. "getClass() accessor for use from C++ only." */
  getClass(): LoopbackDurableObjectClass<T> {
    return this.#loopbackClass;
  }

  /** ← `call`. "Invoking the binding creates a specialization of the class -- not the namespace." */
  call(options: LoopbackDurableObjectClassOptions): DurableObjectClass<T> {
    return this.#loopbackClass.call(options);
  }
}

/**
 * ← `js.alloc<LoopbackDurableObjectNamespace>(…)` plus `JSG_CALLABLE(call)`.
 *
 * This is the type of a `ctx.exports` entry for a Durable Object class with
 * storage, and the reason it is stated in terms of this package's classes rather
 * than `@cloudflare/workers-types`' `LoopbackDurableObjectNamespace` is that the
 * pinned interface is `interface LoopbackDurableObjectNamespace extends
 * DurableObjectNamespace {}` — no call signature, because that resource type
 * carries no `JSG_TS_OVERRIDE` to generate one from. `Cloudflare.Exports`
 * describes the same value correctly, as `LoopbackDurableObjectClass<T> &
 * DurableObjectNamespace<T>`, and `PinnedLoopbackTypes` below checks against
 * that rather than against the interface.
 *
 * `call` is omitted because `JSG_CALLABLE` registers it as the object's call
 * behaviour rather than as a property: on the value, `.call` is
 * `Function.prototype.call`, which is what `asCallable`'s `get` trap answers.
 */
export type LoopbackDurableObjectNamespaceValue<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = Omit<LoopbackDurableObjectNamespace<T>, "call"> &
  ((options?: LoopbackDurableObjectClassOptions) => DurableObjectClass<T>);

export function asLoopbackDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(namespace: LoopbackDurableObjectNamespace<T>): LoopbackDurableObjectNamespaceValue<T> {
  return asCallable({
    properties: namespace,
    prototype: Object.getPrototypeOf(namespace),
    call: (options) => namespace.call(requireOptions(options)),
  });
}

// =======================================================================================
// LoopbackColoLocalActorNamespace

/**
 * ← `LoopbackColoLocalActorNamespace` (`export-loopback.h:192-220`). "Like
 * LoopbackDurableObjectNamespace, but for colo-local (ephemeral) actor
 * namespaces."
 */
export class LoopbackColoLocalActorNamespace extends ColoLocalActorNamespace {
  readonly #loopbackClass: LoopbackDurableObjectClass;

  constructor(channel: ColoLocalActorChannelFactory, loopbackClass: LoopbackDurableObjectClass) {
    super(channel);
    this.#loopbackClass = loopbackClass;
  }

  /** ← `getClass()`. "getClass() accessor for use from C++ only." */
  getClass(): LoopbackDurableObjectClass {
    return this.#loopbackClass;
  }

  /** ← `call`. "Invoking the binding creates a specialization of the class -- not the namespace." */
  call(options: LoopbackDurableObjectClassOptions): DurableObjectClass {
    return this.#loopbackClass.call(options);
  }
}

/**
 * ← `js.alloc<LoopbackColoLocalActorNamespace>(…)` plus `JSG_CALLABLE(call)`,
 * with `call` omitted for the reason given on the durable namespace above.
 */
export type LoopbackColoLocalActorNamespaceValue = Omit<LoopbackColoLocalActorNamespace, "call"> &
  ((options?: LoopbackDurableObjectClassOptions) => DurableObjectClass);

export function asLoopbackColoLocalActorNamespace(
  namespace: LoopbackColoLocalActorNamespace,
): LoopbackColoLocalActorNamespaceValue {
  return asCallable({
    properties: namespace,
    prototype: Object.getPrototypeOf(namespace),
    call: (options) => namespace.call(requireOptions(options)),
  });
}

// =======================================================================================
// The pinned-types check

/** `Value` must be assignable to `Declared`; declaring the constraint is the check. */
type Assignable<Value extends Declared, Declared> = Value;

/**
 * Checked rather than claimed: every value this module produces satisfies the
 * shape `@cloudflare/workers-types` 4.20260702.1 declares for it. The last two
 * are checked against `Cloudflare.Exports`' own description of a `ctx.exports`
 * entry — `LoopbackForExport<T>` intersected with the namespace — because the
 * two named interfaces there are call-signature-less, per the note above.
 */
export type PinnedLoopbackTypes = [
  Assignable<LoopbackServiceStubValue, globalThis.LoopbackServiceStub>,
  Assignable<LoopbackDurableObjectClassValue, globalThis.LoopbackDurableObjectClass>,
  Assignable<
    LoopbackDurableObjectNamespaceValue,
    globalThis.LoopbackDurableObjectClass & globalThis.DurableObjectNamespace
  >,
  Assignable<
    LoopbackColoLocalActorNamespaceValue,
    globalThis.LoopbackDurableObjectClass & globalThis.ColoLocalActorNamespace
  >,
];

// =======================================================================================
// The mechanics JSG supplies

/**
 * ← `JSG_CALLABLE`, which makes a JSG resource object invocable while leaving
 * every other property answering from the resource type.
 *
 * `properties` is where reads land, with `this` bound to it so a method reaching
 * a private field still finds one — the same binding, memoised the same way,
 * that `asDurableObjectStub` performs for `JSG_INHERIT`. `prototype` is what
 * `instanceof` sees, and it is separate from `properties` because
 * `LoopbackServiceStub` is one object with two halves: upstream's identity is the
 * resource type while its behaviour is the inherited `Fetcher`'s.
 *
 * The target is an arrow function rather than a plain one because a plain
 * function has a non-configurable own `prototype` property, which a Proxy may not
 * hide from `ownKeys`.
 *
 * This is the one assertion the four producers above need, made once here. It is
 * `asDurableObjectStub`'s, for `asDurableObjectStub`'s reason: the declared value
 * is a `Fetcher<T>` or a `DurableObjectClass<T>` intersected with a call
 * signature, and `T` is the caller's claim about a class it named, which no value
 * can confirm. Upstream states the same shapes the same way, in a
 * `JSG_TS_OVERRIDE` that no C++ value is checked against either.
 */
const INVOCATION_METHODS = new Set<string | symbol>(["call", "apply", "bind"]);

function asCallable<Value>(facade: {
  readonly properties: object;
  readonly prototype: object | null;
  readonly call: (options: unknown) => unknown;
}): Value {
  const bound = new Map<string | symbol, unknown>();
  const target = (): never => {
    throw new Error("unreachable: the apply trap answers every invocation");
  };

  return new Proxy(target, {
    apply(_target, _thisArg, args: readonly unknown[]): unknown {
      return facade.call(args[0]);
    },

    get(target, property, receiver): unknown {
      // `call`, `apply` and `bind` belong to the callable rather than to the property source.
      // Upstream's object is a function and answers all three from `Function.prototype`, and
      // `call` is also the C++ method name `JSG_CALLABLE` registers — which is the object's call
      // behaviour there and not a JS property, so it must not become one here. Answering from
      // the target keeps `foo.call(thisArg, options)` meaning `foo(options)`, as it does upstream.
      if (INVOCATION_METHODS.has(property)) return Reflect.get(target, property, receiver);

      const cached = bound.get(property);
      if (cached !== undefined) return cached;
      const value: unknown = Reflect.get(facade.properties, property, facade.properties);
      if (typeof value !== "function") return value;
      const method: unknown = value.bind(facade.properties);
      bound.set(property, method);
      return method;
    },

    has(_target, property): boolean {
      return Reflect.has(facade.properties, property);
    },

    ownKeys(): ArrayLike<string | symbol> {
      return Reflect.ownKeys(facade.properties);
    },

    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      const descriptor = Reflect.getOwnPropertyDescriptor(facade.properties, property);
      if (descriptor === undefined) return undefined;
      // Configurable, because the target does not have this key and a Proxy may not report a
      // non-configurable descriptor for a property its target lacks.
      return { ...descriptor, configurable: true };
    },

    getPrototypeOf(): object | null {
      return facade.prototype;
    },
  }) as Value;
}

/**
 * ← JSG's struct unwrapper (`jsg/struct.h:236-246`), for the two option structs
 * here: every field of both is optional, so undefined and null yield an empty
 * struct and anything that is not an object is a `TypeError`. V8's `IsObject()`
 * is true for functions, which is why one is not refused here either.
 *
 * `cohort` is not checked, because upstream does not check it: JSG's `kj::String`
 * unwrapper calls `ToString` on whatever it is given (`jsg/value.h:501-506`), so
 * refusing a non-string here would refuse what workerd coerces. That is the same
 * reading `api/actor.ts`'s `actorVersionOf` already takes of the same field.
 */
function requireOptions<Options extends object>(options: unknown): Options {
  if (
    options !== undefined &&
    options !== null &&
    typeof options !== "object" &&
    typeof options !== "function"
  ) {
    throw new TypeError(LOOPBACK_OPTIONS_NOT_AN_OBJECT_MESSAGE);
  }
  return (options ?? {}) as Options;
}

/** ← `jsg::Optional<jsg::JsRef<jsg::JsObject>> props` — present means an object. */
function requireProps(props: unknown): unknown {
  if (props === undefined) return undefined;
  if (props === null || (typeof props !== "object" && typeof props !== "function")) {
    throw new TypeError(LOOPBACK_PROPS_NOT_AN_OBJECT_MESSAGE);
  }
  return props;
}

/** ← `.cohort = kj::mv(version.cohort).orDefault(kj::none)` (`export-loopback.c++:19-23`). */
function versionRequestOf(
  version: LoopbackServiceStubVersion | undefined,
): VersionRequest | undefined {
  if (version === undefined) return undefined;
  return { cohort: version.cohort ?? undefined };
}
