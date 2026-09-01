/**
 * The MV3 service worker: offscreen lifecycle and the physical alarm watchdog.
 *
 * It deliberately holds no actor, no worker and no session: a service worker is
 * evicted after seconds of idleness and cannot keep a dedicated Worker — or an
 * OPFS sync access handle — across that. Everything durable lives behind the
 * offscreen document; this file is the thing that puts the offscreen document
 * back. It also owns `chrome.alarms`, an API Chrome does not expose inside an
 * offscreen document, while the worker's `AlarmScheduler` remains authoritative
 * for alarm identity, retry policy, and delivery.
 */

import { OffscreenDocumentCoordinator } from "@mcp-b/do-runtime/browser/offscreen-document";
import { WAKE_ALARM, type ExtensionMessage, type ExtensionResponse } from "./protocol";

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

/**
 * The runtime coalesces concurrent creation and recovers Chrome's hidden,
 * occupied offscreen slot. This adapter supplies only the Chrome operations and
 * its string-only occupied-slot signal.
 */
const offscreenDocument = new OffscreenDocumentCoordinator({
  async exists() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [OFFSCREEN_CONTEXT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  },
  create: () =>
    chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [OFFSCREEN_REASON],
      justification: JUSTIFICATION,
    }),
  async close() {
    console.warn(
      "[do-runtime example] an offscreen document held the slot but was not listed; " +
        "closing it and retrying once.",
    );
    await chrome.offscreen.closeDocument();
  },
  isOccupiedError: (error) => String(error).includes(SINGLE_DOCUMENT_ERROR),
});

export function ensureOffscreen(): Promise<void> {
  return offscreenDocument.ensure();
}

async function projectWake(scheduledTime: number | null): Promise<void> {
  if (scheduledTime === null) {
    await chrome.alarms.clear(WAKE_ALARM);
    return;
  }
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
    throw new TypeError("projected alarm time must be a non-negative safe integer");
  }
  await chrome.alarms.create(WAKE_ALARM, { when: scheduledTime });
}

/**
 * `ensure-host` is the popup asking for a host before it sends any operation;
 * `project-wake` mirrors the scheduler's earliest durable wait into Chrome.
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
    if (message?.type !== "ensure-host" && message?.type !== "project-wake") return false;
    const operation =
      message.type === "ensure-host" ? ensureOffscreen() : projectWake(message.scheduledTime);
    void operation.then(
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WAKE_ALARM) return;
  void ensureOffscreen().catch((error: unknown) => {
    console.error("[do-runtime example] alarm wake could not recreate the host:", error);
  });
});

/**
 * Start the host on install and on browser startup, without waiting for a popup.
 */
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
});
