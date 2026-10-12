/**
 * NO upstream test file: `platform.ts` has no upstream twin. This pins the `Timer` contract and
 * the realm-shared captures.
 */

import { afterEach, expect, test, vi } from "vitest";
import * as first from "./platform";
import { platformTimer } from "./platform";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("platformTimer resolves a delay and never resolves one whose signal was already aborted", async () => {
  await expect(platformTimer.afterDelay(1)).resolves.toBeUndefined();
  let settled = false;
  void platformTimer.afterDelay(0, AbortSignal.abort()).finally(() => {
    settled = true;
  });
  await platformTimer.afterDelay(10);
  expect(settled).toBe(false);
});

test("a copy of the runtime loaded after the globals were replaced reads the first copy's captures", async () => {
  // A facet bundle carries its own copy of this module and is evaluated after its root's actor
  // scope replaced the realm's globals with gated and refusing ones.
  const replaced = (name: string) => () => {
    throw new Error(`${name} is the installed actor scope's`);
  };
  vi.stubGlobal("setTimeout", replaced("setTimeout"));
  vi.stubGlobal("clearTimeout", replaced("clearTimeout"));
  vi.stubGlobal("fetch", replaced("fetch"));
  vi.stubGlobal("WebSocket", replaced("WebSocket"));
  vi.stubGlobal("crypto", {});
  vi.stubGlobal("ReadableStream", replaced("ReadableStream"));
  vi.stubGlobal("TransformStream", replaced("TransformStream"));
  vi.resetModules();
  const facet = await import("./platform");

  expect(facet).not.toBe(first);
  expect(facet.platform).toBe(first.platform);
  expect(facet.platformFetch).toBe(first.platformFetch);
  expect(facet.platformWebSocket).toBe(first.platformWebSocket);
  await expect(facet.platformTimer.afterDelay(1)).resolves.toBeUndefined();
});
