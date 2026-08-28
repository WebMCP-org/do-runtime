/**
 * ← workerd `src/workerd/api/actor-state.{h,c++}`
 *
 * The JS-facing storage objects: `DurableObjectStorageOperations` and its two
 * subclasses, `DurableObjectFacets`, and `DurableObjectState`. Everything below
 * this file is reached through one of them.
 *
 * **`DurableObjectStorage` satisfies workers-types with no cast (§2.4).** That
 * was checked rather than asserted, and two shapes here exist only because it
 * has to: `sql.Cursor` and `sql.Statement` must be constructible with no
 * arguments (see `sql.ts`), and `storage.kv` is required. The narrowings that
 * remain are all one thing —
 * `get<T>` returns the caller's claim about the shape of a value SQLite handed
 * back as bytes, which no check can confirm and which upstream states the same
 * way, as a `jsg::JsRef<jsg::JsValue>` behind a `JSG_TS_OVERRIDE`'d
 * `Promise<T>`. There is no `as unknown as` anywhere in this layer.
 *
 * **Every throw is synchronous, including from the promise-returning methods.**
 * That is upstream's: a `JSG_REQUIRE` inside a method returning `jsg::Promise`
 * throws into the isolate before the promise exists, so `put(k, undefined)`
 * throws rather than rejecting. The same goes for a value that will not decode,
 * because §1.4 makes the SQLite path run the decoder before `Promise.resolve`.
 *
 * **What the input gate does and does not do here.** Every entry point calls
 * `requireInputLock` — see its comment in `io/io-context.ts`, which is the one
 * place this package decides what an empty invocation stack means. Nothing else
 * takes a lock: a read returns a value, a write returns a resolved promise, and
 * `atCheckpointEnd` is what keeps the whole chain inside one transaction
 * (§1.7.1). The two exceptions are upstream's own — `sync()` and the bookmark
 * pair release the gate via `awaitIo`, and `transaction()` takes a critical
 * section.
 *
 * **Decision 2's branch has one reachable site**, and it is not where upstream's
 * is. §1.4 measures that SQLite cache operations are immediate, so their
 * `kj::OneOf<T, kj::Promise<T>>` branch has nothing to select between.
 * `transformMaybeBackpressure` keeps the branch because
 * `DeleteAllResults.backpressure` is still a promise in `io/actor-cache.ts`.
 *
 * Not ported, because the substrate has no equivalent: Hibernatable WebSockets,
 * which is the whole reason `DurableObjectState`'s eight WebSocket methods are
 * named throwing stubs; V8's private wire bytes, replaced by a browser-safe
 * structured-clone encoding with the same public value semantics; the billing
 * counters
 * (`billingUnits`, `ActorObserver`, `updateStorageWriteUnit`) and the trace
 * spans, both already absent throughout; `enableSql`, a workerd namespace option
 * that exists to simulate a non-SQLite Durable Object; and `ReplicaActorOutgoingFactory`,
 * whose replication half is a named boundary in `io/actor-cache.ts`.
 *
 * Spec: §1.4, §1.5, §1.10, §2.4, §2.5, decisions 2, 4 and 14 in
 * docs/decisions.md.
 */

import {
  deserialize as deserializeStructuredClone,
  serialize as serializeStructuredClone,
} from "@ungap/structured-clone";
import type {
  ActorCacheInterface,
  ActorCacheOps,
  ActorCacheTransaction,
  GetResultList,
  ReadOptions,
  WriteOptions,
} from "../io/actor-cache";
import type { IoContext } from "../io/io-context";
import { requireInputLock, setUserErrorDetail } from "../io/io-context";
import type { FacetManager, FacetStartInfo } from "../io/worker";
import type { SqliteKv, SqliteKvListCursor } from "../util/sqlite-kv";
import type { SqliteDatabase } from "../util/sqlite";
import { DurableObjectClass } from "./actor";
import { LoopbackColoLocalActorNamespace, LoopbackDurableObjectNamespace } from "./export-loopback";
import type { ActorScopeBindings } from "./global-scope";
import { SqlStorage } from "./sql";
import type { HibernatableWebSocketRegistry } from "./web-socket";

// =======================================================================================
// Constants

/**
 * ← `MAX_FACET_NAME_LENGTH` / `MAX_FACET_TREE_DEPTH`
 * (`actor-state.c++:943,947`), in the anonymous namespace beside the facet code
 * that enforces them. The scaffolding had them in `server/`, which is neither
 * where upstream puts them nor where they are checked.
 */
export const FACET_NAME_MAX_LENGTH = 256;
/** Root is at depth 0, so the deepest allowed facet is at depth 3. */
export const FACET_TREE_MAX_DEPTH = 4;

/**
 * ← what falls off the end of `DurableObjectFacets::get`'s class switch
 * (`actor-state.c++:1029-1043`).
 *
 * Upstream accepts three things as `FacetStartupOptions.class`: a bare
 * `DurableObjectClass`, a `LoopbackDurableObjectNamespace`, or a
 * `LoopbackColoLocalActorNamespace`, unwrapping the last two through
 * `getClass()`. All three are ported — the loopback pair by
 * `api/export-loopback.ts` — and `KJ_UNREACHABLE` is the fourth case there
 * because JSG has already refused anything else while unwrapping the
 * `kj::OneOf`. The check has to be written here because
 * `@cloudflare/workers-types` declares `interface DurableObjectClass<_T> {}`,
 * which every object satisfies, so nothing refuses it before the method body.
 */
export const FACET_CLASS_UNSUPPORTED_MESSAGE =
  "facets.get() was given a class this runtime cannot resolve. `class` must be a " +
  "DurableObjectClass, a LoopbackDurableObjectNamespace or a LoopbackColoLocalActorNamespace — " +
  "which is what a ctx.exports entry for a Durable Object class is.";

