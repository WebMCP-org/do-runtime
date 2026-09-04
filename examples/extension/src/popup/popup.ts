/**
 * The popup. Three buttons and an output pane.
 *
 * It talks to nothing but `chrome.runtime.sendMessage`: `ensure-host` is
 * answered by the service worker, and every `host-op` is answered by the
 * offscreen document, which receives extension messages directly. The popup
 * holds no session and no state, because a popup is destroyed the moment it
 * closes.
 */

import {
  parseExtensionResponse,
  type ExtensionMessage,
  type ExtensionResponse,
  type HostOp,
} from "../protocol";

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`popup.html is missing ${selector}`);
  return element;
}

const output = mustFind<HTMLPreElement>("#output");

/** Newest first, so the last thing that happened is the thing you can see. */
function print(label: string, value: unknown): void {
  const line = `${new Date().toLocaleTimeString()}  ${label}\n${JSON.stringify(value, null, 2)}`;
  output.textContent = `${line}\n\n${output.textContent ?? ""}`;
}

/**
 * `undefined` — the raw value, not a result — is how Chrome says "no listener
 * claimed this message". Every other answer is an `ExtensionResponse`, because
 * `sendResponse` cannot reject and the two sides settle rather than throw.
 */
async function sendOnce(message: ExtensionMessage): Promise<ExtensionResponse | undefined> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  return response === undefined ? undefined : parseExtensionResponse(response);
}

/**
 * One retry, and only for "nobody answered".
 *
 * `chrome.offscreen.createDocument` resolves when the document has loaded, but
 * an extension message sent immediately after can still arrive before that
 * page's `onMessage` listener is registered, and Chrome answers `undefined`
 * rather than queueing. Measured: the popup's first operation failed this way
 * while every later one succeeded.
 *
 * A real error from the other side is NOT retried — it comes straight out of
 * here, because retrying a call that failed on its merits would only hide it.
 */
async function send(message: ExtensionMessage): Promise<unknown> {
  let response = await sendOnce(message);
  if (response === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    response = await sendOnce(message);
  }
  if (response === undefined) {
    throw new Error("no extension context answered; is the offscreen document up?");
  }
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

/**
 * Ask the service worker for a host before anything else.
 *
 * Both halves matter: the service worker may itself have been evicted (the
 * message wakes it), and the offscreen document may be gone (the service worker
 * recreates it). Neither is an error state — it is the ordinary MV3 lifecycle.
 */
async function ensureHost(): Promise<void> {
  await send({ type: "ensure-host" });
}

async function op(name: HostOp, ...args: readonly unknown[]): Promise<void> {
  try {
    await ensureHost();
    print(name, await send({ type: "host-op", op: name, args }));
  } catch (error: unknown) {
    print(`${name} failed`, String(error));
  }
}

function on(id: string, handler: () => void): void {
  mustFind<HTMLButtonElement>(`#${id}`).addEventListener("click", handler);
}

on("increment", () => void op("increment"));
on("read", () => void op("snapshot"));
on("arm", () => void op("armWake", 5_000));
on("status", () => void op("status"));

// Boot the host as soon as the popup opens, so the first click is not the thing
// that pays for placing the actor.
void op("snapshot");
