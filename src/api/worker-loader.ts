/**
 * ← workerd `src/workerd/api/worker-loader.{h,c++}`
 *
 * The Worker Loader binding: `get(name, getCode)` and `load(code)`, the
 * `WorkerStub` they return, and the two ways a dynamic Worker is reached —
 * `getEntrypoint()` for a `Fetcher` and `getDurableObjectClass()` for a
 * `DurableObjectClass`, which is the single bridge between dynamic Workers and
 * facets. Per §1.11 Code Mode is two features composed: a dynamic Worker for
 * execution and a facet for durable state, because "Dynamically-loaded isolates
 * can't directly have storage" (`server/server.c++:4209`).
 *
 * **The scaffolding this file replaces was a hypothesis, and the C++ wants a
 * different shape.** It declared `IsolateHost.execute({executionId, code,
 * namespaces}, onToolCall)` plus `cancel(executionId)`, with a
 * `SandboxNamespaceDescriptor` of `{provider, name}` and a `SandboxToolDispatch`
 * of `(provider, name, args, toolCallId)`. Not one of those words appears in
 * `worker-loader.{h,c++}` or in `io-channels.h`: providers, tool calls and
 * execution ids are the *consumer's* concepts, and this package may not know
 * about Rook, Think or agents. What upstream actually declares is
 * `IoChannelFactory::loadIsolate(channel, name, fetchSource) ->
 * WorkerStubChannel` (`io/io-channels.h:339-343`), with `getEntrypoint` and
 * `getActorClass` on the channel — a Worker-shaped seam, not an
 * execution-shaped one. The scaffolding had transcribed
 * `OffscreenCodemodeExecutor`, which is decision 15's *subject*, not its result.
 * `ActorPorts.isolates` went with it: a Worker Loader is a binding a host puts in
 * `env`, exactly as `DurableObjectNamespace` and `ctx.exports` already are, not a
 * port the container needs — upstream's own is `Global::WorkerLoader{channel}`
 * compiled into the bindings (`server/workerd-api.c++:748`).
 *
 * **`get()` does not cache; the namespace behind it does.** `WorkerLoader::get`
 * calls `loadIsolate` unconditionally and mints a fresh `WorkerStub` every call
 * (`worker-loader.c++:63-83`). The find-or-create by name lives one layer down, in
 * `Server::WorkerLoaderNamespace::loadIsolate` (`server.c++:4243-4281`), together
 * with the rule that a **null or absent name mints a fresh isolate every time** —
 * which upstream's own `isolateUniqueness` test pins at
 * `api/tests/worker-loader-test.js:527-541`. So what this layer owns is which name
 * reaches the seam: `load(code)` is documented as "Shortcut for `get(null, () =>
 * code)`" and both it and `get(null)` pass none.
 *
 * **What `load()` owns that `get()` does not is *when* the code is validated.**
 * `load()` builds the whole `DynamicWorkerSource` synchronously before it returns
 * (`worker-loader.c++:88`), so a malformed module list throws out of `load()`;
 * `get()` defers everything into the callback, so the same mistake surfaces at the
 * first request on the stub, which is what upstream's tests assert
 * (`worker-loader-test.js:812`, `:829`, `:856`). That eager capture is also a
 * memory-safety fix: `data` and `wasm` bytes are copied out of the caller's buffer
 * at that moment, because a resizable `ArrayBuffer` can be shrunk to zero
 * afterwards (`worker-loader.c++:225-232`, `:242-245`, and
 * `api/tests/worker-loader-rab-test.js`).
 *
 * **`globalOutbound: null` is the default posture, per decision 15, and what it
 * enforces here is one hop further out than on workerd.** Upstream substitutes a
 * `NullGlobalOutboundChannel` whose `startRequest` throws
 * (`server.c++:4306-4331`), so ambient `fetch` inside the loaded Worker fails from
 * inside the isolate. This layer's whole job is the same one upstream's is:
 * collapse the three JS states — omitted, `null`, a `Fetcher` — into the two the
 * source carries, where absent means blocked and omitted means the caller's own
 * outbound. Enforcement belongs to whatever `loadIsolate` returns, because that is
 * the thing with an isolate to deny.
 *
 * **The one thing this file refuses that upstream refuses elsewhere.**
 * `Frankenvalue::fromJs` serializes `props` and `env` inside these methods, and a
 * `ctx.exports` binding that has not been invoked declares no `JSG_SERIALIZABLE`,
 * so it is refused there with a `DataCloneError` — pinned at
 * `api/tests/worker-loader-test.js:104`. `api/export-loopback.ts`'s header records
 * that refusal as not surviving; it survives here, because this is the layer
 * upstream refuses at. See `requireSerializableProps` below.
 *
 * **There are no source or `env` size caps, and an earlier statement of this
 * section's spec said there were** — "64 MiB of module source, 1 MiB of `env`
 * (`worker-loader.c++:15-21`)". Those lines are `WorkerStub::getEntrypoint`'s
 * props-and-limits prologue, and no cap of either size exists anywhere in the
 * open-source runtime: the complete list of refusals in the load path is the ten
 * `JSG_REQUIRE`/`JSG_FAIL_REQUIRE` sites this file ports, and none of them
 * measures a length. Those are Cloudflare's documented *production* limits, which
 * workerd does not reproduce — the same class of thing as `ResourceLimits`, and
 * recorded on it. Nothing here counts bytes.
 *
 * Spec: §1.11, decisions 15 and 16 in
 * docs/decisions.md.
 */

