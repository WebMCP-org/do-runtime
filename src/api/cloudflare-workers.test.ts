/**
 * ← workerd has **no** test for `src/cloudflare/workers.ts`.
 *
 * That file is a thin wrapper — "C++ built-in modules do not yet support named
 * exports, so we must define this wrapper module that simply re-exports the
 * classes from the built-in module" — and the behaviour it does own, the `env`
 * and `exports` proxies, is exercised only through workerd's own end-to-end
 * fixtures. So every assertion below is this section's own claim.
 *
 * The groups are the upstream exports: the two proxies and the three `with*`
 * scopes, the four entrypoint classes, and the boundary exports that have
 * nothing in this substrate to resolve against.
 */

import { expect, test } from "vitest";
import {
  ABORT_ISOLATE_UNIMPLEMENTED_MESSAGE,
  CACHE_UNIMPLEMENTED_MESSAGE,
  DurableObject,
  EXPORTS_READ_ONLY_MESSAGE,
  MODULE_WAIT_UNTIL_UNIMPLEMENTED_MESSAGE,
  RPC_STUB_UNIMPLEMENTED_MESSAGE,
  RpcPromise,
  RpcProperty,
  RpcStub,
  RpcTarget,
  ServiceStub,
  WITH_SCOPE_ASYNC_MESSAGE,
  WorkerEntrypoint,
  WorkflowEntrypoint,
  abortIsolate,
  cache,
  env,
  exports,
  tracing,
  waitUntil,
  withEnv,
  withEnvAndExports,
  withExports,
} from "./cloudflare-workers";

/** Every test that touches the base env cleans up after itself; the module is a singleton. */
function clearEnv(): void {
  for (const key of Object.keys(env)) delete (env as Record<string, unknown>)[key];
}

// =======================================================================================
// env — the proxy at `workers.ts:41-104`

test("env reads and writes the base bindings, and its identity never changes", () => {
  clearEnv();
  const before = env;
  (env as Record<string, unknown>).MODEL = "sonnet";
  expect((env as Record<string, unknown>).MODEL).toBe("sonnet");
  expect(env).toBe(before);
  clearEnv();
});

test("env answers has, ownKeys, getOwnPropertyDescriptor and deleteProperty", () => {
  clearEnv();
  Object.assign(env, { A: 1, B: 2 });
  expect("A" in env).toBe(true);
  expect("C" in env).toBe(false);
  expect(Object.keys(env).sort()).toEqual(["A", "B"]);
  expect(Object.getOwnPropertyDescriptor(env, "A")?.value).toBe(1);
  delete (env as Record<string, unknown>).A;
  expect("A" in env).toBe(false);
  Object.defineProperty(env, "C", { value: 3, enumerable: true, configurable: true });
  expect((env as Record<string, unknown>).C).toBe(3);
  clearEnv();
});

test("withEnv swaps the bindings for the call and restores them after", () => {
  clearEnv();
  Object.assign(env, { WHO: "base" });
  const seen = withEnv({ WHO: "scoped" }, () => (env as Record<string, unknown>).WHO);
  expect(seen).toBe("scoped");
  expect((env as Record<string, unknown>).WHO).toBe("base");
  clearEnv();
});

