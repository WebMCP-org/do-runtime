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
 * a mock — and the e2e script drives exactly that, because a Playwright page
 * handle cannot be obtained for an offscreen document.
 */

import { newMessagePortRpcSession } from "capnweb";
import type {
  CounterSnapshot,
  ExtensionMessage,
  ExtensionResponse,
  HostRpc,
  HostOp,
  HostStatus,
  WorkerBoot,
} from "../protocol";

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
worker.postMessage({ port: channel.port2 } satisfies WorkerBoot, [channel.port2]);

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
const host = newMessagePortRpcSession<HostRpc>(channel.port1);

/**
 * The operations, in one place, so the extension-message path and the
 * `window.__host` path cannot drift apart.
 *
 * Every value crossing this boundary is JSON-compatible on purpose: capnweb's
 * only binary type is `Uint8Array`, and `Map`, `Set`, `ArrayBuffer` and typed
 * views other than `Uint8Array` do not survive the hop.
 */
const ops = {
  increment: (): Promise<number> => host.increment() as unknown as Promise<number>,
  snapshot: (): Promise<CounterSnapshot> => host.snapshot() as unknown as Promise<CounterSnapshot>,
  armWake: (delayMs: number): Promise<number> =>
    host.armWake(delayMs) as unknown as Promise<number>,
  status: (): Promise<HostStatus> => host.status() as unknown as Promise<HostStatus>,
} satisfies Record<HostOp, (...args: never[]) => Promise<unknown>>;

async function runOp(op: HostOp, args: readonly unknown[]): Promise<unknown> {
  switch (op) {
    case "increment":
      return await ops.increment();
    case "snapshot":
      return await ops.snapshot();
    case "armWake":
      return await ops.armWake(Number(args[0] ?? 0));
    case "status":
      return await ops.status();
  }
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
