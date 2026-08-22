import { expect, test } from "vitest";
import type { ActorChannelFactory } from "../api/actor";
import { createDurableObjectNamespace } from "./actor-namespace";

type CounterStub = Fetcher & { increment(): Promise<number> };

test("named stubs route to stable, independent actors", async () => {
  const values = new Map<string, number>();
  const channel: ActorChannelFactory = {
    getGlobalActor: ({ id }) => {
      const name = id.getName();
      if (name === undefined) throw new Error("expected a named actor");
      return {
        fetch: () => Promise.reject(new Error("fetch is not used by this test")),
        connect: () => {
          throw new Error("connect is not used by this test");
        },
        async increment(): Promise<number> {
          const value = (values.get(name) ?? 0) + 1;
          values.set(name, value);
          return value;
        },
      } as CounterStub;
    },
  };
  const namespace = createDurableObjectNamespace("counter-test", channel);
  const alpha = namespace.getByName("alpha") as CounterStub & DurableObjectStub;
  const beta = namespace.getByName("beta") as CounterStub & DurableObjectStub;

  expect([alpha.name, await alpha.increment(), await alpha.increment()]).toEqual(["alpha", 1, 2]);
  expect([beta.name, await beta.increment()]).toEqual(["beta", 1]);
});
