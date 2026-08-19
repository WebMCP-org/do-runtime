/**
 * ← workerd `src/workerd/api/tests/worker-loader-test.js`,
 * `worker-loader-rab-test.js` and `worker-loader-unnamed-gc-test.js`.
 *
 * There is no `worker-loader-test.c++`; the three JS suites are the whole
 * upstream test surface, and every one of their twenty-one exported cases is
 * accounted for below — ported where the behaviour lives at this layer, and named
 * with the reason where it does not.
 *
 * **What the port has to substitute.** Upstream drives the loader through a real
 * workerd, so each case asserts a *loaded Worker's* answer — `greet('Alice')`
 * returning `"Hello, Alice"`. The isolate is the substrate here, so what is
 * observable at this layer is the request that reaches `loadIsolate` and the
 * `DynamicWorkerSource` the callback produces. Each test below asserts the same
 * fact one hop earlier: `overrideGlobalOutbound` asserts the outbound `Fetcher`
 * on the source rather than the response text it produces, and so on. Where a
 * case is entirely about what happens inside the isolate — `startupException`,
 * `abortIsolateDynamic`, `pythonBasics`' Python semantics — the isolate-side half
 * is named as such and the loader-side half is still checked.
 *
 * `FakeWorkerLoaderNamespace` is a port too, of
 * `Server::WorkerLoaderNamespace::loadIsolate` (`server.c++:4243-4281`), because
 * `isolateUniqueness` measures caching that `WorkerLoader::get` does not do — see
 * `api/worker-loader.ts`'s header.
 */

import { expect, test, vi } from "vitest";
import type { Actor, Timer } from "../io/io-context";
import { IoContext } from "../io/io-context";
import { InputGate, OutputGate } from "../io/io-gate";
import type {
  ActorClassChannel,
  CompatibilityDateValidation,
  DynamicWorkerSource,
  EntrypointRequest,
  WorkerStubChannel,
} from "../io/io-channels";
import type { ModulesSource } from "../io/worker-source";
import { asFacetStub, type FacetManager, type FacetStartInfo } from "../io/worker";
import { DurableObjectClass } from "./actor";
import { DurableObjectFacets } from "./actor-state";
import {
  LoopbackColoLocalActorNamespace,
  LoopbackDurableObjectClass,
  LoopbackDurableObjectNamespace,
  LoopbackServiceStub,
  asLoopbackColoLocalActorNamespace,
  asLoopbackDurableObjectClass,
  asLoopbackDurableObjectNamespace,
  asLoopbackServiceStub,
} from "./export-loopback";
import type { ActorId, ActorIdFactory } from "../io/actor-id";
import type {
  IsolateChannelFactory,
  LoadIsolateRequest,
  Module,
  WorkerCode,
} from "./worker-loader";
import {
  ALLOW_EXPERIMENTAL_MESSAGE,
  DEAD_LOAD_CONTEXT_MESSAGE,
  NOT_BYTES_MESSAGE,
  NO_MODULES_MESSAGE,
  STREAMING_TAILS_EXPERIMENTAL_MESSAGE,
  WorkerLoader,
  WorkerStub,
  jsModuleInPythonWorkerMessage,
  moduleFieldCountMessage,
  moduleNameMessage,
  notSerializableMessage,
  pythonModuleInJsWorkerMessage,
  typeScriptModuleNameMessage,
} from "./worker-loader";

// =======================================================================================
// Harness

class TestActor implements Actor {
  readonly inputGate = new InputGate();
  readonly outputGate = new OutputGate();
  getInputGate(): InputGate {
    return this.inputGate;
  }
  getOutputGate(): OutputGate {
    return this.outputGate;
  }
  shutdownActorCache(): void {}
  assertCanSetAlarm(): void {}
}

