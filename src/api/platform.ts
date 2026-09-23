/**
 * ← workerd `NO upstream correspondence`
 *
 * workerd's timers and outbound belong to the process. A browser host's
 * `Timer` and `fetch` ports have to reach the platform's own, because
 * `installActorScope` replaces the globals with gated ones built on those
 * ports; a port that read the installed global would arm a timeout to
 * implement a timeout. Beside `global-scope.ts` because that is what replaces
 * them, and not in `util/`, which corresponds to workerd's `util/`.
 */

import type { Timer } from "../io/io-context";
import type { FetchPort } from "./global-scope";

const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);

/**
 * Wall clock and delay on the platform's timers. An aborted delay, including one whose signal
 * was already aborted, never settles.
 */
export const platformTimer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return;
      const handle = rawSetTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, Math.max(0, ms));
      const cancel = (): void => rawClearTimeout(handle);
      signal?.addEventListener("abort", cancel, { once: true });
    }),
};

/** The platform's `fetch`. */
export const platformFetch: FetchPort = globalThis.fetch.bind(globalThis);
