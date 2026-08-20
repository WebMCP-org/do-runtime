/**
 * The page: a supervisor and an editor, and nothing else.
 *
 * It owns no storage — it cannot, because OPFS synchronous access handles exist
 * only inside a dedicated worker, which is the whole reason the actor lives in
 * one. What it owns is worker creation, the session to the actor, the bundler,
 * and the DOM.
 *
 * The loop is: read files from the Durable Object over HTTP, hand them to
 * `@rolldown/browser` as a virtual filesystem, inline the bundle into a
 * sandboxed iframe, and let the browser fetch React from esm.sh through an
 * import map. Every part of that runs in this tab.
 */

import { rolldown } from "@rolldown/browser";
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import {
  AGENT_ORIGIN,
  AGENTS_GLOBAL,
  CLOUDFLARE_WORKERS_GLOBAL,
  WORKSPACE_ORIGIN,
  type AgentBoot,
  type AgentRpc,
  type PageRpc,
  type WireRequest,
  type WorkspaceBoot,
  type WorkspaceRpc,
} from "./wire";
import { storeZip, type ZipEntry } from "./zip";

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`index.html has no ${selector}`);
  return element;
};

const fileList = $<HTMLElement>("#files");
const editor = $<HTMLTextAreaElement>("#editor");
const preview = $<HTMLIFrameElement>("#preview");
const logPane = $<HTMLElement>("#log");
const banner = $<HTMLElement>("#banner");
const status = $<HTMLElement>("#status");
const saveButton = $<HTMLButtonElement>("#save");
const buildButton = $<HTMLButtonElement>("#build");
const exportButton = $<HTMLButtonElement>("#export");

function log(line: string, isError = false): void {
  const row = document.createElement("div");
  row.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  if (isError) row.className = "err";
  logPane.appendChild(row);
  logPane.scrollTop = logPane.scrollHeight;
}

function fail(message: string): void {
  banner.textContent = message;
  banner.hidden = false;
  status.textContent = "stopped";
  log(message, true);
}

// ---------------------------------------------------------------------------
// The worker, and the session to the actor inside it

const workspaceWorker = new Worker(new URL("./worker/host.worker.ts", import.meta.url), {
  type: "module",
});

// An uncaught exception in a dedicated worker goes nowhere anyone can see it:
// what it eventually causes is a call that never answers, several layers away.
// These two listeners are the whole of the fail-loudly wiring on this side.
workspaceWorker.addEventListener("error", (event: ErrorEvent) => {
  fail(`the workspace worker failed: ${event.message}`);
});
workspaceWorker.addEventListener("messageerror", () => {
  fail("the workspace worker could not deserialise a message");
});

/** What the worker can reach in the page. capnweb needs methods on a prototype. */
class PageTarget extends RpcTarget implements PageRpc {
  log(line: string, isError: boolean): void {
    log(`worker: ${line}`, isError);
  }
}

// One raw `postMessage` carries the port, because a `MessagePort` is not a value
// capnweb can serialise. Everything after this is capnweb.
const channel = new MessageChannel();
workspaceWorker.postMessage({ port: channel.port2 } satisfies WorkspaceBoot, [channel.port2]);
const workspace = newMessagePortRpcSession<WorkspaceRpc>(channel.port1, new PageTarget());

// ---------------------------------------------------------------------------
// The Durable Object, addressed as an origin

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type DoResponse = { status: number; ok: boolean; text: string };

/**
 * One `fetch()` on the actor. The URL is absolute and the origin is fictional:
 * nothing here touches the network, and `new Request()` insists on an origin.
 */
async function doFetch(method: string, path: string, body?: string): Promise<DoResponse> {
  const wire: WireRequest = {
    method,
    url: `${WORKSPACE_ORIGIN}${path}`,
    headers: body === undefined ? [] : [["content-type", "text/plain; charset=utf-8"]],
    ...(body === undefined ? {} : { body: encoder.encode(body) }),
  };
  const response = await workspace.request(wire);
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    text: decoder.decode(response.body),
  };
}

