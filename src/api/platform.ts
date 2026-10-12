/**
 * ← workerd `NO upstream correspondence`
 *
 * workerd's timers and outbound belong to the process. A browser host's
 * `Timer` and `fetch` ports have to reach the platform's own, because
 * `installActorScope` replaces the globals with gated ones built on those
 * ports; a port that read the installed global would arm a timeout to
 * implement a timeout. The same replacement makes `WebSocket` refuse
 * construction, so a host that opens its own transport, to hand an actor
 * through `acceptWebSocket`, needs the platform's constructor too. Beside
 * `global-scope.ts` because that is what replaces them, and not in `util/`,
 * which corresponds to workerd's `util/`.
 *
 * `global-scope.ts` wraps the platform's `crypto` and stream constructors from
 * here for the same reason.
 *
 * The captures are realm-shared, and the first copy of this module to load
 * makes them. A facet bundle carries its own copy of the runtime and is
 * evaluated after its root's scope replaced the globals, so a capture of its
 * own would be the gated timer, the gated `fetch` and the refusing `WebSocket`.
 * The host imports the runtime before it can call `installActorScope`, so its
 * copy always loads first, and every later copy reads the platform's.
 */

import type { Timer } from "../io/io-context";
import type { FetchPort } from "./global-scope";

const KEY = Symbol.for("@mcp-b/do-runtime/platform");
type Platform = ReturnType<typeof capture>;
const globals = globalThis as typeof globalThis & { [KEY]?: Platform };

function capture() {
  return Object.freeze({
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    fetch: globalThis.fetch.bind(globalThis) as FetchPort,
    WebSocket: globalThis.WebSocket,
    crypto: globalThis.crypto,
    ReadableStream: globalThis.ReadableStream,
    TransformStream: globalThis.TransformStream,
  });
}

/** The platform's own globals, as the first copy of this module in the realm captured them. */
export const platform: Platform = (globals[KEY] ??= capture());

/**
 * Wall clock and delay on the platform's timers. An aborted delay, including one whose signal
 * was already aborted, never settles.
 */
export const platformTimer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return;
      const handle = platform.setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, Math.max(0, ms));
      const cancel = (): void => platform.clearTimeout(handle);
      signal?.addEventListener("abort", cancel, { once: true });
    }),
};

/** The platform's `fetch`. */
export const platformFetch: FetchPort = platform.fetch;

/**
 * The platform's `WebSocket` constructor, for a host-owned transport. The installed actor scope's
 * `WebSocket` refuses construction because a native handshake cannot wait for the output gate; a
 * host that opens a socket with this one and hands it to `acceptWebSocket` owns that ordering.
 */
export const platformWebSocket: typeof WebSocket = platform.WebSocket;