/** ← `DurableObjectStorageOperations::OpName`. Named only where an error quotes them. */
const OP_GET = "get()";
const OP_GET_ALARM = "getAlarm()";
const OP_LIST = "list()";
const OP_PUT = "put()";
const OP_PUT_ALARM = "setAlarm()";
const OP_DELETE = "delete()";
const OP_DELETE_ALARM = "deleteAlarm()";
const OP_ROLLBACK = "rollback()";

/** ← `actor-state.c++:455`, verbatim: the one message both overloads' misuse produces. */
const PUT_OVERLOAD_MESSAGE =
  "put() may only be called with a single key-value pair and optional options as " +
  "put(key, value, options) or with multiple key-value pairs and optional options as " +
  "put(entries, options)";

/**
 * ← the `kj::OneOf<kj::String, jsg::Dict<…>>` unwrap on put()'s first parameter: `jsg::Dict`
 * takes any JS object except an Array — functions and Maps included — and `kj::String` takes
 * everything else by coercion. A type predicate, so the overload split narrows without a cast.
 */
function isEntriesArgument<T>(value: string | Record<string, T>): value is Record<string, T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * ← the struct wrapper (`jsg/struct.h:246-258`), which is NOT the Dict wrapper: `PutOptions` is
 * all-optional fields, so `null` unwraps to default options, and any object does — arrays and
 * functions included, because the wrapper checks `IsObject()` with no Array exclusion. Only a
 * non-null primitive fails to unwrap. Measured on real workerd: `put({k: 1}, null)`, `…, [])`
 * and `…, function () {})` all write, and `put({k: 1}, "v")` alone is the overload error.
 */
function isPutOptions(value: unknown): boolean {
  return value === null || typeof value === "object" || typeof value === "function";
}

/** The key immediately after `k` in byte order is `k` plus this. */
const NULL_CHARACTER = "\u0000";
/** ← the `0xff` upstream strips from the tail of a prefix, in UTF-16 code units. */
const MAX_CODE_UNIT = 0xffff;

// =======================================================================================
// The value codec

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** A byte JSON could never begin with, `DO`, and the local codec version. */
const VALUE_CODEC_HEADER = new Uint8Array([0, 0x44, 0x4f, 1]);

/**
 * ← `serializeV8Value`. The wire bytes differ because V8's serializer is not
 * available in browsers; the public structured-clone value semantics do not.
 * The short header keeps the new representation unambiguous while old JSON rows
 * remain readable.
 */
export function serializeValue(value: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(serializeStructuredClone(value)));
  const encoded = new Uint8Array(VALUE_CODEC_HEADER.byteLength + body.byteLength);
  encoded.set(VALUE_CODEC_HEADER);
  encoded.set(body, VALUE_CODEC_HEADER.byteLength);
  return encoded;
}

/**
 * ← `deserializeV8Value`.
 *
 * Upstream logs "the key (to help find the data in the database if it hasn't
 * been deleted), the length of the value, and the first three bytes of the value
 * (which is just the v8-internal version header and the tag that indicates the
 * type of the value, but not its contents)". Our four-byte header carries only
 * a marker and version for the same reason.
 */
export function deserializeValue<T = unknown>(key: string, buffer: Uint8Array): T {
  if (buffer.byteLength === 0) {
    throw new Error(`unexpectedly empty value buffer; key = ${key}`);
  }
  try {
    const structured = VALUE_CODEC_HEADER.every((byte, index) => buffer[index] === byte);
    const bytes = structured ? buffer.subarray(VALUE_CODEC_HEADER.byteLength) : buffer;
    const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
    const value = structured
      ? deserializeStructuredClone(parsed as ReturnType<typeof serializeStructuredClone>)
      : parsed;
    return value as T;
  } catch (exception) {
    throw new Error(
      "actor storage deserialization failed: failed to deserialize stored value; " +
        `key = ${key}; size = ${buffer.byteLength}`,
      { cause: exception },
    );
  }
}

// =======================================================================================
// The option transforms

/**
 * ← `transformMaybeBackpressure` (`actor-state.c++:103-119`). THIS is decision
 * 2's live site: `DeleteAllResults.backpressure` is still `Promise<void> |
 * undefined`, so the branch has something to select between.
 *
 * Upstream's own note, kept because it is the reason the flag is threaded here
 * at all: "In practice `allowConcurrency` will have no effect on a backpressure
 * promise since backpressure blocks everything anyway, but we pass the option
 * through for consistency in case of future changes."
 */
function transformMaybeBackpressure(
  ctx: IoContext,
  options: { readonly allowConcurrency?: boolean },
  maybeBackpressure: Promise<void> | undefined,
): Promise<void> {
  if (maybeBackpressure === undefined) return Promise.resolve();
  if (options.allowConcurrency === true) return ctx.awaitIo(maybeBackpressure);
  return ctx.awaitIoWithInputLock(maybeBackpressure, () => {});
}

// =======================================================================================
// compileListOptions

/** ← `DurableObjectStorageOperations::CompiledListOptions`. */
type CompiledListOptions = {
  readonly start: string;
  readonly end: string | undefined;
  readonly reverse: boolean;
  readonly limit: number | undefined;
};

/**
 * ← `DurableObjectStorageOperations::compileListOptions`
 * (`actor-state.c++:314-417`). Returns undefined if the list operation would
 * provably return no results. `SyncKvStorage` reuses it, exactly as upstream's
 * comment says it must.
 *
 * Two translations. `startAfter` gains ONE null character where upstream's
 * `kj::String` gains two, because the second of upstream's is the terminator and
 * a JS string has none. And every comparison here is on UTF-16 code units where
 * upstream's is on UTF-8 bytes, while the range the database actually applies is
 * SQLite's `BINARY` collation over UTF-8 — the two orders agree for every key
 * outside the astral planes, and a key that mixes astral characters with a
 * prefix can land on the wrong side of a clamp this function computes.
 */
