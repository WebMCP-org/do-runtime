/**
 * The conformance harness the suite writes against.
 *
 * The workerd lane is the ORACLE, not a third implementation — this package is
 * deliberately absent from it. So a test has exactly one meaning: "workerd does
 * X" and "our runtime does X" are the same assertion, executed twice.
 *
 * Probe classes are dependency-free (see fixtures/probe.ts), which is why the
 * workerd lane needs no vendored-source aliases and CI's filtered vendor
 * install never bites. Anything that would need vendored `think` or `agents`
 * to express is agent-logic testing and belongs in the extension's integration
 * lanes instead.
 */

export type Capability =
  /** Deterministic clock. Node lane only — a 30s ladder is not assertable on wall time. */
  | "fake-time"
  /** Kill without cleanup: worker.terminate() or dropping the container. */
  | "real-crash"
  /** Substrate boundary: sqlite-wasm lacks the storage capability. */
  | "bookmarks";

export type LaneName = "workerd" | "node" | "browser";

export interface ProbeActor {
  /** Durable identity. `respawn` reopens this same actor. */
  readonly name: string;
  call<T = unknown>(method: string, ...args: readonly unknown[]): Promise<T>;
  /** Launch without awaiting — the gate rows need two overlapping entries. */
  post(method: string, ...args: readonly unknown[]): { settled: Promise<unknown> };
}

export type LaneSocketMessage = string | ArrayBuffer;

export interface LaneClientSocket {
  readonly readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  nextMessage(): Promise<LaneSocketMessage>;
  nextClose(): Promise<{ code: number; reason: string; wasClean: boolean }>;
}

export interface ConformanceHost {
  readonly lane: LaneName;
  readonly capabilities: ReadonlySet<Capability>;
  spawn(name?: string): Promise<ProbeActor>;
  /** Same identity, fresh instance. Durable state must survive. */
  respawn(actor: ProbeActor): Promise<ProbeActor>;
  /** Open a WebSocket through the actor's fetch handler. */
  connect(actor: ProbeActor, tags?: readonly string[]): Promise<LaneClientSocket>;
  /** Rebuild the actor while preserving its hibernatable sockets. */
  evict(actor: ProbeActor): Promise<void>;
  /** Only where "real-crash". */
  crash?(actor: ProbeActor): Promise<void>;
  /** Only where "fake-time". */
  time?: { advance(ms: number): Promise<void> };
}

/**
 * Substrate boundaries are ASSERTED, never skipped.
 *
 * Where the capability exists, run `native`. Where it does not, run `absent` —
 * which asserts the exact named throwing-stub message. Under the fail-closed
 * tenet the throw IS the specified behaviour for that lane, and asserting it is
 * what stops the stubs regressing to the silent `[]` no-ops the design record
 * orders replaced.
 */
export async function substrate(
  host: ConformanceHost,
  capability: Capability,
  branches: { native: () => Promise<void>; absent: () => Promise<void> },
): Promise<void> {
  if (host.capabilities.has(capability)) await branches.native();
  else await branches.absent();
}
