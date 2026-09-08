import {
  IoContext,
  tryCurrentIoContext,
  type Actor,
  type Timer
} from "../../../../../../src/io/io-context";
import { InputGate, OutputGate } from "../../../../../../src/io/io-gate";
import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  getCurrentAgent
} from "../../../agents/src/lifecycle/current-agent";
import { wrapTools } from "../../../agents/src/observability/ai/wrapper/tools";
import { RecordingTracer } from "../../../agents/src/tests/observability/recording-tracer";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
};

// Only the platform Actor boundary is supplied here; gates, invocation context,
// SDK context storage, tracing and generator wrappers are their real implementations.
class ContextActor implements Actor {
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

export function newContext(): IoContext {
  return new IoContext(new ContextActor(), timer);
}

export function currentRequest(): string | undefined {
  const request = getCurrentAgent().request;
  return request ? new URL(request.url).pathname : undefined;
}

function inInvocation<T>(host: object, name: string, run: () => T): T {
  return agentContext.run(
    {
      agent: host,
      connection: undefined,
      request: new Request(`https://agent.test/${name}`),
      email: undefined
    },
    run
  );
}

export function startInvocation(context: IoContext, name: string) {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const host: object = { name };
  const observe = () => ({
    request: currentRequest(),
    host: getCurrentAgent().agent === host,
    input: tryCurrentIoContext() === context
  });
  const result = context.run(() =>
    inInvocation(host, name, async () => {
      const before = observe();
      started.resolve();
      await resume.promise;
      const after = observe();
      try {
        await Promise.reject(new Error("expected rejection"));
      } catch {
        return { before, after, caught: observe() };
      }
      throw new Error("Rejected await unexpectedly resolved");
    })
  );
  return { started: started.promise, resume: resume.resolve, result };
}

export async function tracedStream(context: IoContext) {
  const tracing = new RecordingTracer();
  const host = {};
  const resumed = Promise.withResolvers<void>();
  const observations: string[] = [];
  async function* produce() {
    try {
      await resumed.promise;
      tracing.withSpan("body", {}, () =>
        observations.push(currentRequest() ?? "missing")
      );
      yield currentRequest();
      await Promise.resolve();
      yield currentRequest();
    } finally {
      await Promise.resolve();
      tracing.withSpan("cleanup", {}, () =>
        observations.push(currentRequest() ?? "missing")
      );
    }
  }
  const tools = wrapTools(
    tracing,
    { produce: { execute: produce } },
    false,
    {}
  ) as { produce: { execute: () => AsyncIterable<string | undefined> } };
  const stream = await context.run(() =>
    inInvocation(host, "owner", () =>
      tracing.recordSpan("owner", () => tools.produce.execute())
    )
  );
  return {
    tracing,
    observations,
    resume: resumed.resolve,
    consume: (earlyReturn: boolean) =>
      context.run(() =>
        inInvocation(host, "consumer", async () => {
          const values: Array<string | undefined> = [];
          for await (const value of stream) {
            values.push(value);
            if (earlyReturn) break;
          }
          return { values, consumer: currentRequest() };
        })
      )
  };
}