class FakeTimer implements Timer {
  now(): number {
    return 0;
  }
  afterDelay(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

/** A `Fetcher`-shaped value, distinguishable by `label` so a test can name which one it is. */
function fetcher(label: string): Fetcher {
  const stub = {
    label,
    fetch: (): Promise<Response> => Promise.reject(new Error("no transport in this lane")),
    connect: (): never => {
      throw new Error("no transport in this lane");
    },
  };
  return stub as unknown as Fetcher;
}

function labelOf(value: Fetcher | undefined): string | undefined {
  return (value as unknown as { label?: string } | undefined)?.label;
}

/** Enough of an `ActorIdFactory` for `LoopbackDurableObjectNamespace`'s constructor. */
function fakeIdFactory(): ActorIdFactory {
  const id: ActorId = {
    toString: () => "fake",
    getName: () => undefined,
    getJurisdiction: () => undefined,
    equals: (other) => other.toString() === "fake",
  };
  return {
    newUniqueId: () => id,
    idFromName: () => id,
    idFromString: () => id,
    matchesJurisdiction: () => true,
    cloneWithJurisdiction: () => fakeIdFactory(),
  };
}

/** ← `Server::WorkerLoaderNamespace::WorkerStubImpl` — the object `loadIsolate` returns. */
class FakeWorkerStubChannel implements WorkerStubChannel {
  readonly entrypoints: EntrypointRequest[] = [];
  readonly actorClasses: EntrypointRequest[] = [];
  /** Resolves with whatever `fetchSource` produced, or rejects with what it threw. */
  readonly started: Promise<DynamicWorkerSource>;

  constructor(
    readonly isolateName: string,
    readonly request: LoadIsolateRequest,
  ) {
    // ← `WorkerStubImpl::start`, which is a coroutine that begins with `co_await fetchSource()`.
    this.started = request.fetchSource();
    void this.started.catch(() => {});
  }

  /** Upstream's callback "technically may be called any number of times". */
  refetch(): Promise<DynamicWorkerSource> {
    return this.request.fetchSource();
  }

  getEntrypoint(request: EntrypointRequest): Fetcher {
    this.entrypoints.push(request);
    return fetcher(`${this.isolateName}#${request.name ?? "default"}`);
  }

  getActorClass(request: EntrypointRequest): ActorClassChannel {
    this.actorClasses.push(request);
    return {
      className: `${this.isolateName}#${request.name ?? "default"}`,
      requireAllowsTransfer: () => {},
    };
  }
}

/**
 * ← `Server::WorkerLoaderNamespace::loadIsolate` (`server.c++:4243-4281`), which
 * is where the caching `WorkerLoader::get` does not do actually lives: a named
 * isolate is `findOrCreate`d, an unnamed one is minted per call under a fresh
 * generated name and kept alive by the namespace "until startup completes".
 */
class FakeWorkerLoaderNamespace implements IsolateChannelFactory {
  readonly isolates = new Map<string, FakeWorkerStubChannel>();
  readonly anonymous: FakeWorkerStubChannel[] = [];
  readonly nullClient = fetcher("null-client");
  nullClientCalls = 0;
  /** Whether the source was being built inside a gated slice — divergence 147's question. */
  readonly gatedAtNullClient: boolean[] = [];
  #counter = 0;

  constructor(
    readonly namespaceName = "loader",
    readonly ctx?: IoContext,
  ) {}

  loadIsolate(request: LoadIsolateRequest): WorkerStubChannel {
    const name = request.name;
    if (name !== undefined) {
      const existing = this.isolates.get(name);
      if (existing !== undefined) return existing;
      const created = new FakeWorkerStubChannel(`${this.namespaceName}:${name}`, request);
      this.isolates.set(name, created);
      return created;
    }
    const created = new FakeWorkerStubChannel(
      `${this.namespaceName}:dynamic:${this.#counter++}`,
      request,
    );
    this.anonymous.push(created);
    return created;
  }

  getNullClientChannel(): Fetcher {
    this.nullClientCalls += 1;
    if (this.ctx !== undefined) this.gatedAtNullClient.push(this.ctx.hasCurrent());
    return this.nullClient;
  }
}

type Harness = {
  readonly ctx: IoContext;
  readonly channel: FakeWorkerLoaderNamespace;
  readonly loader: WorkerLoader;
  run<T>(body: () => T | PromiseLike<T>): Promise<T>;
};

function newHarness(options?: {
  allowExperimentalFeatures?: boolean;
  compatDateValidation?: CompatibilityDateValidation;
}): Harness {
  const actor = new TestActor();
  const ctx = new IoContext(actor, new FakeTimer());
  const channel = new FakeWorkerLoaderNamespace("loader", ctx);
  const loader = new WorkerLoader(ctx, channel, {
    compatDateValidation: options?.compatDateValidation ?? "codeVersion",
    allowExperimentalFeatures: options?.allowExperimentalFeatures ?? true,
  });
  // `IoContext`'s constructor already takes the one `onBroken()` branch each gate allows.
  return {
    ctx,
    channel,
    loader,
    run: async <T,>(body: () => T | PromiseLike<T>): Promise<T> => {
      const result = await ctx.run(body);
      await quiesce();
      return result;
    },
  };
}

async function quiesce(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The shape almost every upstream case uses. */
function code(overrides: Partial<WorkerCode> = {}): WorkerCode {
  return {
    compatibilityDate: "2025-01-01",
    mainModule: "foo.js",
    modules: { "foo.js": "export default { greet(name) { return 'Hello, ' + name; } }" },
    ...overrides,
  };
}

function modulesOf(source: DynamicWorkerSource): ModulesSource {
  return source.source.variant;
}

// =======================================================================================
// The messages, pinned as literals
//
// Every other message assertion in this file goes through the exported helper, which
// cannot notice the helper changing. These are the copies from
// `api/worker-loader.c++` and `jsg/ser.c++`, written out.

test("every ported message is upstream's, character for character", () => {
  expect(NO_MODULES_MESSAGE).toBe("Dynamic Worker code must contain at least one module.");

  expect(moduleNameMessage("main.mjs")).toBe(
    "Module name must end with '.js' or '.py' (or the content must be an object indicating " +
      "the type explicitly). Got: main.mjs",
  );

  expect(typeScriptModuleNameMessage("main.ts")).toBe(
    "Module name must end with '.js' or '.py' (or the content must be an object indicating " +
      "the type explicitly). Got: main.ts. If you're trying to load TypeScript, bundle it " +
      "first with '@cloudflare/worker-bundler' and pass the generated JavaScript modules.",
  );

  expect(moduleFieldCountMessage("a.js", 2)).toBe(
    "Each module must contain exactly one of 'js', 'cjs', 'text', 'data', 'json', 'py', or " +
      "'wasm'. Module 'a.js' contained 2 properties.",
  );

  expect(jsModuleInPythonWorkerMessage("foo.js")).toBe(
    'Module "foo.js" is a JS module, but the main module is a Python module.',
  );

  expect(pythonModuleInJsWorkerMessage("foo.py")).toBe(
    'Module "foo.py" is a Python module, but the main module isn\'t a Python module.',
  );

  expect(STREAMING_TAILS_EXPERIMENTAL_MESSAGE).toBe(
    "Streaming tail workers are experimental. You must pass the option 'allowExperimental: " +
      "true' to the worker loader to use them",
  );

  expect(ALLOW_EXPERIMENTAL_MESSAGE).toBe(
    "'allowExperimental' is only allowed when the calling worker has the 'experimental' " +
      "compat flag set.",
  );

  // ← `api/tests/worker-loader-test.js:104`, the one this file's refusal has to match.
  expect(notSerializableMessage("LoopbackServiceStub")).toBe(
    'Could not serialize object of type "LoopbackServiceStub". This type does not support ' +
      "serialization.",
  );

  expect(DEAD_LOAD_CONTEXT_MESSAGE).toBe(
    "The request which initiated this dynamic worker load has already completed.",
  );
});

// =======================================================================================
// `basics` — the stub is synchronous and the entrypoint request carries name and props

test("basics: get() returns a stub without waiting for the code", async () => {
  const h = newHarness();
  let called = false;

  const stub = await h.run(() =>
    h.loader.get("basics", () => {
      called = true;
      return code();
    }),
  );

  expect(stub).toBeInstanceOf(WorkerStub);
  // The callback DID run — `loadIsolate` starts it — but the stub existed before it finished.
  expect(called).toBe(true);
});

test("basics: the default entrypoint is requested with no name", async () => {
  const h = newHarness();
  await h.run(() => {
    h.loader.get("basics", () => code()).getEntrypoint();
  });

  const isolate = h.channel.isolates.get("basics");
  expect(isolate?.entrypoints).toEqual([{ name: undefined, props: undefined, limits: undefined }]);
});

test("basics: a named entrypoint carries its own props, once per specialization", async () => {
  const h = newHarness();
  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("alternate", { props: { greeting: "Welcome" } });
    worker.getEntrypoint("alternate", { props: { greeting: "Howdy" } });
  });

  expect(h.channel.isolates.get("basics")?.entrypoints).toEqual([
    { name: "alternate", props: { greeting: "Welcome" }, limits: undefined },
    { name: "alternate", props: { greeting: "Howdy" }, limits: undefined },
  ]);
});

test('basics: the entrypoint name "default" means the default entrypoint', async () => {
  const h = newHarness();
  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("default");
    worker.getEntrypoint(null);
    worker.getDurableObjectClass("default");
  });