function compileListOptions(
  options: DurableObjectListOptions | undefined,
): CompiledListOptions | undefined {
  let start = "";
  let end: string | undefined;
  let reverse = false;
  let limit: number | undefined;

  if (options !== undefined) {
    if (options.start !== undefined) {
      if (options.startAfter !== undefined) {
        throw new TypeError("list() cannot be called with both start and startAfter values.");
      }
      start = options.start;
    }
    if (options.startAfter !== undefined) {
      // Convert an exclusive startAfter into an inclusive start key, so the implementation below
      // does not have to handle both. ONE null character, not upstream's two: the second of
      // upstream's is `kj::String`'s terminator, and a JS string has none.
      start = options.startAfter + NULL_CHARACTER;
    }
    if (options.end !== undefined) end = options.end;
    if (options.reverse !== undefined) reverse = options.reverse;
    if (options.limit !== undefined) {
      if (!(options.limit > 0)) throw new TypeError("List limit must be positive.");
      limit = options.limit;
    }

    const prefix = options.prefix;
    if (prefix !== undefined && prefix.length > 0) {
      // Let's clamp `start` and `end` to include only keys with the given prefix.
      if (start < prefix) {
        // `start` is before `prefix`, so listing should actually start at `prefix`.
        start = prefix;
      } else if (start.startsWith(prefix)) {
        // `start` is within the prefix, so need not be modified.
      } else {
        // `start` comes after the last value with the prefix, so there's no overlap.
        return undefined;
      }

      const keyAfterPrefix = firstKeyAfterPrefix(prefix);
      if (keyAfterPrefix === undefined) {
        // The prefix is a run of maximal code units, so it includes the entire key space through
        // the last possible key. Hence there is no end — but an end specified earlier still holds.
      } else if (end === undefined) {
        // We didn't have any end set, so use the end of the prefix range.
        end = keyAfterPrefix;
      } else if (end <= prefix) {
        // No keys could possibly match both the end and the prefix.
        return undefined;
      } else if (end.startsWith(prefix)) {
        // `end` is within the prefix, so need not be modified.
      } else {
        // `end` comes after all keys with the prefix, so stop at the end of the prefix.
        end = keyAfterPrefix;
      }
    }
  }

  if (end !== undefined && end <= start) {
    // Key range is empty.
    return undefined;
  }

  return { start, end, reverse, limit };
}

/**
 * ← the `keyAfterPrefix` vector: strip maximal trailing units, then increment.
 *
 * Returns undefined when the prefix is nothing but maximal units, which is
 * upstream's "the prefix is a string of some number of 0xff bytes, so includes
 * the entire key space up through the last possible key".
 */
function firstKeyAfterPrefix(prefix: string): string | undefined {
  let head = prefix;
  while (head.length > 0 && head.charCodeAt(head.length - 1) === MAX_CODE_UNIT) {
    head = head.slice(0, -1);
  }
  if (head.length === 0) return undefined;
  return head.slice(0, -1) + String.fromCharCode(head.charCodeAt(head.length - 1) + 1);
}

// =======================================================================================
// SyncKvStorage

/**
 * ← workerd `src/workerd/api/sync-kv.{h,c++}`. The synchronous surface lives
 * beside the asynchronous storage owner because both share the same codec and
 * list-option compiler over one `SqliteKv`.
 */
class SyncKvStorage implements globalThis.SyncKvStorage {
  readonly #ctx: IoContext;
  readonly #kv: SqliteKv;

  constructor(ctx: IoContext, kv: SqliteKv) {
    this.#ctx = ctx;
    this.#kv = kv;
  }

