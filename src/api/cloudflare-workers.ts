/**
 * ← workerd `src/cloudflare/workers.ts` — the built-in `cloudflare:workers`
 * module.
 *
 * Upstream's own header explains the file's shape: "C++ built-in modules do not
 * yet support named exports, so we must define this wrapper module that simply
 * re-exports the classes from the built-in module." The classes come from
 * `cloudflare-internal:workers` (`src/cloudflare/internal/workers.d.ts`); the
 * behaviour this file owns is the two proxies and the three scope functions.
 *
 * **The export surface was re-derived, not inherited.** The extension shim this
 * replaces (`offscreen/worker/host/shims/cloudflare-workers.ts`, 58 lines)
 * documents its surface as the result of grepping `from "cloudflare:workers"`
 * across `vendor/agents/packages/agents/src`. Re-running that grep across all of
 * `vendor/agents` finds six values — `env` (178 imports), `exports` (48),
 * `WorkerEntrypoint` (16), `RpcTarget` (16), `DurableObject` (13),
 * `WorkflowEntrypoint` (3) — and **four types the shim does not have**:
 * `WorkflowEvent` (8), `WorkflowSleepDuration` (4), `WorkflowStep` (3) and
 * `WorkflowStepEvent` (2). `@cloudflare/workers-types` declares only
 * `WorkflowSleepDuration` of those four globally, so the other three are
 * declared here, where the module that exports them lives.
 *
 * Everything else upstream exports is ported too, per the package README's rule
 * that consumer count is not the filter: `RpcStub`, `RpcPromise`, `RpcProperty`,
 * `ServiceStub`, `waitUntil`, `cache`, `tracing` and `abortIsolate`. Each of
 * those is a named throwing boundary, and each throw says which layer owns the
 * thing that is missing rather than that it is missing.
 *
 * **The one thing to know before wiring this in.** `RpcTarget` is declared here,
 * as upstream declares it — capnweb's own documentation says "on Cloudflare
 * Workers, this `RpcTarget` is an alias for the one exported from the
 * `cloudflare:workers` module, so they can be used interchangably." That alias is
 * **unreachable** in capnweb 0.10.0: `let workersModule = globalThis[Symbol("workers-module")]`
 * reads a symbol created fresh inside capnweb's own module and exported nowhere,
 * so it is always `undefined` and capnweb falls back to its private `class {}`.
 * `value instanceof RpcTarget` inside capnweb therefore tests capnweb's class,
 * not this one, which is why today's extension shim re-exports capnweb's. The
 * transport adaptation (`src/transport/`) owns reconciling the two; `api/` may not
 * import a transport library, and inverting the dependency — making the module
 * that defines the base class depend on the library that aliases it — is the
 * layering upstream does not have.
 *
 * Spec: the shim-surface inventory in docs/shim-surface.md and decision 16 in
 * docs/decisions.md.
 */

import { asyncContext, withAsyncContext } from "../util/async-context";

// =======================================================================================
// Boundary messages

/**
 * `entrypoints.waitUntil` reaches `IoContext::current()`, a thread-local this
 * package deliberately does not port — `io/io-context.ts`'s invocation stack
 * replaces it, and it is reachable only from inside a gated slice rather than
 * from module scope.
 */
export const MODULE_WAIT_UNTIL_UNIMPLEMENTED_MESSAGE =
  "The module-level waitUntil() from cloudflare:workers has no current request to attach to in " +
  "this runtime. Call ctx.waitUntil() on the DurableObjectState or ExecutionContext you were " +
  "given instead.";

/**
 * Upstream: "In workerd, the handler aborts the process (unless used on a
 * dynamic worker). In the edge runtime it will condemn and terminate the current
 * isolate." There is no isolate to condemn, which is the same absence
 * `DurableObjectState.abort()` records for `js.terminateExecutionNow()`.
 */
export const ABORT_ISOLATE_UNIMPLEMENTED_MESSAGE =
  "abortIsolate() is not available in this runtime: there is no isolate to condemn. Break the " +
  "actor's output gate instead, which is what DurableObjectState.abort() does.";

/** The Workers Cache API is an edge facility; `caches` in a browser is a different contract. */
export const CACHE_UNIMPLEMENTED_MESSAGE =
  "The cloudflare:workers cache context is not available in this runtime: CacheContext.purge() " +
  "is an edge operation with no browser equivalent.";