  const isolate = h.channel.isolates.get("basics");
  expect(isolate?.entrypoints.map((request) => request.name)).toEqual([undefined, undefined]);
  expect(isolate?.actorClasses.map((request) => request.name)).toEqual([undefined]);
});

// =======================================================================================
// `basics` — "serializability is not inherited" (`worker-loader-test.js:90-107`)

test("basics: a ctx.exports binding in props is refused, and the message is upstream's", async () => {
  const h = newHarness();
  const binding = asLoopbackServiceStub(
    new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") }),
  );

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    expect(() => worker.getEntrypoint("FancyPropsEntrypoint", { props: { greeter: binding } })).toThrow(
      notSerializableMessage("LoopbackServiceStub"),
    );
  });
});

test("basics: the refusal is a DataCloneError, as jsg's serializer raises", async () => {
  const h = newHarness();
  const binding = asLoopbackServiceStub(
    new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") }),
  );

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    try {
      worker.getEntrypoint("FancyPropsEntrypoint", { props: { greeter: binding } });
      expect.unreachable("expected a DataCloneError");
    } catch (error) {
      expect((error as DOMException).name).toBe("DataCloneError");
    }
  });
});

test("basics: an INVOKED ctx.exports binding is accepted, which is the distinction upstream draws", async () => {
  const h = newHarness();
  const stub = new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") });

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("FancyPropsEntrypoint", {
      props: { greeter: stub.callWithVersion({ props: { greeting: "G'day" } }) },
    });
  });

  expect(h.channel.isolates.get("basics")?.entrypoints).toHaveLength(1);
});

test("the refusal reaches a nested occurrence and names its path", async () => {
  const h = newHarness();
  const binding = asLoopbackServiceStub(
    new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") }),
  );

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    expect(() =>
      worker.getEntrypoint("x", { props: { outer: { list: [1, { inner: binding }] } } }),
    ).toThrow("<props>.outer.list[1].inner");
  });
});

test("all four ctx.exports binding types are refused, and each names itself", async () => {
  const h = newHarness();
  const actorClass = new LoopbackDurableObjectClass({
    getActorClass: () => ({ className: "Greeter", requireAllowsTransfer: () => {} }),
  });
  const colo = new LoopbackColoLocalActorNamespace(
    { getColoLocalActor: () => fetcher("colo") },
    actorClass,
  );
  const namespace = new LoopbackDurableObjectNamespace(
    { getGlobalActor: () => fetcher("global") },
    fakeIdFactory(),
    actorClass,
  );
  const cases: [unknown, string][] = [
    [
      asLoopbackServiceStub(new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("s") })),
      "LoopbackServiceStub",
    ],
    [asLoopbackDurableObjectClass(actorClass), "LoopbackDurableObjectClass"],
    [asLoopbackDurableObjectNamespace(namespace), "LoopbackDurableObjectNamespace"],
    [asLoopbackColoLocalActorNamespace(colo), "LoopbackColoLocalActorNamespace"],
  ];

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    for (const [value, typeName] of cases) {
      expect(() => worker.getEntrypoint("x", { props: { value } })).toThrow(
        notSerializableMessage(typeName),
      );
    }
  });
});

test("a host object in props is not descended into: upstream asks the type, not the value", async () => {
  const h = newHarness();
  // A class instance with an OWN enumerable accessor that throws, standing in for a stub whose
  // `get` trap would mint an RPC import. Own and enumerable is what makes `Object.entries` reach
  // it, so this fails the moment the walk stops checking the prototype. Upstream's serializer
  // never touches it — it dispatches on the JSG resource type — so neither does this walk.
  class Hostile {
    constructor() {
      Object.defineProperty(this, "boom", {
        enumerable: true,
        get: (): never => {
          throw new Error("a host object's properties were read");
        },
      });
    }
  }
  expect(Object.getPrototypeOf(new Hostile())).not.toBe(Object.prototype);

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("x", { props: { stub: new Hostile() } });
  });

  expect(h.channel.isolates.get("basics")?.entrypoints).toHaveLength(1);
});

test("a plain DurableObjectClass in props is NOT refused: the base is serializable", async () => {
  const h = newHarness();
  const specialized = new DurableObjectClass({
    className: "Greeter",
    requireAllowsTransfer: () => {},
  });

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("x", { props: { greeter: specialized } });
  });

  expect(h.channel.isolates.get("basics")?.entrypoints).toHaveLength(1);
});

test("a cycle in props terminates rather than walking forever", async () => {
  const h = newHarness();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  await h.run(() => {
    const worker = h.loader.get("basics", () => code());
    worker.getEntrypoint("x", { props: cyclic });
  });

  expect(h.channel.isolates.get("basics")?.entrypoints).toHaveLength(1);
});

// =======================================================================================
// `passEnv` / `passEnvCaps`

test("passEnv: env reaches the source", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("passEnv", () => code({ env: { hello: 123 } })));

  const source = await h.channel.isolates.get("passEnv")?.started;
  expect(source?.env).toEqual({ hello: 123 });
});

