export type OffscreenDocumentAdapter = {
  exists(): Promise<boolean>;
  create(): Promise<void>;
  close(): Promise<void>;
  isOccupiedError(error: unknown): boolean;
  /**
   * Resolves once the document answers, for a document just created and one
   * that already existed. A document can load before its listeners register.
   * It must settle, rejecting on its own timeout: every `ensure()` caller
   * shares the flight it runs in.
   */
  ready?(): Promise<void>;
  /**
   * Decides whether a document that failed `ready()` is closed and recreated.
   * The replacement gets one more `ready()`; declining rethrows the failure.
   */
  replaceUnready?(error: unknown): boolean | Promise<boolean>;
};

/**
 * Keeps one browser offscreen document alive across concurrent callers and a
 * stale, unlisted document slot. Concurrent callers share one creation and one
 * readiness probe; when to give up on a mute document stays with the host.
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
    if (!(await this.adapter.exists())) await this.#create();
    if (this.adapter.ready === undefined) return;
    try {
      await this.adapter.ready();
    } catch (error) {
      if (!(await this.adapter.replaceUnready?.(error))) throw error;
      await this.adapter.close();
      await this.#create();
      await this.adapter.ready();
    }
  }

  async #create(): Promise<void> {
    try {
      await this.adapter.create();
    } catch (error) {
      if (!this.adapter.isOccupiedError(error)) throw error;
      await this.adapter.close();
      await this.adapter.create();
    }
  }
}
