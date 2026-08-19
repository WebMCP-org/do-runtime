/**
 * ← workerd has **no** test for `src/workerd/api/actor.{h,c++}`.
 *
 * That was checked rather than assumed: `api/` holds `actor-state-test.c++` and
 * `actor-state-iocontext-test.c++` and no `actor-test.c++`, and the only files
 * in the tree that include `actor.h` at all are `server/server-test.c++`,
 * `api/api-rtti-test.c++` and `api/basics-test.c++` — an end-to-end server
 * harness and two type-registration checks, none of which asserts anything this
 * file implements. The nearest upstream unit test is
 * `server/actor-id-impl-test.c++`, which covers the ID *factory*; that is
 * `server/`'s and Section 6's, and `io/actor-id.ts` is the interface it fills.
 *
 * So every assertion below is this section's own claim, and the groups are the
 * upstream members they cover: `DurableObjectId` (`actor.h:42`),
 * `ColoLocalActorNamespace` (`:25`), `DurableObjectNamespace` (`:142`),
 * the `DurableObject` stub (`:87`), and `DurableObjectClass` (`:367`).
 *
 * The three outgoing factories (`:293`, `:331`, `:352`) are Section 7's and are
 * not tested here — what is tested is the request each one is handed, since
 * that is the shape they plug into and the only thing this layer decides.
 */

import { expect, test } from "vitest";
import type { ActorId, ActorIdFactory } from "../io/actor-id";
import type { ActorClassChannel } from "../io/io-channels";
import {
  ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE,
  ColoLocalActorNamespace,
  DurableObjectClass,
  DurableObjectId,
  DurableObjectNamespace,
  FOREIGN_ACTOR_ID_MESSAGE,
  MAX_COLO_LOCAL_ACTOR_ID_BYTES,
  type ActorChannelFactory,
  type ColoLocalActorChannelFactory,
  type ColoLocalActorRequest,
  type GlobalActorRequest,
} from "./actor";

// =======================================================================================
// Harness

/**
 * A stand-in for `ActorIdFactoryImpl::ActorIdImpl`. Upstream's is a keyed
 * SHA-256; the only properties this file depends on are that `toString()` round
 * trips through `idFromString` and that `equals` compares the string.
 */
class FakeActorId implements ActorId {
  constructor(
    private readonly value: string,
    private readonly name: string | undefined,
    private readonly jurisdiction: string | undefined,
  ) {}
  toString(): string {
    return this.value;
  }
  getName(): string | undefined {
    return this.name;
  }
  getJurisdiction(): string | undefined {
    return this.jurisdiction;
  }
  equals(other: ActorId): boolean {
    return other.toString() === this.value;
  }
}

class FakeIdFactory implements ActorIdFactory {
  counter = 0;
  constructor(readonly jurisdiction?: string) {}
  newUniqueId(jurisdiction: string | undefined): ActorId {
    this.counter += 1;
    return new FakeActorId(`unique-${this.counter}`, undefined, jurisdiction ?? this.jurisdiction);
  }
  idFromName(name: string): ActorId {
    return new FakeActorId(`name:${name}`, name, this.jurisdiction);
  }
  idFromString(str: string): ActorId {
    return new FakeActorId(str, undefined, this.jurisdiction);
  }
  matchesJurisdiction(id: ActorId): boolean {
    return id.getJurisdiction() === this.jurisdiction;
  }
  cloneWithJurisdiction(maybeJurisdiction: string | undefined): ActorIdFactory {
    return new FakeIdFactory(maybeJurisdiction);
  }
}

/** Section 7's transport, standing in as the one thing an actor channel produces. */
type TransportStub = Fetcher & { echo(value: string): Promise<string> };

