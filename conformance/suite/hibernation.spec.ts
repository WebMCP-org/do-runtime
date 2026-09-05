/**
 * Hibernatable WebSockets, measured against the pinned workerd lane and then
 * replayed unchanged against the two do-runtime lanes.
 */

import { describe, expect, it } from "vitest";
import { host } from "conformance:host";
import type { ProbeActor } from "../host";

type CapturedError = { name: string; message: string };

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  expect(ready(value)).toBe(true);
  return value;
}

async function journal(actor: ProbeActor): Promise<{
  events: Record<string, unknown>[];
  trace: string[];
  times: { event: string; at: number }[];
  listenerMessages: number;
  clients: Record<string, unknown[]>;
  closes: Record<string, { code: number; reason: string; wasClean: boolean }[]>;
  listed: string[];
}> {
  return await actor.call("socketJournal");
}

describe("acceptWebSocket and getWebSockets", () => {
  it("A1-A4 refuses cross-accepts, enforces pair use, and permits the client half", async () => {
    const actor = await host.spawn("ws-accept");
    expect(await actor.call("acceptanceSemantics")).toEqual({
      doubleHibernation: {
        name: "Error",
        message: "Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`",
      },
      classicThenHibernation: {
        name: "Error",
        message: "Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`",
      },
      hibernationThenClassic: {
        name: "TypeError",
        message: "Can't accept() WebSocket after enabling hibernation.",
      },
      clientHalfAccepted: ["client-half"],
      usedPair: {
        name: "Error",
        message:
          "Cannot call `acceptWebSocket()` on this WebSocket because its pair has already been accepted or used in a Response.",
      },
    });

    expect(await actor.call("acceptAfterAwait")).toEqual(["after-await"]);
    await actor.call("stashSocketForLaterEvent");
    // An unused pair survives across events. Pair USE, not pair creation, is the boundary.
    expect(await actor.call("acceptSocketFromLaterEvent")).toBeNull();
  });

  it("A5 coerces, de-duplicates, and bounds tags with workerd's errors", async () => {
    const actor = await host.spawn("ws-tags");
    const result = await actor.call<{
      normalized: string[];
      tooMany: CapturedError;
      tooLong: CapturedError;
      nonArray: CapturedError;
    }>("tagSemantics");
    const longTag = "x".repeat(257);
    expect(result).toEqual({
      normalized: ["", "123", "null", "[object Object]", "dup"],
      tooMany: {
        name: "Error",
        message: "a Hibernatable WebSocket cannot have more than 10 tags",
      },
      tooLong: {
        name: "Error",
        message: `"${longTag}" is longer than the max tag length (256 characters).`,
      },
      nonArray: {
        name: "TypeError",
        message:
          "Failed to execute 'acceptWebSocket' on 'DurableObjectState': parameter 2 is not of type 'Array'.",
      },
    });
  });

  it("B1-B3 returns snapshots with LIFO unfiltered and FIFO tagged ordering", async () => {
    const actor = await host.spawn("ws-order");
    expect(await actor.call("orderingSemantics")).toEqual({
      all: ["third", "second", "first"],
      shared: ["first", "second"],
      alpha: ["first"],
      lower: [],
      empty: [],
      nonString: [],
      freshArray: true,
      sameObjects: true,
    });
  });

  it("I enforces the per-instance 32768 socket cap", async () => {
    const actor = await host.spawn("ws-capacity");
    expect(await actor.call("socketCapacity")).toEqual({
      name: "Error",
      message: "only 32768 websockets can be accepted on a single Durable Object instance",
    });
  }, 60_000);
});

describe("attachments", () => {
  it("C1-C7 snapshots structured clones, distinguishes undefined, and works on any socket", async () => {
    const actor = await host.spawn("ws-attachments");
    expect(await actor.call("attachmentSemantics")).toEqual({
      snapshot: 1,
      freshClone: true,
      neverSerialized: null,
      explicitUndefined: "undefined",
      zeroArgument: {
        name: "TypeError",
        message:
          "Failed to execute 'serializeAttachment' on 'WebSocket': parameter 1 is not of type 'Value'.",
      },
      rich: { map: true, date: true, bigint: "bigint", bytes: true, cyclic: true },
      functionError: {
        name: "DataCloneError",
        message: "function foo() {} could not be cloned.",
      },
      symbolError: { name: "DataCloneError", message: "Symbol(s) could not be cloned." },
      sizePass: null,
      sizeFail: {
        name: "Error",
        message:
          "A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16385 bytes.",
      },
      classic: "classic",
      client: "closed",
    });
  });
});

