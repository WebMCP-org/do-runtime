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
 * **Every method is `async` on purpose.** `container.entry(instance)` returns a
 * proxy whose every method invocation is one gated event, so a synchronous
 * method still answers a promise at runtime — while `entry<T>(target: T): T`
 * types it as unchanged. Declaring the methods async makes the declared type and
 * the runtime type the same thing, instead of needing a cast at the call site.
 */

import { Agent, callable, type StreamingResponse } from "agents";

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

/** How many event rows `snapshot()` reports. The table keeps all of them. */
const RECENT_EVENTS = 10;

export type CounterEnv = Record<string, never>;
type CounterState = { value: number };

export class Counter extends Agent<CounterEnv, CounterState> {
  static override options = { hibernate: false };
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
