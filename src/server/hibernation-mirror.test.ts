import { describe, expect, test } from "vitest";
import {
  HibernationMirror,
  type RawWebSocket,
  type RehydratedWebSocket,
} from "../index";

function rawWebSocket(): RawWebSocket {
  return {
    addEventListener() {},
    close() {},
    send() {},
  };
}

describe("HibernationMirror", () => {
  test("hands copied socket metadata to a replacement host", () => {
    const socket = rawWebSocket();
    const tags = ["connection-id", "room"];
    const attachment = new Uint8Array([1, 2, 3]);
    const mirror = new HibernationMirror();

    mirror.accepted(socket, tags);
    mirror.attachment(socket, attachment);
    mirror.autoResponse({ request: "ping", response: "pong" });
    mirror.autoResponseTimestamp(socket, 10);
    tags[0] = "changed";
    attachment[0] = 9;

    const snapshot = mirror.snapshot();
    expect(snapshot).toEqual([
      {
        socket,
        tags: ["connection-id", "room"],
        attachment: new Uint8Array([1, 2, 3]),
        autoResponseTimestamp: 10,
      },
    ] satisfies RehydratedWebSocket[]);
    expect(mirror.autoResponsePair).toEqual({ request: "ping", response: "pong" });

    const replacement = new HibernationMirror(snapshot, mirror.autoResponsePair);
    snapshot[0]!.tags = ["mutated"];
    snapshot[0]!.attachment![0] = 8;
    expect(replacement.snapshot()).toEqual([
      {
        socket,
        tags: ["connection-id", "room"],
        attachment: new Uint8Array([1, 2, 3]),
        autoResponseTimestamp: 10,
      },
    ]);
    expect(replacement.autoResponsePair).toEqual({ request: "ping", response: "pong" });
    replacement.autoResponseTimestamp(socket, 20);
    expect(replacement.snapshot()[0]?.autoResponseTimestamp).toBe(20);
    expect(mirror.snapshot()[0]?.autoResponseTimestamp).toBe(10);

    mirror.closed(socket);
    expect(mirror.snapshot()).toEqual([]);
  });
});