/** The four stub types are the RPC system's, and the RPC system here is the transport adaptation. */
export const RPC_STUB_UNIMPLEMENTED_MESSAGE =
  "RpcStub, RpcPromise, RpcProperty and ServiceStub belong to the RPC system, which in this " +
  "runtime is the capnweb transport adaptation rather than this module. Construct one through " +
  "the transport.";

/**
 * Upstream's `exports` proxy defines no `set` trap, so an assignment lands on the
 * empty proxy target and is silently lost — its comment says "This proxy is
 * read-only - mutations are not supported." A silent loss is the failure mode
 * this repository's fail-closed tenet exists to prevent, so it throws instead.
 */
export const EXPORTS_READ_ONLY_MESSAGE =
  "The cloudflare:workers exports object is read-only. Install worker exports with " +
  "withExports() or withEnvAndExports().";

/**
 * Upstream's scopes are `AsyncContext`-propagated, so an `async` callback keeps
 * its bindings across an await. Decision 8's propagation is not built (and Part 4
 * records that this package needs none), so the scope here is the synchronous
 * call — which is exactly what upstream's `fn: () => unknown` signature describes
 * and nothing more. A callback that returns a thenable would silently read the
 * wrong bindings after its first await, so it is refused: the same guard, for the
 * same reason, that `transactionSync` already applies to its callback.
 */
export const WITH_SCOPE_ASYNC_MESSAGE =
  "withEnv(), withExports() and withEnvAndExports() take a synchronous callback in this runtime. " +
  "The returned value is a thenable, and everything after its first await would run outside the " +
  "scope with the previous bindings installed.";

// =======================================================================================
// env and exports

/**
 * ← `export const env: Cloudflare.Env`. `Cloudflare.Env` is generated per project
 * from a `wrangler.jsonc`, and this package has neither, so the value type is the
 * open record the extension shim already used.
 */
export type Bindings = Record<string, unknown>;

/**
 * The scope stacks. Upstream's current env comes from
 * `innerEnv.getCurrentEnv()`, which is `kj::none` before the runtime installs
 * one — the branch every trap below guards with `if (inner)`. Here the bottom of
 * each stack is a real object installed at module load, so that branch is
 * unreachable and the guard collapses.
 *
 * The bottom entry is also what makes `Object.assign(env, bindings)` work, which
 * is how a host installs long-lived bindings: upstream's `set` trap forwards into
 * the current env, and here the current env outside any scope is that object.
 */
const envScopes: Bindings[] = [{}];
const exportsScopes: Bindings[] = [{}];

function topOf(scopes: Bindings[]): Bindings {
  const top = scopes.at(-1);
  if (top === undefined) {
    // Unreachable: both stacks are seeded at module load and every push has a matching pop in a
    // `finally`. Written as a throw rather than a `!` because the package has no non-null assertions.
    throw new Error("cloudflare:workers scope stack is empty");
  }
  return top;
}

/**
 * ← the `env` proxy (`workers.ts:41-104`). Upstream's comment, which is the whole
 * reason this is a proxy rather than an object: "Since env is imported as a
 * module-level reference, the object identity cannot be changed. The proxy
 * provides indirection, delegating to different underlying env objects based on
 * async context (see withEnv()). Mutations via this proxy modify the current
 * underlying env object in-place - if you're inside a withEnv() scope, mutations
 * affect the override object, not the base environment."
 */
export const env: Bindings = new Proxy<Bindings>(
  {},
  {
    get(_target, property): unknown {
      return Reflect.get(topOf(envScopes), property);
    },
    set(_target, property, newValue): boolean {
      return Reflect.set(topOf(envScopes), property, newValue);
    },
    has(_target, property): boolean {
      return Reflect.has(topOf(envScopes), property);
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Reflect.ownKeys(topOf(envScopes));
    },
    deleteProperty(_target, property): boolean {
      return Reflect.deleteProperty(topOf(envScopes), property);
    },
    defineProperty(_target, property, attributes): boolean {
      return Reflect.defineProperty(topOf(envScopes), property, attributes);
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      return Reflect.getOwnPropertyDescriptor(topOf(envScopes), property);
    },
  },
);

/**
 * ← the `exports` proxy (`workers.ts:109-147`). Same indirection as `env`, minus
 * the mutating traps — with `set` and `defineProperty` throwing where upstream
 * lets them fall through to the dead proxy target.
 */
