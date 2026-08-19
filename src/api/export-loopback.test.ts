/**
 * ← workerd has **no** unit test for `src/workerd/api/export-loopback.{h,c++}`.
 *
 * That was checked rather than assumed: `api/` holds no `export-loopback-test.c++`,
 * and the only files in the tree that name any of the four classes are
 * `api/actor-state.{h,c++}` (the facet class switch), `server/workerd-api.c++`
 * (where each one is constructed) and two behavioural JS suites.
 *
 * Those two suites are the upstream assertions, and the ones that do not need a
 * whole server to express are ported here under the behaviour they pin:
 *
 *  - `api/tests/worker-loader-test.js:449-450` —
 *    `ctx.exports.FacetTestActor.idFromName('foo')` followed by
 *    `ctx.exports.FacetTestActor.get(id)`. One `ctx.exports` entry answering
 *    both halves of a namespace is the whole reason
 *    `LoopbackDurableObjectNamespace` exists, and it is exactly what the
 *    vendored consumer needs (`vendor/agents/packages/agents/src/index.ts:10829`,
 *    `:10855`, `:10857`).
 *  - `api/tests/worker-loader-test.js:64-65`, `:416`, `api/tests/js-rpc-test.js:2063` —
 *    `ctx.exports.X({ props: … })` and `ctx.exports.testOutbound({})` produce a
 *    *specialized* stub, while `ctx.exports.testOutbound` used without invoking
 *    (`:405`) is the unspecialized one.
 *  - `api/tests/worker-loader-test.js:104` — a `LoopbackServiceStub` is not
 *    serializable even though its parent `Fetcher` is. That one ports, but not
 *    here: the refusal happens where `Frankenvalue::fromJs` does, inside
 *    `WorkerStub::getEntrypoint`, so it is asserted in
 *    `api/worker-loader.test.ts`. What is here is the half this module owns —
 *    that the four types exist and that invoking one produces something else.
 *    (An earlier revision of this note said it did not port at all. See the
 *    module comment.)
 *
 * Everything else below is this section's own claim.
 */

import { expect, test } from "vitest";
import type { ActorId, ActorIdFactory } from "../io/actor-id";
import type { ActorClassChannel } from "../io/io-channels";
import {
  ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE,
  ColoLocalActorNamespace,
  DurableObjectClass,
  DurableObjectNamespace,
  type ActorChannelFactory,
  type ColoLocalActorChannelFactory,
  type ColoLocalActorRequest,
  type GlobalActorRequest,
} from "./actor";
import {
  LOOPBACK_OPTIONS_NOT_AN_OBJECT_MESSAGE,
  LOOPBACK_PROPS_NOT_AN_OBJECT_MESSAGE,
  LoopbackColoLocalActorNamespace,
  LoopbackDurableObjectClass,
  LoopbackDurableObjectNamespace,
  LoopbackServiceStub,
  asLoopbackColoLocalActorNamespace,
  asLoopbackDurableObjectClass,
  asLoopbackDurableObjectNamespace,
  asLoopbackServiceStub,
  type ActorClassChannelFactory,
  type ActorClassRequest,
  type SubrequestChannelFactory,
  type SubrequestChannelRequest,
} from "./export-loopback";

// =======================================================================================
// Harness

/** Section 7's transport, standing in as the one thing a channel produces. */
type TransportStub = Fetcher & { echo(value: string): Promise<string> };

function transportStub(label: string): TransportStub {
  const stub = {
    fetch: (): Promise<Response> => Promise.reject(new Error("no transport in this lane")),
    connect: (): never => {
      throw new Error("no transport in this lane");
    },
    echo(value: string): Promise<string> {
      // `this` proves the forwarding binds to the transport object, not to the loopback wrapper.
      return Promise.resolve(`${label}:${value}:${this === stub ? "bound" : "unbound"}`);
    },
  };
  return stub;
}

class FakeSubrequestFactory implements SubrequestChannelFactory {
  readonly requests: SubrequestChannelRequest[] = [];
  readonly produced: TransportStub[] = [];
  getSubrequestChannel(request: SubrequestChannelRequest): Fetcher {
    this.requests.push(request);
    const stub = transportStub(`service-${this.requests.length}`);
    this.produced.push(stub);
    return stub;
  }
  get last(): SubrequestChannelRequest {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error("no request recorded");
    return request;
  }
}

class FakeActorClassFactory implements ActorClassChannelFactory {
  readonly requests: ActorClassRequest[] = [];
  readonly produced: ActorClassChannel[] = [];
  getActorClass(request: ActorClassRequest): ActorClassChannel {
    this.requests.push(request);
    const channel: ActorClassChannel = {
      className: `Child-${this.requests.length}`,
      requireAllowsTransfer: () => {},
    };
    this.produced.push(channel);
    return channel;
  }
  get last(): ActorClassRequest {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error("no request recorded");
    return request;
  }
}

