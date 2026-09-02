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
import {
  RELAY_CLIENT_READY,
  type CounterState,
  type CounterSnapshot,
  type ExtensionMessage,
  type ExtensionResponse,
  type HostRpc,
  type HostOp,
  type HostStatus,
  type NestedSubAgentSnapshot,
  type RelayRoundTrip,
  type SubAgentSnapshot,
  type SupervisorRpc,
  type ThinkProbeStatus,
  type ThinkProbeSubmission,
  type WorkerBoot,
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

type CloseableSocket = EventTarget & {
  readonly CLOSING: number;
  readonly OPEN: number;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
};

function waitForOpen(socket: CloseableSocket): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const opened = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("close", failed);
      socket.removeEventListener("error", failed);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("close", failed, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

async function beforeTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = AbortSignal.timeout(15_000);
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout.addEventListener("abort", () => reject(new Error(`${label} timed out`)), {
        once: true,
      });
    }),
  ]);
}

function relayAddress(origin: string): {
  readonly host: string;
  readonly hostSocket: string;
  readonly protocol: "ws" | "wss";
} {
  const url = new URL(origin);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("relay origin must be a bare HTTP(S) origin");
  }
  const protocol = url.protocol === "https:" ? "wss" : "ws";
  url.protocol = `${protocol}:`;
  url.pathname = "/host";
  return { host: url.host, hostSocket: url.href, protocol };
}

function isRelayFrame(value: unknown): value is string | ArrayBuffer {
  return typeof value === "string" || value instanceof ArrayBuffer;
}

/** A real network AgentClient reaches the local Agent through a native relay DO. */
async function runRelayRoundTrip(origin: string): Promise<RelayRoundTrip> {
  const address = relayAddress(origin);
  const relayHost = new WebSocket(address.hostSocket);
  relayHost.binaryType = "arraybuffer";

  let local: InstanceType<typeof AgentWebSocket> | undefined;
  let resolveLocal!: () => void;
  let rejectLocal!: (error: Error) => void;
  const localReady = new Promise<void>((resolve, reject) => {
    resolveLocal = resolve;
    rejectLocal = reject;
  });

  relayHost.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (local === undefined) {
      if (event.data !== RELAY_CLIENT_READY) {
        rejectLocal(new Error("relay sent a frame before pairing its client"));
        return;
      }
      local = new AgentWebSocket("ws://actor.invalid/agents/counter/counter");
      local.binaryType = "arraybuffer";
      local.addEventListener("message", (localEvent) => {
        if (relayHost.readyState === relayHost.OPEN) relayHost.send(localEvent.data);
      });
      local.addEventListener("close", (close) => {
        if (relayHost.readyState < relayHost.CLOSING) {
          relayHost.close(close.code, close.reason);
        }
      });
      void waitForOpen(local).then(resolveLocal, rejectLocal);
      return;
    }
    if (!isRelayFrame(event.data)) {
      local.close(1003, "unsupported relay frame");
      return;
    }
    if (local.readyState === local.OPEN) local.send(event.data);
  });
  relayHost.addEventListener("close", () => {
    if (local !== undefined && local.readyState < local.CLOSING) {
      local.close(1000, "relay closed");
    }
  });
  relayHost.addEventListener("error", () => rejectLocal(new Error("relay host socket failed")));

  let client: AgentClient<unknown, CounterState> | undefined;
  try {
    await beforeTimeout(waitForOpen(relayHost), "relay host connection");

    let resolveInitial!: (state: CounterState) => void;
    let resolveSynchronized!: (state: CounterState) => void;
    const initialState = new Promise<CounterState>((resolve) => {
      resolveInitial = resolve;
    });
    const synchronizedState = new Promise<CounterState>((resolve) => {
      resolveSynchronized = resolve;
    });
    let receivedInitial = false;
    client = new AgentClient<unknown, CounterState>({
      agent: "Counter",
      name: "counter",
      host: address.host,
      protocol: address.protocol,
      WebSocket,
      defaultCallTimeout: 10_000,
      onStateUpdate: (state) => {
        if (!receivedInitial) {
          receivedInitial = true;
          resolveInitial(state);
        } else {
          resolveSynchronized(state);
        }
      },
    });

    const [initial] = await beforeTimeout(
      Promise.all([initialState, client.ready, localReady]),
      "relayed Agent handshake",
    );
    const incrementedValue = await client.call<number>("increment");
    const synchronized = await beforeTimeout(synchronizedState, "relayed state update");
    const streamChunks: unknown[] = [];
    const streamFinal = await client.call("streamValues", [], {
      stream: { onChunk: (chunk) => streamChunks.push(chunk) },
    });
    return {
      initialValue: initial.value,
      incrementedValue,
      synchronizedValue: synchronized.value,
      streamChunks,
      streamFinal,
    };
  } finally {
    client?.close(1000, "relay proof complete");
    if (local !== undefined && local.readyState < local.CLOSING) {
      local.close(1000, "relay proof complete");
    }
    if (relayHost.readyState < relayHost.CLOSING) {
      relayHost.close(1000, "relay proof complete");
    }
  }
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
  sdkSetLegacyState: async (value: number): Promise<void> => {
    if (!Number.isSafeInteger(value)) throw new TypeError("value must be a safe integer");
    const client = await connectedAgent();
    client.setState({ value });
  },
  sdkSetState: async (value: number): Promise<CounterState> => {
    if (!Number.isSafeInteger(value)) throw new TypeError("value must be a safe integer");
    const client = await connectedAgent();
    if (client.state === undefined) throw new Error("Agents client connected without state");
    const state = { ...client.state, value };
    client.setState(state);
    return state;
  },
  sdkState: async (): Promise<CounterState> => {
    const client = await connectedAgent();
    if (client.state === undefined) throw new Error("Agents client connected without state");
    return client.state;
  },
  relayRoundTrip: async (origin: string): Promise<RelayRoundTrip> =>
    await runRelayRoundTrip(origin),
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
    case "sdkSetLegacyState":
      return await ops.sdkSetLegacyState(Number(args[0]));
    case "sdkSetState":
      return await ops.sdkSetState(Number(args[0]));
    case "sdkState":
      return await ops.sdkState();
    case "relayRoundTrip":
      return await ops.relayRoundTrip(String(args[0]));
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
