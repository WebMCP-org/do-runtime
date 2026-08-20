/**
 * The wire between the page and the actor, and the one idea in this example
 * worth stealing: **the Durable Object is addressed as an origin.**
 *
 * A Durable Object's front door is `fetch(Request) -> Response`. Everything the
 * page wants from the workspace — list the files, read one, write one — is
 * therefore a request to a URL, exactly as it would be if the actor were running
 * on Cloudflare and the page were talking to it over the network. Nothing here
 * is a "storage API": the page has no privileged access to the actor's SQLite
 * database and cannot have any, because the database is behind the actor's input
 * gate in another thread.
 *
 * **Why the request is flattened into a record instead of being a `Request`.**
 * The page↔worker hop is a Cap'n Web session over a `MessagePort`, and capnweb
 * serialises by prototype identity: an object literal is an object, a
 * `Uint8Array` is bytes, and everything else is either passed by reference (an
 * `RpcTarget`) or refused. So the wire types below use exactly two shapes —
 * plain objects and `Uint8Array` — and the real `Request` is constructed on the
 * far side, inside the worker, where the actor can be handed the genuine
 * article. Do not "improve" `body` into an `ArrayBuffer`, a `DataView`, a `Map`
 * or a `Blob`.
 *
 * (capnweb 0.10.0 does in fact have `request`, `response` and `readable` arms in
 * its serialiser — see `node_modules/capnweb/dist/index.js`, `typeForRpc` — so a
 * later version of this example might pass the `Request` across whole. That is a
 * stream crossing a worker boundary with a lifetime the actor's gates do not
 * know about, which is a bigger claim than this example needs to make.)
 */

/** One request for the actor's `fetch()` handler, flattened for the hop. */
export type WireRequest = {
  method: string;
  /** Absolute, because `new Request()` demands it. See `WORKSPACE_ORIGIN`. */
  url: string;
  headers: [string, string][];
  /**
   * Absent rather than empty for GET and DELETE: `new Request(url, { method:
   * "GET", body: <anything> })` throws, so "no body" has to be distinguishable
   * from "zero-length body" on this side of the wire.
   */
  body?: Uint8Array;
};

/** One `Response` from the actor, flattened the same way. */
export type WireResponse = {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
};

/** What the worker exposes to the page over the session. */
export interface WorkspaceRpc {
  /**
   * Place the actor. Separate from `request` so that a boot failure — an OPFS
   * pool this tab cannot lock, most likely — reaches the page as itself rather
   * than as whatever the first request happens to say.
   */
  ready(): Promise<void>;
  /** One `fetch()` event on the actor. */
  request(wire: WireRequest): Promise<WireResponse>;
}

/** What the dedicated user-actor worker exposes to the page. */
export interface AgentRpc {
  /** Compile/import/place the authored class and return its exported name. */
  ready(): Promise<string>;
  /** One `fetch()` event on the authored Durable Object. */
  request(wire: WireRequest): Promise<WireResponse>;
  /** Finish requests, close SQLite, and release the OPFS pool before replacement. */
  dispose(): Promise<void>;
}

/** What the page exposes to the worker: somewhere to put a line the user should see. */
export interface PageRpc {
  log(line: string, isError: boolean): void;
}

/** The boot message. A `MessagePort` is not a value capnweb can serialise, so it */
/** travels once by raw `postMessage` with a transfer list, and everything after is capnweb. */
export type WorkspaceBoot = {
  port: MessagePort;
};

/** The evaluated source is a Rolldown IIFE exporting its module record as default. */
export type AgentBoot = {
  port: MessagePort;
  source: string;
};

/** The global Rolldown uses for the browser's `cloudflare:workers` external. */
export const CLOUDFLARE_WORKERS_GLOBAL = "__vibeCloudflareWorkers";

/** The global Rolldown uses for the browser-hosted `agents` package. */
export const AGENTS_GLOBAL = "__vibeAgents";

/**
 * The origin the actor answers on. It is never resolved and never reaches the
 * network — `fetch()` here is a method call on an object in a Web Worker — but
 * `new Request()` needs an absolute URL, so it needs to be something. `.invalid`
 * is reserved by RFC 2606 precisely so that it can never accidentally become a
 * real host.
 */
export const WORKSPACE_ORIGIN = "http://workspace.invalid";

/** The equally fictional origin used when the preview calls the authored actor. */
export const AGENT_ORIGIN = "http://agent.invalid";

/**
 * The one failure this example expects a user to hit, so it is worded for a user.
 *
 * The OPFS SAH pool takes an exclusive sync access handle on every file in its
 * directory. That is what makes SQLite synchronous in a browser, and it is also
 * why a second tab of this page cannot install the same pool: the first tab
 * still holds the handles.
 */
export const WORKSPACE_LOCKED_MESSAGE =
  "This workspace is already open in another tab. The Durable Object's storage takes exclusive " +
  "locks on its files, so only one tab can hold it at a time — close the other tab and reload.";