test("passEnvCaps: an un-invoked ctx.exports binding in env is refused too", async () => {
  const h = newHarness();
  const binding = asLoopbackServiceStub(
    new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") }),
  );

  await h.run(() => h.loader.get("passEnvCaps", () => code({ env: { greeter: binding } })));

  await expect(h.channel.isolates.get("passEnvCaps")?.started).rejects.toThrow(
    notSerializableMessage("LoopbackServiceStub"),
  );
});

test("passEnvCaps: the invoked form is carried", async () => {
  const h = newHarness();
  const stub = new LoopbackServiceStub({ getSubrequestChannel: () => fetcher("greeter") });
  const greeter = stub.callWithVersion({ props: { greeting: "Hello" } });

  await h.run(() => h.loader.get("passEnvCaps", () => code({ env: { greeter } })));

  const source = await h.channel.isolates.get("passEnvCaps")?.started;
  expect((source?.env as { greeter: Fetcher } | undefined)?.greeter).toBe(greeter);
});

// =======================================================================================
// globalOutbound — the three JS states collapse to two on the source

test("overrideGlobalOutbound: a Fetcher is carried through", async () => {
  const h = newHarness();
  const outbound = fetcher("testOutbound");
  await h.run(() => h.loader.get("override", () => code({ globalOutbound: outbound })));

  const source = await h.channel.isolates.get("override")?.started;
  expect(source?.globalOutbound).toBe(outbound);
  expect(h.channel.nullClientCalls).toBe(0);
});

test("inheritGlobalOutbound: omitting it takes the calling worker's own outbound", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("inherit", () => code()));

  const source = await h.channel.isolates.get("inherit")?.started;
  expect(labelOf(source?.globalOutbound)).toBe("null-client");
  expect(h.channel.nullClientCalls).toBe(1);
});

test("the source is built inside a gated slice, which is what awaitIo is there for", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("gated", async () => {
      // A promise the runtime does not own. Without `awaitIo` the continuation — and with it
      // `toDynamicWorkerSource` — would resume with an empty invocation stack (divergence 147).
      await new Promise((resolve) => setTimeout(resolve, 1));
      return code();
    }),
  );
  await quiesce();

  await h.channel.isolates.get("gated")?.started;
  expect(h.channel.gatedAtNullClient).toEqual([true]);
});

test("nullGlobalOutbound: null blocks it, and does NOT fall back to the caller's", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("blocked", () => code({ globalOutbound: null })));

  const source = await h.channel.isolates.get("blocked")?.started;
  expect(source?.globalOutbound).toBeUndefined();
  expect(h.channel.nullClientCalls).toBe(0);
});

// =======================================================================================
// `tails`

test("tails: tail workers are carried", async () => {
  const h = newHarness();
  const tail = fetcher("TestTail");
  await h.run(() => h.loader.get("tails", () => code({ tails: [tail] })));

  const source = await h.channel.isolates.get("tails")?.started;
  expect(source?.tails).toEqual([tail]);
  expect(source?.streamingTails).toEqual([]);
});

test("streamingTails require allowExperimental, and upstream's message says so", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("streaming", () => code({ streamingTails: [fetcher("TestTail")] })),
  );

  await expect(h.channel.isolates.get("streaming")?.started).rejects.toThrow(
    STREAMING_TAILS_EXPERIMENTAL_MESSAGE,
  );
});

test("streamingTails are carried once allowExperimental is set", async () => {
  const h = newHarness();
  const tail = fetcher("TestTail");
  await h.run(() =>
    h.loader.get("streaming", () =>
      code({ allowExperimental: true, streamingTails: [tail] }),
    ),
  );

  const source = await h.channel.isolates.get("streaming")?.started;
  expect(source?.streamingTails).toEqual([tail]);
});

// =======================================================================================
// `facets` — the bridge `getDurableObjectClass` opens

test("facets: getDurableObjectClass hands back a DurableObjectClass over the channel's token", async () => {
  const h = newHarness();
  const actorClass = await h.run(() =>
    h.loader.get("facets", () => code()).getDurableObjectClass("MyActor", {
      props: { foo: 123, bar: 456 },
    }),
  );

  expect(actorClass).toBeInstanceOf(DurableObjectClass);
  expect(actorClass.getChannel().className).toBe("loader:facets#MyActor");
  expect(h.channel.isolates.get("facets")?.actorClasses).toEqual([
    { name: "MyActor", props: { foo: 123, bar: 456 }, limits: undefined },
  ]);
});

test("facets: the class goes straight into ctx.facets.get, which is the whole bridge", async () => {
  const h = newHarness();
  const started: FacetStartInfo[] = [];
  const facetManager: FacetManager = {
    getDepth: () => 0,
    getFacet: (_name, getStartInfo) => {
      void getStartInfo().then((info) => started.push(info));
      return asFacetStub(fetcher("facet"));
    },
    abortFacet: () => {},
    deleteFacet: () => {},
    cloneFacet: () => {},
  };
  const facets = new DurableObjectFacets(h.ctx, facetManager, "parent-id");

  await h.run(() => {
    const cls = h.loader.get("facets", () => code()).getDurableObjectClass("MyActor");
    facets.get("bar", () => ({ class: cls }));
  });
  await quiesce();

  expect(started).toEqual([
    { actorClass: { className: "loader:facets#MyActor", requireAllowsTransfer: expect.any(Function) }, id: "parent-id" },
  ]);
});

// =======================================================================================
// `isolateUniqueness` (`worker-loader-test.js:456-543`)

test("isolateUniqueness: the same name reaches the same isolate and the code loads once", async () => {
  const h = newHarness();
  const loadCode = vi.fn(() => code());

  await h.run(() => {
    h.loader.get("shared", loadCode).getEntrypoint();
    h.loader.get("shared", loadCode).getEntrypoint();
  });

  expect(loadCode).toHaveBeenCalledTimes(1);
  expect(h.channel.isolates.size).toBe(1);
});

test("isolateUniqueness: different names reach different isolates", async () => {
  const h = newHarness();
  const loadCode = vi.fn(() => code());

  await h.run(() => {
    h.loader.get("one", loadCode);
    h.loader.get("two", loadCode);
  });

  expect(loadCode).toHaveBeenCalledTimes(2);
  expect([...h.channel.isolates.keys()]).toEqual(["one", "two"]);
});