import type {
  CompatibilityDateValidation,
  CompatibilityFlagsRequest,
  DynamicWorkerSource,
  EntrypointRequest,
  ResourceLimits,
  WorkerStubChannel,
} from "../io/io-channels";
import type { IoContext } from "../io/io-context";
import { requireInputLock } from "../io/io-context";
import type { Module as SourceModule, ModuleContent, WorkerSource } from "../io/worker-source";
import { DurableObjectClass } from "./actor";
import {
  LoopbackColoLocalActorNamespace,
  LoopbackDurableObjectClass,
  LoopbackDurableObjectNamespace,
  LoopbackServiceStub,
} from "./export-loopback";

// =======================================================================================
// Messages

/** ← `JSG_REQUIRE(code.modules.fields.size() > 0, …)` (`worker-loader.c++:175-176`). */
export const NO_MODULES_MESSAGE = "Dynamic Worker code must contain at least one module.";

const MODULE_NAME_PREFIX =
  "Module name must end with '.js' or '.py' (or the content must be an object " +
  "indicating the type explicitly). Got: ";

/** ← `JSG_FAIL_REQUIRE` at `worker-loader.c++:204-206`. */
export function moduleNameMessage(name: string): string {
  return `${MODULE_NAME_PREFIX}${name}`;
}

/**
 * ← `JSG_FAIL_REQUIRE` at `worker-loader.c++:197-201`, the `.ts` / `.tsx` / `.jsx`
 * arm. Upstream's is the message above plus the bundler suggestion.
 */
export function typeScriptModuleNameMessage(name: string): string {
  return (
    `${MODULE_NAME_PREFIX}${name}. If you're trying to load TypeScript, bundle it first with ` +
    "'@cloudflare/worker-bundler' and pass the generated JavaScript modules."
  );
}

/** ← `JSG_REQUIRE(fieldCount == 1, …)` (`worker-loader.c++:212-215`). */
export function moduleFieldCountMessage(name: string, fieldCount: number): string {
  return (
    "Each module must contain exactly one of 'js', 'cjs', 'text', 'data', 'json', 'py', or " +
    `'wasm'. Module '${name}' contained ${fieldCount} properties.`
  );
}

/** ← `JSG_FAIL_REQUIRE` at `worker-loader.c++:261-262`. */
export function jsModuleInPythonWorkerMessage(name: string): string {
  return `Module "${name}" is a JS module, but the main module is a Python module.`;
}

/** ← `JSG_FAIL_REQUIRE` at `worker-loader.c++:266-267`. */
export function pythonModuleInJsWorkerMessage(name: string): string {
  return `Module "${name}" is a Python module, but the main module isn't a Python module.`;
}

/** ← `JSG_REQUIRE` at `worker-loader.c++:152-154`. Upstream's carries no closing period. */
export const STREAMING_TAILS_EXPERIMENTAL_MESSAGE =
  "Streaming tail workers are experimental. You must pass the option " +
  "'allowExperimental: true' to the worker loader to use them";

/**
 * ← `JSG_REQUIRE_NONNULL(weakIoctx->tryGet(), Error, …)` (`worker-loader.c++:73-74`),
 * the guard the AUTOVULN-CLOUDFLARE-WORKERD-256 fix added.
 *
 * **The precondition differs and the failure mode nearly did too.** Upstream's
 * `IoContext` is per REQUEST, so a stub can outlive the context that made it and
 * the raw `&ioctx` capture was a use-after-free; the WeakRef turns that into this
 * message. Ours is per CONTAINER and outlives every stub it made, so the
 * destroyed case cannot happen — what remains reachable is an **aborted** actor,
 * and for that `IoContext::awaitIo` deliberately leaves its promise unsettled
 * ("`result` is deliberately left unsettled, as upstream leaves it",
 * `io/io-context.ts`). Upstream can afford that because `runAlarm`'s caller and
 * everything else in a torn-down request is being destroyed anyway; a dynamic
 * worker load cannot, because `WorkerStubChannel`'s contract is that a failed
 * load makes every request on the stub **fail** — a load that never settles makes
 * every request on the stub hang instead, which is the failure this repository's
 * own divergence 149 exists to prevent ("a JS promise has to settle, and one that
 * never does is a hang nobody can see"). So the abort is observed explicitly and
 * answered with upstream's own message.
 */
export const DEAD_LOAD_CONTEXT_MESSAGE =
  "The request which initiated this dynamic worker load has already completed.";

