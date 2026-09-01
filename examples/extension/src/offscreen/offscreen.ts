/**
 * The offscreen document: this extension's supervisor.
 *
 * It spawns the actor worker, holds the one RPC session to it, and forwards
 * extension messages onto that session. It owns no storage — it cannot, because
 * OPFS sync access handles exist only in a dedicated worker — which is exactly
 * the division the runtime's browser topology describes, with this document
 * playing the page.
 *
 * **Why an offscreen document at all.** An MV3 service worker cannot hold a
 * dedicated Worker across its own eviction and has no DOM to spawn one from. The
 * offscreen API exists for precisely this: a hidden document with the
 * `WORKERS` reason, created by the service worker and living independently of
 * it.
 *
 * **This page doubles as a debuggable tab page.** Open
 * `chrome-extension://<id>/offscreen.html` in a normal tab and it boots the same
 * worker and exposes the same operations on `window.__host`. Nothing here is
 * conditional on being offscreen, so the tab is a real reproduction rather than
 * a mock. The e2e drives the real offscreen host through extension messages and
 * opens this tab only to prove the Web Lock refuses a duplicate supervisor.
 */

import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { AgentClient } from "agents/client";
import {
  browserStorageSummary,
  holdExclusiveBrowserHost,
} from "../../../platform-shims/browser-storage";
import { createMessagePortWebSocketConstructor } from "@mcp-b/do-runtime/browser/message-port-websocket";
import type {
  CounterState,
  CounterSnapshot,
  ExtensionMessage,
  ExtensionResponse,
  HostRpc,
  HostOp,
  HostStatus,
  NestedSubAgentSnapshot,
  SubAgentSnapshot,
  SupervisorRpc,
  ThinkProbeStatus,
  ThinkProbeSubmission,
  WorkerBoot,
} from "../protocol";

const storageStatus = browserStorageSummary();
const releaseHost = await holdExclusiveBrowserHost("do-runtime:extension");
if (releaseHost === null) {
  document.body.textContent = "another extension page owns this Durable Object host";
  await new Promise<never>(() => {});
}
if (releaseHost !== null) window.addEventListener("pagehide", releaseHost, { once: true });

/**
 * `{ type: "module" }` and a `new URL(..., import.meta.url)` specifier, which is
 * the form the bundler understands and the form MV3's `worker-src 'self'`
 * permits. A blob worker would be blocked by that CSP.
 */
const worker = new Worker(new URL("../worker/actor.worker.ts", import.meta.url), {
  type: "module",
});

/**
 * **Attach these before the boot message.** A dedicated worker's own
 * `console.error` is not reliably visible anywhere a human is looking, and an
 * uncaught exception inside one goes nowhere at all: the failure it eventually
 * causes is an RPC call that never answers, several layers away from the cause.
 * These two listeners are the whole of this host's fail-loudly wiring.
 */
worker.addEventListener("error", (event: ErrorEvent) => {
  console.error("[do-runtime example] actor worker failed:", event.message, event.error ?? event);
});
worker.addEventListener("messageerror", () => {
  console.error("[do-runtime example] actor worker could not deserialise a message");
});

/**
 * One raw `postMessage` carrying a `MessagePort` in the transfer list, and then
 * capnweb over that port for everything else.
 *
 * The raw hop is not a warm-up: a `MessagePort` is not a value capnweb can
 * serialise, so the port has to arrive by structured clone before any session
 * can exist to carry it.
 */
const channel = new MessageChannel();
const sockets = new MessageChannel();
worker.postMessage(
  { port: channel.port2, sockets: sockets.port2 } satisfies WorkerBoot,
  [channel.port2, sockets.port2],
);

/**
 * The page side uses capnweb directly because it sends no Workers `RpcTarget`.
 * The actor worker uses the runtime's `newRpcSession`, which applies the
 * identity graft before it exposes its Workers targets.
 *
 * No local main is passed because nothing calls back: this example's alarm
 * scheduler lives in the actor's own worker, so the worker never needs to reach
 * the supervisor. A host with more than one actor would pass a target here, the
 * way the runtime's conformance page does.
 */
class SupervisorTarget extends RpcTarget implements SupervisorRpc {
  async projectWake(scheduledTime: number | null): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: "project-wake",
      scheduledTime,
    } satisfies ExtensionMessage)) as ExtensionResponse;
    if (!response.ok) throw new Error(response.error);
  }
}

const host = newMessagePortRpcSession<HostRpc>(channel.port1, new SupervisorTarget());
const AgentWebSocket = createMessagePortWebSocketConstructor(sockets.port1);
let agent: AgentClient<unknown, CounterState> | undefined;
let firstState: Promise<void> | undefined;

async function connectedAgent(): Promise<AgentClient<unknown, CounterState>> {
  if (agent === undefined) {
    let stateReceived!: () => void;
    firstState = new Promise<void>((resolve) => {
      stateReceived = resolve;
    });
    agent = new AgentClient<unknown, CounterState>({
      agent: "Counter",
      name: "counter",
      host: "actor.invalid",
      protocol: "ws",
      WebSocket: AgentWebSocket,
      onStateUpdate: () => stateReceived(),
    });
  }
  await firstState;
  return agent;
}

/**
 * The operations, in one place, so the extension-message path and the
 * `window.__host` path cannot drift apart.
 *
 * Every value crossing this boundary is JSON-compatible on purpose: capnweb's
 * only binary type is `Uint8Array`, and `Map`, `Set`, `ArrayBuffer` and typed
 * views other than `Uint8Array` do not survive the hop.
 */
