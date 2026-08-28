/**
 * The actual bundled facet class.
 *
 * Vite emits this as a self-contained extension module and prefixes the built
 * chunk with this facet's Workers globals. Binding the whole chunk matters:
 * Agents SDK internals use `crypto` too. The source class itself remains
 * ordinary Agents SDK code, with no blob, eval, or shared ambient.
 */

import { Agent } from "agents";

type CounterState = { value: number };
type CounterEnv = { Counter: DurableObjectNamespace<Counter> };
type SubAgentSnapshot = { name: string; value: number; parentValue: number };
type NestedSubAgentSnapshot = { childValue: number; leafValue: number };

/** A type-only parent handle; `parentAgent()` resolves it by class name. */
class Counter extends Agent<CounterEnv, CounterState> {
  declare currentValue: () => Promise<number>;
}

export class CounterChild extends Agent<CounterEnv, CounterState> {
  override initialState: CounterState = { value: 0 };

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
}

export class CounterLeaf extends Agent<CounterEnv, CounterState> {
  override initialState: CounterState = { value: 0 };

  async bump(): Promise<NestedSubAgentSnapshot> {
    const value = this.state.value + 1;
    this.setState({ value });
    const parent = await this.parentAgent(CounterChild);
    return { childValue: await parent.currentValue(), leafValue: value };
  }
}