/** The text convenience: a 2xx body, or the actor's own error message, thrown. */
async function doText(method: string, path: string, body?: string): Promise<string> {
  const response = await doFetch(method, path, body);
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${response.text}`);
  return response.text;
}

const filePath = (path: string): string => `/file?path=${encodeURIComponent(path)}`;

const listFiles = async (): Promise<string[]> => JSON.parse(await doText("GET", "/files"));
const readFile = (path: string): Promise<string> => doText("GET", filePath(path));
const writeFile = (path: string, content: string): Promise<string> =>
  doText("PUT", filePath(path), content);

// ---------------------------------------------------------------------------
// Build: rolldown over the actor's filesystem

const ENTRY = "/src/main.tsx";
/** What a relative import may leave off, in the order rolldown should try them. */
const RESOLVE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js"];

const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

function resolveRelative(base: string, relative: string): string {
  const parts = base.split("/").filter(Boolean);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/**
 * Bundle the workspace.
 *
 * The plugin is the interesting part and it is nine lines: rolldown asks for a
 * module, the plugin asks the Durable Object for it. There is no filesystem, no
 * service worker, and no fetch interception — `load` is an HTTP GET to an actor
 * in a Web Worker, which is the same shape it would have if the actor were on
 * Cloudflare.
 *
 * Bare specifiers are marked external and never resolved here; the preview's
 * import map turns them into esm.sh URLs at runtime. That is what keeps the
 * bundle to the code you actually wrote.
 */
async function bundleWorkspace(
  entry: string,
  external: (id: string) => boolean,
  iifeName?: string,
): Promise<string> {
  // One listing per build, so `resolveId` is a set lookup rather than a round
  // trip per candidate extension.
  const paths = new Set(await listFiles());

  const bundle = await rolldown({
    input: entry,
    cwd: "/",
    external,
    plugins: [
      {
        name: "durable-object-fs",
        resolveId(source: string, importer: string | undefined) {
          const absolute = source.startsWith("/")
            ? source
            : resolveRelative(dirname(importer ?? "/"), source);
          for (const extension of RESOLVE_EXTENSIONS) {
            if (paths.has(absolute + extension)) return absolute + extension;
          }
          throw new Error(`cannot resolve ${source} from ${importer ?? "the entry"}`);
        },
        load: (id: string) => readFile(id),
      },
    ],
  });
  const { output } = await bundle.generate(
    iifeName === undefined
      ? { format: "esm" }
      : {
          format: "iife",
          name: iifeName,
          globals: {
            "cloudflare:workers": CLOUDFLARE_WORKERS_GLOBAL,
            agents: AGENTS_GLOBAL,
          },
        },
  );
  await bundle.close();
  const first = output[0];
  if (first === undefined) throw new Error("rolldown produced no output chunk");
  return iifeName === undefined ? first.code : `${first.code}\nexport default ${iifeName};\n`;
}

const build = (): Promise<string> =>
  bundleWorkspace(ENTRY, (id) => !id.startsWith(".") && !id.startsWith("/"));

// ---------------------------------------------------------------------------
// The authored Durable Object, in its own worker and persistent pool

const AGENT_ENTRY = "/server/agent.ts";
const AGENT_MODULE = "__vibeAuthoredModule";
const AGENT_STOP_TIMEOUT_MS = 1_000;
let agentWorker: Worker | undefined;
let agent: RpcStub<AgentRpc> | undefined;
let agentClassName: string | undefined;

async function stopAgent(): Promise<void> {
  const currentWorker = agentWorker;
  const currentAgent = agent;
  agentWorker = undefined;
  agent = undefined;
  agentClassName = undefined;
  if (currentWorker === undefined) return;
  try {
    await Promise.race([
      currentAgent?.dispose(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent shutdown timed out")), AGENT_STOP_TIMEOUT_MS),
      ),
    ]);
    log("agent storage released");
  } catch (error) {
    log(
      `agent shutdown fell back to termination: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    currentWorker.terminate();
  }
}

