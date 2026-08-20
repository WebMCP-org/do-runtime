const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  createActorContainer,
  DEFAULT_ALARM_OUTLET,
  gateRequestBody,
  installActorScope,
  newRpcSession,
  noFacets,
  type ActorContainer,
  type Timer,
} from "@mcp-b/do-runtime";
import type { SqliteWasmHost } from "@mcp-b/do-runtime/backends/sqlite-wasm";
import * as cloudflareWorkers from "cloudflare:workers";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import * as agents from "agents";
import {
  AGENTS_GLOBAL,
  CLOUDFLARE_WORKERS_GLOBAL,
  type AgentBoot,
  type AgentRpc,
  type PageRpc,
  type WireRequest,
  type WireResponse,
} from "../wire";
import { TrackedSqliteWasmProvider, type RetryablePoolOptions } from "./sqlite-storage";

// Stable forever: changing either value orphans the authored actor's data.
const UNIQUE_KEY = "do-runtime-example-vibe-user-agent";
const POOL_NAME = "vibe-user-agent";
const STORAGE_PREFIX = "/agent";
const ACTOR_ID = "default";

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = rawSetTimeout(resolve, Math.max(0, ms));
      signal?.addEventListener("abort", () => rawClearTimeout(handle));
    }),
};

type ReleasableSqliteWasmHost = SqliteWasmHost & {
  pool: SqliteWasmHost["pool"] & { pauseVfs(): unknown };
};

async function installPool(): Promise<ReleasableSqliteWasmHost> {
  Object.defineProperty(globalThis, "sqlite3ApiConfig", {
    configurable: true,
    value: { disable: { vfs: { opfs: true, "opfs-wl": true } } },
  });
  const sqlite3 = await sqlite3InitModule();
  const options: RetryablePoolOptions = {
    name: POOL_NAME,
    clearOnInit: false,
    initialCapacity: 8,
    forceReinitIfPreviouslyFailed: true,
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs(options);
      return { pool, capi: sqlite3.capi };
    } catch (error) {
      if (attempt === 1) report("the agent storage is still releasing; waiting", false);
      if (attempt >= 20) throw new Error("The user agent's storage stayed locked.", { cause: error });
      await new Promise<void>((resolve) => rawSetTimeout(resolve, 150));
    }
  }
}

let live:
  | {
      container: ActorContainer;
      entry: { fetch(request: Request): Promise<Response> | Response };
      className: string;
      storage: TrackedSqliteWasmProvider;
    }
  | undefined;
let scopeContainer: ActorContainer | undefined;
let placing: Promise<NonNullable<typeof live>> | undefined;
let authoredSource = "";
let scopeInstalled = false;
let shuttingDown = false;
let pooled: Promise<ReleasableSqliteWasmHost> | undefined;
const requests = new Set<Promise<WireResponse>>();

function installScope(): void {
  if (scopeInstalled) return;
  scopeInstalled = true;
  const resolve = () => {
    if (scopeContainer === undefined) {
      throw new Error("The user agent reached an actor-scoped API without a live container.");
    }
    return scopeContainer.globals;
  };
  installActorScope(globalThis, resolve);
}