function transportStub(label: string): TransportStub {
  const stub = {
    fetch: (): Promise<Response> => Promise.reject(new Error("no transport in this lane")),
    connect: (): never => {
      throw new Error("no transport in this lane");
    },
    echo(value: string): Promise<string> {
      // `this` proves the forwarding binds to the transport object, not to the stub wrapper.
      return Promise.resolve(`${label}:${value}:${this === stub ? "bound" : "unbound"}`);
    },
  };
  return stub;
}

class FakeChannelFactory implements ActorChannelFactory {
  readonly requests: GlobalActorRequest[] = [];
  readonly stub = transportStub("global");
  getGlobalActor(request: GlobalActorRequest): Fetcher {
    this.requests.push(request);
    return this.stub;
  }
  get last(): GlobalActorRequest {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error("no request recorded");
    return request;
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

function namespaceOf(jurisdiction?: string): {
  ns: DurableObjectNamespace;
  factory: FakeChannelFactory;
  ids: FakeIdFactory;
} {
  const factory = new FakeChannelFactory();
  const ids = new FakeIdFactory(jurisdiction);
  return { ns: new DurableObjectNamespace(factory, ids), factory, ids };
}

function channel(className: string): ActorClassChannel {
  return { className, requireAllowsTransfer: () => {} };
}

// =======================================================================================
// DurableObjectId — `actor.h:42-84`

test("DurableObjectId.toString() is the inner ActorId's", () => {
  const id = new DurableObjectId(new FakeActorId("abc", undefined, undefined));
  expect(id.toString()).toBe("abc");
});

test("DurableObjectId.name is the inner id's name, and undefined when it has none", () => {
  const named = new DurableObjectId(new FakeActorId("name:x", "x", undefined));
  expect(named.name).toBe("x");
  const unique = new DurableObjectId(new FakeActorId("unique-1", undefined, undefined));
  expect(unique.name).toBeUndefined();
});

test("DurableObjectId.jurisdiction is the inner id's", () => {
  const id = new DurableObjectId(new FakeActorId("abc", undefined, "eu"));
  expect(id.jurisdiction).toBe("eu");
});

test("DurableObjectId.getInner() hands back the ActorId the outgoing factory needs", () => {
  const inner = new FakeActorId("abc", undefined, undefined);
  expect(new DurableObjectId(inner).getInner()).toBe(inner);
});

test("DurableObjectId.equals() delegates to the inner id", () => {
  const a = new DurableObjectId(new FakeActorId("abc", undefined, undefined));
  const b = new DurableObjectId(new FakeActorId("abc", "other-name", "eu"));
  const c = new DurableObjectId(new FakeActorId("xyz", undefined, undefined));
  expect(a.equals(b)).toBe(true);
  expect(a.equals(c)).toBe(false);
});

test("DurableObjectId.equals() refuses an id this package did not mint", () => {
  const a = new DurableObjectId(new FakeActorId("abc", undefined, undefined));
  const foreign: globalThis.DurableObjectId = {
    toString: () => "abc",
    equals: () => true,
  };
  expect(() => a.equals(foreign)).toThrow(FOREIGN_ACTOR_ID_MESSAGE);
});

// =======================================================================================
// ColoLocalActorNamespace — `actor.h:25-37`, `actor.c++:116-129`

test("ColoLocalActorNamespace.get() returns the channel factory's stub", () => {
  const factory = new FakeColoLocalFactory();
  const ns = new ColoLocalActorNamespace(factory);
  expect(ns.get("worker-1")).toBe(factory.stub);
  expect(factory.requests).toEqual([{ actorId: "worker-1" }]);
});

test("ColoLocalActorNamespace.get() rejects an empty actor id", () => {
  const ns = new ColoLocalActorNamespace(new FakeColoLocalFactory());
  expect(() => ns.get("")).toThrow("Actor ID length must be in the range [1, 2048].");
});

test("ColoLocalActorNamespace.get() accepts 2048 bytes and rejects 2049", () => {
  const factory = new FakeColoLocalFactory();
  const ns = new ColoLocalActorNamespace(factory);
  expect(ns.get("a".repeat(MAX_COLO_LOCAL_ACTOR_ID_BYTES))).toBe(factory.stub);
  expect(() => ns.get("a".repeat(MAX_COLO_LOCAL_ACTOR_ID_BYTES + 1))).toThrow(
    "Actor ID length must be in the range [1, 2048].",
  );
});

test("ColoLocalActorNamespace.get() measures the id in UTF-8 bytes, as kj::String::size() does", () => {
  const ns = new ColoLocalActorNamespace(new FakeColoLocalFactory());
  // 1024 code units, 3 bytes each: inside the UTF-16 limit and outside the byte limit.
  const wide = "中".repeat(1024);
  expect(wide.length).toBeLessThanOrEqual(MAX_COLO_LOCAL_ACTOR_ID_BYTES);
  expect(() => ns.get(wide)).toThrow("Actor ID length must be in the range [1, 2048].");
});

// =======================================================================================
// DurableObjectNamespace — `actor.h:142-291`, `actor.c++:137-230`

test("newUniqueId() passes no jurisdiction by default and the option when given", () => {
  const { ns, ids } = namespaceOf();
  expect(ns.newUniqueId().toString()).toBe("unique-1");
  expect(ns.newUniqueId({ jurisdiction: "eu" }).jurisdiction).toBe("eu");
  expect(ids.counter).toBe(2);
});

test("idFromName() and idFromString() come straight off the id factory", () => {
  const { ns } = namespaceOf();
  expect(ns.idFromName("root").toString()).toBe("name:root");
  expect(ns.idFromName("root").name).toBe("root");
  expect(ns.idFromString("deadbeef").toString()).toBe("deadbeef");
});

test("get() asks the channel factory for a GET_OR_CREATE actor and returns its stub", async () => {
  const { ns, factory } = namespaceOf();
  const id = ns.idFromName("root");
  const stub = ns.get(id);
  expect(factory.last.mode).toBe("GET_OR_CREATE");
  expect(factory.last.id).toBe(id.getInner());
  expect(stub.id).toBe(id);
  expect(await stub.fetch(new Request("http://x")).catch((error: Error) => error.message)).toBe(
    "no transport in this lane",
  );
});

test("getExisting() differs from get() only in the mode", () => {
  const { ns, factory } = namespaceOf();
  ns.getExisting(ns.idFromName("root"));
  expect(factory.last.mode).toBe("GET_EXISTING");
});

test("getByName() is idFromName() followed by get()", () => {
  const { ns, factory } = namespaceOf();
  const stub = ns.getByName("root");
  expect(factory.last.mode).toBe("GET_OR_CREATE");
  expect(factory.last.id.toString()).toBe("name:root");
  expect(stub.name).toBe("root");
});

test("locationHint is forwarded to the outgoing request", () => {
  const { ns, factory } = namespaceOf();
  ns.getByName("root", { locationHint: "weur" });
  expect(factory.last.locationHint).toBe("weur");
  ns.getByName("root");
  expect(factory.last.locationHint).toBeUndefined();
});

test("routingMode 'primary-only' becomes PRIMARY_ONLY and anything else is a RangeError", () => {
  const { ns, factory } = namespaceOf();
  ns.getByName("root", { routingMode: "primary-only" });
  expect(factory.last.routingMode).toBe("PRIMARY_ONLY");
  ns.getByName("root");
  expect(factory.last.routingMode).toBe("DEFAULT");
  expect(() => ns.getByName("root", { routingMode: "replica-only" })).toThrow(
    "unknown routingMode: replica-only",
  );
  expect(() => ns.getByName("root", { routingMode: "replica-only" })).toThrow(RangeError);
});

test("version.cohort is forwarded to the outgoing request", () => {
  const { ns, factory } = namespaceOf();
  ns.getByName("root", { version: { cohort: "canary" } });
  expect(factory.last.version).toEqual({ cohort: "canary" });
  ns.getByName("root");
  expect(factory.last.version).toBeUndefined();
});

test("replica routing is off, because replication is a substrate boundary here", () => {
  const { ns, factory } = namespaceOf();
  ns.getByName("root");
  expect(factory.last.enableReplicaRouting).toBe(false);
});

test("get() refuses an id from a different jurisdiction", () => {
  const { ns } = namespaceOf("eu");
  const foreign = new DurableObjectId(new FakeActorId("x", undefined, "fedramp"));
  expect(() => ns.get(foreign)).toThrow(
    "get called on jurisdictional subnamespace with an ID from a different jurisdiction",
  );
});

test("get() refuses an id object this package did not mint", () => {
  const { ns } = namespaceOf();
  const foreign: globalThis.DurableObjectId = { toString: () => "x", equals: () => false };
  expect(() => ns.get(foreign)).toThrow(FOREIGN_ACTOR_ID_MESSAGE);
});

test("jurisdiction() clones the id factory and keeps the channel factory", () => {
  const { ns, factory } = namespaceOf();
  const eu = ns.jurisdiction("eu");
  expect(eu).not.toBe(ns);
  expect(eu.idFromName("root").jurisdiction).toBe("eu");
  eu.getByName("root");
  expect(factory.requests).toHaveLength(1);
});

test("jurisdiction() with no argument and with null both clear the jurisdiction", () => {
  const { ns } = namespaceOf("eu");
  expect(ns.jurisdiction().idFromName("root").jurisdiction).toBeUndefined();
  expect(ns.jurisdiction(null).idFromName("root").jurisdiction).toBeUndefined();
});

// =======================================================================================
// The DurableObject stub — `actor.h:87-139`

test("the stub answers id and name over the transport Fetcher", () => {
  const { ns } = namespaceOf();
  const named = ns.getByName("root");
  expect(named.id.toString()).toBe("name:root");
  expect(named.name).toBe("root");

  const unique = ns.get(ns.newUniqueId());
  expect(unique.name).toBeUndefined();
  // Upstream's is a JSG_READONLY_INSTANCE_PROPERTY, so the property exists and reads undefined.
  expect("name" in unique).toBe(true);
});

test("the stub forwards an RPC method to the transport, bound to the transport", async () => {
  const { ns, factory } = namespaceOf();
  const stub = ns.getByName("root");
  const rpc = stub as unknown as TransportStub;
  expect(await rpc.echo("hi")).toBe("global:hi:bound");
  expect(factory.stub.echo).toBeTypeOf("function");
});

test("the stub reports a property the transport does not have as undefined", () => {
  const { ns } = namespaceOf();
  const stub = ns.getByName("root");
  expect((stub as unknown as Record<string, unknown>).nope).toBeUndefined();
  expect("nope" in stub).toBe(false);
});

// =======================================================================================
// DurableObjectClass — `actor.h:367-393`, `actor.c++:232-359`

test("DurableObjectClass.getChannel() hands back the actor class channel", () => {
  const actorClass = channel("CodemodeRuntime");
  expect(new DurableObjectClass(actorClass).getChannel()).toBe(actorClass);
});

test("DurableObjectClass serialization is a named substrate boundary in both directions", () => {
  const actorClass = new DurableObjectClass(channel("CodemodeRuntime"));
  expect(() => actorClass.serialize()).toThrow(ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE);
  expect(() => DurableObjectClass.deserialize()).toThrow(
    ACTOR_CLASS_SERIALIZATION_UNIMPLEMENTED_MESSAGE,
  );
});

test("DurableObjectClass.serialize() asks the channel first, as upstream does", () => {
  let asked = 0;
  const actorClass = new DurableObjectClass({
    className: "CodemodeRuntime",
    requireAllowsTransfer: () => {
      asked += 1;
      throw new Error("this class may not be transferred");
    },
  });
  expect(() => actorClass.serialize()).toThrow("this class may not be transferred");
  expect(asked).toBe(1);
});