export const exports: Bindings = new Proxy<Bindings>(
  {},
  {
    get(_target, property): unknown {
      return Reflect.get(topOf(exportsScopes), property);
    },
    set(): never {
      throw new TypeError(EXPORTS_READ_ONLY_MESSAGE);
    },
    defineProperty(): never {
      throw new TypeError(EXPORTS_READ_ONLY_MESSAGE);
    },
    deleteProperty(): never {
      throw new TypeError(EXPORTS_READ_ONLY_MESSAGE);
    },
    has(_target, property): boolean {
      return Reflect.has(topOf(exportsScopes), property);
    },
    ownKeys(): ArrayLike<string | symbol> {
      return Reflect.ownKeys(topOf(exportsScopes));
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      return Reflect.getOwnPropertyDescriptor(topOf(exportsScopes), property);
    },
  },
);

/** ← `withEnv` (`workers.ts:21-23`). */
export function withEnv(newEnv: unknown, fn: () => unknown): unknown {
  return runInScopes([{ scopes: envScopes, value: newEnv }], fn);
}

/** ← `withExports` (`workers.ts:25-27`). */
export function withExports(newExports: unknown, fn: () => unknown): unknown {
  return runInScopes([{ scopes: exportsScopes, value: newExports }], fn);
}

/** ← `withEnvAndExports` (`workers.ts:29-34`). */
export function withEnvAndExports(
  newEnv: unknown,
  newExports: unknown,
  fn: () => unknown,
): unknown {
  return runInScopes(
    [
      { scopes: envScopes, value: newEnv },
      { scopes: exportsScopes, value: newExports },
    ],
    fn,
  );
}

function runInScopes(
  pushes: readonly { readonly scopes: Bindings[]; readonly value: unknown }[],
  fn: () => unknown,
): unknown {
  // Validate every scope before pushing any: a refusal must not leave one installed realm-wide.
  for (const push of pushes) asBindings(push.value);
  for (const push of pushes) push.scopes.push(asBindings(push.value));
  try {
    const result = fn();
    if (isThenable(result)) throw new TypeError(WITH_SCOPE_ASYNC_MESSAGE);
    return result;
  } finally {
    for (const push of pushes) push.scopes.pop();
  }
}