/** ← `JSG_REQUIRE(!allowExperimental, …)` (`worker-loader.c++:282-284`). */
export const ALLOW_EXPERIMENTAL_MESSAGE =
  "'allowExperimental' is only allowed when the calling worker has the 'experimental' " +
  "compat flag set.";

/**
 * ← `Serializer::throwDataCloneErrorForObject` (`jsg/ser.c++:175-183`), whose type
 * name is `obj->GetConstructorName()` — the JSG resource type's name, which is the
 * class name here. Pinned for `LoopbackServiceStub` at
 * `api/tests/worker-loader-test.js:104`.
 */
export function notSerializableMessage(typeName: string): string {
  return `Could not serialize object of type "${typeName}". This type does not support serialization.`;
}

/** Not something `jsg::asBytes()` would accept for a `kj::Array<const byte>` body. */
export const NOT_BYTES_MESSAGE =
  "A module's 'data' or 'wasm' body must be an ArrayBuffer or a view over one.";

// =======================================================================================
// The outgoing seam — the two IoChannelFactory methods this file reaches

/**
 * ← the two arguments `IoChannelFactory::loadIsolate` takes besides the channel
 * number (`io/io-channels.h:339-343`). Upstream: "Use a dynamic Worker loader
 * binding to obtain an Worker by name. If name is null, or if the named Worker
 * doesn't already exist, the callback will be called to fetch the source code from
 * which the Worker should be created."
 *
 * Upstream's own note on the callback, at `worker-loader.c++:90-94`, is the
 * contract an implementation has to honour: "the callback we pass to
 * `loadIsolate()` technically may be called any number of times. Yes, even though
 * we aren't providing an ID. The runtime can actually evict the isolate while a
 * stub still exists, as long as there is no active request on the stub, and then
 * recreate the isolate on the next request."
 */
export type LoadIsolateRequest = {
  /**
   * ← `kj::Maybe<kj::String> name`. Absent means the isolate is not cached and a
   * fresh one is minted per call (`server.c++:4264-4281`).
   */
  readonly name: string | undefined;
  /** ← `kj::Function<kj::Promise<DynamicWorkerSource>()> fetchSource`. */
  fetchSource(): Promise<DynamicWorkerSource>;
};

/**
 * ← `IoChannelFactory`'s two dynamic-worker methods, collapsed the way
 * `api/actor.ts` and `api/export-loopback.ts` already collapse theirs: both take a
 * channel *number* upstream and there is no numbered channel table here, so each
 * becomes a factory method taking an object request. Declared beside its one
 * consumer for the same reason `ActorChannelFactory` is.
 *
 * This is the whole substrate seam of §1.11. A host implements it three ways — the
 * offscreen document in the browser, an in-realm module evaluation under Node, and
 * the real `worker_loaders` binding on workerd — and nothing above it has to know
 * which.
 */
export interface IsolateChannelFactory {
  /** ← `IoChannelFactory::loadIsolate`. Returns before the Worker has loaded. */
  loadIsolate(request: LoadIsolateRequest): WorkerStubChannel;

  /**
   * ← `getSubrequestChannel(IoContext::NULL_CLIENT_CHANNEL)`
   * (`worker-loader.c++:137-138`, `io/io-context.h:753`) — the calling worker's own
   * global outbound, which a loaded Worker inherits when `globalOutbound` is
   * omitted. Upstream reaches it by channel number 0; with no channel table it is a
   * method on the one factory that needs it.
   *
   * Upstream deliberately does not call `requireAllowsTransfer()` on this one: "if
   * it was the global outbound of the parent, it must be OK to be the global
   * outbound of the child."
   */
  getNullClientChannel(): Fetcher;
}

// =======================================================================================
// The JS-facing structs

/**
 * ← `WorkerLoader::Module` (`worker-loader.h:62-78`). "Exactly one must be filled
 * in."
 *
 * `data` and `wasm` are `ArrayBuffer | ArrayBufferView` where
 * `@cloudflare/workers-types` declares `ArrayBuffer`, because upstream unwraps
 * them with `jsg::asBytes()`, which accepts either — and upstream's own tests pass
 * a `Uint8Array` to both (`worker-loader-test.js:585`, `:645`). A superset of the
 * pinned types, the same relationship `DurableObjectNamespace.getExisting` has.
 *
 * `serializedJson` is absent: upstream's own comment calls it a HACK for owning
 * the string `Worker::Script::Source` only borrows, and a JS string is owned.
 */
export type Module = {
  /** ES module. */
  readonly js?: string;
  /** Common JS module. */
  readonly cjs?: string;
  /** "text blob, imports as a string" */
  readonly text?: string;
  /** "byte blob, imports as ArrayBuffer" */
  readonly data?: ArrayBuffer | ArrayBufferView;
  /** "arbitrary JS value, will be serialized to JSON and then parsed again when imported" */
  readonly json?: unknown;
  /** Python module. */
  readonly py?: string;
  /** "compiled WASM module" */
  readonly wasm?: ArrayBuffer | ArrayBufferView;
};

