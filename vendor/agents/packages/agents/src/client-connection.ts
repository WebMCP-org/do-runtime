import type { PartySocket, PartySocketOptions } from "partysocket";

/** Destination identity excludes credentials, which may refresh on reconnect. */
export function socketDestinationKey(options: PartySocketOptions): string {
  return JSON.stringify([
    options.host ?? null,
    options.basePath ?? null,
    options.party ?? null,
    options.prefix ?? null,
    options.room ?? null,
    options.path ?? null,
    options.protocol ?? null,
    options.protocols ?? null
  ]);
}

type ReadyEntry = {
  promise: Promise<void>;
  resolve(): void;
  resolved: boolean;
};
type Identity = { name: string; agent: string };

/** Readiness survives failed connects and settles only after stored state lands. */
export class ClientReadiness {
  #destinations = new Map<string, ReadyEntry>();
  #sockets = new WeakMap<
    PartySocket,
    { stateSeen: boolean; pending: Identity | null }
  >();

  at(destination: string): ReadyEntry {
    let entry = this.#destinations.get(destination);
    if (!entry) {
      let resolveReady!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      entry = {
        promise,
        resolved: false,
        resolve() {
          this.resolved = true;
          resolveReady();
        }
      };
      this.#destinations.set(destination, entry);
    }
    return entry;
  }

  reset(destination: string, socket?: PartySocket): void {
    if (socket) this.#sockets.delete(socket);
    if (this.#destinations.get(destination)?.resolved)
      this.#destinations.delete(destination);
  }

  retainPending(current: string): void {
    for (const [key, entry] of this.#destinations) {
      if (key !== current && entry.resolved) this.#destinations.delete(key);
    }
  }

  identity(
    socket: PartySocket,
    identity: Identity,
    stateFollows: boolean,
    apply: (identity: Identity) => void
  ): void {
    const progress = this.#progress(socket);
    if (stateFollows && !progress.stateSeen) progress.pending = identity;
    else apply(identity);
  }

  state(socket: PartySocket, apply: (identity: Identity) => void): void {
    const progress = this.#progress(socket);
    progress.stateSeen = true;
    const pending = progress.pending;
    progress.pending = null;
    if (pending) apply(pending);
  }

  #progress(socket: PartySocket) {
    let progress = this.#sockets.get(socket);
    if (!progress) {
      progress = { stateSeen: false, pending: null };
      this.#sockets.set(socket, progress);
    }
    return progress;
  }
}

/** Ignore non-object frames; custom application messages remain the host's domain. */
export function parseClientFrame(
  data: unknown
): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const frame: unknown = JSON.parse(data);
    if (frame === null || typeof frame !== "object" || Array.isArray(frame))
      return null;
    return frame as Record<string, unknown>;
  } catch {
    return null;
  }
}