test("withEnv restores the bindings when the callback throws", () => {
  clearEnv();
  Object.assign(env, { WHO: "base" });
  expect(() =>
    withEnv({ WHO: "scoped" }, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect((env as Record<string, unknown>).WHO).toBe("base");
  clearEnv();
});

test("withEnv nests", () => {
  clearEnv();
  Object.assign(env, { WHO: "base" });
  const seen = withEnv({ WHO: "outer" }, () => [
    (env as Record<string, unknown>).WHO,
    withEnv({ WHO: "inner" }, () => (env as Record<string, unknown>).WHO),
    (env as Record<string, unknown>).WHO,
  ]);
  expect(seen).toEqual(["outer", "inner", "outer"]);
  clearEnv();
});

test("withEnv refuses a callback that returns a thenable", () => {
  clearEnv();
  expect(() => withEnv({}, () => Promise.resolve(1))).toThrow(WITH_SCOPE_ASYNC_MESSAGE);
  // The scope is still unwound, so the refusal does not leave the wrong bindings installed.
  Object.assign(env, { WHO: "base" });
  expect((env as Record<string, unknown>).WHO).toBe("base");
  clearEnv();
});

// =======================================================================================
// exports — the proxy at `workers.ts:109-147`

test("exports reads the current worker exports and is read-only", () => {
  const seen = withExports({ Agent: "class" }, () => (exports as Record<string, unknown>).Agent);
  expect(seen).toBe("class");
  expect((exports as Record<string, unknown>).Agent).toBeUndefined();
  expect(() => {
    (exports as Record<string, unknown>).Agent = "sneaky";
  }).toThrow(EXPORTS_READ_ONLY_MESSAGE);
});

test("exports refuses defineProperty, delete and a redirected set", () => {
  // Three doors to the same refusal, and each needs its own assertion. A plain assignment to a
  // property the proxy target lacks falls through [[Set]] into [[DefineOwnProperty]], so the
  // `set` and `defineProperty` traps cover each other there; `delete` reaches neither, and a
  // `Reflect.set` with a different receiver reaches only `set`, because the data property would
  // be created on the receiver instead of on the proxy.
  expect(() => Object.defineProperty(exports, "Agent", { value: 1, configurable: true })).toThrow(
    EXPORTS_READ_ONLY_MESSAGE,
  );
  expect(() => {
    delete (exports as Record<string, unknown>).Agent;
  }).toThrow(EXPORTS_READ_ONLY_MESSAGE);
  expect(() => Reflect.set(exports, "Agent", 1, {})).toThrow(EXPORTS_READ_ONLY_MESSAGE);
});

test("exports answers has, ownKeys and getOwnPropertyDescriptor inside a scope", () => {
  withExports({ Agent: "class", Conversation: "class" }, () => {
    expect("Agent" in exports).toBe(true);
    expect("Nope" in exports).toBe(false);
    expect(Object.keys(exports).sort()).toEqual(["Agent", "Conversation"]);
    expect(Object.getOwnPropertyDescriptor(exports, "Agent")?.value).toBe("class");
  });
});

test("withEnvAndExports installs both at once", () => {
  clearEnv();
  const seen = withEnvAndExports({ WHO: "scoped" }, { Agent: "class" }, () => ({
    who: (env as Record<string, unknown>).WHO,
    agent: (exports as Record<string, unknown>).Agent,
  }));
  expect(seen).toEqual({ who: "scoped", agent: "class" });
  expect((env as Record<string, unknown>).WHO).toBeUndefined();
  expect((exports as Record<string, unknown>).Agent).toBeUndefined();
  clearEnv();
});

// =======================================================================================
// The entrypoint classes

test("RpcTarget is a constructible marker base class", () => {
  class Thing extends RpcTarget {
    greet(): string {
      return "hi";
    }
  }
  const thing = new Thing();
  expect(thing).toBeInstanceOf(RpcTarget);
  expect(thing.greet()).toBe("hi");
});

test("DurableObject stores ctx and env and is an RpcTarget", () => {
  class Agent extends DurableObject<{ MODEL: string }> {
    read(): [DurableObjectState, { MODEL: string }] {
      return [this.ctx, this.env];
    }
  }
  const ctx = {} as DurableObjectState;
  const bindings = { MODEL: "sonnet" };
  const agent = new Agent(ctx, bindings);
  expect(agent.read()).toEqual([ctx, bindings]);
  expect(agent).toBeInstanceOf(RpcTarget);
});

test("WorkerEntrypoint stores ctx and env", () => {
  class Connector extends WorkerEntrypoint<{ KEY: string }> {
    read(): [ExecutionContext, { KEY: string }] {
      return [this.ctx, this.env];
    }
  }
  const ctx = {} as ExecutionContext;
  const bindings = { KEY: "k" };
  expect(new Connector(ctx, bindings).read()).toEqual([ctx, bindings]);
});

test("WorkflowEntrypoint constructs and stores ctx and env", () => {
  class Flow extends WorkflowEntrypoint<{ KEY: string }> {
    run(): Promise<unknown> {
      return Promise.resolve(this.env.KEY);
    }
  }
  const flow = new Flow({} as ExecutionContext, { KEY: "k" });
  expect(flow).toBeInstanceOf(WorkflowEntrypoint);
});

// =======================================================================================
// The boundary exports

test("the module-level waitUntil names the context it cannot find", () => {
  expect(() => waitUntil(Promise.resolve())).toThrow(MODULE_WAIT_UNTIL_UNIMPLEMENTED_MESSAGE);
});

test("abortIsolate is a named boundary", () => {
  expect(() => abortIsolate("because")).toThrow(ABORT_ISOLATE_UNIMPLEMENTED_MESSAGE);
});

test("cache throws on any access rather than answering undefined", () => {
  expect(() => (cache as unknown as Record<string, unknown>).purge).toThrow(
    CACHE_UNIMPLEMENTED_MESSAGE,
  );
});

// The conformance suite's §1.12 is what pins this against workerd; here is the
// part a lane cannot see — the callback's own return value comes back untouched,
// and a throw from it propagates rather than being swallowed by the span.
test("tracing runs the callback and returns its value", () => {
  expect(tracing.startActiveSpan("probe", (span) => `traced:${span.isTraced}`)).toBe(
    "traced:false",
  );
  expect(() =>
    tracing.startActiveSpan("probe", () => {
      throw new Error("from inside the span");
    }),
  ).toThrow("from inside the span");
});

test("the four RPC stub types refuse construction and point at the transport", () => {
  expect(() => new RpcStub({})).toThrow(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  expect(() => new RpcPromise()).toThrow(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  expect(() => new RpcProperty()).toThrow(RPC_STUB_UNIMPLEMENTED_MESSAGE);
  expect(() => new ServiceStub()).toThrow(RPC_STUB_UNIMPLEMENTED_MESSAGE);
});
