/**
 * A hibernatable socket across a real actor-worker termination.
 *
 * The suite's eviction rows rebuild the container inside a worker that stays
 * alive, so the socket object survives with it. A Chrome-extension host
 * discards the worker instead: the port the worker held dies with it, the host
 * keeps the client's side of the socket and the mirrored state, and hands a
 * fresh port for the same socket to the replacement. This spec is that cycle
 * over one OPFS pool, with the page as the host.
 */

import { expect, test } from "vitest";
import type { MessagePortWebSocketWireMessage } from "../../src/browser/message-port-websocket";
import type { SocketBoot, SocketReport } from "./hibernation-worker-restart.worker";

type Kind = SocketReport["kind"];

/** Every worker the test started, terminated however it ends. */
const workers: Worker[] = [];

function start(boot: SocketBoot): { worker: Worker; reports: SocketReport[] } {
  const worker = new Worker(new URL("./hibernation-worker-restart.worker.ts", import.meta.url), {
    type: "module",
  });
  workers.push(worker);
  const reports: SocketReport[] = [];
  worker.addEventListener("message", (event: MessageEvent<SocketReport>) => reports.push(event.data));
  worker.addEventListener("error", (event) => reports.push({ kind: "error", error: event.message }));
  worker.postMessage(boot, [boot.port]);
  return { worker, reports };
}

/** The client's side of one worker generation's port: what it sends, and what reaches it. */
function client(port: MessagePort): {
  send: (frame: MessagePortWebSocketWireMessage) => void;
  frames: MessagePortWebSocketWireMessage[];
} {
  const frames: MessagePortWebSocketWireMessage[] = [];
  port.onmessage = (event: MessageEvent<MessagePortWebSocketWireMessage>) => frames.push(event.data);
  return { send: (frame) => port.postMessage(frame), frames };
}

/**
 * Polls until `read` answers, failing fast on a worker error. Longer than the 10 s a
 * replacement's pool install may wait, so a slow release reports as itself.
 */
async function until<T>(reports: SocketReport[], read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const failure = reports.find((report) => report.kind === "error");
    if (failure?.kind === "error") throw new Error(failure.error);
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const next = <K extends Kind>(reports: SocketReport[], kind: K) =>
  until(
    reports,
    () => reports.find((report): report is Extract<SocketReport, { kind: K }> => report.kind === kind),
    kind,
  );

test("hibernated sockets survive actor-worker termination through transferred MessagePorts", async () => {
  const poolName = `do-runtime-hibernation-restart-${Math.random().toString(36).slice(2)}`;
  const url = "wss://room.invalid/";
  try {
    const first = new MessageChannel();
    const before = client(first.port1);
    const accepting = start({ poolName, url, port: first.port2 });
    await next(accepting.reports, "accepted");
    before.send({ type: "message", data: "ping" });
    expect(await until(accepting.reports, () => before.frames[0], "pong")).toEqual({
      type: "message",
      data: "pong",
    });
    accepting.worker.postMessage("hibernate");
    const { kind: _hibernated, ...hibernated } = await next(accepting.reports, "hibernated");
    expect(hibernated).toEqual({
      socket: {
        tags: ["room:lobby", "user:ada"],
        attachment: expect.any(Uint8Array),
        autoResponseTimestamp: expect.any(Number),
      },
      autoResponse: { request: "ping", response: "pong" },
    });
    accepting.worker.terminate();

    const second = new MessageChannel();
    const after = client(second.port1);
    const restarted = start({ poolName, url, port: second.port2, hibernated });
    await next(restarted.reports, "ready");
    after.send({ type: "message", data: "hello" });
    expect(await next(restarted.reports, "message")).toEqual({
      kind: "message",
      message: "hello",
      tags: ["room:lobby", "user:ada"],
      attachment: { user: "ada", since: new Date(0), roles: new Set(["admin"]) },
      autoResponseTimestamp: hibernated.socket.autoResponseTimestamp,
      stored: "ada",
    });
    expect(await until(restarted.reports, () => after.frames[0], "echo")).toEqual({
      type: "message",
      data: "echo:hello",
    });
    after.send({ type: "message", data: "ping" });
    expect(await until(restarted.reports, () => after.frames[1], "pong")).toEqual({
      type: "message",
      data: "pong",
    });
    after.send({ type: "close", code: 4000, reason: "bye" });
    expect(await next(restarted.reports, "close")).toEqual({
      kind: "close",
      code: 4000,
      reason: "bye",
      wasClean: true,
    });

    // Both pings were answered without waking a handler in either worker.
    expect(accepting.reports.map(({ kind }) => kind)).toEqual(["accepted", "hibernated"]);
    expect(restarted.reports.map(({ kind }) => kind)).toEqual(["ready", "message", "close"]);
  } finally {
    for (const worker of workers.splice(0)) worker.terminate();
  }
}, 30_000);