function asBindings(value: unknown): Bindings {
  if (value !== null && typeof value === "object") return value as Bindings;
  throw new TypeError("cloudflare:workers scopes take an object of bindings.");
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

// =======================================================================================
// The entrypoint classes

/**
 * ← `RpcTarget` (`cloudflare/internal/workers.d.ts`: `export class RpcTarget {}`).
 *
 * Upstream's public type declares it `abstract` with one branding member; the
 * implementation declaration has neither, and this follows the implementation so
 * that a marker instance can exist. See this file's header for the identity
 * constraint capnweb imposes on it.
 */
export class RpcTarget {}

/**
 * ← `DurableObject` (`cloudflare/internal/workers.d.ts`; public shape in
 * `@cloudflare/workers-types`).
 *
 * `extends RpcTarget` is this runtime's, not upstream's: workerd's RPC system
 * knows the three entrypoint classes natively through `Rpc.*Branded`, and
 * capnweb recognises only `RpcTarget`. Same observable behaviour — an instance
 * may be passed by reference over RPC — through the mechanism the substrate has.
 *
 * `ctx` and `env` are `protected` because that is what the published types say,
 * and upstream's comment on `WorkerEntrypoint` says why it matters rather than
 * being style: "`protected` fields don't appear in `keyof`s, so can't be accessed
 * over RPC." The extension shim had them public.
 */
export class DurableObject<Env = unknown, Props = unknown> extends RpcTarget {
  protected ctx: DurableObjectState<Props>;
  protected env: Env;

  constructor(ctx: DurableObjectState<Props>, env: Env) {
    super();
    this.ctx = ctx;
    this.env = env;
  }
}

/** ← `WorkerEntrypoint`. */
export class WorkerEntrypoint<Env = unknown, Props = unknown> extends RpcTarget {
  protected ctx: ExecutionContext<Props>;
  protected env: Env;

  constructor(ctx: ExecutionContext<Props>, env: Env) {
    super();
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * ← `WorkflowEntrypoint`.
 *
 * The extension shim threw from the constructor. That throw is dropped: the class
 * is a plain base whose `run` a Workflows binding dispatches, and there is no
 * Workflows binding here — so the absent thing is the binding, which nothing in
 * this package offers, rather than the base class. Constructing one and never
 * dispatching it is what happens today either way, and a constructor that throws
 * would take down module evaluation for a consumer that merely declares a
 * subclass.
 */
export class WorkflowEntrypoint<Env = unknown, T = unknown> extends RpcTarget {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    super();
    this.ctx = ctx;
    this.env = env;
  }

  run(_event: Readonly<WorkflowEvent<T>>, _step: WorkflowStep): Promise<unknown> {
    throw new Error("WorkflowEntrypoint subclasses must implement run().");
  }
}

// =======================================================================================
// The RPC stub types — the transport adaptation's, not this layer's

/** ← `RpcStub`. */
export class RpcStub {
  constructor(_server: object) {
    throw new Error(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  }
}

/** ← `RpcPromise`. */
export class RpcPromise {
  constructor() {
    throw new Error(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  }
}

/** ← `RpcProperty`. */
export class RpcProperty {
  constructor() {
    throw new Error(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  }
}

/** ← `ServiceStub`. */
export class ServiceStub {
  constructor() {
    throw new Error(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  }
}

// =======================================================================================
// The boundary exports

/** ← `export const waitUntil = entrypoints.waitUntil.bind(entrypoints)`. */
export function waitUntil(_promise: Promise<unknown>): never {
  throw new Error(MODULE_WAIT_UNTIL_UNIMPLEMENTED_MESSAGE);
}

/** ← `abortIsolate` (`workers.ts:206-215`). */
export function abortIsolate(_reason?: string): never {
  throw new Error(ABORT_ISOLATE_UNIMPLEMENTED_MESSAGE);
}

/**
 * ← the `cache` proxy (`workers.ts:152-198`).
 *
 * Upstream's `cache` answers `undefined` when there is no current context —
 * "Used to enable safe no-op access outside module init" — which here would be
 * every access, and `cache.purge(...)` would fail as "purge is not a function"
 * three frames from the cause. A throwing proxy names the boundary at the access.
 *
 * The one assertion in this file, in one place: no value can be a `CacheContext`
 * here, and the object that stands in for one exists precisely so that touching it
 * fails. Same shape as `io/worker.ts`'s `asFacetStub`.
 */
function boundaryObject<T extends object>(message: string): T {
  const thrower = (): never => {
    throw new Error(message);
  };
  return new Proxy(
    {},
    { get: thrower, has: thrower, ownKeys: thrower, getOwnPropertyDescriptor: thrower },
  ) as T;
}

export const cache: CacheContext = boundaryObject(CACHE_UNIMPLEMENTED_MESSAGE);

/** The host owns sampling and recording. The runtime owns span lifetimes and scope. */
export interface WorkerSpanRecorder {
  readonly isTraced: boolean;
  spanContext(): TracingSpanContext;
  setAttribute(key: string, value: boolean | number | string): void;
  setStatus(status: TracingSpanStatus): void;
  updateName(name: string): void;
  recordException(exception: unknown): void;
  end(): void;
}

type WorkerSpanParent = TracingSpanContext & { readonly isRemote?: true };
type StartWorkerSpan = (name: string, parent?: WorkerSpanParent) => WorkerSpanRecorder | undefined;

const SPAN_CONSTRUCTION = Symbol("Span");
const RECORD_SPAN = Symbol.for("@mcp-b/do-runtime/record-worker-span");
const recording = globalThis as typeof globalThis & { [RECORD_SPAN]?: StartWorkerSpan };

/** Install one recorder for this worker realm, including any separately bundled facets. */
export function installWorkerTracing(startSpan: StartWorkerSpan): void {
  if (recording[RECORD_SPAN] && recording[RECORD_SPAN] !== startSpan) {
    throw new TypeError("Worker tracing already has a recorder");
  }
  recording[RECORD_SPAN] = startSpan;
}

class Span {
  #ended = false;

  constructor(token?: typeof SPAN_CONSTRUCTION, private readonly recorder?: WorkerSpanRecorder) {
    if (token !== SPAN_CONSTRUCTION) throw new TypeError("Illegal constructor");
  }

  get isTraced(): boolean {
    return !this.#ended && (this.recorder?.isTraced ?? false);
  }

  // ← workerd ec93d7032: identity is returned by value and survives end().
  spanContext(): TracingSpanContext {
    const context = this.recorder?.spanContext();
    return context
      ? { ...context }
      : { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }

  setAttribute(key: string, value: boolean | number | string): this {
    if (!this.#ended) this.recorder?.setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: Record<string, boolean | number | string | undefined>): this {
    if (this.#ended || !this.recorder) return this;
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.setAttribute(key, value);
    }
    return this;
  }

  updateName(name: string): this {
    if (!this.#ended) this.recorder?.updateName(name);
    return this;
  }

  // ← workerd 1f6faa79b: validation also applies to untraced and ended spans.
  setStatus(status: TracingSpanStatus): this {
    const code = status.code;
    if (code !== "unset" && code !== "ok" && code !== "error") {
      throw new TypeError("Span status code must be 'unset', 'ok', or 'error'.");
    }
    if (!this.#ended) this.recorder?.setStatus(status);
    return this;
  }

  recordException(exception: unknown): void {
    if (!this.#ended) this.recorder?.recordException(exception);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.recorder?.end();
  }
}

// Facet bundles share the constructor and its private creation capability.
const SPAN_REALM = Symbol.for("@mcp-b/do-runtime/span-realm");
type SpanRealm = {
  readonly Span: typeof Span;
  readonly create: (recorder?: WorkerSpanRecorder) => Span;
};
const spanRealms = globalThis as typeof globalThis & { [SPAN_REALM]?: SpanRealm };
const spanRealm = (spanRealms[SPAN_REALM] ??= {
  Span,
  create: (recorder) => new Span(SPAN_CONSTRUCTION, recorder),
});

// ← Workerd's AsyncContextFrame::StorageScope. Browser continuations use
// the runtime's await transform, while Node has native AsyncLocalStorage.
type TraceScope = { readonly span: Span } | { readonly parent: WorkerSpanParent };
const TRACE_SCOPE = Symbol.for("@mcp-b/do-runtime/trace-scope");
type AsyncScope<T> = {
  getStore(): T | undefined;
  run<Result>(store: T, run: () => Result): Result;
};
type NativeAsyncHooks = { AsyncLocalStorage: new <T>() => AsyncScope<T> };
const nodeScopes = globalThis as typeof globalThis & { [TRACE_SCOPE]?: AsyncScope<TraceScope> };
const nodeHost = globalThis as {
  process?: { getBuiltinModule?: (name: string) => unknown };
};
const nodeAsyncHooks = nodeHost.process?.getBuiltinModule?.("node:async_hooks") as
  | NativeAsyncHooks
  | undefined;
const nodeScope = nodeAsyncHooks
  ? (nodeScopes[TRACE_SCOPE] ??= new nodeAsyncHooks.AsyncLocalStorage<TraceScope>())
  : undefined;

function currentTraceScope(): TraceScope | undefined {
  if (nodeScope) return nodeScope.getStore();
  return asyncContext.current.get(TRACE_SCOPE) as TraceScope | undefined;
}

function runInTraceScope<T>(scope: TraceScope, run: () => T): T {
  if (nodeScope) return nodeScope.run(scope, run);
  const context = new Map(asyncContext.current);
  context.set(TRACE_SCOPE, scope);
  return withAsyncContext(context, run);
}

function getActiveSpan(): Span | undefined {
  const scope = currentTraceScope();
  if (scope && "span" in scope) return scope.span;
}

function currentParent(): WorkerSpanParent | undefined {
  const scope = currentTraceScope();
  if (scope) return "span" in scope ? scope.span.spanContext() : scope.parent;
}

function startSpan(name: string): Span {
  return spanRealm.create(recording[RECORD_SPAN]?.(name, currentParent()));
}

function startActiveSpan<T, A extends unknown[]>(
  name: string,
  run: (span: Span, ...args: A) => T,
  ...args: A
): T {
  const span = startSpan(name);
  return runInTraceScope({ span }, () => run(span, ...args));
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function parseTraceparent(value: string | null | undefined): WorkerSpanParent | undefined {
  // Match Workerd's version-00 field widths. All-zero identities are invalid.
  if (value?.length !== 55) return;
  const [, traceId, spanId, flags] = TRACEPARENT.exec(value) ?? [];
  if (!traceId || !spanId || !flags || !/[1-9a-f]/.test(traceId) || !/[1-9a-f]/.test(spanId)) {
    return;
  }
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true };
}

/** Capture W3C trace context for a trusted runtime handoff. */
export function captureWorkerTraceparent(): string | undefined {
  const parent = currentParent();
  if (
    !parent || !Number.isInteger(parent.traceFlags) ||
    parent.traceFlags < 0 || parent.traceFlags > 255
  ) {
    return;
  }
  const flags = parent.traceFlags.toString(16).padStart(2, "0");
  const value = "00-" + parent.traceId + "-" + parent.spanId + "-" + flags;
  if (parseTraceparent(value)) return value;
}

/** Resume trace context at a trusted runtime handoff, including after a restart. */
export function withWorkerTraceparent<T>(
  value: string | null | undefined,
  run: () => T,
): T {
  const parent = parseTraceparent(value);
  return parent ? runInTraceScope({ parent }, run) : run();
}

export const tracing: Tracing = {
  Span: spanRealm.Span,
  startSpan,
  startActiveSpan,
  getActiveSpan,
  enterSpan(name, run, ...args) {
    // Workerd owns the lifetime for enterSpan and defers ending until a
    // returned Promise settles. startActiveSpan leaves ending to the caller.
    return startActiveSpan(name, (span) => {
      let result;
      try {
        result = run(span, ...args);
      } catch (error) {
        span.end();
        throw error;
      }
      if (result instanceof Promise) return result.finally(() => span.end()) as typeof result;
      span.end();
      return result;
    });
  },
};

/** Observe a runtime-owned operation without allocating a span on unconfigured hosts. */
export function observeWorkerOperation<T>(
  name: string,
  run: (span?: ReturnType<Tracing["startSpan"]>) => T,
): T {
  if (!recording[RECORD_SPAN]) return run();
  return tracing.enterSpan(name, (span) => {
    const fail = (error: unknown): never => {
      span.setStatus({ code: "error" });
      throw error;
    };
    try {
      const result = run(span);
      if (result instanceof Promise) return result.catch(fail) as typeof result;
      return result;
    } catch (error) {
      return fail(error);
    }
  });
}

// =======================================================================================
// The Workflow types
//
// `@cloudflare/workers-types` declares `WorkflowSleepDuration`, `WorkflowDurationLabel` and
// `WorkflowRetentionDuration` globally and the rest of the family only inside the
// `cloudflare:workers` module, so the rest are declared here — the module that exports them.
// Ported from that module declaration verbatim; they are types and carry no behaviour.

/**
 * `@cloudflare/workers-types` also declares these two globally, and this module
 * declares its own for the reason upstream's module does: `export type {}` needs
 * a local declaration, and the module is where the names belong.
 */
export type WorkflowDurationLabel =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export type WorkflowSleepDuration = `${number} ${WorkflowDurationLabel}${"s" | ""}` | number;

export type WorkflowRetentionDuration = WorkflowSleepDuration;
export type WorkflowDelayDuration = WorkflowSleepDuration;
export type WorkflowTimeoutDuration = WorkflowSleepDuration;
export type WorkflowBackoff = "constant" | "linear" | "exponential";
export type WorkflowStepSensitivity = "output";

export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDelayDuration | number;
    backoff?: WorkflowBackoff;
  };
  timeout?: WorkflowTimeoutDuration | number;
  sensitive?: WorkflowStepSensitivity;
};

export type WorkflowStepRollbackConfig = Pick<WorkflowStepConfig, "retries" | "timeout">;

export type WorkflowCronSchedule = {
  /** Cron expression that triggered this event. */
  cron: string;
  /** Timestamp of the scheduled trigger, in milliseconds since the Unix epoch. */
  scheduledTime: number;
};

export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
  schedule?: WorkflowCronSchedule;
};

export type WorkflowStepEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  type: string;
  sensitive?: WorkflowStepSensitivity;
};

export type WorkflowStepContext = {
  step: { name: string; count: number };
  attempt: number;
  config: WorkflowStepConfig;
};

export type WorkflowRollbackContext<T = unknown> = {
  ctx: WorkflowStepContext;
  error: Error;
  output: T | undefined;
  /** @deprecated Use `ctx.step.name` and `ctx.step.count` instead. */
  stepName: string;
};

export type WorkflowRollbackHandler<T = unknown> = (
  ctx: WorkflowRollbackContext<T>,
) => Promise<void>;

export type WorkflowStepRollbackOptions<T = unknown> = {
  rollback: WorkflowRollbackHandler<T>;
  rollbackConfig?: WorkflowStepRollbackConfig;
};

/**
 * ← `WorkflowStep`, an abstract class in the module declaration. Declared and
 * never implemented here for the same reason `WorkflowEntrypoint.run` throws: a
 * `WorkflowStep` is handed to `run()` by a Workflows binding, and there is none.
 */
export declare abstract class WorkflowStep {
  do<T>(
    name: string,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  sleep: (name: string, duration: WorkflowSleepDuration) => Promise<void>;
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  waitForEvent<T>(
    name: string,
    options: { type: string; timeout?: WorkflowTimeoutDuration | number },
  ): Promise<WorkflowStepEvent<T>>;
}

export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";