/** ← `WorkerLoader::WorkerCode` (`worker-loader.h:80-120`). */
export type WorkerCode = {
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly allowExperimental?: boolean;
  readonly limits?: ResourceLimits;
  readonly mainModule: string;
  /**
   * "Modules are specified as an object mapping names to content. If the content is
   * just a string, an ES module is assumed. If it's an object, the type of module
   * is determined based on which property is set."
   */
  readonly modules: Record<string, Module | string>;
  /** "Any RPC-serializable value!" */
  readonly env?: unknown;
  /**
   * "`Fetcher` (e.g. service binding) representing the loaded worker's global
   * outbound. If omitted, inherit the current worker's global outbound. If `null`,
   * block the global outbound (all requests throw errors)."
   */
  readonly globalOutbound?: Fetcher | null;
  /** "Specify tail workers." */
  readonly tails?: readonly Fetcher[];
  readonly streamingTails?: readonly Fetcher[];
};

/** ← `WorkerStub::EntrypointOptions` (`worker-loader.h:22-27`). */
export type EntrypointOptions = {
  readonly props?: unknown;
  readonly limits?: ResourceLimits;
};

// =======================================================================================
// WorkerStub

/**
 * ← `WorkerStub` (`worker-loader.h:15-50`). "JS stub pointing to a remote Worker
 * loaded using WorkerLoader. This is not a stub for a specific entrypoint, but
 * instead the entire Worker, allowing the caller to call any entrypoint (and
 * specify arbitrary props)."
 */
export class WorkerStub implements globalThis.WorkerStub {
  readonly #channel: WorkerStubChannel;

  constructor(channel: WorkerStubChannel) {
    this.#channel = channel;
  }

  /** ← `WorkerStub::getEntrypoint` (`worker-loader.c++:13-36`). */
  getEntrypoint<T extends Rpc.WorkerEntrypointBranded | undefined = undefined>(
    name?: string | null,
    options?: EntrypointOptions,
  ): Fetcher<T> {
    return asEntrypointStub<T>(this.#channel.getEntrypoint(entrypointRequestOf(name, options)));
  }

  /**
   * ← `WorkerStub::getDurableObjectClass` (`worker-loader.c++:38-61`).
   *
   * **This is the bridge into facets and it is a real connection, not a named
   * boundary.** The `ActorClassChannel` the channel answers with is the same token
   * `DurableObjectClass.getChannel()` hands to `FacetStartInfo.actorClass`, which
   * `FacetManager.getFacet` hands to `FacetHost.start` — so a class obtained here
   * goes straight into `ctx.facets.get(name, () => ({ class }))` with nothing in
   * between, which is exactly the shape upstream's `FacetTestActor` uses
   * (`worker-loader-test.js:421-433`).
   */
  getDurableObjectClass<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name?: string | null,
    options?: EntrypointOptions,
  ): DurableObjectClass<T> {
    return new DurableObjectClass<T>(this.#channel.getActorClass(entrypointRequestOf(name, options)));
  }
}

/**
 * The one assertion `getEntrypoint` needs, and it is `asFacetStub`'s
 * (`io/worker.ts`) for `asFacetStub`'s reason: `Fetcher<T>` for an unresolved `T`
 * is a conditional type over the caller's claim about an entrypoint it named, and
 * no value can confirm that claim. Upstream states the same shape the same way, in
 * a `JSG_TS_OVERRIDE` (`worker-loader.h:40-45`) that no C++ value is checked
 * against either. What IS checked is the half that carries behaviour — `fetch` and
 * `connect` — because the argument is a `Fetcher` before it is widened.
 */
function asEntrypointStub<T extends Rpc.WorkerEntrypointBranded | undefined>(
  stub: Fetcher,
): Fetcher<T> {
  return stub as Fetcher<T>;
}

/**
 * ← the identical prologue of both `WorkerStub` methods (`worker-loader.c++:16-32`
 * and `:41-57`).
 *
 * `"default"` collapses to no name, which is upstream's own line
 * (`if (n2 != "default"_kj)`) and is why `getEntrypoint("default")` and
 * `getEntrypoint()` reach the same entrypoint.
 */
function entrypointRequestOf(
  name: string | null | undefined,
  options: EntrypointOptions | undefined,
): EntrypointRequest {
  return {
    name: entrypointNameOf(name),
    props: requireSerializableProps(options?.props, "props"),
    limits: options?.limits,
  };
}

function entrypointNameOf(name: string | null | undefined): string | undefined {
  // ← `jsg::Optional<kj::Maybe<kj::String>>`: absent and null are the same request. Anything
  // else reaches JSG's `kj::String` unwrapper, which calls ToString (`jsg/value.h:501-506`) —
  // the same reading `api/export-loopback.ts` gives `version.cohort`.
  if (name === undefined || name === null) return undefined;
  const text = String(name);
  return text === "default" ? undefined : text;
}

// =======================================================================================
// WorkerLoader

/**
 * The two constructor inputs upstream's `WorkerLoader` resolves from ambients this
 * package does not have.
 */
export type WorkerLoaderOptions = {
  /**
   * ← `WorkerLoader`'s second constructor parameter (`worker-loader.h:58`), whose
   * comment is "`compatDateValidation` will differ between workerd vs.
   * production". It is carried onto the `DynamicWorkerSource` rather than consumed
   * here, because the compilation it feeds is a substrate boundary — see
   * `CompatibilityFlagsRequest` in `io/io-channels.ts`.
   */
  readonly compatDateValidation: CompatibilityDateValidation;

  /**
   * ← `FeatureFlags::get(js).getWorkerdExperimental()` (`worker-loader.c++:281`) —
   * the *calling* worker's `experimental` compatibility flag, which gates
   * `allowExperimental` on the loaded one.
   *
   * Every other compatibility flag this package meets was answered by "a runtime
   * with no deployed history takes the current behaviour" (`api/actor.ts`, and the
   * README row for `deleteAllDeletesAlarm`). That reading does not work here:
   * `experimental` has no default-on date and never turns on by itself, so taking
   * the current behaviour would hard-code `false`, make `allowExperimental: true`
   * always throw, and put `streamingTails` out of reach — the feature subset the
   * README's second paragraph forbids. So the bit moves from an ambient to an
   * explicit input, which is what this package does with every ambient.
   * `compileCompatibilityFlags`'s own parameter for the same bit is named
   * `allowExperimentalFeatures`.
   */
  readonly allowExperimentalFeatures: boolean;
};

/**
 * ← `WorkerLoader` (`worker-loader.h:52-150`). "JS interface for worker loader
 * binding."
 *
 * Takes an `IoContext` where upstream reads `IoContext::current()`, which is the
 * substitution every class in `api/` makes (`DurableObjectFacets`,
 * `DurableObjectStorageOperations`); and an `IsolateChannelFactory` where upstream
 * holds a channel number, which is the substitution every outgoing seam in `api/`
 * makes.
 */
export class WorkerLoader implements globalThis.WorkerLoader {
  readonly #ctx: IoContext;
  readonly #channel: IsolateChannelFactory;
  readonly #options: WorkerLoaderOptions;