describe("handler dispatch and close state", () => {
  it("D1-D3 dispatches methods only and normalizes binary messages to ArrayBuffer", async () => {
    const actor = await host.spawn("ws-dispatch");
    await actor.call("openSelfSocket", "socket", ["socket"]);
    await actor.call("sendSelf", "socket", "hello");
    await actor.call("sendSelfBinary", "socket", [1, 2, 3]);
    await actor.call("sendSelf", "socket", "echo");

    const result = await eventually(
      () => journal(actor),
      (value) => value.events.length >= 3 && value.clients.socket?.includes("echoed"),
    );
    expect(result.listenerMessages).toBe(0);
    expect(result.events.slice(0, 3)).toEqual([
      { id: "socket", message: { kind: "string", value: "hello" } },
      { id: "socket", message: { kind: "ArrayBuffer", value: [1, 2, 3] } },
      { id: "socket", message: { kind: "string", value: "echo" } },
    ]);
    expect(result.clients.socket).toContain("echoed");
  });

  it("D2 silently drops missing and throwing handlers and keeps later delivery alive", async () => {
    const actor = await host.spawn("ws-handler-failures");
    await actor.call("openSelfSocket", "socket", ["socket"]);
    await actor.call("removeSocketMessageHandler");
    await actor.call("sendSelf", "socket", "missing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await actor.call("restoreSocketMessageHandler");
    await actor.call("throwOnNextSocketMessage");
    await actor.call("sendSelf", "socket", "throws");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await actor.call("sendSelf", "socket", "survives");

    const result = await eventually(
      () => journal(actor),
      (value) => value.events.some((event) => JSON.stringify(event).includes("survives")),
    );
    expect(result.events).toEqual([
      { id: "socket", message: { kind: "string", value: "survives" } },
    ]);
    expect(result.listed).toEqual(["socket"]);
    expect(result.closes.socket).toEqual([]);
  });

  it("D4 overlaps handler promises but waits for blockConcurrencyWhile", async () => {
    const concurrent = await host.spawn("ws-concurrent");
    await concurrent.call("openSelfSocket", "socket", ["socket"]);
    await concurrent.call("sendSelf", "socket", "slow:one");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await concurrent.call("sendSelf", "socket", "slow:two");
    const overlapping = await eventually(
      () => journal(concurrent),
      (value) => value.trace.length === 4,
    );
    expect(overlapping.trace).toEqual([
      "start:slow:one",
      "start:slow:two",
      "end:slow:one",
      "end:slow:two",
    ]);
    expect(overlapping.times[1]!.at - overlapping.times[0]!.at).toBeLessThan(180);

    const blocked = await host.spawn("ws-blocked");
    await blocked.call("openSelfSocket", "socket", ["socket"]);
    await blocked.call("sendSelf", "socket", "block:one");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await blocked.call("sendSelf", "socket", "block:two");
    const serialized = await eventually(
      () => journal(blocked),
      (value) => value.trace.length === 4,
    );
    expect(serialized.trace).toEqual([
      "start:block:one",
      "end:block:one",
      "start:block:two",
      "end:block:two",
    ]);
    expect(serialized.times[2]!.at - serialized.times[0]!.at).toBeGreaterThanOrEqual(190);
  });

  it("D5/B4 reports peer close while listed, tolerates reciprocity, then evicts", async () => {
    const actor = await host.spawn("ws-peer-close");
    await actor.call("openSelfSocket", "socket", ["socket"]);
    await actor.call("closeSelfClient", "socket", 4001, "bye");
    const result = await eventually(
      () => journal(actor),
      (value) => value.events.some((event) => "close" in event),
    );
    expect(result.events.at(-1)).toEqual({
      id: "socket",
      close: { code: 4001, reason: "bye", wasClean: true },
      readyState: 2,
      listedDuringHandler: false,
      sendAfterPeerClose: null,
      reciprocalClose: null,
    });
    expect((await journal(actor)).listed).toEqual([]);
  });

  it("D6-D7 own close echoes, send-after-close throws synchronously, and close validates", async () => {
    const actor = await host.spawn("ws-own-close");
    await actor.call("openSelfSocket", "socket", ["socket"]);
    expect(await actor.call("sendAfterOwnClose", "socket")).toEqual({
      name: "TypeError",
      message: "Can't call WebSocket send() after close().",
    });
    const result = await eventually(
      () => journal(actor),
      (value) => value.events.some((event) => "close" in event),
    );
    expect(result.events.at(-1)).toEqual({
      id: "socket",
      close: { code: 4002, reason: "server out", wasClean: true },
      readyState: 3,
      listedDuringHandler: false,
      sendAfterPeerClose: {
        name: "TypeError",
        message: "Can't call WebSocket send() after close().",
      },
      reciprocalClose: null,
    });

    const invalidCode = (code: number): CapturedError => ({
      name: "InvalidAccessError",
      message: `Invalid WebSocket close code: ${code}.`,
    });
    expect(await actor.call("closeValidation")).toEqual({
      code999: invalidCode(999),
      code1005: invalidCode(1005),
      code1006: invalidCode(1006),
      code5000: invalidCode(5000),
      longReason: {
        name: "SyntaxError",
        message: "WebSocket close reason must not be longer than 123 bytes when UTF-8 encoded.",
      },
      code1000: null,
      code3000: null,
      code4999: null,
    });
  });

  it("D7 exposes ready states on the constructor and prototype", async () => {
    const actor = await host.spawn("ws-ready-state");
    expect(await actor.call("readyStateConstants")).toEqual({
      fresh: [1, 1],
      constructorValues: [0, 1, 2, 3, 0, 1, 2, 3],
      prototype: [0, 1, 2, 3, 0, 1, 2, 3],
    });
  });

  it("keeps root and facet socket registries isolated", async () => {
    const actor = await host.spawn("ws-facet-isolation");
    expect(await actor.call("facetSocketIsolation")).toEqual([1, 0, 1]);
  });
});

describe("auto-response, timeout, pair, and tags", () => {
  it("preserves auto-responses and their timestamps through eviction", async () => {
    const actor = await host.spawn("ws-auto-response-eviction");
    const client = await host.connect(actor, ["connection-id"]);
    const read = () =>
      actor.call<{
        pair: { request: string; response: string } | null;
        timestamp: number;
      }>("externalAutoResponse", "connection-id");
    await actor.call("setAutoResponse", "ping", "pong");
    await client.send("ping");
    expect(await client.nextMessage()).toBe("pong");
    const before = await read();
    expect(before.timestamp).toBeTypeOf("number");

    await host.evict(actor);
    expect(await read()).toEqual(before);
    await host.evict(actor);
    await client.send("ping");
    expect(await client.nextMessage()).toBe("pong");
    const after = await read();
    expect(after.pair).toEqual({ request: "ping", response: "pong" });
    expect(after.timestamp).toBeGreaterThanOrEqual(before.timestamp);
    expect(await actor.call("readExternalObservation")).toBeNull();
    await host.evict(actor);
    expect(await read()).toEqual(after);

    await actor.call("clearAutoResponse");
    await host.evict(actor);
    expect(await read()).toEqual({ pair: null, timestamp: after.timestamp });
    await client.send("ping");
    await eventually(
      () => actor.call("readExternalObservation"),
      (value) => value !== null,
    );
  });

  it("E1-E5 auto-responds exact text, stamps the socket, and clears with undefined", async () => {
    const actor = await host.spawn("ws-auto-response");
    await actor.call("openSelfSocket", "socket", ["socket"]);
    await actor.call("setAutoResponse", "ping", "pong");
    await actor.call("sendSelf", "socket", "ping");
    const answered = await eventually(
      () => journal(actor),
      (value) => value.clients.socket?.includes("pong"),
    );
    expect(answered.events).toEqual([]);
    const auto = await actor.call<{
      value: { request: string; response: string };
      fresh: boolean;
      timestamp: number;
      unacceptedTimestamp: null;
      badTimestamp: CapturedError;
      nullSetter: CapturedError;
    }>("autoResponseSemantics", "socket");
    expect(auto.value).toEqual({ request: "ping", response: "pong" });
    expect(auto.fresh).toBe(true);
    expect(auto.timestamp).toBeTypeOf("number");
    expect(auto.unacceptedTimestamp).toBeNull();
    expect(auto.badTimestamp).toEqual({
      name: "TypeError",
      message:
        "Failed to execute 'getWebSocketAutoResponseTimestamp' on 'DurableObjectState': parameter 1 is not of type 'WebSocket'.",
    });
    expect(auto.nullSetter).toEqual({
      name: "TypeError",
      message:
        "Failed to execute 'setWebSocketAutoResponse' on 'DurableObjectState': parameter 1 is not of type 'WebSocketRequestResponsePair'.",
    });

    await actor.call("sendSelf", "socket", "Ping");
    await actor.call("sendSelfBinary", "socket", [...new TextEncoder().encode("ping")]);
    await eventually(() => journal(actor), (value) => value.events.length === 2);
    await actor.call("clearAutoResponse");
    await actor.call("sendSelf", "socket", "ping");
    expect((await eventually(() => journal(actor), (value) => value.events.length === 3)).events).toHaveLength(3);
  });

  it("E6 bounds each auto-response side at 2048 UTF-8 bytes", async () => {
    const actor = await host.spawn("ws-auto-limits");
    expect(await actor.call("autoResponseLimits")).toEqual({
      request: {
        name: "RangeError",
        message: "Request cannot be larger than 2048 bytes. A request of size 2049 was provided.",
      },
      response: {
        name: "RangeError",
        message: "Response cannot be larger than 2048 bytes. A response of size 2049 was provided.",
      },
    });
  });

  it("F stores, coerces, bounds, and clears the event timeout", async () => {
    const actor = await host.spawn("ws-timeout");
    expect(await actor.call("timeoutSemantics")).toEqual({
      initial: null,
      thousand: 1_000,
      truncated: 1,
      coerced: 42,
      negative: {
        name: "TypeError",
        message:
          "The value cannot be converted because it is negative and this API expects a positive number.",
      },
      outOfRange: {
        name: "TypeError",
        message: "Value out of range. Must be less than or equal to 4294967295.",
      },
      sevenDays: { name: "Error", message: "Event timeout should not exceed 604800000 ms." },
      nan: {
        name: "TypeError",
        message: "The value cannot be converted because it is not an integer.",
      },
      cleared: null,
    });
  });

  it("G implements WebSocketRequestResponsePair as a coercing read-only value", async () => {
    const actor = await host.spawn("ws-pair-class");
    const result = await actor.call<{
      values: string[];
      json: string;
      hasSetter: boolean;
      withoutNew: CapturedError;
      badCoercion: CapturedError;
    }>("pairClassSemantics");
    expect(result.values).toEqual(["123", "null"]);
    expect(result.json).toBe("{}");
    expect(result.hasSetter).toBe(false);
    expect(result.withoutNew.message).toContain("Failed to construct 'WebSocketRequestResponsePair'");
    expect(result.badCoercion).toEqual({ name: "Error", message: "coercion failed" });
  });

  it("H distinguishes unaccepted, classic, and untagged hibernatable sockets", async () => {
    const actor = await host.spawn("ws-get-tags");
    expect(await actor.call("getTagsSemantics")).toEqual({
      unaccepted: {
        name: "Error",
        message:
          "you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.",
      },
      classic: {
        name: "Error",
        message: "only hibernatable websockets can have tags.",
      },
      tags: [],
      fresh: true,
    });
  });
});

it("preserves tags and attachment across a real eviction without reconnecting", async () => {
  const actor = await host.spawn("ws-eviction");
  const client = await host.connect(actor, ["connection-id", "room"]);
  await actor.call("setHibernationMarker", "dirty-instance");
  await host.evict(actor);
  await client.send("after-wake");

  const observation = await eventually(
    () => actor.call<Record<string, unknown> | null>("readExternalObservation"),
    (value) => value !== null,
  );
  expect(observation).toEqual({
    id: "connection-id",
    message: { kind: "string", value: "after-wake" },
    attachment: {
      id: "connection-id",
      tags: ["connection-id", "room"],
      marker: "attachment-survived",
    },
    tags: ["connection-id", "room"],
    listed: true,
    actorName: "ws-eviction",
    marker: "init",
    connects: 1,
  });
});
