/** A live client socket crosses real Worker.terminate(), using the public supervisor. */
import { expect, test } from "vitest";
import { RpcTarget } from "../../src/api/cloudflare-workers";
import { BrowserWorkerSupervisor } from "../../src/browser/worker-supervisor";
import type { MessagePortWebSocketWireMessage } from "../../src/browser/message-port-websocket";
import type { RoomConfiguration, RoomService } from "./hibernation-worker-restart.worker";

test("hibernated sockets survive actor-worker termination through transferred MessagePorts", async () => {
  const configuration = { poolName: `do-runtime-hibernation-restart-${crypto.randomUUID()}` };
  let generations = 0;
  using supervisor = new BrowserWorkerSupervisor<RoomConfiguration, RoomService>({
    key: ({ poolName }) => poolName,
    createWorker: () => {
      generations++;
      return new Worker(new URL("./hibernation-worker-restart.worker.ts", import.meta.url), {
        type: "module",
      });
    },
    hostExports: () => new RpcTarget(),
    removeStorage: async () => {},
    idleGraceMs: 30_000,
  });
  const reference = supervisor.reference(configuration);
  using first = await reference.resolve();
  const frames: MessagePortWebSocketWireMessage[] = [];
  const socket = supervisor.connect(configuration, {
    id: "transport-42",
    url: "wss://room.invalid/",
    peer: { send: (frame) => frames.push(frame), close() {} },
  });
  socket.receive({ type: "message", data: "ping" });
  await expect.poll(() => frames[0]).toEqual({ type: "message", data: "pong" });
  expect(await first.inspect()).toEqual({ messages: [], closes: [] });
  expect(await supervisor.hibernate(configuration)).toBe(true);
  expect(supervisor.size).toBe(0);

  // This frame itself wakes and rebinds the existing transport. No client reconnect.
  socket.receive({ type: "message", data: "hello" });
  using after = await reference.resolve();
  await expect.poll(() => frames[1]).toEqual({ type: "message", data: "echo:hello" });
  const restored = await after.inspect();
  expect(restored.messages).toEqual([
    {
      message: "hello",
      tags: ["room:lobby", "user:ada"],
      attachment: { user: "ada", since: new Date(0).toISOString(), roles: ["admin"] },
      autoResponseTimestamp: expect.any(Number),
      stored: "ada",
    },
  ]);
  expect(generations).toBe(2);
  socket.receive({ type: "message", data: "ping" });
  await expect.poll(() => frames[2]).toEqual({ type: "message", data: "pong" });
  socket.close(4000, "bye");
  await expect
    .poll(async () => (await after.inspect()).closes)
    .toEqual([{ code: 4000, reason: "bye", wasClean: true }]);
  expect((await after.inspect()).messages).toHaveLength(1);
}, 30_000);