class FakeActorId implements ActorId {
  constructor(
    private readonly value: string,
    private readonly actorName: string | undefined,
  ) {}
  toString(): string {
    return this.value;
  }
  getName(): string | undefined {
    return this.actorName;
  }
  getJurisdiction(): string | undefined {
    return undefined;
  }
  equals(other: ActorId): boolean {
    return other.toString() === this.value;
  }
}

class FakeIdFactory implements ActorIdFactory {
  counter = 0;
  newUniqueId(): ActorId {
    this.counter += 1;
    return new FakeActorId(`unique-${this.counter}`, undefined);
  }
  idFromName(name: string): ActorId {
    return new FakeActorId(`name:${name}`, name);
  }
  idFromString(str: string): ActorId {
    return new FakeActorId(str, undefined);
  }
  matchesJurisdiction(): boolean {
    return true;
  }
  cloneWithJurisdiction(): ActorIdFactory {
    return this;
  }
}

class FakeActorChannelFactory implements ActorChannelFactory {
  readonly requests: GlobalActorRequest[] = [];
  readonly stub = transportStub("global");
  getGlobalActor(request: GlobalActorRequest): Fetcher {
    this.requests.push(request);
    return this.stub;
  }
}

class FakeColoLocalFactory implements ColoLocalActorChannelFactory {
  readonly requests: ColoLocalActorRequest[] = [];
  readonly stub = transportStub("colo");
  getColoLocalActor(request: ColoLocalActorRequest): Fetcher {
    this.requests.push(request);
    return this.stub;
  }
}

// =======================================================================================
// LoopbackServiceStub — `export-loopback.h:18-109`, `export-loopback.c++:11-29`

test("LoopbackServiceStub is a Fetcher over the unspecialized channel", () => {
  const factory = new FakeSubrequestFactory();
  const stub = new LoopbackServiceStub(factory);
  expect(factory.requests).toEqual([{}]);
  expect(stub.getFetcher()).toBe(factory.produced[0]);
});

test("the unspecialized Fetcher answers property reads, bound to the transport", async () => {
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  const rpc = service as unknown as TransportStub;
  expect(await rpc.echo("hi")).toBe("service-1:hi:bound");
});

test("invoking the stub specializes it with props and returns a different Fetcher", () => {
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  const specialized = service({ props: { greeting: "G'day" } });
  expect(factory.last).toEqual({ props: { greeting: "G'day" } });
  expect(specialized).toBe(factory.produced[1]);
  expect(specialized).not.toBe(factory.produced[0]);
});

test("invoking the stub with an empty object asks for a channel with no props", () => {
  // ← `ctx.exports.testOutbound({})` (`worker-loader-test.js:416`).
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  service({});
  expect(factory.last).toEqual({});
});

test("invoking the stub with no argument is the empty struct JSG unwraps from undefined", () => {
  // ← `jsg/struct.h:236-243`: a struct whose every field is optional unwraps from
  // undefined or null as `T{}`.
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  service();
  expect(factory.last).toEqual({});
});

test("a version cohort reaches the channel, and an omitted or null cohort does not", () => {
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  service({ version: { cohort: "canary" } });
  expect(factory.last).toEqual({ version: { cohort: "canary" } });
  // `jsg::Optional<kj::Maybe<kj::String>>`: omitted and null are the same request.
  service({ version: {} });
  expect(factory.last).toEqual({ version: {} });
  service({ version: { cohort: null } });
  expect(factory.last).toEqual({ version: {} });
  service({ props: {} });
  expect(factory.last).toEqual({ props: {} });
});

test("a non-object options argument is refused, as JSG's struct unwrapper refuses it", () => {
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  const callable = service as unknown as (options: unknown) => Fetcher;
  expect(() => callable("props")).toThrow(LOOPBACK_OPTIONS_NOT_AN_OBJECT_MESSAGE);
  expect(() => callable(7)).toThrow(TypeError);
  expect(factory.requests).toHaveLength(1);
});

test("non-object props are refused, as jsg::JsObject refuses them", () => {
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  const callable = service as unknown as (options: unknown) => Fetcher;
  expect(() => callable({ props: "greeting" })).toThrow(LOOPBACK_PROPS_NOT_AN_OBJECT_MESSAGE);
  expect(() => callable({ props: null })).toThrow(LOOPBACK_PROPS_NOT_AN_OBJECT_MESSAGE);
  expect(factory.requests).toHaveLength(1);
});

