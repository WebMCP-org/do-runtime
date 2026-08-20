/**
 * The workerd lane: the oracle. This package is deliberately not loaded here —
 * every assertion is measuring Cloudflare's runtime.
 */

import { env } from "cloudflare:test";
import type { Capability, ConformanceHost, ProbeActor } from "../host";

type ProbeNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const probes = () => (env as unknown as { PROBE: ProbeNamespace }).PROBE;

let probeCounter = 0;

/**
 * A fresh stub each time. Re-getting by the same name is what `respawn` needs:
 * same durable identity, new instance — which is exactly how the transaction
 * rows read state back after `ctx.abort` destroyed the actor.
 */
function actor(name: string): ProbeActor {
  const namespace = probes();
  const stub = namespace.get(namespace.idFromName(name));
  const invoke = (method: string, args: readonly unknown[]) => {
    const fn = stub[method];
    if (!fn) throw new Error(`Probe has no method ${method}`);
    return fn(...args);
  };
  return {
    name,
    call: <T,>(method: string, ...args: readonly unknown[]) => invoke(method, args) as Promise<T>,
    post: (method: string, ...args: readonly unknown[]) => ({
      settled: invoke(method, args),
    }),
  };
}

export const host: ConformanceHost = {
  lane: "workerd",
  // Native here, throwing stubs in ours — `substrate()` asserts both sides.
  capabilities: new Set<Capability>([
    "hibernation",
    "bookmarks",
  ]),
  spawn: async (name = `probe-${probeCounter++}`) => actor(name),
  respawn: async (a) => actor(a.name),
};