const ops = {
  directStubIncrement: async (): Promise<number> => await host.directStubIncrement(),
  email: async (subject: string, body: string): Promise<void> => await host.email(subject, body),
  evict: async (): Promise<void> => await host.evict(),
  increment: async (): Promise<number> => await host.increment(),
  enqueueIncrement: async (amount: number): Promise<string> => await host.enqueueIncrement(amount),
  mcp: async (method: string, params: Record<string, unknown>): Promise<unknown> =>
    await host.mcp(method, params),
  snapshot: async (): Promise<CounterSnapshot> => await host.snapshot(),
  subAgents: async (): Promise<readonly SubAgentSnapshot[]> => await host.subAgents(),
  overlapSubAgents: async (): Promise<readonly SubAgentSnapshot[]> => await host.overlapSubAgents(),
  subAgentLifecycle: async (): Promise<readonly number[]> => await host.subAgentLifecycle(),
  nestedSubAgent: async (): Promise<NestedSubAgentSnapshot> => await host.nestedSubAgent(),
  armSubAgentWake: async (delayMs: number): Promise<number> => await host.armSubAgentWake(delayMs),
  scheduledSubAgentValue: async (): Promise<number> => await host.scheduledSubAgentValue(),
  startThink: async (name: string, text: string): Promise<void> =>
    await host.startThink(name, text),
  submitThink: async (
    name: string,
    text: string,
    idempotencyKey: string,
  ): Promise<ThinkProbeSubmission> => await host.submitThink(name, text, idempotencyKey),
  thinkStatus: async (name: string): Promise<ThinkProbeStatus> => await host.thinkStatus(name),
  stopThink: async (name: string): Promise<void> => await host.stopThink(name),
  armWake: async (delayMs: number): Promise<number> => await host.armWake(delayMs),
  status: async (): Promise<HostStatus> => await host.status(),
  sdkIncrement: async (): Promise<number> => await (await connectedAgent()).call("increment"),
  sdkSetState: async (value: number): Promise<CounterState> => {
    if (!Number.isSafeInteger(value)) throw new TypeError("value must be a safe integer");
    const client = await connectedAgent();
    const state = { value };
    client.setState(state);
    return state;
  },
  sdkState: async (): Promise<CounterState> => {
    const client = await connectedAgent();
    if (client.state === undefined) throw new Error("Agents client connected without state");
    return client.state;
  },
  storageStatus: async (): Promise<string> => await storageStatus,
  sdkStream: async (): Promise<{ chunks: unknown[]; final: unknown }> => {
    const chunks: unknown[] = [];
    const final = await (await connectedAgent()).call("streamValues", [], {
      stream: { onChunk: (chunk) => chunks.push(chunk) },
    });
    return { chunks, final };
  },
} satisfies Record<HostOp, (...args: never[]) => Promise<unknown>>;

async function runOp(op: HostOp, args: readonly unknown[]): Promise<unknown> {
  switch (op) {
    case "directStubIncrement":
      return await ops.directStubIncrement();
    case "email":
      return await ops.email(String(args[0]), String(args[1]));
    case "evict":
      return await ops.evict();
    case "increment":
      return await ops.increment();
    case "enqueueIncrement":
      return await ops.enqueueIncrement(Number(args[0]));
    case "mcp": {
      const params = args[1];
      if (!isRecord(params)) {
        throw new TypeError("MCP params must be an object");
      }
      return await ops.mcp(String(args[0]), params);
    }
    case "snapshot":
      return await ops.snapshot();
    case "subAgents":
      return await ops.subAgents();
    case "overlapSubAgents":
      return await ops.overlapSubAgents();
    case "subAgentLifecycle":
      return await ops.subAgentLifecycle();
    case "nestedSubAgent":
      return await ops.nestedSubAgent();
    case "armSubAgentWake":
      return await ops.armSubAgentWake(Number(args[0] ?? 0));
    case "scheduledSubAgentValue":
      return await ops.scheduledSubAgentValue();
    case "startThink":
      return await ops.startThink(String(args[0]), String(args[1]));
    case "submitThink":
      return await ops.submitThink(String(args[0]), String(args[1]), String(args[2]));
    case "thinkStatus":
      return await ops.thinkStatus(String(args[0]));
    case "stopThink":
      return await ops.stopThink(String(args[0]));
    case "armWake":
      return await ops.armWake(Number(args[0] ?? 0));
    case "status":
      return await ops.status();
    case "sdkIncrement":
      return await ops.sdkIncrement();
    case "sdkSetState":
      return await ops.sdkSetState(Number(args[0]));
    case "sdkState":
      return await ops.sdkState();
    case "storageStatus":
      return await ops.storageStatus();
    case "sdkStream":
      return await ops.sdkStream();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The same operations on the page, so this document can be driven when it is
 * opened as an ordinary tab.
 *
 * Unconditional: an offscreen document and a tab at the same URL are the same
 * page, and making the hook depend on which one it is would leave the tab
 * running different code from the thing being debugged.
 */
declare global {
  interface Window {
    __host?: typeof ops;
  }
}
window.__host = ops;

/**
 * Extension messages. The popup sends these; the offscreen document receives
 * them directly, because `chrome.runtime.sendMessage` reaches every extension
 * context and not only the service worker.
 *
 * `return true` keeps `sendResponse` alive across the await, and it is returned
 * ONLY for a message this listener will actually answer — a listener that claims
 * every message holds the channel open for messages meant for someone else.
 */
if (typeof chrome !== "undefined" && chrome.runtime?.id !== undefined) {
  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ExtensionResponse) => void,
    ): boolean => {
      if (message?.type !== "host-op") return false;
      void runOp(message.op, message.args).then(
        (value) => {
          sendResponse({ ok: true, value });
        },
        (error: unknown) => {
          sendResponse({ ok: false, error: String(error) });
        },
      );
      return true;
    },
  );
}