async function restartAgent(initial = false): Promise<void> {
  // A normal replacement closes SQLite and pauses the VFS before termination.
  // A crashed/reloaded worker cannot acknowledge teardown, so installPool still retries.
  await stopAgent();
  const source = await bundleWorkspace(
    AGENT_ENTRY,
    (id) => id === "cloudflare:workers" || id === "agents",
    AGENT_MODULE,
  );
  const nextWorker = new Worker(new URL("./worker/agent.worker.ts", import.meta.url), {
    type: "module",
  });
  nextWorker.addEventListener("error", (event: ErrorEvent) => {
    log(`agent worker failed: ${event.message}`, true);
  });
  nextWorker.addEventListener("messageerror", () => {
    log("agent worker could not deserialise a message", true);
  });

  const nextChannel = new MessageChannel();
  nextWorker.postMessage(
    { port: nextChannel.port2, source } satisfies AgentBoot,
    [nextChannel.port2],
  );
  const nextAgent = newMessagePortRpcSession<AgentRpc>(nextChannel.port1, new PageTarget());
  try {
    const className = await nextAgent.ready();
    agentWorker = nextWorker;
    agent = nextAgent;
    agentClassName = className;
    log(initial ? `user agent placed: ${className}` : "agent restarted; storage intact");
  } catch (error) {
    nextWorker.terminate();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Preview

const REACT_VERSION = "19.2.7";

/**
 * The dependencies the preview resolves over the network. Everything else in the
 * bundle is the workspace's own code.
 */
const IMPORT_MAP = {
  imports: {
    react: `https://esm.sh/react@${REACT_VERSION}`,
    "react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
    "react-dom/client": `https://esm.sh/react-dom@${REACT_VERSION}/client`,
  },
};

/**
 * `sandbox="allow-scripts"` without `allow-same-origin`, so the preview runs in
 * an opaque origin: it cannot read this document, its storage, or its OPFS. That
 * is the minimum for running code someone (or something) just wrote.
 *
 * It also means the bundle has to be INLINE. A `blob:` URL belongs to this
 * document's origin and an opaque-origin iframe is not allowed to load it, so a
 * `<script src=blob:…>` — the obvious way to do this — fails silently in exactly
 * this configuration.
 */
function renderPreview(code: string): void {
  const escaped = code.replaceAll("</script", "<\\/script");
  const parentOrigin = JSON.stringify(location.origin);
  preview.srcdoc = `<!doctype html>
<html><head><meta charset="utf-8" />
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script>
  // Runtime failures inside the preview are the point of the log pane, and an
  // opaque origin can still postMessage to its parent.
  addEventListener("error", (e) => parent.postMessage({ preview: String(e.message) }, ${parentOrigin}));
  addEventListener("unhandledrejection", (e) => parent.postMessage({ preview: String(e.reason) }, ${parentOrigin}));

  // The opaque preview gets one capability: /api/* requests. A transferred
  // MessagePort is the reply channel for exactly one request.
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const path = raw.startsWith("/api/")
      ? raw
      : (() => {
          try {
            const url = new URL(raw);
            return url.hostname === "preview.invalid" && url.pathname.startsWith("/api/")
              ? url.pathname + url.search
              : null;
          } catch { return null; }
        })();
    if (path === null) return nativeFetch(input, init);

    const request = input instanceof Request
      ? new Request(input, init)
      : new Request("http://preview.invalid" + path, init);
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    const channel = new MessageChannel();
    const reply = new Promise((resolve, reject) => {
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port1.onmessageerror = () => reject(new Error("the /api bridge reply was unreadable"));
    });
    const message = {
      previewApi: {
        method: request.method,
        path,
        headers: [...request.headers.entries()],
        ...(body === undefined ? {} : { body }),
      },
    };
    parent.postMessage(message, ${parentOrigin}, body === undefined
      ? [channel.port2]
      : [channel.port2, body.buffer]);
    const response = await reply;
    channel.port1.close();
    const responseBody = request.method === "HEAD" || [204, 205, 304].includes(response.status)
      ? null
      : response.body;
    return new Response(responseBody, { status: response.status, headers: response.headers });
  };
</script>
</head><body><div id="root"></div>
<script type="module">${escaped}</script>
</body></html>`;
}

addEventListener("message", (event: MessageEvent) => {
  // The origin is necessarily opaque; source identity plus strict payload
  // validation is the authority check for the one sandboxed frame.
  if (event.source !== preview.contentWindow || event.origin !== "null") return;
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "preview" in data) {
    log(`preview: ${String((data as { preview: unknown }).preview)}`, true);
    return;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "previewApi" in data &&
    event.ports[0] !== undefined
  ) {
    void forwardPreviewApi((data as { previewApi: unknown }).previewApi, event.ports[0]);
  }
});

type PreviewApiRequest = {
  method: string;
  path: string;
  headers: [string, string][];
  body?: Uint8Array;
};

function isPreviewApiRequest(value: unknown): value is PreviewApiRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<PreviewApiRequest>;
  return (
    typeof request.method === "string" &&
    typeof request.path === "string" &&
    request.path.startsWith("/api/") &&
    Array.isArray(request.headers) &&
    request.headers.every(
      (header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === "string" &&
        typeof header[1] === "string",
    ) &&
    (request.body === undefined || request.body instanceof Uint8Array)
  );
}

async function forwardPreviewApi(value: unknown, port: MessagePort): Promise<void> {
  try {
    if (!isPreviewApiRequest(value)) throw new Error("invalid /api bridge request");
    if (agent === undefined) throw new Error("the user agent is not running");
    const response = await agent.request({
      method: value.method,
      url: `${AGENT_ORIGIN}${value.path}`,
      headers: value.headers,
      ...(value.body === undefined ? {} : { body: value.body }),
    });
    port.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`/api bridge failed: ${message}`, true);
    port.postMessage({
      status: 502,
      headers: [["content-type", "text/plain; charset=utf-8"]],
      body: encoder.encode(message),
    });
  } finally {
    port.close();
  }
}

// ---------------------------------------------------------------------------
// UI

