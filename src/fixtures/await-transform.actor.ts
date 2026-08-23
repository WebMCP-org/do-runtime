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
