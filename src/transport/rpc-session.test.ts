/**
 * ← workerd `NO upstream test file` — the module under test has no upstream
 * twin (see its header), so these are the transport adaptation's own.
 *
 * Two assertions, and they are different claims. The first is the contract: a
 * session established through this module carries a value whose class descends
 * from `api/cloudflare-workers.ts`'s `RpcTarget`, which is the exact thing
 * decision 18 exists to make possible and the exact thing that fails with
 * `Cannot serialize value` when the graft has not run. The second is why this
 * module re-applies the graft per session instead of relying on an import: it
 * survives the link being removed underneath it, which is what makes the
 * guarantee a property of the call rather than of an import graph.
 */

import { afterEach, expect, test } from "vitest";
import { RpcTarget as TransportRpcTarget } from "capnweb";
import { RpcTarget } from "../api/cloudflare-workers";
import { newRpcSession, reconcileRpcTargetIdentity } from "./rpc-session";

/** Extends the DECLARED class, which is the one an application reaches through `cloudflare:workers`. */
class Greeter extends RpcTarget {
  greet(name: string): string {
    return `hello ${name}`;
  }
}

const open: MessagePort[] = [];

function pair(): { client: MessagePort; server: MessagePort } {
  const channel = new MessageChannel();
  open.push(channel.port1, channel.port2);
  return { client: channel.port1, server: channel.port2 };
}

afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

test("a session from this module carries a cloudflare:workers RpcTarget", async () => {
  const { client, server } = pair();
  newRpcSession(server, new Greeter());
  const remote = newRpcSession<Greeter>(client);

  expect(await remote.greet("facet")).toBe("hello facet");
});

test("the identity graft is re-applied per session, not only at import", () => {
  // Undo the prior session's link, which is the state a host reaching capnweb
  // by some other route would find itself in.
  Object.setPrototypeOf(RpcTarget.prototype, Object.prototype);
  expect(new Greeter()).not.toBeInstanceOf(TransportRpcTarget);

  const { client, server } = pair();
  newRpcSession(server, new Greeter());
  newRpcSession(client);

  expect(new Greeter()).toBeInstanceOf(TransportRpcTarget);
});

test("reconciling repeatedly keeps the same prototype link", () => {
  reconcileRpcTargetIdentity();
  const before = Object.getPrototypeOf(RpcTarget.prototype) as object;
  reconcileRpcTargetIdentity();
  expect(Object.getPrototypeOf(RpcTarget.prototype)).toBe(before);
});

test("an indirect capnweb link is accepted rather than flattened", () => {
  const original = Object.getPrototypeOf(RpcTarget.prototype) as object;
  const intermediate = Object.create(TransportRpcTarget.prototype) as object;
  Object.setPrototypeOf(RpcTarget.prototype, intermediate);
  try {
    reconcileRpcTargetIdentity();
    expect(Object.getPrototypeOf(RpcTarget.prototype)).toBe(intermediate);
  } finally {
    Object.setPrototypeOf(RpcTarget.prototype, original);
  }
});

test("an unrelated prototype link is refused rather than discarded", () => {
  const original = Object.getPrototypeOf(RpcTarget.prototype) as object;
  const foreign = Object.create(Object.prototype) as object;
  Object.setPrototypeOf(RpcTarget.prototype, foreign);
  try {
    expect(() => reconcileRpcTargetIdentity()).toThrow(
      /RpcTarget already inherits from something other than Object/,
    );
    expect(Object.getPrototypeOf(RpcTarget.prototype)).toBe(foreign);
  } finally {
    Object.setPrototypeOf(RpcTarget.prototype, original);
  }
});
