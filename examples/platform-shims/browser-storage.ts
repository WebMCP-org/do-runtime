/** Request durable origin storage and return a human-readable status line. */
export async function browserStorageSummary(): Promise<string> {
  try {
    const alreadyPersistent = await navigator.storage.persisted();
    const persistent = alreadyPersistent || (await navigator.storage.persist());
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return `storage: ${persistent ? "persistent" : "best-effort"}, ${Math.round(usage)} B used of ${Math.round(quota)} B`;
  } catch (error) {
    return `storage: unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Hold one origin-scoped host lease without queueing behind an existing owner. */
export async function holdExclusiveBrowserHost(name: string): Promise<(() => void) | null> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return await new Promise<(() => void) | null>((resolve, reject) => {
    void navigator.locks
      .request(name, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
        if (lock === null) {
          resolve(null);
          return;
        }
        resolve(release);
        await released;
      })
      .catch(reject);
  });
}