test("a function is an object to both unwrappers, as it is to V8's IsObject()", () => {
  // JSG's struct unwrapper and `jsg::JsObject` both test `handle->IsObject()`, which is true for
  // a function — so neither position refuses one, however unusual passing one would be.
  const factory = new FakeSubrequestFactory();
  const service = asLoopbackServiceStub(new LoopbackServiceStub(factory));
  const callable = service as unknown as (options: unknown) => Fetcher;
  const props = (): void => {};
  callable(props);
  expect(factory.last).toEqual({});
  callable({ props });
  expect(factory.last.props).toBe(props);
});

test("the callable stub keeps its own identity", () => {
  const service = asLoopbackServiceStub(new LoopbackServiceStub(new FakeSubrequestFactory()));
  expect(service).toBeInstanceOf(LoopbackServiceStub);
  expect(typeof service).toBe("function");
});

test("a forwarded method is memoised, as upstream gets for free by there being one object", () => {
  const service = asLoopbackServiceStub(new LoopbackServiceStub(new FakeSubrequestFactory()));
  expect(service.fetch).toBe(service.fetch);
});

test("the callable stub neither invents nor hides properties of what it forwards to", () => {
  const factory = new FakeSubrequestFactory();
  const stub = new LoopbackServiceStub(factory);
  const service = asLoopbackServiceStub(stub);
  expect("fetch" in service).toBe(true);
  expect("nope" in service).toBe(false);
  expect((service as unknown as Record<string, unknown>).nope).toBeUndefined();
  expect(Object.keys(service)).toEqual(Object.keys(stub.getFetcher()));
});

// =======================================================================================
// LoopbackDurableObjectClass — `export-loopback.h:116-148`, `export-loopback.c++:31-40`

test("LoopbackDurableObjectClass is a DurableObjectClass over the unspecialized channel", () => {
  const factory = new FakeActorClassFactory();
  const cls = new LoopbackDurableObjectClass(factory);
  expect(factory.requests).toEqual([{}]);
  expect(cls).toBeInstanceOf(DurableObjectClass);
  expect(cls.getChannel()).toBe(factory.produced[0]);
});

test("invoking the class specializes it and returns a plain DurableObjectClass", () => {
  const factory = new FakeActorClassFactory();
  const cls = asLoopbackDurableObjectClass(new LoopbackDurableObjectClass(factory));
  const specialized = cls({ props: { greeting: "Welcome" } });
  expect(factory.last).toEqual({ props: { greeting: "Welcome" } });
  expect(specialized).toBeInstanceOf(DurableObjectClass);
  // ← `js.alloc<DurableObjectClass>(...)`: the specialization is NOT itself a loopback class.
  expect(specialized).not.toBeInstanceOf(LoopbackDurableObjectClass);
  expect(specialized.getChannel()).toBe(factory.produced[1]);
});

test("invoking the class with no argument asks for a channel with no props", () => {
  const factory = new FakeActorClassFactory();
  const cls = asLoopbackDurableObjectClass(new LoopbackDurableObjectClass(factory));
  cls();
  expect(factory.requests).toEqual([{}, {}]);
});

test("the callable class is a DurableObjectClass and a loopback class", () => {
  const cls = asLoopbackDurableObjectClass(new LoopbackDurableObjectClass(new FakeActorClassFactory()));
  expect(cls).toBeInstanceOf(LoopbackDurableObjectClass);
  expect(cls).toBeInstanceOf(DurableObjectClass);
  expect(typeof cls).toBe("function");
});

test("the callable class still reaches DurableObjectClass's substrate boundary", () => {
  const cls = asLoopbackDurableObjectClass(
    new LoopbackDurableObjectClass(new FakeActorClassFactory()),
  );
  expect(() => cls.serialize()).toThrow(ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE);
});

// =======================================================================================
// LoopbackDurableObjectNamespace — `export-loopback.h:155-189`

function loopbackNamespace(): {
  ns: LoopbackDurableObjectNamespace;
  actors: FakeActorChannelFactory;
  classes: FakeActorClassFactory;
} {
  const actors = new FakeActorChannelFactory();
  const classes = new FakeActorClassFactory();
  const ns = new LoopbackDurableObjectNamespace(
    actors,
    new FakeIdFactory(),
    new LoopbackDurableObjectClass(classes),
  );
  return { ns, actors, classes };
}

