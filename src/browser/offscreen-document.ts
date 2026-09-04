export type OffscreenDocumentAdapter = {
  exists(): Promise<boolean>;
  create(): Promise<void>;
  close(): Promise<void>;
  isOccupiedError(error: unknown): boolean;
};

/**
 * Keeps one browser offscreen document alive across concurrent callers and a
 * stale, unlisted document slot. Readiness and application policy stay with
 * the embedding host.
 */
export class OffscreenDocumentCoordinator {
  #ensuring: Promise<void> | undefined;

  constructor(private readonly adapter: OffscreenDocumentAdapter) {}

  ensure(): Promise<void> {
    this.#ensuring ??= this.#ensureOnce().finally(() => {
      this.#ensuring = undefined;
    });
    return this.#ensuring;
  }

  async #ensureOnce(): Promise<void> {
    if (await this.adapter.exists()) return;
    try {
      await this.adapter.create();
    } catch (error) {
      if (!this.adapter.isOccupiedError(error)) throw error;
      await this.adapter.close();
      await this.adapter.create();
    }
  }
}