  constructor(ctx: IoContext, channel: IsolateChannelFactory, options: WorkerLoaderOptions) {
    this.#ctx = ctx;
    this.#channel = channel;
    this.#options = options;
  }

  /**
   * ← `WorkerLoader::get` (`worker-loader.c++:63-83`).
   *
   * Nothing is validated here: the code callback is deferred whole into the reentry
   * callback, so every refusal `toDynamicWorkerSource` can make surfaces at the
   * first request on the returned stub instead. That is upstream's own behaviour
   * and its tests depend on it.
   */
  get(name: string | null | undefined, getCode: () => WorkerCode | Promise<WorkerCode>): WorkerStub {
    const ctx = this.#ctx;

    // ← `ioctx.makeReentryCallback(…)` (`worker-loader.c++:67`), and it is decision 13 for the
    // same reason the facet startup callback is: a Worker loaded from inside
    // blockConcurrencyWhile() would otherwise queue behind the section waiting for it.
    const reenterAndGetCode = ctx.makeReentryCallback(
      async (): Promise<DynamicWorkerSource> =>
        // ← the inner `getCode(js).then(js, …)` (`:70-76`). A jsg promise continuation re-enters
        // the isolate, so the source is built holding a fresh input lock rather than in whatever
        // context the code promise happened to resolve in; `awaitIo` is that re-entry, and it is
        // what keeps `toDynamicWorkerSource` gated (divergence 147).
        await Promise.race([
          ctx.awaitIo(Promise.resolve(getCode()), (code) => this.#toDynamicWorkerSource(code)),
          // ← `JSG_REQUIRE_NONNULL(weakIoctx->tryGet(), …)` (`:73-74`). `awaitIo`'s own answer to
          // an aborted context is to leave its promise unsettled, which would wedge every request
          // on the stub — see `DEAD_LOAD_CONTEXT_MESSAGE`. `onAbort()` only ever rejects.
          ctx.onAbort().catch((): never => {
            throw new Error(DEAD_LOAD_CONTEXT_MESSAGE);
          }),
        ]),
    );

    return new WorkerStub(
      this.#channel.loadIsolate({ name: loadNameOf(name), fetchSource: reenterAndGetCode }),
    );
  }

  /**
   * ← `WorkerLoader::load` (`worker-loader.c++:85-107`). "Shortcut for `get(null,
   * () => code)`."
   *
   * A shortcut with two consequences upstream states outright. The source is built
   * **now**, synchronously, so every refusal below throws from this call rather
   * than from the first request; and `name` is `kj::none`, so the isolate is not
   * cached and a fresh Worker is minted per call.
   *
   * Upstream's clone-per-invocation is absent because a JS source object is
   * immutable and shared safely — see `io/worker-source.ts`'s header. The
   * atomic-refcount wrapper it needs for that ("it may ultimately destroy the
   * `ownContent` in another thread ... Ugh!") goes with it.
   */
  load(code: WorkerCode): WorkerStub {
    // ← `auto& ioctx = IoContext::current();` (`:86`), which asserts. `get()` does not need the
    // line because `makeReentryCallback` makes the same assertion for it.
    requireInputLock(this.#ctx, "load()");

    const source = this.#toDynamicWorkerSource(code);
    return new WorkerStub(
      this.#channel.loadIsolate({ name: undefined, fetchSource: async () => source }),
    );
  }

  /** ← `WorkerLoader::toDynamicWorkerSource` (`worker-loader.c++:109-172`). */
  #toDynamicWorkerSource(code: WorkerCode): DynamicWorkerSource {
    const source = extractSource(code);
    const compatibilityFlags = this.#extractCompatFlags(code);

    // ← `Frankenvalue::fromJs(js, codeEnv.getHandle(js))` (`:117-120`).
    const env = requireSerializableProps(code.env, "env");

    // ← `:122-139`. Three JS states collapse to two: `null` leaves the source's outbound absent,
    // which is what blocks it, and an omitted one inherits the caller's.
    let globalOutbound: Fetcher | undefined;
    if (code.globalOutbound !== undefined) {
      if (code.globalOutbound !== null) {
        globalOutbound = requireTransferableChannel(code.globalOutbound);
      } else {
        // "Application passed `null` to disable internet access. Leave `globalOutbound` as
        // `kj::none`."
      }
    } else {
      // "Inherit the calling worker's global outbound channel." No transferrability check, per
      // upstream: the parent's outbound is by definition allowed to be the child's.
      globalOutbound = this.#channel.getNullClientChannel();
    }

    // ← `:141-148`.
    const tails = (code.tails ?? []).map(requireTransferableChannel);

    // ← `:150-161`.
    const streamingTailsInput = code.streamingTails;
    let streamingTails: readonly Fetcher[] = [];
    if (streamingTailsInput !== undefined) {
      if ((code.allowExperimental ?? false) !== true) {
        throw new Error(STREAMING_TAILS_EXPERIMENTAL_MESSAGE);
      }
      streamingTails = streamingTailsInput.map(requireTransferableChannel);
    }

    return {
      source,
      compatibilityFlags,
      limits: code.limits,
      env,
      globalOutbound,
      tails,
      streamingTails,
    };
  }

  /**
   * ← `WorkerLoader::extractCompatFlags` (`worker-loader.c++:278-306`), first half
   * only.
   *
   * The second half compiles the date and flags into a `CompatibilityFlags::Reader`
   * by walking that schema's capnp annotations, and reports
   * `errorReporter.errors.front()`. There is no `compatibility-date.capnp` here and
   * no schema reflection to walk one with, so the inputs travel on the
   * `DynamicWorkerSource` to the layer that has an isolate to configure. See
   * `CompatibilityFlagsRequest` in `io/io-channels.ts`.
   */
  #extractCompatFlags(code: WorkerCode): CompatibilityFlagsRequest {
    const allowExperimental = code.allowExperimental ?? false;
    if (!this.#options.allowExperimentalFeatures) {
      if (allowExperimental) throw new Error(ALLOW_EXPERIMENTAL_MESSAGE);
    }

    return {
      compatibilityDate: code.compatibilityDate,
      compatibilityFlags: code.compatibilityFlags ?? [],
      allowExperimental,
      dateValidation: this.#options.compatDateValidation,
    };
  }
}

/**
 * ← `kj::Maybe<kj::String> name` on `WorkerLoader::get`. Absent and null are the
 * same request, and both mint a fresh isolate — `worker-loader-test.js:527-541`
 * checks `get(null)` and two `get(undefined)`s all get their own module scope.
 *
 * Unlike the entrypoint name, `"default"` is not special here: it names an
 * isolate, not an export.
 */
function loadNameOf(name: string | null | undefined): string | undefined {
  return name === undefined || name === null ? undefined : String(name);
}

// =======================================================================================
// extractSource

/**
 * ← `WorkerLoader::extractSource` (`worker-loader.c++:174-276`).
 *
 * Iteration order is the object's own key order, which is `jsg::Dict`'s: both the
 * fieldCount and mixed-language refusals name the FIRST offending module in that
 * order, and upstream's `noMixedJsPythonModules` pair depends on it
 * (`worker-loader-test.js:803-835`).
 */
function extractSource(code: WorkerCode): WorkerSource {
  const entries = Object.entries(code.modules);
  if (entries.length === 0) throw new TypeError(NO_MODULES_MESSAGE);

  const modules: SourceModule[] = entries.map(([name, value]) => ({
    name,
    content: moduleContentOf(name, value),
  }));

  // ← `:255`. Whether the Worker is Python is decided by the MAIN module's name alone.
  const isPython = code.mainModule.endsWith(".py");

  // ← `:257-269`. "Disallow Python modules when the main module is a JS module, and vice versa."
  for (const module of modules) {
    const isJsModule =
      module.content.type === "esModule" || module.content.type === "commonJsModule";
    if (isPython && isJsModule) {
      throw new TypeError(jsModuleInPythonWorkerMessage(module.name));
    }
    const isPythonModule = module.content.type === "pythonModule";
    if (!isPython && isPythonModule) {
      throw new TypeError(pythonModuleInJsWorkerMessage(module.name));
    }
  }

  return { variant: { type: "modulesSource", mainModule: code.mainModule, modules, isPython } };
}

/** ← the `KJ_SWITCH_ONEOF(entry.value)` at `worker-loader.c++:179-251`. */
function moduleContentOf(name: string, value: Module | string): ModuleContent {
  if (typeof value === "string") return stringModuleContentOf(name, value);
  return objectModuleContentOf(name, value);
}

/** ← the `kj::String` arm (`:180-207`): the name alone decides the type. */
function stringModuleContentOf(name: string, body: string): ModuleContent {
  if (name.endsWith(".py")) return { type: "pythonModule", body };
  if (name.endsWith(".js")) return { type: "esModule", body };
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".jsx")) {
    throw new TypeError(typeScriptModuleNameMessage(name));
  }
  throw new TypeError(moduleNameMessage(name));
}

