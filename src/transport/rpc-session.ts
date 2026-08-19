/**
 * ← workerd `NO upstream correspondence (capnweb adaptation)`
 *
 * The one door onto a capnweb session, so that decision 18's identity graft
 * cannot be skipped by establishing one some other way.
 *
 * The `RpcTarget` identity graft lives here because the guarantee belongs to
 * the call that establishes a session, not to whichever sibling module happened
 * to run a side effect first. It is re-applied for every session and is
 * idempotent.
 *
 * **What this deliberately is not.** It is not a transport abstraction and takes
 * no options capnweb does not: a lane or a host that needs
 * `newWebSocketRpcSession` instead should call `reconcileRpcTargetIdentity()`
 * itself and say so, rather than growing this into a second capnweb API. The
 * `MessagePort` form is the only one this substrate uses — the extension's
 * offscreen↔worker hop and the browser lane's page↔actor and page↔alarms hops are
 * all `newMessagePortRpcSession` — and a port carries structured clone, which is
 * what makes capnweb's `structuredClonable` encoding level available.
 *
 * Spec: decision 18 in docs/decisions.md.
 */

import {
  newMessagePortRpcSession,
  RpcTarget as TransportRpcTarget,
  type RpcStub,
} from "capnweb";
import { RpcTarget } from "../api/cloudflare-workers";

/** Make the declared Workers RpcTarget recognizable to capnweb by reference. */
export function reconcileRpcTargetIdentity(): void {
  if ((RpcTarget as unknown) === (TransportRpcTarget as unknown)) return;
  if (
    Object.prototype.isPrototypeOf.call(
      TransportRpcTarget.prototype,
      RpcTarget.prototype,
    )
  ) {
    return;
  }
  const existing: unknown = Object.getPrototypeOf(RpcTarget.prototype);
  if (existing !== Object.prototype) {
    throw new Error(
      "The cloudflare:workers RpcTarget already inherits from something other than Object, so " +
        "the capnweb identity cannot be reconciled without discarding that link.",
    );
  }
  Object.setPrototypeOf(RpcTarget.prototype, TransportRpcTarget.prototype);
}

/**
 * Establish a capnweb session over a `MessagePort`, with the `RpcTarget`
 * identity reconciled first.
 *
 * `localMain` is what the peer reaches; the returned stub is what the peer
 * exposed. Both ends call this — a session is symmetric — and either side may
 * omit its main when it exports nothing.
 */
export function newRpcSession<T = unknown>(port: MessagePort, localMain?: unknown): RpcStub<T> {
  reconcileRpcTargetIdentity();
  // Through `unknown`, because capnweb's own return type is `RpcStub<Stubify<...>>` and asking a
  // checker to compare that against `RpcStub<T>` structurally is what makes it recurse until it
  // gives up (TS2589, and two TS2321s behind it). The narrowing is the point of the signature —
  // the caller names the peer's main — and it is unchecked either way.
  return newMessagePortRpcSession(port, localMain) as unknown as RpcStub<T>;
}