  get<T = unknown>(key: string): T | undefined {
    requireInputLock(this.#ctx, "kv.get()");
    const value = this.#kv.get(key);
    if (value === undefined) return undefined;
    return deserializeValue<T>(key, value);
  }

  list<T = unknown>(options?: globalThis.SyncKvListOptions): Iterable<[string, T]> {
    requireInputLock(this.#ctx, "kv.list()");
    const compiled = compileListOptions(options);
    if (compiled === undefined) {
      // Key range is empty. Upstream allocates a cursor over a null query for exactly this.
      return [];
    }

    const cursor = this.#kv.list(
      compiled.start,
      compiled.end,
      compiled.limit,
      compiled.reverse ? "REVERSE" : "FORWARD",
    );
    return listIterator<T>(cursor);
  }

  put<T>(key: string, value: T): void {
    requireInputLock(this.#ctx, "kv.put()");
    this.#kv.put(key, serializeValue(value));
  }

  delete(key: string): boolean {
    requireInputLock(this.#ctx, "kv.delete()");
    return this.#kv.delete(key);
  }
}

/** ← `SyncKvStorage::listNext`, whose cancellation branch is the reason it is not a plain loop. */
function* listIterator<T>(cursor: SqliteKvListCursor): IterableIterator<[string, T]> {
  for (;;) {
    const pair = cursor.next();
    if (pair !== undefined) {
      yield [pair.key, deserializeValue<T>(pair.key, pair.value)];
      continue;
    }
    if (cursor.wasCanceled()) {
      throw new Error(
        "kv.list() iterator was invalidated because a new call to kv.list() was started. " +
          "Only one kv.list() iterator can exist at a time.",
      );
    }
    return;
  }
}

// =======================================================================================
// DurableObjectStorageOperations

/**
 * ← `DurableObjectStorageOperations`. "Common implementation of
 * DurableObjectStorage and DurableObjectTransaction. This class is designed to
 * be used as a mixin."
 */
abstract class DurableObjectStorageOperations {
  protected readonly ctx: IoContext;

  constructor(ctx: IoContext) {
    this.ctx = ctx;
  }

  protected abstract getCache(op: string): ActorCacheOps;

  get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
  get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
  get<T = unknown>(
    keyOrKeys: string | string[],
    maybeOptions?: DurableObjectGetOptions,
  ): Promise<T | undefined> | Promise<Map<string, T>> {
    requireInputLock(this.ctx, OP_GET);
    const options = { ...maybeOptions };
    if (typeof keyOrKeys === "string") return this.#getOne<T>(keyOrKeys, options);
    return this.#getMultiple<T>(keyOrKeys, options);
  }

  getAlarm(maybeOptions?: DurableObjectGetAlarmOptions): Promise<number | null> {
    requireInputLock(this.ctx, OP_GET_ALARM);
    // Even if we do not have an alarm handler, we might once have had one. It's fine to return
    // whatever a previous alarm setting or a falsy result.
    const options = { ...maybeOptions, noCache: false };
    return Promise.resolve(this.getCache(OP_GET_ALARM).getAlarm(options));
  }

  list<T = unknown>(maybeOptions?: DurableObjectListOptions): Promise<Map<string, T>> {
    requireInputLock(this.ctx, OP_LIST);
    const compiled = compileListOptions(maybeOptions);
    if (compiled === undefined) return Promise.resolve(new Map<string, T>());

    const options = { ...maybeOptions };
    const cache = this.getCache(OP_LIST);
    const result = compiled.reverse
      ? cache.listReverse(compiled.start, compiled.end, compiled.limit, options)
      : cache.list(compiled.start, compiled.end, compiled.limit, options);
    return Promise.resolve(listResultsToMap<T>(result));
  }

  put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, T>,
    valueOrOptions?: T | DurableObjectPutOptions,
    maybeOptions?: DurableObjectPutOptions,
  ): Promise<void> {
    requireInputLock(this.ctx, OP_PUT);
    // The second parameter carries a value in one overload and the options bag in the other, and
    // which it is follows from the first — so `isEntriesArgument` below is the parameter-1
    // unwrap, and the guard after it is `optionsTypeHandler.tryUnwrap` on parameter 2. Two
    // upstream steps, in that order: which overload, then whether the rest of the call agrees
    // with it.
    //
    // ← the `kj::OneOf<kj::String, jsg::Dict<...>>` unwrap, which picks the overload by which
    // alternative accepts the argument. `jsg::Dict` takes a plain object and refuses an Array;
    // `kj::String` takes everything else by stringifying it — so a non-string key is NOT a
    // mistake upstream, it is the single-key overload with a coerced key. Reading one as entries
    // instead is a silently dropped write, because `Object.entries` on a primitive is `[]`: the
    // call resolves having written nothing.
    //
    // Measured on real workerd: `put(123, "v")` writes `"123"`, `put(null, "v")` writes `"null"`,
    // `put(10n, "v")` writes `"10"`, `put([["a", 1]], "v")` writes `"a,1"`, and a symbol key
    // throws V8's own conversion error. That last one is why the coercion below is a template
    // literal: `String(symbol)` is the one form that returns a description instead of throwing,
    // so it would swallow the case upstream refuses. `put(new Map(...))` reaches the Dict
    // alternative and writes nothing, which the entries branch already reproduces.
    //
    // A function reaches the `Dict` alternative too, so it is entries here rather than a key
    // stringified to its own source text.
    if (!isEntriesArgument(keyOrEntries)) {
      if (valueOrOptions === undefined) {
        throw new TypeError("put() called with undefined value.");
      }
      return this.#putOne(`${keyOrEntries}`, valueOrOptions as T, { ...maybeOptions });
    }
    // ← the `else` of `optionsTypeHandler.tryUnwrap` (`actor-state.c++:449-456`): once the key
    // unwrapped as a `Dict`, a second argument can only be the options bag, and a non-null
    // primitive there is the caller mixing the two overloads. Without this the value spreads
    // into the options — `put({a: 1}, "v")` wrote key `a` with `{0: "v"}` for options.
    if (valueOrOptions !== undefined && !isPutOptions(valueOrOptions)) {
      throw new TypeError(PUT_OVERLOAD_MESSAGE);
    }
    return this.#putMultiple(keyOrEntries, {
      ...(valueOrOptions as DurableObjectPutOptions | undefined),
    });
  }

  delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
  delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
  delete(
    keyOrKeys: string | string[],
    maybeOptions?: DurableObjectPutOptions,
  ): Promise<boolean> | Promise<number> {
    requireInputLock(this.ctx, OP_DELETE);
    const options = { ...maybeOptions };
    if (typeof keyOrKeys === "string") {
      return Promise.resolve(this.getCache(OP_DELETE).delete(keyOrKeys, options));
    }
    return Promise.resolve(this.getCache(OP_DELETE).deleteMultiple(keyOrKeys, options));
  }

  setAlarm(scheduledTime: number | Date, maybeOptions?: DurableObjectSetAlarmOptions): Promise<void> {
    requireInputLock(this.ctx, OP_PUT_ALARM);
    const when = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    if (!(when > 0)) {
      throw new TypeError("setAlarm() cannot be called with an alarm time <= 0");
    }

    // "This doesn't check if we have an alarm handler per say. It checks if we have an initialized
    // (post-ctor) JS durable object with an alarm handler."
    this.ctx.getActorOrThrow().assertCanSetAlarm();

    const options = { ...maybeOptions, noCache: false };

    // "We fudge times set in the past to Date.now() to ensure that any one user can't DDOS the
    // alarm polling system by putting dates far in the past and therefore getting sorted earlier by
    // the index. This also ensures uniqueness of alarm times (which is required for correctness)."
    this.getCache(OP_PUT_ALARM).setAlarm(Math.max(when, this.ctx.now()), options);
    return Promise.resolve();
  }

  deleteAlarm(maybeOptions?: DurableObjectSetAlarmOptions): Promise<void> {
    requireInputLock(this.ctx, OP_DELETE_ALARM);
    // Even if we do not have an alarm handler, we might once have had one. It's fine to remove that
    // alarm or noop on the absence of one.
    const options = { ...maybeOptions, noCache: false };
    this.getCache(OP_DELETE_ALARM).setAlarm(null, options);
    return Promise.resolve();
  }

