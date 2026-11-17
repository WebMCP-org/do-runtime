import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { useAgent } from "../react";
import { AgentClient } from "../client";

declare class A extends Agent<typeof env, {}> {
  prop: string;
  f1: () => number;
  f2: (a: string) => void;
  f3: (a: number, b: string) => Promise<string>;
  f4: (a?: string) => void;
  f5: (a: string | undefined) => void;
  f6: () => Promise<void>;
  nonSerializableParams: (a: string, b: { c: Date }) => void;
  nonSerializableReturn: (a: string) => Date;
}

const { stub } = useAgent<A, {}>({
  agent: "test"
});

stub.f1() satisfies Promise<number>;
// @ts-expect-error
stub.f1(1) satisfies Promise<number>;

stub.f2("test") satisfies Promise<void>;
// @ts-expect-error should receive a [string]
stub.f2();
// @ts-expect-error
stub.f2(1);

stub.f3(1, "test") satisfies Promise<string>;
// @ts-expect-error should receive a [number, string]
stub.f3() satisfies Promise<string>;
// @ts-expect-error
stub.f3(1) satisfies Promise<string>;

stub.f4() satisfies Promise<void>;
stub.f4() satisfies Promise<void>;
stub.f4(undefined) satisfies Promise<void>;

// @ts-expect-error should receive a [string | undefined]
stub.f5() satisfies Promise<void>;
stub.f5(undefined) satisfies Promise<void>;

stub.f6() satisfies Promise<void>;

// @ts-expect-error should not have base Agent methods
stub.setState({ prop: "test" });

// @ts-expect-error Date parameter not serializable
stub.nonSerializableParams("test", { c: new Date() });
// @ts-expect-error Date return not serializable
stub.nonSerializableReturn("test");

const node = new AgentClient<A>({
  agent: "test",
  host: "localhost",
  startClosed: true
});

node.stub.f3(1, "test") satisfies Promise<string>;
node.call("f3", [1, "test"], {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}) satisfies Promise<string>;
// @ts-expect-error the stub infers the required string argument
node.stub.f3(1);
// @ts-expect-error the method returns a string
node.stub.f3(1, "test") satisfies Promise<number>;
// @ts-expect-error named calls infer the same argument tuple
node.call("f3", ["test", 1]);
// @ts-expect-error method names come from the declared Agent
node.call("notAnAgentMethod");
// @ts-expect-error RPC arguments exclude functions
node.stub.f2(() => "test");