test("isolateUniqueness: a null or undefined name mints a fresh isolate every time", async () => {
  const h = newHarness();
  const loadCode = vi.fn(() => code());

  await h.run(() => {
    h.loader.get(null, loadCode);
    h.loader.get(undefined, loadCode);
    h.loader.get(undefined, loadCode);
  });

  expect(loadCode).toHaveBeenCalledTimes(3);
  expect(h.channel.anonymous).toHaveLength(3);
  expect(h.channel.isolates.size).toBe(0);
  // Three distinct isolates, which is what "each should be a different isolate" means upstream.
  expect(new Set(h.channel.anonymous.map((stub) => stub.isolateName)).size).toBe(3);
});

test("isolateUniqueness: get() mints a NEW WorkerStub even when the isolate is reused", async () => {
  const h = newHarness();
  const [first, second] = await h.run(() => [
    h.loader.get("shared", () => code()),
    h.loader.get("shared", () => code()),
  ]);

  expect(first).not.toBe(second);
});

test('the isolate name "default" is not special, unlike the entrypoint name', async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("default", () => code()));

  expect([...h.channel.isolates.keys()]).toEqual(["default"]);
  expect(h.channel.anonymous).toHaveLength(0);
});

test("a non-string name is coerced, as jsg's kj::String unwrapper coerces it", async () => {
  const h = newHarness();
  // ← `kj::Maybe<kj::String> name`, unwrapped by `jsg/value.h:501-506`, which calls ToString on
  // whatever it is given. The declared type refuses this, so only an untyped caller reaches it —
  // and workerd names the isolate "7" rather than failing.
  await h.run(() => {
    (h.loader as unknown as { get(name: unknown, getCode: () => WorkerCode): unknown }).get(
      7,
      () => code(),
    );
    (
      h.loader as unknown as {
        getDurableObjectClass?: unknown;
      } & { get(name: unknown, getCode: () => WorkerCode): { getEntrypoint(name: unknown): unknown } }
    )
      .get("coerce", () => code())
      .getEntrypoint(7);
  });

  expect([...h.channel.isolates.keys()]).toEqual(["7", "coerce"]);
  expect(h.channel.isolates.get("coerce")?.entrypoints[0]?.name).toBe("7");
});

// =======================================================================================
// `moduleTypes` and `wasmModules` (`worker-loader-test.js:546-658`)

test("moduleTypes: every object module type maps to its upstream variant", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("moduleTypes", () =>
      code({
        mainModule: "main.js",
        modules: {
          "main.js": { js: "export default {}" },
          "text.txt": { text: "Hello from text module!" },
          "data.json": { json: { message: "Hello from JSON module!", value: 42 } },
          "cjs.cjs": { cjs: "module.exports = {};" },
          "binary.dat": { data: new TextEncoder().encode("Hello from binary data!") },
        },
      }),
    ),
  );

  const source = await h.channel.isolates.get("moduleTypes")?.started;
  const modules = modulesOf(source as DynamicWorkerSource).modules;
  expect(modules.map((module) => [module.name, module.content.type])).toEqual([
    ["main.js", "esModule"],
    ["text.txt", "textModule"],
    ["data.json", "jsonModule"],
    ["cjs.cjs", "commonJsModule"],
    ["binary.dat", "dataModule"],
  ]);
  expect(modules[2]?.content).toEqual({
    type: "jsonModule",
    body: '{"message":"Hello from JSON module!","value":42}',
  });
  const data = modules[4]?.content;
  expect(data?.type === "dataModule" && new TextDecoder().decode(data.body)).toBe(
    "Hello from binary data!",
  );
});

test("wasmModules: wasm bytes are carried as a wasmModule", async () => {
  const h = newHarness();
  const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  await h.run(() =>
    h.loader.get("wasm", () =>
      code({ mainModule: "main.js", modules: { "main.js": { js: "" }, "math.wasm": { wasm } } }),
    ),
  );

  const source = await h.channel.isolates.get("wasm")?.started;
  const content = modulesOf(source as DynamicWorkerSource).modules[1]?.content;
  expect(content?.type).toBe("wasmModule");
  expect(content?.type === "wasmModule" && [...content.body]).toEqual([...wasm]);
});

test("a string module is an ES module when it ends in .js", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("strings", () => code()));

  const source = await h.channel.isolates.get("strings")?.started;
  expect(modulesOf(source as DynamicWorkerSource).modules[0]?.content.type).toBe("esModule");
});

test("the main module's name is carried onto the source", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("mainName", () =>
      code({ mainModule: "entry.js", modules: { "entry.js": "", "other.js": "" } }),
    ),
  );

  const source = await h.channel.isolates.get("mainName")?.started;
  expect(modulesOf(source as DynamicWorkerSource).mainModule).toBe("entry.js");
});

test("a json body V8 cannot represent becomes the string 'undefined', as it does upstream", async () => {
  const h = newHarness();
  // `js.serializeJson` is `toString(v8::JSON::Stringify(...))` (`jsg/jsg.c++:161-164`), and
  // stringifying a function yields the JS value `undefined`, which that `toString` renders as
  // the six characters. `JSON.stringify` returns the JS `undefined` instead, and a module body
  // has to be a string.
  await h.run(() =>
    h.loader.get("badJson", () =>
      code({
        mainModule: "a.js",
        modules: { "a.js": { js: "" }, "b.json": { json: (): void => {} } },
      }),
    ),
  );

  const source = await h.channel.isolates.get("badJson")?.started;
  expect(modulesOf(source as DynamicWorkerSource).modules[1]?.content).toEqual({
    type: "jsonModule",
    body: "undefined",
  });
});

// =======================================================================================
// `compatDateFlags` and `ctxExports` — what the compat request carries

test("compatDateFlags: the date and flags reach the compatibility request", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("compat", () =>
      code({ compatibilityDate: "2023-01-01", compatibilityFlags: ["nodejs_compat"] }),
    ),
  );

  const source = await h.channel.isolates.get("compat")?.started;
  expect(source?.compatibilityFlags).toEqual({
    compatibilityDate: "2023-01-01",
    compatibilityFlags: ["nodejs_compat"],
    allowExperimental: false,
    dateValidation: "codeVersion",
  });
});

