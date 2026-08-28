/**
 * What the offscreen document and the actor worker say to each other, and what
 * the popup and the offscreen document say to each other.
 *
 * **This module imports nothing.** It is the one file both TypeScript projects
 * compile — `tsconfig.page.json` with DOM, `tsconfig.worker.json` with
 * WebWorker — so anything it imported would have to typecheck under both lib
 * sets at once. That is exactly the collision the two projects exist to avoid;
 * see this example's README.
 */

/** The `MessagePort` boot message, sent raw because capnweb cannot carry a port. */
export type WorkerBoot = {
  readonly port: MessagePort;
  readonly sockets: MessagePort;
};

/** The one Chrome watchdog mirroring the scheduler's earliest durable wake. */
export const WAKE_ALARM = "do-runtime-wake";

/** What the actor worker can ask its offscreen supervisor to project. */
export interface SupervisorRpc {
  projectWake(scheduledTime: number | null): Promise<void>;
}

/** The state shape the real Agents client receives over its socket. */
export type CounterState = { readonly value: number };

/** The recent-events rows `snapshot()` reports. Mirrors `worker/counter.ts`. */
export type CounterEvent = {
  readonly at: number;
  readonly kind: string;
};

export type CounterSnapshot = {
  readonly value: number;
  readonly events: readonly CounterEvent[];
};

export type SubAgentSnapshot = {
  readonly name: string;
  readonly value: number;
  readonly parentValue: number;
};

export type NestedSubAgentSnapshot = {
  readonly childValue: number;
  readonly leafValue: number;
};

/**
 * What the worker reports about the host itself, as opposed to about the actor.
 *
 * `broken` is `container.onBroken` having rejected. A host that does not consume
 * that promise gets an actor that answers nothing and logs nothing, so this
 * carries it somewhere a human can see it.
 */
export type HostStatus = {
  /** The actor id, which is also the key the alarm scheduler knows it by. */
  readonly actorId: string;
  /** True once the container has been placed at least once. */
  readonly placed: boolean;
  /** The `onBroken` rejection, stringified, or null while the container is healthy. */
  readonly broken: string | null;
  /** `AlarmScheduler.taskFailure()`, stringified, or null. A background failure belongs to no call. */
  readonly alarmTaskFailure: string | null;
  /** The alarm time the scheduler currently holds for this actor, or null. */
  readonly nextAlarm: number | null;
};

/**
 * The actor worker's RPC surface, reached over capnweb.
 *
 * capnweb dispatches by looking a method up on the target and refuses an OWN
 * property with "instance properties cannot be accessed over RPC", so the
 * implementation is a class with prototype methods — never arrow-function
 * fields. Every value here is JSON-compatible for the same transport reason:
 * the only binary type capnweb carries is `Uint8Array`, and no `Map`, `Set`, or
 * `ArrayBuffer` view survives the hop.
 */
export interface HostRpc {
  directStubIncrement(): Promise<number>;
  email(subject: string, body: string): Promise<void>;
  evict(): Promise<void>;
  increment(): Promise<number>;
  enqueueIncrement(amount: number): Promise<string>;
  mcp(method: string, params: Record<string, unknown>): Promise<unknown>;
  snapshot(): Promise<CounterSnapshot>;
  subAgents(): Promise<readonly SubAgentSnapshot[]>;
  overlapSubAgents(): Promise<readonly SubAgentSnapshot[]>;
  subAgentLifecycle(): Promise<readonly number[]>;
  nestedSubAgent(): Promise<NestedSubAgentSnapshot>;
  armSubAgentWake(delayMs: number): Promise<number>;
  scheduledSubAgentValue(): Promise<number>;
  armWake(delayMs: number): Promise<number>;
  status(): Promise<HostStatus>;
}

/** The operation names the popup, the page hook, and the e2e driver all use. */
export type HostOp =
  | keyof HostRpc
  | "sdkIncrement"
  | "sdkSetState"
  | "sdkState"
  | "sdkStream"
  | "storageStatus";

/**
 * `chrome.runtime.sendMessage` payloads.
 *
 * `ensure-host` is answered by the service worker; `host-op` is answered by the
 * offscreen document, which receives extension messages directly. They are one
 * union because both travel the same channel and every listener has to be able
 * to say "not mine" — a listener that returns `true` for a message it will never
 * answer holds `sendResponse` open until the channel closes.
 */
export type ExtensionMessage =
  | { readonly type: "ensure-host" }
  | { readonly type: "project-wake"; readonly scheduledTime: number | null }
  | { readonly type: "host-op"; readonly op: HostOp; readonly args: readonly unknown[] };

/** Every answer is a settled result rather than a throw: `sendResponse` cannot reject. */
export type ExtensionResponse<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