/** The seven fields of `WorkerLoader::Module`, in upstream's `JSG_STRUCT` order. */
const MODULE_FIELDS = ["js", "cjs", "text", "data", "json", "py", "wasm"] as const;

/** ← the `Module` arm (`:208-250`). */
function objectModuleContentOf(name: string, module: Module): ModuleContent {
  // ← the seven `!= kj::none` sums at `:209-211`. `jsg::Optional` reads undefined as absent, so a
  // field explicitly set to undefined does not count — which is what makes a `{...spread}` of a
  // partially-filled module behave the same way in both runtimes.
  const fieldCount = MODULE_FIELDS.filter((field) => module[field] !== undefined).length;
  if (fieldCount !== 1) throw new TypeError(moduleFieldCountMessage(name, fieldCount));

  if (module.js !== undefined) return { type: "esModule", body: module.js };
  if (module.cjs !== undefined) return { type: "commonJsModule", body: module.cjs };
  if (module.text !== undefined) return { type: "textModule", body: module.text };
  // ← `:225-232`. "The kj::Array<const byte> produced by jsg::asBytes() points into a V8
  // BackingStore. If the user passed a *resizable* ArrayBuffer they can call resize(0) (or
  // transfer/detach) after load() returns but before the child isolate is compiled
  // asynchronously, leaving us with a (ptr,len) into PROT_NONE pages. Copy now so the bytes
  // survive until compileDataGlobal()."
  if (module.data !== undefined) return { type: "dataModule", body: copyBytes(module.data) };
  if (module.json !== undefined) {
    // ← `js.serializeJson(kj::mv(json))` (`:234-235`). Upstream then clears the field because it
    // moved out of a V8Ref; nothing is moved here. `JSON.stringify` answers undefined for a value
    // it cannot represent at the root — a function or a symbol — where V8's JSON serializer
    // throws; the string is what a module body has to be, so the undefined is made one.
    return { type: "jsonModule", body: JSON.stringify(module.json) ?? "undefined" };
  }
  if (module.py !== undefined) return { type: "pythonModule", body: module.py };
  if (module.wasm !== undefined) return { type: "wasmModule", body: copyBytes(module.wasm) };

  // ← `KJ_UNREACHABLE` (`:247`): fieldCount === 1 has already found one of the seven.
  throw new Error("unreachable: exactly one module field is set");
}