test("ctxExports: omitted flags become an empty list, not undefined", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("ctxExports", () => code()));

  const source = await h.channel.isolates.get("ctxExports")?.started;
  expect(source?.compatibilityFlags.compatibilityFlags).toEqual([]);
});

test("allowExperimental is refused unless the CALLING worker is experimental", async () => {
  const h = newHarness({ allowExperimentalFeatures: false });
  await h.run(() => h.loader.get("experimental", () => code({ allowExperimental: true })));

  await expect(h.channel.isolates.get("experimental")?.started).rejects.toThrow(
    ALLOW_EXPERIMENTAL_MESSAGE,
  );
});

test("a calling worker that is not experimental may still load a non-experimental Worker", async () => {
  const h = newHarness({ allowExperimentalFeatures: false });
  await h.run(() => h.loader.get("plain", () => code()));

  const source = await h.channel.isolates.get("plain")?.started;
  expect(source?.compatibilityFlags.allowExperimental).toBe(false);
});

test("an allowed allowExperimental reaches the compatibility request as true", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("exp", () => code({ allowExperimental: true })));

  const source = await h.channel.isolates.get("exp")?.started;
  expect(source?.compatibilityFlags.allowExperimental).toBe(true);
});

test("the loader's compatDateValidation is what rides the request", async () => {
  const h = newHarness({ compatDateValidation: "currentDateForCloudflare" });
  await h.run(() => h.loader.get("validation", () => code()));

  const source = await h.channel.isolates.get("validation")?.started;
  expect(source?.compatibilityFlags.dateValidation).toBe("currentDateForCloudflare");
});

// =======================================================================================
// `asyncCodeLoader` and `codeLoaderException`

test("asyncCodeLoader: an async callback is awaited", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return code({ env: { late: true } });
    }),
  );
  await quiesce();

  const source = await h.channel.isolates.get("async")?.started;
  expect(source?.env).toEqual({ late: true });
});

test("codeLoaderException: what the callback throws is what the load fails with", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("boom", () => {
      throw new Error("Code loader failed!");
    }),
  );

  await expect(h.channel.isolates.get("boom")?.started).rejects.toThrow("Code loader failed!");
});

// =======================================================================================
// `noMixedJsPythonModules`, its mirror, and the TypeScript suggestion

test("noMixedJsPythonModules: a JS module under a Python main module is refused", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("mixed", () =>
      code({
        mainModule: "foo.py",
        modules: { "foo.py": "class Default: pass", "foo.js": "export default {}" },
      }),
    ),
  );

  await expect(h.channel.isolates.get("mixed")?.started).rejects.toThrow(
    jsModuleInPythonWorkerMessage("foo.js"),
  );
});

test("noMixedJsPythonModules2: a Python module under a JS main module is refused", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("mixed2", () =>
      code({
        mainModule: "foo.js",
        modules: { "foo.py": "class Default: pass", "foo.js": "export default {}" },
      }),
    ),
  );

  await expect(h.channel.isolates.get("mixed2")?.started).rejects.toThrow(
    pythonModuleInJsWorkerMessage("foo.py"),
  );
});

test("pythonBasics: a .py main module makes the source Python", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("python", () =>
      code({ mainModule: "foo.py", modules: { "foo.py": "class Default: pass" } }),
    ),
  );

  const source = await h.channel.isolates.get("python")?.started;
  const variant = modulesOf(source as DynamicWorkerSource);
  expect(variant.isPython).toBe(true);
  expect(variant.modules[0]?.content.type).toBe("pythonModule");
});

test("suggestWorkerBundlerForTypeScriptModules: all three extensions get the bundler suggestion", async () => {
  for (const mainModule of ["main.ts", "main.tsx", "main.jsx"]) {
    const h = newHarness();
    await h.run(() =>
      h.loader.get(mainModule, () =>
        code({ mainModule, modules: { [mainModule]: "export default {}" } }),
      ),
    );

    await expect(h.channel.isolates.get(mainModule)?.started).rejects.toThrow(
      typeScriptModuleNameMessage(mainModule),
    );
  }
});

test("a string module with an unrecognised extension gets the plain message, NOT the TS one", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("plainName", () =>
      code({ mainModule: "main.mjs", modules: { "main.mjs": "export default {}" } }),
    ),
  );

  // `toThrow` matches a substring and the plain message is a PREFIX of the TypeScript one, so
  // the assertion has to be on the whole text or it cannot tell the two apart.
  await expect(h.channel.isolates.get("plainName")?.started).rejects.toThrow(
    new RegExp(`^${escapeRegExp(moduleNameMessage("main.mjs"))}$`),
  );
});

test("a cjs module under a Python main module is refused too", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("cjsMixed", () =>
      code({
        mainModule: "foo.py",
        modules: { "foo.py": "class Default: pass", "helper.cjs": { cjs: "module.exports = {}" } },
      }),
    ),
  );

  await expect(h.channel.isolates.get("cjsMixed")?.started).rejects.toThrow(
    jsModuleInPythonWorkerMessage("helper.cjs"),
  );
});

test("an object py module counts as a Python module wherever it sits", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("objectPy", () =>
      code({ mainModule: "a.js", modules: { "a.js": { js: "" }, "b.txt": { py: "pass" } } }),
    ),
  );

  await expect(h.channel.isolates.get("objectPy")?.started).rejects.toThrow(
    pythonModuleInJsWorkerMessage("b.txt"),
  );
});

test("an object py module is carried when the main module is Python", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("objectPyOk", () =>
      code({ mainModule: "a.py", modules: { "a.py": { py: "pass" } } }),
    ),
  );

  const source = await h.channel.isolates.get("objectPyOk")?.started;
  expect(modulesOf(source as DynamicWorkerSource).modules[0]?.content).toEqual({
    type: "pythonModule",
    body: "pass",
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =======================================================================================
// extractSource's own refusals

test("an empty module list is refused", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("empty", () => code({ modules: {} })));

  await expect(h.channel.isolates.get("empty")?.started).rejects.toThrow(NO_MODULES_MESSAGE);
});