let selectedPath = ENTRY;

async function refreshFiles(): Promise<void> {
  const paths = await listFiles();
  fileList.replaceChildren();
  for (const path of paths) {
    const button = document.createElement("button");
    button.textContent = path;
    button.dataset.path = path;
    button.ariaCurrent = String(path === selectedPath);
    button.addEventListener("click", () => {
      void withBusy("opening", () => openFile(path));
    });
    fileList.appendChild(button);
  }
}

async function openFile(path: string): Promise<void> {
  selectedPath = path;
  editor.value = await readFile(path);
  for (const button of fileList.querySelectorAll("button")) {
    button.ariaCurrent = String(button.dataset.path === path);
  }
  status.textContent = path;
}

/** Bundle, render, and report. The status line is what the e2e watches. */
async function rebuild(): Promise<void> {
  const started = performance.now();
  const code = await build();
  const elapsed = Math.round(performance.now() - started);
  renderPreview(code);
  status.textContent = `built in ${elapsed}ms`;
  log(`built ${code.length} bytes in ${elapsed}ms`);
}

function exportedWorker(className: string): string {
  return `export { ${className} } from "./server/agent";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.AGENT.getByName("default").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
`;
}

async function exportProject(): Promise<void> {
  if (agentClassName === undefined) throw new Error("the user agent is not running");
  const paths = await listFiles();
  const sources = await Promise.all(
    paths.map(async (path): Promise<ZipEntry> => [path.slice(1), await readFile(path)]),
  );
  const app = await build();
  const wrangler = `${JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name: "vibe-platform-export",
      main: "worker.ts",
      compatibility_date: "2026-08-20",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [{ name: "AGENT", class_name: agentClassName }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: [agentClassName] }],
      assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
    },
    null,
    2,
  )}\n`;
  const publicHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Durable Object app</title>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
</head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>\n`;
  const readme = `# Exported vibe-platform project

The files under \`server/\` and \`src/\` are the exact workspace sources. \`worker.ts\` routes
\`/api/*\` to the \`${agentClassName}\` Durable Object and everything else to the built assets.

\`pnpm install\`, then \`pnpm exec wrangler deploy --dry-run\`, validates the Worker bundle and asset manifest locally.
It does not create Cloudflare resources, upload anything, or prove production credentials.

Run \`pnpm exec wrangler deploy\` when you are ready to deploy.
`;
  const packageJson = `${JSON.stringify(
    {
      name: "vibe-platform-export",
      private: true,
      type: "module",
      scripts: { deploy: "wrangler deploy", "deploy:dry": "wrangler deploy --dry-run" },
      dependencies: { agents: "0.21.0" },
      devDependencies: { wrangler: "^4.114.0" },
    },
    null,
    2,
  )}\n`;
  const bytes = storeZip([
    ...sources,
    ["worker.ts", exportedWorker(agentClassName)],
    ["public/index.html", publicHtml],
    ["public/app.js", app],
    ["wrangler.jsonc", wrangler],
    ["package.json", packageJson],
    ["README.md", readme],
  ]);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "vibe-platform.zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  status.textContent = "exported vibe-platform.zip";
  log(`exported ${bytes.length} bytes; server sources unchanged`);
}

let busy = false;

/** One action at a time, and a failed one says so in the status line and the log. */
async function withBusy(what: string, run: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  saveButton.disabled = true;
  buildButton.disabled = true;
  exportButton.disabled = true;
  status.textContent = `${what}…`;
  try {
    await run();
  } catch (error) {
    status.textContent = `${what} failed`;
    log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    busy = false;
    saveButton.disabled = false;
    buildButton.disabled = false;
    exportButton.disabled = false;
  }
}

saveButton.addEventListener("click", () => {
  void withBusy("saving", async () => {
    await writeFile(selectedPath, editor.value);
    // Durable before this line runs: the actor's output gate held the response
    // until the write it could reveal had committed.
    log(`saved ${selectedPath}`);
    await refreshFiles();
    if (selectedPath.startsWith("/server/")) await restartAgent();
    await rebuild();
  });
});

buildButton.addEventListener("click", () => {
  void withBusy("building", rebuild);
});

exportButton.addEventListener("click", () => {
  void withBusy("exporting", exportProject);
});

// ---------------------------------------------------------------------------
// Boot

async function boot(): Promise<void> {
  // Placement is asynchronous — a database has to open — so this is where a
  // storage failure surfaces, rather than inside whatever request came first.
  await workspace.ready();
  log(`actor placed; crossOriginIsolated=${String(crossOriginIsolated)}`);
  await refreshFiles();
  await openFile(ENTRY);
  await restartAgent(true);
  await withBusy("building", rebuild);
}

void boot().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