  #getOne<T>(key: string, options: ReadOptions): Promise<T | undefined> {
    const value = this.getCache(OP_GET).get(key, options);
    return Promise.resolve(value === undefined ? undefined : deserializeValue<T>(key, value));
  }

  #getMultiple<T>(keys: string[], options: ReadOptions): Promise<Map<string, T>> {
    const result = this.getCache(OP_GET).getMultiple(keys, options);
    return Promise.resolve(listResultsToMap<T>(result));
  }

  #putOne<T>(key: string, value: T, options: WriteOptions): Promise<void> {
    this.getCache(OP_PUT).put(key, serializeValue(value), options);
    return Promise.resolve();
  }

  #putMultiple<T>(entries: Record<string, T>, options: WriteOptions): Promise<void> {
    const pairs: { key: string; value: Uint8Array }[] = [];
    for (const [key, value] of Object.entries(entries)) {
      // "We silently drop fields with value=undefined in putMultiple. There aren't many good
      // options here, as deleting an undefined field is confusing, throwing could break otherwise
      // working code, and a stray undefined here or there is probably closer to what the user
      // desires."
      if (value === undefined) continue;
      pairs.push({ key, value: serializeValue(value) });
    }
    this.getCache(OP_PUT).putMultiple(pairs, options);
    return Promise.resolve();
  }
}

/** ← `listResultsToMap` and `getMultipleResultsToMap`, minus the billing halves. */
function listResultsToMap<T>(rows: GetResultList): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of rows) {
    map.set(entry.key, deserializeValue<T>(entry.key, entry.value));
  }
  return map;
}

// =======================================================================================
// DurableObjectStorage

/**
 * The engine `DurableObjectStorage` drives.
 *
 * Upstream holds an `ActorCacheInterface` and reaches `getSqliteDatabase()` /
 * `getSqliteKv()` through it, both `kj::Maybe`s that are non-null exactly when
 * the actor is SQLite-backed — which here it always is. `transactionSync` is the
 * third member and is one layer lower than upstream's for the reason
 * `io/actor-sqlite.ts` records: the savepoint depth counter and `notifyWrite`
 * both live there, so this file's is a one-line forward the way
 * `blockConcurrencyWhile` already is.
 */
export type StorageCache = ActorCacheInterface & {
  getSqliteDatabase(): SqliteDatabase;
  getSqliteKv(): SqliteKv;
  transactionSync<T>(callback: () => T): T;
};

