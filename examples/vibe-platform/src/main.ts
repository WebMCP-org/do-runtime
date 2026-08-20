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
import { newRpcSession } from "@mcp-b/do-runtime";
import { RpcTarget } from "@mcp-b/do-runtime/cloudflare-workers";
import {
  WORKSPACE_ORIGIN,
  type PageRpc,
  type WireRequest,
  type WorkspaceBoot,
  type WorkspaceRpc,
} from "./wire";

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

const worker = new Worker(new URL("./worker/host.worker.ts", import.meta.url), { type: "module" });

// An uncaught exception in a dedicated worker goes nowhere anyone can see it:
// what it eventually causes is a call that never answers, several layers away.
// These two listeners are the whole of the fail-loudly wiring on this side.
worker.addEventListener("error", (event: ErrorEvent) => {
  fail(`the workspace worker failed: ${event.message}`);
});
worker.addEventListener("messageerror", () => {
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
worker.postMessage({ port: channel.port2 } satisfies WorkspaceBoot, [channel.port2]);
const workspace = newRpcSession<WorkspaceRpc>(channel.port1, new PageTarget());

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
async function build(): Promise<string> {
  // One listing per build, so `resolveId` is a set lookup rather than a round
  // trip per candidate extension.
  const paths = new Set(await listFiles());

  const bundle = await rolldown({
    input: ENTRY,
    cwd: "/",
    external: (id: string) => !id.startsWith(".") && !id.startsWith("/"),
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
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const first = output[0];
  if (first === undefined) throw new Error("rolldown produced no output chunk");
  return first.code;
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
  preview.srcdoc = `<!doctype html>
<html><head><meta charset="utf-8" />
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script>
  // Runtime failures inside the preview are the point of the log pane, and an
  // opaque origin can still postMessage to its parent.
  addEventListener("error", (e) => parent.postMessage({ preview: String(e.message) }, "*"));
  addEventListener("unhandledrejection", (e) => parent.postMessage({ preview: String(e.reason) }, "*"));
</script>
</head><body><div id="root"></div>
<script type="module">${escaped}</script>
</body></html>`;
}

addEventListener("message", (event: MessageEvent) => {
  // The preview is an opaque origin, so `event.origin` is the string "null" and
  // proves nothing. The shape is the check.
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "preview" in data) {
    log(`preview: ${String((data as { preview: unknown }).preview)}`, true);
  }
});

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

let busy = false;

/** One action at a time, and a failed one says so in the status line and the log. */
async function withBusy(what: string, run: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  saveButton.disabled = true;
  buildButton.disabled = true;
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
  }
}

saveButton.addEventListener("click", () => {
  void withBusy("saving", async () => {
    await writeFile(selectedPath, editor.value);
    // Durable before this line runs: the actor's output gate held the response
    // until the write it could reveal had committed.
    log(`saved ${selectedPath}`);
    await refreshFiles();
    await rebuild();
  });
});

buildButton.addEventListener("click", () => {
  void withBusy("building", rebuild);
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
  await withBusy("building", rebuild);
}

void boot().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