test("a module object with no fields is refused, and the count is named", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("zero", () => code({ mainModule: "a.js", modules: { "a.js": {} } })),
  );

  await expect(h.channel.isolates.get("zero")?.started).rejects.toThrow(
    moduleFieldCountMessage("a.js", 0),
  );
});

test("a module object with two fields is refused", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("two", () =>
      code({ mainModule: "a.js", modules: { "a.js": { js: "x", text: "y" } } }),
    ),
  );

  await expect(h.channel.isolates.get("two")?.started).rejects.toThrow(
    moduleFieldCountMessage("a.js", 2),
  );
});

test("a field explicitly set to undefined does not count, as jsg::Optional reads it", async () => {
  const h = newHarness();
  // The cast is `exactOptionalPropertyTypes`: neither this package's `Module` nor
  // `@cloudflare/workers-types`' admits an explicit undefined, but a JS caller — or a
  // `{...spread}` of a partially-filled module, which is how upstream's own `mixedModules`
  // fixture is written — produces one, and jsg reads it as absent.
  const partial = { js: "x", text: undefined } as unknown as Module;
  await h.run(() =>
    h.loader.get("undef", () => code({ mainModule: "a.js", modules: { "a.js": partial } })),
  );

  const source = await h.channel.isolates.get("undef")?.started;
  expect(modulesOf(source as DynamicWorkerSource).modules[0]?.content.type).toBe("esModule");
});

test("a data body that is not bytes is refused", async () => {
  const h = newHarness();
  await h.run(() =>
    h.loader.get("notBytes", () =>
      code({
        mainModule: "a.js",
        modules: {
          "a.js": { js: "x" },
          "b.dat": { data: "not bytes" as unknown as ArrayBuffer },
        },
      }),
    ),
  );

  await expect(h.channel.isolates.get("notBytes")?.started).rejects.toThrow(NOT_BYTES_MESSAGE);
});

// =======================================================================================
// `justLoad` (`worker-loader-test.js:912-959`)

test("justLoad: load() mints an unnamed isolate, fresh every call", async () => {
  const h = newHarness();
  await h.run(() => {
    h.loader.load(code());
    h.loader.load(code());
  });

  expect(h.channel.anonymous).toHaveLength(2);
  expect(h.channel.isolates.size).toBe(0);
});

test("justLoad: the stub reaches entrypoints exactly as get()'s does", async () => {
  const h = newHarness();
  await h.run(() => {
    const worker = h.loader.load(code());
    worker.getEntrypoint();
    worker.getEntrypoint("alternate", { props: { greeting: "Welcome" } });
  });

  expect(h.channel.anonymous[0]?.entrypoints).toEqual([
    { name: undefined, props: undefined, limits: undefined },
    { name: "alternate", props: { greeting: "Welcome" }, limits: undefined },
  ]);
});

test("load() builds the source EAGERLY, so a bad module list throws from load() itself", async () => {
  const h = newHarness();

  await h.run(() => {
    expect(() => h.loader.load(code({ modules: {} }))).toThrow(NO_MODULES_MESSAGE);
  });
  expect(h.channel.anonymous).toHaveLength(0);
});

test("get() defers, so the same mistake surfaces on the load instead", async () => {
  const h = newHarness();

  await h.run(() => {
    // No throw here — that is the whole difference between the two.
    h.loader.get("deferred", () => code({ modules: {} }));
  });
  await expect(h.channel.isolates.get("deferred")?.started).rejects.toThrow(NO_MODULES_MESSAGE);
});

test("load()'s callback answers the same source however often it is called", async () => {
  const h = newHarness();
  await h.run(() => h.loader.load(code()));

  const channel = h.channel.anonymous[0];
  // ← "the callback we pass to `loadIsolate()` technically may be called any number of times.
  // Yes, even though we aren't providing an ID." Upstream clones for this; a JS source object is
  // immutable and the same one is handed back.
  expect(await channel?.refetch()).toBe(await channel?.started);
  expect(await channel?.refetch()).toBe(await channel?.refetch());
});

test("get()'s callback is re-run when the isolate asks again", async () => {
  const h = newHarness();
  const loadCode = vi.fn(() => code());
  await h.run(() => h.loader.get("evicted", loadCode));
  await quiesce();

  // The named-isolate cache is the namespace's; the loader's callback answers every time it is
  // asked, which is what lets a runtime "evict the isolate while a stub still exists".
  const again = h.channel.isolates.get("evicted")?.refetch();
  await quiesce();
  await expect(again).resolves.toBeDefined();
  expect(loadCode).toHaveBeenCalledTimes(2);
});

// =======================================================================================
// `worker-loader-rab-test.js` — the bytes must be copied before the caller can revoke them

test("resizableArrayBufferDataModule: data bytes survive rab.resize(0) after load()", async () => {
  const h = newHarness();
  const expected = "Hello from resizable ArrayBuffer!";
  const rab = new ArrayBuffer(64, { maxByteLength: 128 });
  new TextEncoder().encodeInto(expected, new Uint8Array(rab));

  await h.run(() =>
    h.loader.load(
      code({ mainModule: "main.js", modules: { "main.js": { js: "" }, "data.bin": { data: rab } } }),
    ),
  );
  rab.resize(0);

  const source = await h.channel.anonymous[0]?.started;
  const content = modulesOf(source as DynamicWorkerSource).modules[1]?.content;
  expect(content?.type === "dataModule" && content.body.byteLength).toBe(64);
  expect(
    content?.type === "dataModule" &&
      new TextDecoder().decode(content.body.subarray(0, expected.length)),
  ).toBe(expected);
});

test("resizableArrayBufferWasmModule: wasm bytes survive it too", async () => {
  const h = newHarness();
  const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const rab = new ArrayBuffer(bytes.byteLength, { maxByteLength: bytes.byteLength * 2 });
  new Uint8Array(rab).set(bytes);

  await h.run(() =>
    h.loader.load(
      code({ mainModule: "main.js", modules: { "main.js": { js: "" }, "m.wasm": { wasm: rab } } }),
    ),
  );
  rab.resize(0);

  const source = await h.channel.anonymous[0]?.started;
  const content = modulesOf(source as DynamicWorkerSource).modules[1]?.content;
  expect(content?.type === "wasmModule" && [...content.body]).toEqual([...bytes]);
});

