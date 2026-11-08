function portHop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

export async function readAfterForeignAwait(storage: DurableObjectStorage): Promise<unknown> {
  await portHop();
  await portHop();
  return await storage.get("key");
}

/** Detached reactions on promises the runtime does not own; each chain is handed to `settled`. */
export function writeFromDetachedReactions(
  storage: DurableObjectStorage,
  settled: (chain: Promise<unknown>) => void,
): void {
  settled(
    storage.put("held", 1).then(async () => {
      await portHop();
      await storage.put("afterAwait", 2);
    }),
  );
  settled(portHop().then(() => portHop()).then(() => storage.put("afterForeign", 3)));
  settled(Promise.reject(new Error("rejected")).catch(() => portHop()).finally(() => storage.put("afterFinally", 4)));
}
