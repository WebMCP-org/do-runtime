import type {
  HibernationHost,
  RawWebSocket,
  RehydratedWebSocket,
} from "../api/web-socket";

export type HibernationAutoResponse = { request: string; response: string };

type MirroredWebSocket = RehydratedWebSocket & { tags: readonly string[] };

/** In-memory socket state shared by embedders that replace live actor containers. */
export class HibernationMirror implements HibernationHost {
  readonly #entries = new Map<RawWebSocket, MirroredWebSocket>();
  #autoResponsePair: HibernationAutoResponse | null;

  constructor(
    rehydrated: readonly RehydratedWebSocket[] = [],
    autoResponsePair: HibernationAutoResponse | null = null,
  ) {
    for (const value of rehydrated) this.#entries.set(value.socket, cloneEntry(value));
    this.#autoResponsePair = cloneAutoResponse(autoResponsePair);
  }

  get autoResponsePair(): HibernationAutoResponse | null {
    return cloneAutoResponse(this.#autoResponsePair);
  }

  accepted(socket: RawWebSocket, tags: readonly string[]): void {
    this.#entries.set(socket, { socket, tags: [...tags] });
  }

  attachment(socket: RawWebSocket, bytes: Uint8Array | null): void {
    const entry = this.#entries.get(socket);
    if (entry === undefined) {
      throw new Error("Hibernation mirror: attachment preceded socket acceptance.");
    }
    if (bytes === null) delete entry.attachment;
    else entry.attachment = bytes.slice();
  }

  autoResponse(pair: HibernationAutoResponse | null): void {
    this.#autoResponsePair = cloneAutoResponse(pair);
  }

  closed(socket: RawWebSocket): void {
    this.#entries.delete(socket);
  }

  snapshot(): RehydratedWebSocket[] {
    return [...this.#entries.values()].map(cloneEntry);
  }
}

function cloneEntry(value: RehydratedWebSocket): MirroredWebSocket {
  const entry: MirroredWebSocket = {
    socket: value.socket,
    tags: [...(value.tags ?? [])],
  };
  if (value.attachment !== undefined) entry.attachment = value.attachment.slice();
  if (value.autoResponseTimestamp !== undefined) {
    entry.autoResponseTimestamp = value.autoResponseTimestamp;
  }
  return entry;
}

function cloneAutoResponse(pair: HibernationAutoResponse | null): HibernationAutoResponse | null {
  return pair === null ? null : { ...pair };
}
