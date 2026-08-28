/**
 * The actor. One Durable Object class, and it is the only file in this example
 * that a product would actually write — everything else is the host wiring the
 * runtime needs, which is the part this example exists to show.
 *
 * It is deliberately ordinary Agents SDK code: it imports `Agent` from
 * `agents`, persists state with `setState()`, and uses the SDK's queue and
 * scheduler. Nothing in it knows it is running in a Chrome
 * extension, in a Web Worker, or over an OPFS file, and that is the property the
 * runtime sells. `vite.config.ts` aliases `cloudflare:workers` to the package's
 * own module; on Cloudflare the specifier resolves natively and this file does
 * not change.
 *
 */

import { McpServer } from "@modelcontextprotocol/server";
import { Agent, callable, type StreamingResponse } from "agents";
import type { AgentEmail } from "agents/email";
import { createMcpHandler } from "agents/mcp/server";

/** What `snapshot()` hands back. JSON-compatible: it crosses two RPC hops. */
export type CounterSnapshot = {
  readonly value: number;
  readonly events: readonly CounterEvent[];
};

export type CounterEvent = {
  /** `Date.now()` when the row was written. */
  readonly at: number;
  /** The public operation that produced this row. */
  readonly kind: string;
};

export type SubAgentSnapshot = {
  readonly name: string;
  readonly value: number;
  readonly parentValue: number;
};
export type NestedSubAgentSnapshot = { childValue: number; leafValue: number };

/** How many event rows `snapshot()` reports. The table keeps all of them. */
const RECENT_EVENTS = 10;

export type CounterEnv = { Counter: DurableObjectNamespace<Counter> };
type CounterState = { value: number };

export class Counter extends Agent<CounterEnv, CounterState> {
  override initialState: CounterState = { value: 0 };