test("the callable namespace answers idFromName and get, as ctx.exports must", () => {
  // ← `worker-loader-test.js:449-450`, and the vendored consumer's `:10829` / `:10855`.
  const { ns, actors } = loopbackNamespace();
  const exported = asLoopbackDurableObjectNamespace(ns);
  const id = exported.idFromName("foo");
  expect(id.toString()).toBe("name:foo");
  expect(exported.get(id)).toBeDefined();
  expect(actors.requests).toHaveLength(1);
  expect(actors.requests[0]?.id.toString()).toBe("name:foo");
});

test("the callable namespace is a DurableObjectNamespace and a loopback namespace", () => {
  const exported = asLoopbackDurableObjectNamespace(loopbackNamespace().ns);
  expect(exported).toBeInstanceOf(LoopbackDurableObjectNamespace);
  expect(exported).toBeInstanceOf(DurableObjectNamespace);
  expect(typeof exported).toBe("function");
});

test("getClass() hands back the loopback class the namespace was built with", () => {
  const { ns } = loopbackNamespace();
  expect(ns.getClass()).toBeInstanceOf(LoopbackDurableObjectClass);
  expect(asLoopbackDurableObjectNamespace(ns).getClass()).toBe(ns.getClass());
});

test("call, apply and bind belong to the callable, not to what it forwards to", () => {
  // Three of the four classes have a C++ method literally named `call`, which `JSG_CALLABLE`
  // registers as the object's call behaviour rather than as a JS property — so on a `ctx.exports`
  // entry `.call` is `Function.prototype.call` and nothing else.
  const { ns, classes } = loopbackNamespace();
  const exported = asLoopbackDurableObjectNamespace(ns);
  expect(exported.call).toBe(Function.prototype.call);
  expect(exported.apply).toBe(Function.prototype.apply);
  expect(exported.bind).toBe(Function.prototype.bind);

  expect(exported.call(null, { props: { via: "call" } })).toBeInstanceOf(DurableObjectClass);
  expect(classes.last).toEqual({ props: { via: "call" } });
  exported.apply(null, [{ props: { via: "apply" } }]);
  expect(classes.last).toEqual({ props: { via: "apply" } });
  exported.bind(null)({ props: { via: "bind" } });
  expect(classes.last).toEqual({ props: { via: "bind" } });
});

test("invoking the namespace specializes the class, not the namespace", () => {
  // ← "Invoking the binding creates a specialization of the class -- not the namespace."
  const { ns, classes } = loopbackNamespace();
  const exported = asLoopbackDurableObjectNamespace(ns);
  const specialized = exported({ props: { foo: 123 } });
  expect(classes.last).toEqual({ props: { foo: 123 } });
  expect(specialized).toBeInstanceOf(DurableObjectClass);
  expect(specialized).not.toBeInstanceOf(DurableObjectNamespace);
});

// =======================================================================================
// LoopbackColoLocalActorNamespace — `export-loopback.h:192-220`

function loopbackColoLocal(): {
  ns: LoopbackColoLocalActorNamespace;
  actors: FakeColoLocalFactory;
  classes: FakeActorClassFactory;
} {
  const actors = new FakeColoLocalFactory();
  const classes = new FakeActorClassFactory();
  const ns = new LoopbackColoLocalActorNamespace(actors, new LoopbackDurableObjectClass(classes));
  return { ns, actors, classes };
}

test("the callable colo-local namespace answers get()", () => {
  const { ns, actors } = loopbackColoLocal();
  const exported = asLoopbackColoLocalActorNamespace(ns);
  expect(exported.get("worker-1")).toBe(actors.stub);
  expect(actors.requests).toEqual([{ actorId: "worker-1" }]);
});

test("the callable colo-local namespace keeps ColoLocalActorNamespace's argument check", () => {
  const exported = asLoopbackColoLocalActorNamespace(loopbackColoLocal().ns);
  expect(() => exported.get("")).toThrow("Actor ID length must be in the range [1, 2048].");
});

test("the callable colo-local namespace is a ColoLocalActorNamespace and a loopback one", () => {
  const exported = asLoopbackColoLocalActorNamespace(loopbackColoLocal().ns);
  expect(exported).toBeInstanceOf(LoopbackColoLocalActorNamespace);
  expect(exported).toBeInstanceOf(ColoLocalActorNamespace);
  expect(typeof exported).toBe("function");
});

test("colo-local getClass() and invocation both reach the loopback class", () => {
  const { ns, classes } = loopbackColoLocal();
  const exported = asLoopbackColoLocalActorNamespace(ns);
  expect(exported.getClass()).toBe(ns.getClass());
  const specialized = exported({ props: { foo: 1 } });
  expect(classes.last).toEqual({ props: { foo: 1 } });
  expect(specialized).toBeInstanceOf(DurableObjectClass);
  expect(specialized).not.toBeInstanceOf(ColoLocalActorNamespace);
});
