import type {
  HibernationHost,
  RawWebSocket,
  RehydratedWebSocket,
} from "../src/index";

type MirroredWebSocket = RehydratedWebSocket & { tags: readonly string[] };

/** In-memory socket state shared by the Node and browser reference embedders. */
export class HibernationMirror implements HibernationHost {
  readonly #entries = new Map<RawWebSocket, MirroredWebSocket>();
  autoResponsePair: { request: string; response: string } | null = null;

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

  autoResponse(pair: { request: string; response: string } | null): void {
    this.autoResponsePair = pair === null ? null : { ...pair };
  }

  closed(socket: RawWebSocket): void {
    this.#entries.delete(socket);
  }

  snapshot(): RehydratedWebSocket[] {
    return [...this.#entries.values()];
  }
}