test("a view over a larger buffer copies only its own window", async () => {
  const h = newHarness();
  const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
  const view = new Uint8Array(buffer, 2, 3);

  await h.run(() =>
    h.loader.load(
      code({ mainModule: "a.js", modules: { "a.js": { js: "" }, "b.dat": { data: view } } }),
    ),
  );

  const source = await h.channel.anonymous[0]?.started;
  const content = modulesOf(source as DynamicWorkerSource).modules[1]?.content;
  expect(content?.type === "dataModule" && [...content.body]).toEqual([3, 4, 5]);
});

test("mutating the caller's buffer after the call does not change the captured bytes", async () => {
  const h = newHarness();
  const bytes = new Uint8Array([1, 2, 3]);

  await h.run(() =>
    h.loader.load(
      code({ mainModule: "a.js", modules: { "a.js": { js: "" }, "b.dat": { data: bytes } } }),
    ),
  );
  bytes[0] = 99;

  const source = await h.channel.anonymous[0]?.started;
  const content = modulesOf(source as DynamicWorkerSource).modules[1]?.content;
  expect(content?.type === "dataModule" && [...content.body]).toEqual([1, 2, 3]);
});

// =======================================================================================
// `worker-loader-unnamed-gc-test.js`
//
// Upstream's case is about kj/V8 lifetime: dropping the only JS reference to an
// unnamed stub during `getCode` and forcing GC destroyed the `start()` coroutine
// while it was firing. JS has no such hazard — the namespace holds the channel and
// the callback's promise holds its own continuation — so what survives the port is
// the observable: a load whose stub nobody keeps still completes.

test("unnamedStubGcDuringGetCode: an unnamed load completes with no reference to its stub", async () => {
  const h = newHarness();
  let getCodeCalled = false;

  await h.run(() => {
    h.loader.get(null, async () => {
      getCodeCalled = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return code({ env: { survived: true } });
    });
  });
  await quiesce();

  expect(getCodeCalled).toBe(true);
  expect(await h.channel.anonymous[0]?.started).toMatchObject({ env: { survived: true } });
});

// =======================================================================================
// `regressionDeadIoContextGetCode` — the reachable half of upstream's WeakRef check

test("a load whose context aborts fails with upstream's message rather than hanging", async () => {
  const h = newHarness();
  const { promise } = Promise.withResolvers<WorkerCode>();

  await h.run(() => h.loader.get("dead", () => promise));
  h.ctx.abort(new Error("the actor went away"));

  // `awaitIo` alone would leave this unsettled forever, and `WorkerStubChannel`'s contract is
  // that a failed load makes requests FAIL — a hung one makes them hang.
  await expect(h.channel.isolates.get("dead")?.started).rejects.toThrow(
    DEAD_LOAD_CONTEXT_MESSAGE,
  );
});

test("a load that already produced its source is unaffected by a later abort", async () => {
  const h = newHarness();
  await h.run(() => h.loader.get("live", () => code({ env: { fine: true } })));
  await quiesce();
  h.ctx.abort(new Error("the actor went away"));

  expect(await h.channel.isolates.get("live")?.started).toMatchObject({ env: { fine: true } });
});

// =======================================================================================
// The two things `makeReentryCallback` is there for (decision 13)

test("get() outside a gated slice throws, as IoContext::current() asserts", () => {
  const h = newHarness();
  expect(() => h.loader.get("x", () => code())).toThrow();
});

test("load() outside a gated slice throws too", () => {
  const h = newHarness();
  expect(() => h.loader.load(code())).toThrow("load(): no input lock available in this context");
});

test("the code callback inherits the critical section it was created in", async () => {
  const h = newHarness();
  const order: string[] = [];

  await h.ctx.run(async () => {
    await h.ctx.blockConcurrencyWhile(async () => {
      h.loader.get("inherited", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("getCode");
        return code();
      });
      // A callback that did NOT inherit would queue behind this section and could not
      // finish before it ends, which is decision 13's deadlock.
      await h.channel.isolates.get("inherited")?.started;
      order.push("sectionEnd");
    });
  });
  await quiesce();

  expect(order).toEqual(["getCode", "sectionEnd"]);
});

// =======================================================================================
// `limits` — carried, and a no-op on both runtimes

test("limits ride the source and the entrypoint request untouched", async () => {
  const h = newHarness();
  const limits = { cpuMs: 50, subRequests: 3 };
  await h.run(() => {
    h.loader.get("limits", () => code({ limits })).getEntrypoint("x", { limits });
  });

  const isolate = h.channel.isolates.get("limits");
  expect((await isolate?.started)?.limits).toEqual(limits);
  expect(isolate?.entrypoints[0]?.limits).toEqual(limits);
});

// =======================================================================================
// Cases whose behaviour is entirely inside the isolate
//
// `startupException`, `abortIsolateDynamic` and `abortIsolateDynamicAnonymous`
// assert what a *loaded* Worker does — a module that throws at global scope, and
// `abortIsolate()` terminating one isolate rather than the process. Both live
// behind `loadIsolate`, and upstream's own implementation of both is in
// `server.c++` (`WorkerStubImpl::onAbortIsolate`, `:4374-4380`), not in
// `api/worker-loader.c++`. The loader-side halves they do exercise are covered
// above: the `allowExperimental` gate the abort cases set, and the fact that a
// failed load surfaces on the stub rather than at `get()`.
//
// `tails`' rendezvous through an actor and `passEnvCaps`' round trip likewise
// measure the isolate; their loader-side halves are the two tests above.

test("a stub is constructible directly over a channel, which is all WorkerStub is", () => {
  const channel = new FakeWorkerStubChannel("direct", {
    name: "direct",
    fetchSource: () => Promise.resolve(undefined as unknown as DynamicWorkerSource),
  });
  const stub = new WorkerStub(channel);

  stub.getEntrypoint("named");
  expect(channel.entrypoints).toEqual([{ name: "named", props: undefined, limits: undefined }]);
});
