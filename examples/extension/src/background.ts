/**
 * The MV3 service worker. Its only job is to make sure the offscreen document
 * exists.
 *
 * It deliberately holds no actor, no worker and no session: a service worker is
 * evicted after seconds of idleness and cannot keep a dedicated Worker — or an
 * OPFS sync access handle — across that. Everything durable lives behind the
 * offscreen document; this file is the thing that puts the offscreen document
 * back.
 */

import type { ExtensionMessage, ExtensionResponse } from "./protocol";

const OFFSCREEN_URL = "offscreen.html";

const JUSTIFICATION =
  "Hosts the Durable Object runtime's actor worker, which needs OPFS synchronous access " +
  "handles and therefore a dedicated Worker that outlives the service worker.";

/**
 * Chrome reports a document that already exists by refusing to create a second
 * one, and the refusal's TEXT is the only place the fact appears.
 *
 * This substring is matched rather than an error code because Chrome offers no
 * code for it.
 */
const SINGLE_DOCUMENT_ERROR = "single offscreen document";

/**
 * String literals rather than `chrome.runtime.ContextType.OFFSCREEN_DOCUMENT`
 * and `chrome.offscreen.Reason.WORKERS`.
 *
 * Chrome exposes those enum objects at runtime, but `chrome-types` models both
 * as string-union TYPES with no runtime value, so the dotted form does not
 * compile. The literals are the same wire values and work in both worlds.
 */
const OFFSCREEN_CONTEXT: chrome.runtime.ContextType = "OFFSCREEN_DOCUMENT";
const OFFSCREEN_REASON: chrome.offscreen.Reason = "WORKERS";

/** Whether Chrome currently reports a live offscreen document. */
async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [OFFSCREEN_CONTEXT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

function createOffscreen(): Promise<void> {
  return chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: JUSTIFICATION,
  });
}

/**
 * In flight, so two callers never both try to create the document.
 *
 * **This is not defensive tidiness, it is the fix for a measured failure.**
 * `onInstalled` and the popup's first `ensure-host` arrive within milliseconds
 * of each other. Unserialised, both see no document, both call
 * `createDocument`, the loser gets "single offscreen document", and the recovery
 * below then CLOSES the winner's perfectly healthy document — taking its worker,
 * its container and its OPFS handles with it — and builds a third. Measured, the
 * symptom was a popup whose first operation came back "no extension context
 * answered" while a later one succeeded.
 */
let ensuring: Promise<void> | undefined;

/**
 * Create the offscreen document if it is not there, and recover if it is there
 * in a way `getContexts` cannot see.
 *
 * **The catch is the whole of this function.** A crashed offscreen document is
 * absent from `getContexts` and still holds the one offscreen slot, so the check
 * says "create it" and the create fails. Chrome's error string is the only
 * report of the corpse; closing and retrying once is the only way back. Without
 * this, one renderer crash means the extension has no actor until the browser is
 * restarted — and nothing anywhere says why.
 *
 * Retried ONCE rather than in a loop: the second failure is a real failure and
 * belongs at the caller, not in a spin.
 */
export function ensureOffscreen(): Promise<void> {
  ensuring ??= (async (): Promise<void> => {
    if (await offscreenExists()) return;
    try {
      await createOffscreen();
    } catch (error: unknown) {
      if (!String(error).includes(SINGLE_DOCUMENT_ERROR)) throw error;
      console.warn(
        "[do-runtime example] an offscreen document held the slot but was not listed; " +
          "closing it and retrying once.",
      );
      await chrome.offscreen.closeDocument();
      await createOffscreen();
    }
  })().finally(() => {
    ensuring = undefined;
  });
  return ensuring;
}

/**
 * `ensure-host` is the popup asking for a host before it sends any operation.
 * `host-op` messages are NOT answered here — the offscreen document receives
 * them directly — so this listener returns `false` for them and lets the channel
 * belong to whoever will actually reply.
 */
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ): boolean => {
    if (message?.type !== "ensure-host") return false;
    void ensureOffscreen().then(
      () => {
        sendResponse({ ok: true, value: null });
      },
      (error: unknown) => {
        sendResponse({ ok: false, error: String(error) });
      },
    );
    return true;
  },
);

/**
 * Start the host on install and on browser startup, so an armed alarm can fire
 * without anyone opening the popup first.
 *
 * This is where a production extension would go further and project the
 * scheduler's next wake onto `chrome.alarms`; see this example's README for why
 * that is deliberately not shown here.
 */
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
});