export class DurableObjectStorage
  extends DurableObjectStorageOperations
  implements globalThis.DurableObjectStorage
{
  readonly #cache: StorageCache;
  #sql: SqlStorage | undefined;
  #kv: globalThis.SyncKvStorage | undefined;

  constructor(ctx: IoContext, cache: StorageCache) {
    super(ctx);
    this.#cache = cache;
  }

  /** ← `DurableObjectStorage::getActorCacheInterface`, which `DurableObjectState::abort` needs. */
  getActorCacheInterface(): StorageCache {
    return this.#cache;
  }

  /** ← `DurableObjectStorage::getSqliteDb`. Always SQLite-backed here; see the header. */
  getSqliteDb(): SqliteDatabase {
    return this.#cache.getSqliteDatabase();
  }

  protected override getCache(): ActorCacheOps {
    return this.#cache;
  }

  /** ← `JSG_LAZY_INSTANCE_PROPERTY(sql, getSql)`. */
  get sql(): SqlStorage {
    this.#sql ??= new SqlStorage(this.ctx, this);
    return this.#sql;
  }

  /** ← `JSG_LAZY_INSTANCE_PROPERTY(kv, getKv)`. */
  get kv(): globalThis.SyncKvStorage {
    this.#kv ??= new SyncKvStorage(this.ctx, this.#cache.getSqliteKv());
    return this.#kv;
  }

  /**
   * ← `DurableObjectStorage::deleteAll`.
   *
   * `deleteAlarm` is upstream's `FeatureFlags::get(js).getDeleteAllDeletesAlarm()`,
   * a compatibility flag that exists so Workers published before it keep the old
   * behaviour. A runtime with no deployed history takes the current behaviour.
   */
  deleteAll(maybeOptions?: DurableObjectPutOptions): Promise<void> {
    requireInputLock(this.ctx, "deleteAll()");
    const options = { ...maybeOptions };
    const result = this.#cache.deleteAll(options, { deleteAlarm: true });
    return transformMaybeBackpressure(this.ctx, options, result.backpressure);
  }

  /**
   * ← `DurableObjectStorage::transaction`.
   *
   * The critical section is load bearing and upstream says why: "the call to
   * `startTransaction()` is when the SQLite-backed implementation will actually
   * invoke `BEGIN TRANSACTION`, so it's important that we're inside the
   * blockConcurrencyWhile block before that point so we don't accidentally catch
   * some other asynchronous event in our transaction."
   *
   * The exception is packed into the result rather than thrown out of the
   * section, and then rethrown outside it. Upstream's reason: "We don't actually
   * want to reset the object, we only want to roll back the transaction and
   * propagate the exception." A throw out of a critical section permanently
   * breaks the input gate (§1.5), so a failing transaction callback would
   * destroy the actor.
   */
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    requireInputLock(this.ctx, "transaction()");
    type TxnResult =
      | { readonly isError: false; readonly value: T }
      | { readonly isError: true; readonly exception: unknown };

    return this.ctx
      .blockConcurrencyWhile(async (): Promise<TxnResult> => {
        const txn = new DurableObjectTransaction(this.ctx, this.#cache.startTransaction());
        try {
          const value = await closure(txn);
          txn.maybeCommit();
          return { isError: false, value };
        } catch (exception) {
          txn.maybeRollback();
          return { isError: true, exception };
        }
      })
      .then((result) => {
        if (result.isError) throw result.exception;
        return result.value;
      });
  }

  /** ← `DurableObjectStorage::transactionSync`, a forward for the reason above. */
  transactionSync<T>(callback: () => T): T {
    requireInputLock(this.ctx, "transactionSync()");
    return this.#cache.transactionSync(callback);
  }

  /**
   * ← `DurableObjectStorage::sync`.
   *
   * Upstream's `awaitIo` rather than `awaitIoWithInputLock`, which is the one
   * storage method that deliberately opens the gate: "we're merely checking if
   * we have any pending or in-flight operations, and providing a promise that
   * resolves when they succeed."
   */
  sync(): Promise<void> {
    requireInputLock(this.ctx, "sync()");
    return this.ctx.awaitIo(this.#cache.onNoPendingFlush());
  }

  /**
   * Real, not a boundary: `ActorSqlite`'s is "an ersatz implementation that's
   * good enough for local dev with D1's Session API", built on the metadata
   * table's local-development bookmark. Anything above this package that
   * surfaces it to an application should know it is a counter and not a
   * recovery point — as it is on workerd.
   */
  getCurrentBookmark(): Promise<string> {
    requireInputLock(this.ctx, "getCurrentBookmark()");
    return this.ctx.awaitIo(this.#cache.getCurrentBookmark());
  }

  waitForBookmark(bookmark: string): Promise<void> {
    requireInputLock(this.ctx, "waitForBookmark()");
    return this.ctx.awaitIo(this.#cache.waitForBookmark(bookmark));
  }

  /** Substrate boundary: point-in-time recovery. Upstream reaches the cache directly, as this does. */
  getBookmarkForTime(timestamp: number | Date): Promise<string> {
    return this.#cache.getBookmarkForTime(
      timestamp instanceof Date ? timestamp.getTime() : timestamp,
    );
  }

  /** Substrate boundary: point-in-time recovery. */
  onNextSessionRestoreBookmark(bookmark: string): Promise<string> {
    return this.#cache.onNextSessionRestoreBookmark(bookmark);
  }

  /** Substrate boundary: replication. */
  ensureReplicas(): void {
    this.#cache.ensureReplicas();
  }

  /** Substrate boundary: replication. */
  disableReplicas(): void {
    this.#cache.disableReplicas();
  }

  /**
   * ← `DurableObjectStorage::getPrimary` / `isReplica`. `maybePrimary` is set
   * only by the replica constructor, and nothing constructs a replica here, so
   * these answer upstream's own non-replica case rather than a stubbed one.
   */
  getPrimary(): undefined {
    return undefined;
  }

  isReplica(): boolean {
    return false;
  }
}

// =======================================================================================
// DurableObjectTransaction

class DurableObjectTransaction
  extends DurableObjectStorageOperations
  implements globalThis.DurableObjectTransaction
{
  /** Becomes undefined when committed or rolled back. */
  #cacheTxn: ActorCacheTransaction | undefined;
  #rolledBack = false;

  constructor(ctx: IoContext, cacheTxn: ActorCacheTransaction) {
    super(ctx);
    this.#cacheTxn = cacheTxn;
  }

  protected override getCache(op: string): ActorCacheOps {
    if (this.#rolledBack) throw new Error(`Cannot ${op} on rolled back transaction`);
    const txn = this.#cacheTxn;
    if (txn === undefined) {
      throw new Error(
        `Cannot call ${op} on transaction that has already committed: ` +
          "did you move `txn` outside of the closure?",
      );
    }
    return txn;
  }

  /** Called from JS. */
  rollback(): void {
    if (this.#rolledBack) return; // allow multiple calls to rollback()
    this.getCache(OP_ROLLBACK); // just for the checks
    const txn = this.#cacheTxn;
    if (txn !== undefined) {
      txn.rollback();
      // ← the `IoContext::addWaitUntil(prom.attach(mv(cacheTxn)))`, whose attach is the
      // destruction Section 1 turned into an explicit drop.
      txn.drop();
      this.#cacheTxn = undefined;
    }
    this.#rolledBack = true;
  }

  /** Just throws an exception saying this isn't supported. */
  deleteAll(): never {
    throw new Error("Cannot call deleteAll() within a transaction");
  }

  /**
   * Called from the runtime, not JS, after the transaction callback has
   * completed. Does nothing if the transaction is already committed or rolled
   * back. Synchronous, because `ActorCacheTransaction::commit` is (§1.4).
   */
  maybeCommit(): void {
    const txn = this.#cacheTxn;
    if (txn === undefined) return;
    this.#cacheTxn = undefined;
    txn.commit();
    txn.drop();
  }

  /** Same, for the failure path. Upstream's drops the transaction, whose destructor rolls back. */
  maybeRollback(): void {
    const txn = this.#cacheTxn;
    this.#cacheTxn = undefined;
    this.#rolledBack = true;
    txn?.drop();
  }
}

// =======================================================================================
// DurableObjectFacets

/**
 * ← `requireValidFacetName` (`actor-state.c++:949-952`).
 *
 * The comparison is `name.size()` on a `kj::StringPtr`, which is **UTF-8 bytes**,
 * so it is measured in bytes here too — the same `TextEncoder` pass, for the same
 * reason, that `ColoLocalActorNamespace.get`'s `[1, 2048]` bound already costs.
 * Comparing `name.length` accepts a 256-character non-ASCII name that upstream
 * refuses, which is a bound a caller can hit.
 */
function requireValidFacetName(name: string): void {
  if (textEncoder.encode(name).length > FACET_NAME_MAX_LENGTH) {
    throw new TypeError(`Facet name is too long (max ${FACET_NAME_MAX_LENGTH} characters).`);
  }
}

/**
 * ← the `KJ_SWITCH_ONEOF(options.$class)` lambda (`actor-state.c++:1029-1043`).
 *
 * Three arms, and the order matters for the same reason it does upstream: a
 * `LoopbackDurableObjectClass` *is* a `DurableObjectClass`, so it takes the bare
 * arm here exactly as JSG's `kj::OneOf` unwraps it into the first alternative.
 * The two loopback namespaces are not classes and carry one, which `getClass()`
 * hands back.
 *
 * A `ctx.exports` entry is the callable façade `api/export-loopback.ts` produces
 * rather than the instance itself, and every check below is an `instanceof` that
 * the façade's `getPrototypeOf` answers — which is why that trap exists.
 */
function requireFacetClass(actorClass: unknown): DurableObjectClass {
  if (actorClass instanceof DurableObjectClass) return actorClass;
  if (actorClass instanceof LoopbackDurableObjectNamespace) return actorClass.getClass();
  if (actorClass instanceof LoopbackColoLocalActorNamespace) return actorClass.getClass();
  throw new TypeError(FACET_CLASS_UNSUPPORTED_MESSAGE);
}

/**
 * ← `DurableObjectFacets`.
 *
 * **`clone` is the fourth method, and the vendored C++ snapshot does not have
 * it.** The design record cites `actor-state.h:431-497` and
 * `server.c++:721-749`; neither line range contains it, `DurableObjectFacets`
 * there exposes exactly `get`, `abort` and `delete`, and
 * `Worker::Actor::FacetManager` has exactly `getDepth`, `getFacet`, `abortFacet`
 * and `deleteFacet`. It is real all the same: `@cloudflare/workers-types`
 * 4.20260702.1 — a month newer than the snapshot — declares
 * `clone(src: string, dst: string): void` on `DurableObjectFacets`. So the
 * signature comes from the types and the semantics from §1.10 (abort dst, delete
 * dst storage, recursive copy of the src subtree), and the orchestration is
 * `server/`'s `cloneFacet`. There is nothing upstream to check the body against,
 * which makes it the one method here with no reference — worth knowing when it
 * is wrong.
 */
export class DurableObjectFacets implements globalThis.DurableObjectFacets {
  readonly #ctx: IoContext;
  readonly #facetManager: FacetManager | undefined;
  readonly #parentId: string;

  constructor(ctx: IoContext, facetManager: FacetManager | undefined, parentId: string) {
    this.#ctx = ctx;
    this.#facetManager = facetManager;
    this.#parentId = parentId;
  }

  /**
   * Get a facet by name, starting it if it isn't already running.
   * `getStartupOptions` is invoked only if the facet wasn't already running.
   *
   * Returns a `Fetcher` instead of a `DurableObject` because the returned stub
   * does not have the `id` or `name` methods that a DO stub normally has.
   */
  get<T extends Rpc.DurableObjectBranded | undefined = undefined>(
    name: string,
    getStartupOptions: () => FacetStartupOptions<T> | Promise<FacetStartupOptions<T>>,
  ): Fetcher<T> {
    requireValidFacetName(name);
    const facetManager = this.#getFacetManager();

    if (facetManager.getDepth() + 1 >= FACET_TREE_MAX_DEPTH) {
      throw new Error(
        "Facet nesting depth limit exceeded. The maximum depth including the root Durable " +
          `Object is ${FACET_TREE_MAX_DEPTH}.`,
      );
    }

    // Where upstream reads `IoContext::current()`, which is after both checks above.
    requireInputLock(this.#ctx, "facets.get()");

    // ← `ioCtx.makeReentryCallback(...)` (`actor-state.c++:1011`), which is decision 13: without
    // it a facet started from inside blockConcurrencyWhile() would queue behind the section that
    // is waiting for it.
    const getStartInfo = this.#ctx.makeReentryCallback(async (): Promise<FacetStartInfo> => {
      const options = await getStartupOptions();
      const id = options.id;
      return {
        // ← `actorClass.getChannel(ioCtx)` (`actor-state.c++:1045`).
        actorClass: requireFacetClass(options.class).getChannel(),
        // Child inherits parent ID.
        id:
          id === undefined
            ? this.#parentId
            : typeof id === "string"
              ? id
              : id.name ?? id.toString(),
      };
    });

    return facetManager.getFacet<T>(name, getStartInfo);
  }

  abort(name: string, reason: unknown): void {
    requireValidFacetName(name);
    this.#getFacetManager().abortFacet(name, reason);
  }

  delete(name: string): void {
    requireValidFacetName(name);
    this.#getFacetManager().deleteFacet(name);
  }

  clone(src: string, dst: string): void {
    requireValidFacetName(src);
    requireValidFacetName(dst);
    this.#getFacetManager().cloneFacet(src, dst);
  }

  #getFacetManager(): FacetManager {
    const facetManager = this.#facetManager;
    if (facetManager === undefined) {
      throw new Error("This Durable Object does not support creating facets.");
    }
    return facetManager;
  }
}

// =======================================================================================
// DurableObjectState

export type DurableObjectStateOptions = {
  id: DurableObjectId;
  /** The `ctx.exports` class registry. */
  exports: Record<string, unknown>;
  props: unknown;
  storage?: DurableObjectStorage;
  /** Absent for an actor whose host offers no facets, as upstream's `kj::Maybe` is. */
  facets?: FacetManager;
  /** ← `ActorVersion`, a deployment cohort with nothing to read it here. */
  version?: { cohort?: string };
  /**
   * This actor's `ServiceWorkerGlobalScope` half — the container's own
   * `globals`. Required, unlike `storage` and `facets`: a host that offers no
   * storage is a real posture upstream has, but an actor with no gated timers
   * is not, and the failure of a missing one is an ungated timer that WORKS
   * until a continuation after it touches storage. See
   * `DurableObjectState.globals`.
   */
  globals: ActorScopeBindings;
  webSockets?: HibernatableWebSocketRegistry;
};

/** The type passed as the first parameter to a Durable Object class's constructor. */
export class DurableObjectState implements globalThis.DurableObjectState {
  readonly #ctx: IoContext;
  readonly #options: DurableObjectStateOptions;
  #facets: DurableObjectFacets | undefined;

  constructor(ctx: IoContext, options: DurableObjectStateOptions) {
    this.#ctx = ctx;
    this.#options = options;
  }

  get id(): DurableObjectId {
    return this.#options.id;
  }

  get props(): unknown {
    return this.#options.props;
  }

  /** ← `JSG_LAZY_INSTANCE_PROPERTY(exports, getExports)`, behind `enableCtxExports` upstream. */
  get exports(): Record<string, unknown> {
    return this.#options.exports;
  }

  get version(): { cohort?: string } | undefined {
    return this.#options.version;
  }

  /**
   * NO upstream correspondence, because upstream needs none: a
   * `ServiceWorkerGlobalScope` IS the isolate's global object there, so an
   * actor's class reaches its gated `setTimeout` by writing `setTimeout`.
   *
   * Here one realm hosts several actors, so the names on `globalThis` can only
   * be bound to one of them and a continuation cannot be asked which one it
   * belongs to. `ctx` is the one reference every Durable Object class already
   * holds and that already means exactly one actor — the constructor was handed
   * it — so it is where the scope goes. An actor's method writes
   * `this.ctx.globals.setTimeout(…)`; a free function it calls takes the scope
   * as a parameter.
   *
   * `installActorScope` still exists and is still what a host uses for a
   * dynamically-loaded Worker source, which has no `ctx` to reach through and
   * its own module scope to destructure into. The two are the same object.
   */
  get globals(): ActorScopeBindings {
    return this.#options.globals;
  }

  get storage(): DurableObjectStorage {
    const storage = this.#options.storage;
    if (storage === undefined) {
      throw new Error("This Durable Object does not have storage.");
    }
    return storage;
  }

  /** ← `JSG_LAZY_INSTANCE_PROPERTY(facets, getFacets)`. */
  get facets(): DurableObjectFacets {
    this.#facets ??= new DurableObjectFacets(
      this.#ctx,
      this.#options.facets,
      this.#options.id.toString(),
    );
    return this.#facets;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#ctx.addWaitUntil(promise.then(() => {}));
  }

  /**
   * ← `DurableObjectState::blockConcurrencyWhile` (`actor-state.c++:1128-1131`),
   * which is a one-line forward and nothing else. The 30-second deadline, the
   * brokenness annotation and the never-settled promise on failure all live in
   * `IoContext::blockConcurrencyWhile`, which Section 2 already implements.
   *
   * Its precondition comes with it: `IoContext::blockConcurrencyWhile` calls
   * `getInputLock()`, which asserts, so this is reachable only from inside a
   * gated slice.
   */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return this.#ctx.blockConcurrencyWhile(callback);
  }

  /**
   * ← `DurableObjectState::abort`. Reset the object, including breaking the
   * output gate and canceling any writes that haven't been committed yet.
   *
   * `js.terminateExecutionNow()` has no port — there is no isolate to terminate —
   * so the caller's own slice keeps running to its next await, where `IoContext`
   * refuses to re-enter.
   */
  abort(reason?: string): void {
    const description =
      reason === undefined
        ? "broken.outputGateBroken; jsg.Error: Application called abort() to reset Durable Object."
        : `broken.outputGateBroken; jsg.Error: ${reason}`;
    const error = new Error(description);
    // ← `error.setDetail(jsg::EXCEPTION_IS_USER_ERROR, ...)` (`actor-state.c++:1143`). It is what
    // tells `isAlarmFailureUserError` that this reset was the application's doing, so an alarm
    // handler that aborts is retried a bounded number of times rather than forever.
    setUserErrorDetail(error);

    // "Make sure we _synchronously_ break storage so that there's no chance our promise fulfilling
    // will race against the output gate, possibly allowing writes to complete before being
    // canceled."
    this.#options.storage?.getActorCacheInterface().shutdown(error);

    this.#ctx.abort(error);
  }

  /** ← `DurableObjectState::getPrimaryStub`. Non-null only for a replica; see the storage note. */
  get primaryStub(): undefined {
    return this.#options.storage?.getPrimary();
  }

  /** Substrate boundary: replication. */
  configureReadReplication(options: { mode: string }): Promise<void> {
    const storage = this.#options.storage;
    if (storage === undefined) {
      throw new TypeError("This actor does not support read replication.");
    }
    if (storage.isReplica()) {
      throw new Error("Replica Durable Objects cannot call configureReadReplication().");
    }
    if (options.mode !== "auto" && options.mode !== "disabled") {
      throw new TypeError(
        `configureReadReplication() called with unknown mode setting: ${options.mode}.`,
      );
    }
    return this.#ctx.awaitIo(
      storage.getActorCacheInterface().configureReadReplication(options.mode === "auto"),
    );
  }

  acceptWebSocket(ws: WebSocket, tags?: string[]): void {
    this.#webSockets().acceptWebSocket(ws, tags);
  }

  getWebSockets(tag?: string): WebSocket[] {
    return tag === undefined
      ? this.#webSockets().getWebSockets()
      : this.#webSockets().getWebSockets(tag);
  }

  setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void {
    this.#webSockets().setWebSocketAutoResponse(maybeReqResp);
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return this.#webSockets().getWebSocketAutoResponse();
  }

  getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null {
    return this.#webSockets().getWebSocketAutoResponseTimestamp(ws);
  }

  setHibernatableWebSocketEventTimeout(timeoutMs?: number): void {
    this.#webSockets().setHibernatableWebSocketEventTimeout(timeoutMs);
  }

  getHibernatableWebSocketEventTimeout(): number | null {
    return this.#webSockets().getHibernatableWebSocketEventTimeout();
  }

  getTags(ws: WebSocket): string[] {
    return this.#webSockets().getTags(ws);
  }

  #webSockets(): HibernatableWebSocketRegistry {
    const webSockets = this.#options.webSockets;
    if (webSockets === undefined) throw new Error("This Durable Object has no WebSocket runtime.");
    return webSockets;
  }
}
