/**
 * ← workerd `src/workerd/io/worker-source.h` — the `ModulesSource` arm.
 *
 * "Represents the source code for a Worker … WorkerSource is a data structure
 * that can be constructed from either representation -- as well as from
 * non-capnp-based sources, like the dynamic worker loader API." That last clause
 * is why this file exists at all: `api/worker-loader.ts`'s `extractSource`
 * produces one of these, and `io/io-channels.ts`'s `DynamicWorkerSource` carries
 * it, so it has to live in `io/` where both can see it.
 *
 * **A partial port, in the shape `io/io-channels.ts` already established.** Three
 * things upstream has here have nothing to port onto:
 *
 *  - **The `ScriptSource` arm** — Service Workers syntax, one file plus injected
 *    globals. It arrives from a worker *configuration*, and configuration
 *    compilation (`server/workerd-api.c++`'s `compileScript`) has no port here.
 *    `WorkerLoader::extractSource` provably cannot produce one either: its single
 *    `return` is a `ModulesSource` (`api/worker-loader.c++:271-275`). So
 *    `WorkerSource.variant` is declared with the one arm this package can reach,
 *    and stays a tagged union so the other is additive rather than a reshape.
 *  - **`capnpSchemas`, `pythonMemorySnapshot`, `CapnpModule` and
 *    `dynamicEnvBuilder`** — capnp readers and an edge-runtime `env` hack, none of
 *    which has a schema or a reader here.
 *  - **`clone()`** — upstream deep-copies because a `WorkerSource` holds
 *    `StringPtr`s into a buffer someone else owns and `loadIsolate`'s callback
 *    "technically may be called any number of times" (`api/worker-loader.c++:90`).
 *    A JS value has no such lifetime: the same frozen object is handed back on
 *    every call, which is what `clone()` was reproducing. `ownContent` and
 *    `ownContentIsRpcResponse` on `DynamicWorkerSource` are the other half of the
 *    same kj bookkeeping and are absent for the same reason.
 *
 * **A `kj::OneOf` is tagged by its C++ type; a JS union needs the tag in the
 * value.** Every variant here carries a `type` naming upstream's struct, so
 * `content.is<Worker::Script::EsModule>()` becomes `content.type === "esModule"`.
 * That is the same substitution `util/sqlite.ts` makes for statement kinds and
 * the reason it is stated once, here.
 *
 * Spec: §1.11, decision 15 in docs/decisions.md.
 */

/** ← `WorkerSource::EsModule`. `ownBody` is a Rust transpiler artifact with no port. */
export type EsModule = {
  readonly type: "esModule";
  readonly body: string;
};

/** ← `WorkerSource::CommonJsModule`. */
export type CommonJsModule = {
  readonly type: "commonJsModule";
  readonly body: string;
  /** Upstream's field. `WorkerLoader::extractSource` never fills it. */
  readonly namedExports?: readonly string[];
};

/** ← `WorkerSource::TextModule`. "text blob, imports as a string". */
export type TextModule = {
  readonly type: "textModule";
  readonly body: string;
};

/** ← `WorkerSource::DataModule`. "byte blob, imports as ArrayBuffer". */
export type DataModule = {
  readonly type: "dataModule";
  readonly body: Uint8Array;
};

/** ← `WorkerSource::WasmModule`. "Compiled .wasm file content." */
export type WasmModule = {
  readonly type: "wasmModule";
  readonly body: Uint8Array;
};

/**
 * ← `WorkerSource::JsonModule`. "JSON-encoded content; will be parsed
 * automatically when imported."
 */
export type JsonModule = {
  readonly type: "jsonModule";
  readonly body: string;
};

/** ← `WorkerSource::PythonModule`. */
export type PythonModule = {
  readonly type: "pythonModule";
  readonly body: string;
};

/**
 * ← `WorkerSource::ModuleContent`, minus the two arms no ported caller can
 * produce: `PythonRequirement` (a system-provided package, named by a
 * configuration this package does not compile) and `CapnpModule` (a type id into
 * a schema bundle with no reader).
 */
export type ModuleContent =
  | EsModule
  | CommonJsModule
  | TextModule
  | DataModule
  | WasmModule
  | JsonModule
  | PythonModule;

/** ← `WorkerSource::Module`. */
export type Module = {
  readonly name: string;
  readonly content: ModuleContent;
  /** ← "Hack for tests: register this as an internal module. Not allowed in production." */
  readonly treatAsInternalForTest?: boolean;
};

/** ← `WorkerSource::ModulesSource`. "source code for a worker using ES Modules syntax." */
export type ModulesSource = {
  readonly type: "modulesSource";
  /** "Path to the main module, which can be looked up in the module registry." */
  readonly mainModule: string;
  /** "All the Worker's modules." */
  readonly modules: readonly Module[];
  readonly isPython: boolean;
};

/** ← `WorkerSource::variant`, whose `ScriptSource` arm is a boundary — see the header. */
export type WorkerSourceVariant = ModulesSource;

/** ← `WorkerSource`. */
export type WorkerSource = {
  readonly variant: WorkerSourceVariant;
};