async function evaluateActor(): Promise<{
  ActorClass: new (ctx: DurableObjectState, env: Record<string, never>) => object;
  className: string;
  exports: Record<string, unknown>;
}> {
  (globalThis as Record<string, unknown>)[CLOUDFLARE_WORKERS_GLOBAL] = cloudflareWorkers;
  (globalThis as Record<string, unknown>)[AGENTS_GLOBAL] = agents;
  const url = URL.createObjectURL(new Blob([authoredSource], { type: "text/javascript" }));
  let imported: Record<string, unknown>;
  try {
    imported = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
  const module = imported.default;
  if (typeof module !== "object" || module === null) {
    throw new Error("The authored bundle did not export a module record.");
  }

  // The SDK's aliased Workers module can have a different class identity from
  // the host's copy, so either public base is an authored actor.
  const classes = Object.entries(module).filter(
    (entry): entry is [string, typeof DurableObject] =>
      typeof entry[1] === "function" &&
      (entry[1].prototype instanceof DurableObject || entry[1].prototype instanceof agents.Agent),
  );
  if (classes.length !== 1) {
    throw new Error(
      `server/agent.ts must export exactly one DurableObject or Agent class; found ${classes.length}.`,
    );
  }
  const match = classes[0];
  if (match === undefined) throw new Error("server/agent.ts exports no DurableObject class.");
  const [className, ActorClass] = match;
  if (className === "default" || !/^[$A-Z_a-z][$\w]*$/.test(className)) {
    throw new Error("The DurableObject class must use a named JavaScript export for Wrangler.");
  }
  return {
    ActorClass: ActorClass as unknown as new (
      ctx: DurableObjectState,
      env: Record<string, never>,
    ) => object,
    className,
    exports: module as Record<string, unknown>,
  };
}

async function place(): Promise<NonNullable<typeof live>> {
  pooled ??= installPool();
  const host = await pooled;
  installScope();
  const evaluated = await evaluateActor();
  const storage = new TrackedSqliteWasmProvider(host, STORAGE_PREFIX);
  const container = await createActorContainer({
    id: ACTOR_ID,
    uniqueKey: UNIQUE_KEY,
    exports: evaluated.exports,
    env: {},
    ports: {
      sql: storage,
      alarms: DEFAULT_ALARM_OUTLET,
      facets: noFacets,
      timer,
    },
  });
  scopeContainer = container;
  void container.onBroken.catch((error: unknown) => {
    if (scopeContainer === container) scopeContainer = undefined;
    if (live?.container === container) live = undefined;
    storage.close();
    report(`the user agent broke: ${describe(error)}`, true);
  });
  const instance = await container.start(
    (ctx, env) => new evaluated.ActorClass(ctx, env as Record<string, never>),
  );
  if (!("fetch" in instance) || typeof instance.fetch !== "function") {
    throw new Error(`${evaluated.className} has no fetch() handler.`);
  }
  live = {
    container,
    entry: container.entry(
      instance as { fetch(request: Request): Promise<Response> | Response },
    ),
    className: evaluated.className,
    storage,
  };
  return live;
}

async function placed(): Promise<NonNullable<typeof live>> {
  if (shuttingDown) throw new Error("The user agent is shutting down.");
  if (live !== undefined) return live;
  placing ??= place().finally(() => {
    placing = undefined;
  });
  return await placing;
}

class AgentTarget extends RpcTarget implements AgentRpc {
  async ready(): Promise<string> {
    try {
      return (await placed()).className;
    } catch (error) {
      report(`agent failed: ${describe(error)}`, true);
      throw error;
    }
  }

  async request(wire: WireRequest): Promise<WireResponse> {
    const pending = (async (): Promise<WireResponse> => {
      const { container, entry } = await placed();
      const request = new Request(wire.url, {
        method: wire.method,
        headers: wire.headers,
        ...(wire.body === undefined ? {} : { body: wire.body.slice() }),
      });
      const response = await entry.fetch(gateRequestBody(container, request));
      return {
        status: response.status,
        headers: [...response.headers.entries()],
        body: new Uint8Array(await response.arrayBuffer()),
      };
    })();
    requests.add(pending);
    try {
      return await pending;
    } finally {
      requests.delete(pending);
    }
  }

  async dispose(): Promise<void> {
    shuttingDown = true;
    await Promise.allSettled(requests);
    const current = live;
    live = undefined;
    scopeContainer = undefined;
    current?.storage.close();
    (await pooled)?.pool.pauseVfs();
  }
}

let peer: ReturnType<typeof newRpcSession<PageRpc>> | undefined;

function report(line: string, isError: boolean): void {
  if (peer === undefined) return;
  Promise.resolve(peer.log(line, isError)).catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener("message", (event: MessageEvent<AgentBoot>) => {
  if (peer !== undefined) throw new Error("This user-agent worker was booted twice.");
  authoredSource = event.data.source;
  peer = newRpcSession<PageRpc>(event.data.port, new AgentTarget());
});