/**
 * ← `jsg::asBytes()` followed by `kj::heapArray<const kj::byte>(data.asPtr())`
 * (`worker-loader.c++:231`, `:244`). The copy is the whole point — see the caller.
 */
function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new TypeError(NOT_BYTES_MESSAGE);
}

// =======================================================================================
// What may cross into a dynamic Worker

/**
 * ← `Fetcher::getSubrequestChannel(ioctx)` followed by
 * `channel->requireAllowsTransfer()` (`worker-loader.c++:125-126`, `:144-145`,
 * `:157-158`).
 *
 * **The check has nothing to call, and that is a recorded divergence rather than
 * an omission.** Upstream's `SubrequestChannel` carries `requireAllowsTransfer()`;
 * here a `SubrequestChannel` and the `Fetcher` built over it are one object
 * (`io/io-channels.ts`'s header, and the same collapse `api/actor.ts` and
 * `api/export-loopback.ts` already made), and a `Fetcher` is
 * `@cloudflare/workers-types`' interface with no such member. The one refusal it
 * produces in the open-source runtime is `throwDynamicEntrypointTransferError`
 * (`server.c++:167-173`), raised by `WorkerService::requireAllowsTransfer` when
 * `isDynamic` — an isolate-host fact here, exactly as it is a `server/` fact there.
 *
 * Kept as a named function rather than inlined so the three call sites read as
 * upstream's do, and so there is one place to put the check if a `Fetcher` seam
 * ever grows one.
 */
function requireTransferableChannel(fetcher: Fetcher): Fetcher {
  return fetcher;
}

