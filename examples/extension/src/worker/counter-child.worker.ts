/**
 * The actual bundled facet class.
 *
 * Vite emits this as a self-contained extension module and prefixes the built
 * chunk with this facet's Workers globals. Binding the whole chunk matters:
 * Agents SDK internals use `crypto` too. The source class itself remains
 * ordinary Agents SDK code, with no blob, eval, or shared ambient.
 */

import { platformFetch, platformTimer, platformWebSocket } from "@mcp-b/do-runtime";
import { Agent } from "agents";
import type {
  CounterValueState,
  NestedSubAgentSnapshot,
  SubAgentPlatformSnapshot,
  SubAgentSnapshot,
} from "../protocol";

type CounterEnv = { Counter: DurableObjectNamespace<Counter> };

/** A type-only parent handle; `parentAgent()` resolves it by class name. */
class Counter extends Agent<CounterEnv> {
  declare currentValue: () => Promise<number>;
}

export class CounterChild extends Agent<CounterEnv, CounterValueState> {
  override initialState: CounterValueState = { value: 0 };

  async bump(): Promise<SubAgentSnapshot> {
    const value = this.state.value + 1;
    this.setState({ value });
    const parent = await this.parentAgent(Counter);
    return { name: this.name, value, parentValue: await parent.currentValue() };
  }

  async bumpAfter(delayMs: number): Promise<SubAgentSnapshot> {
    await scheduler.wait(delayMs);
    return await this.bump();
  }

  async currentValue(): Promise<number> {
    return this.state.value;
  }

  async bumpLeaf(): Promise<NestedSubAgentSnapshot> {
    const leaf = await this.subAgent(CounterLeaf, "leaf");
    return await leaf.bump();
  }

  async armWake(delayMs: number): Promise<number> {
    const at = Date.now() + Math.max(0, delayMs);
    await this.schedule(new Date(at), "scheduledBump");
    return at;
  }

  async scheduledBump(): Promise<void> {
    this.setState({ value: this.state.value + 1 });
  }

  /**
   * The platform primitives this bundle's own copy of the runtime exports. It is evaluated after
   * the root installed its actor scope, so a copy that captured the globals for itself would
   * hold the refusing `WebSocket` and the root's gated timer and `fetch`.
   */
  async platformPrimitives(): Promise<SubAgentPlatformSnapshot> {
    return {
      // Nothing listens on port 1; constructing the socket is the proof, so close it at once.
      webSocket: await outcome(() => new platformWebSocket("ws://127.0.0.1:1/").close()),
      timer: await outcome(() => platformTimer.afterDelay(0)),
      fetch: await outcome(async () => await (await platformFetch("data:,ok")).text()),
    };
  }
}

async function outcome(run: () => unknown): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export class CounterLeaf extends Agent<CounterEnv, CounterValueState> {
  override initialState: CounterValueState = { value: 0 };

  async bump(): Promise<NestedSubAgentSnapshot> {
    const value = this.state.value + 1;
    this.setState({ value });
    const parent = await this.parentAgent(CounterChild);
    return { childValue: await parent.currentValue(), leafValue: value };
  }
}