  /**
   * Schema on every call rather than once in the constructor.
   *
   * `CREATE TABLE IF NOT EXISTS` is cheap, and the constructor is the one place
   * where getting it wrong is expensive: a class constructor runs under boot
   * semantics with the input gate held, and a throw there breaks the actor
   * before any caller exists to see it. Workers examples do the same thing for
   * the same reason.
   */
  #schema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, kind TEXT NOT NULL)",
    );
  }

  #record(kind: string): void {
    this.ctx.storage.sql.exec("INSERT INTO events (at, kind) VALUES (?, ?)", Date.now(), kind);
  }

  /**
   * One gated event: schema, bump, event row, read back. No `await` anywhere in
   * the body, so the whole thing is one synchronous slice inside the input gate
   * and the writes coalesce into the one implicit transaction that commits when
   * the event ends.
   *
   * The reply does not leave the actor until that transaction is durable — the
   * output gate — so a caller that reads `3` here can never afterwards see `2`.
   */
  @callable()
  async increment(): Promise<number> {
    this.#schema();
    const value = this.state.value + 1;
    this.setState({ value });
    this.#record("increment");
    return value;
  }

  @callable({ streaming: true })
  async streamValues(stream: StreamingResponse): Promise<void> {
    stream.send(this.state.value);
    stream.send(this.state.value + 1);
    stream.end("done");
  }

  override async onRequest(request: Request): Promise<Response> {
    const value = this.state.value;
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "Counter", version: "1.0.0" });
      server.registerTool(
        "counter-value",
        { description: "Read the current counter value" },
        async () => ({ content: [{ type: "text", text: String(value) }] }),
      );
      return server;
    });
    return await handler.fetch(request);
  }

  async onEmail(email: AgentEmail): Promise<void> {
    this.#schema();
    this.#record(`sdk-email:${email.headers.get("subject") ?? "(no subject)"}`);
  }

  async enqueueIncrement(amount: number): Promise<string> {
    if (!Number.isSafeInteger(amount)) throw new TypeError("amount must be a safe integer");
    return await this.queue("queuedIncrement", { amount });
  }

  async queuedIncrement({ amount }: { amount: number }): Promise<void> {
    this.#schema();
    this.setState({ value: this.state.value + amount });
    this.#record("sdk-queue");
  }

  async snapshot(): Promise<CounterSnapshot> {
    this.#schema();
    const events = this.ctx.storage.sql
      .exec("SELECT at, kind FROM events ORDER BY rowid DESC LIMIT ?", RECENT_EVENTS)
      .toArray() as unknown as CounterEvent[];
    return { value: this.state.value, events };
  }

  /**
   * The production-shaped facet proof: this is the Agents SDK's public
   * `subAgent()` API, not a direct `ctx.facets` probe. Both children are entered
   * together, keep their own Agent state, and call back through `parentAgent()`.
   */
  async subAgents(): Promise<SubAgentSnapshot[]> {
    const [alpha, beta] = await Promise.all([
      this.subAgent(CounterChild, "alpha"),
      this.subAgent(CounterChild, "beta"),
    ]);
    return await Promise.all([alpha.bump(), beta.bump()]);
  }

  async overlapSubAgents(): Promise<SubAgentSnapshot[]> {
    const [alpha, beta] = await Promise.all([
      this.subAgent(CounterChild, "alpha"),
      this.subAgent(CounterChild, "beta"),
    ]);
    return await Promise.all([alpha.bumpAfter(20), beta.bumpAfter(0)]);
  }

  async subAgentLifecycle(): Promise<number[]> {
    const first = await this.subAgent(CounterChild, "lifecycle");
    const firstValue = (await first.bump()).value;

    this.abortSubAgent(CounterChild, "lifecycle", new Error("restart lifecycle proof"));
    const restarted = await this.subAgent(CounterChild, "lifecycle");
    const restartedValue = (await restarted.bump()).value;

    await this.deleteSubAgent(CounterChild, "lifecycle");
    const recreated = await this.subAgent(CounterChild, "lifecycle");
    const recreatedValue = (await recreated.bump()).value;
    return [firstValue, restartedValue, recreatedValue];
  }

  async nestedSubAgent(): Promise<NestedSubAgentSnapshot> {
    const child = await this.subAgent(CounterChild, "nested");
    await child.bump();
    return await child.bumpLeaf();
  }

  async armSubAgentWake(delayMs: number): Promise<number> {
    return await (await this.subAgent(CounterChild, "scheduled")).armWake(delayMs);
  }

  async scheduledSubAgentValue(): Promise<number> {
    return await (await this.subAgent(CounterChild, "scheduled")).currentValue();
  }

  /** Reached through `CounterChild.parentAgent(Counter)`. */
  async currentValue(): Promise<number> {
    return this.state.value;
  }

  /**
   * Arm a wake `delayMs` from now, and answer the absolute time it was armed
   * for.
   *
   * `Agent.schedule()` records the callback in Agent SQLite and sets the one
   * physical Durable Object alarm. The storage engine then tells the host's
   * alarm outlet (`ports.alarms`) before the local commit lands. The retry
   * ladder, backoff and abandonment are the host `AlarmScheduler`'s.
   */
  async armWake(delayMs: number): Promise<number> {
    this.#schema();
    const at = Date.now() + Math.max(0, delayMs);
    await this.schedule(new Date(at), "scheduledIncrement");
    return at;
  }

  /**
   * The wake itself. Strictly serialised against every other event on this
   * actor, so it may read and write storage exactly as a method call does.
   *
   * A throw from here is not a lost alarm: it reaches the scheduler as a failed
   * delivery, which retries it on the persisted ladder — and, in this port,
   * across a service-worker eviction, because the ladder is rows rather than
   * process memory.
   */
  async scheduledIncrement(): Promise<void> {
    this.#schema();
    this.#record("sdk-schedule");
    this.setState({ value: this.state.value + 1 });
  }
}

/**
 * The root's typed class token. The facet host resolves this name to the
 * separately bundled MV3 module; this copy is never instantiated.
 */
export class CounterChild extends Agent<CounterEnv, CounterState> {
  declare bump: () => Promise<SubAgentSnapshot>;
  declare bumpAfter: (delayMs: number) => Promise<SubAgentSnapshot>;
  declare bumpLeaf: () => Promise<NestedSubAgentSnapshot>;
  declare armWake: (delayMs: number) => Promise<number>;
  declare currentValue: () => Promise<number>;
}