/**
 * ← `Frankenvalue::fromJs(js, …)`, whose serializer refuses any object whose JSG
 * resource type declares no `JSG_SERIALIZABLE` (`jsg/ser.c++:175-183`).
 *
 * Four types reachable from this package are in that set, and all four for one
 * reason: `JSG_INHERIT` does not carry serializability. Upstream says so twice — in
 * `export-loopback.h:57-58` ("Note that `LoopbackServiceStub` is intentionally NOT
 * serializable, unlike its parent class Fetcher") and in the test that pins it,
 * whose comment reads "it's more testing LoopbackServiceStub and that
 * serializability is not inherited" (`worker-loader-test.js:91-92`). None of
 * `LoopbackServiceStub`, `LoopbackDurableObjectClass`,
 * `LoopbackDurableObjectNamespace` or `LoopbackColoLocalActorNamespace` declares
 * `JSG_SERIALIZABLE`; every one of them *invoked* produces something that does — a
 * `Fetcher` or a plain `DurableObjectClass` — which is exactly the distinction
 * `worker-loader-test.js:62-107` measures, accepting the invoked form in `props`
 * and refusing the bare binding.
 *
 * **This discharges the obligation the README left open on Section 7.** That row
 * says the refusal would have to come from `src/transport/` if a `Fetcher` ever
 * became serializable; the layer upstream refuses at is this one, because
 * `Frankenvalue::fromJs` runs inside `getEntrypoint`, `getDurableObjectClass` and
 * `toDynamicWorkerSource`. Putting it here makes it reachable today rather than
 * conditional on a transport change that has not happened, and it depends on no
 * transport fact — so `api/` still imports no transport library.
 *
 * The walk descends into plain objects and arrays only. Everything else is a host
 * object: either one the substrate knows how to carry (a `Fetcher`, a
 * `DurableObjectClass`, an `RpcTarget`) or one of the four above. Walking a host
 * object's own keys would drive proxy traps — a stub's `get` mints an RPC import —
 * which is a cost upstream's serializer never pays, because it asks the type rather
 * than the value.
 */
function requireSerializableProps(root: unknown, field: string): unknown {
  // A cycle would otherwise walk forever; upstream's serializer handles one natively.
  const seen = new Set<object>();

  const visit = (value: unknown, path: string): void => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    const subject = value as object;

    const refused = notSerializableType(subject);
    if (refused !== undefined) {
      throw new DOMException(`${notSerializableMessage(refused)} At ${path}.`, "DataCloneError");
    }

    if (seen.has(subject)) return;
    seen.add(subject);

    if (Array.isArray(subject)) {
      subject.forEach((entry, index) => {
        visit(entry, `${path}[${index}]`);
      });
      return;
    }

    // Plain objects only — see the note above on why a host object is not descended into.
    const prototype: unknown = Object.getPrototypeOf(subject);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const [name, entry] of Object.entries(subject)) visit(entry, `${path}.${name}`);
  };

  visit(root, `<${field}>`);
  return root;
}

/**
 * The four `ctx.exports` binding types, named by the class whose name
 * `GetConstructorName()` would report.
 *
 * The four are mutually exclusive — each extends a different base
 * (`api/export-loopback.ts`) — so the order is presentational. What the order does
 * NOT do is reach a base class: `DurableObjectClass`, `DurableObjectNamespace`,
 * `ColoLocalActorNamespace` and `Fetcher` are all serializable upstream
 * (`actor.h:389`), and it is exactly `JSG_INHERIT`'s failure to carry
 * serializability that makes the four subclasses refuse where their bases accept.
 */
function notSerializableType(value: object): string | undefined {
  if (value instanceof LoopbackServiceStub) return "LoopbackServiceStub";
  if (value instanceof LoopbackDurableObjectNamespace) return "LoopbackDurableObjectNamespace";
  if (value instanceof LoopbackColoLocalActorNamespace) return "LoopbackColoLocalActorNamespace";
  if (value instanceof LoopbackDurableObjectClass) return "LoopbackDurableObjectClass";
  return undefined;
}

// =======================================================================================
// The pinned-types check

/** `Value` must be assignable to `Declared`; declaring the constraint is the check. */
type Assignable<Value extends Declared, Declared> = Value;

/**
 * §2.4's no-cast rule: these reach a consumer as `env` bindings typed by
 * `@cloudflare/workers-types`, so the type system checks the surface rather than a
 * cast doing it. The three struct rows point the other way, because a struct is an
 * argument: what has to hold is that every code a consumer can write against the
 * pinned type is one this file accepts. `Module` is a strict superset by the two
 * byte fields, for the reason its own comment gives.
 */
type PinnedWorkerLoaderTypes = [
  Assignable<WorkerLoader, globalThis.WorkerLoader>,
  Assignable<WorkerStub, globalThis.WorkerStub>,
  Assignable<globalThis.WorkerLoaderWorkerCode, WorkerCode>,
  Assignable<globalThis.WorkerLoaderModule, Module>,
  Assignable<globalThis.WorkerStubEntrypointOptions, EntrypointOptions>,
];
