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

import {
  BrowserAlarmCoordinator,
  parseBrowserAlarmProjection,
  parseBrowserAlarmTransportJournal,
} from "@mcp-b/do-runtime/browser/alarm-coordinator";
import { OffscreenDocumentCoordinator } from "@mcp-b/do-runtime/browser/offscreen-document";
import {
  parseExtensionResponse,
  WAKE_ALARM,
  type ExtensionMessage,
  type ExtensionResponse,
} from "./protocol";

const OFFSCREEN_URL = "offscreen.html";

/** The alarm coordinator's journal, which outlives every service worker. */
const WAKE_JOURNAL = "do-runtime-wake-journal";

/** How long a document may take to answer its first ping before it is replaced. */
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 50;

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
 * The runtime coalesces concurrent creation, recovers Chrome's hidden, occupied
 * offscreen slot, and waits for the document to answer. This adapter supplies
 * only the Chrome operations, its string-only occupied-slot signal, and a ping.
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
      "[do-runtime example] replacing an offscreen document that is unlisted or not answering.",
    );
    // A document that is already gone refuses to close; creating one is still right.
    await chrome.offscreen.closeDocument().catch(() => {});
  },
  isOccupiedError: (error) => String(error).includes(SINGLE_DOCUMENT_ERROR),
  /**
   * `createDocument` resolves before `offscreen.ts` registers its listener
   * behind a top-level await, and Chrome answers a message sent in that gap
   * with nothing rather than queueing it. Each ping races the deadline, because
   * a wedged listener never answers and `ready()` must settle.
   */
  async ready() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, READY_TIMEOUT_MS);
    });
    try {
      for (;;) {
        const answer: unknown = await Promise.race([
          chrome.runtime
            .sendMessage({ type: "host-ping" } satisfies ExtensionMessage)
            .catch(() => undefined),
          expired,
        ]);
        if (answer !== undefined) return;
        if (Date.now() >= deadline) throw new Error("the offscreen document did not answer");
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }
    } finally {
      clearTimeout(timer);
    }
  },
  /** A document still mute after the timeout is replaced once, not pinged forever. */
  replaceUnready: () => true,
});

/**
 * The physical half of the worker's `AlarmScheduler`. The runtime journals each
 * hop, so a service worker stopped mid-delivery leaves a watchdog that resumes
 * it; this adapter supplies Chrome's alarm and storage calls and the delivery.
 */
const alarms = new BrowserAlarmCoordinator({
  // Recreate the host if Chrome removed it, then wait until its scheduler has
  // finished everything due by the consumed wake.
  async deliver(scheduledTime) {
    await offscreenDocument.ensure();
    const response: unknown = await chrome.runtime.sendMessage({
      type: "host-op",
      op: "fireAlarm",
      args: [scheduledTime],
    } satisfies ExtensionMessage);
    const result = parseExtensionResponse(response);
    if (!result.ok) throw new Error(result.error);
    const projection = parseBrowserAlarmProjection(result.value);
    if (projection === null) throw new TypeError("the host answered an invalid wake projection");
    return projection;
  },
  physical: {
    async clear() {
      await chrome.alarms.clear(WAKE_ALARM);
    },
    create: (when) => chrome.alarms.create(WAKE_ALARM, { when }),
  },
  store: {
    load: async () =>
      parseBrowserAlarmTransportJournal((await chrome.storage.local.get(WAKE_JOURNAL))[WAKE_JOURNAL]),
    save: (journal) => chrome.storage.local.set({ [WAKE_JOURNAL]: journal }),
  },
});
void alarms.reconcile().catch((error: unknown) => {
  console.error("[do-runtime example] the alarm journal could not be reconciled:", error);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `ensure-host` is the popup asking for a host before it sends any operation;
 * `project-wake` carries the scheduler's latest projection to the coordinator.
 * `host-ping` and `host-op` messages are NOT answered here — the offscreen
 * document receives them directly — so this listener returns `false` for them
 * and lets the channel belong to whoever will actually reply.
 */
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ): boolean => {
    if (!isRecord(message) || (message.type !== "ensure-host" && message.type !== "project-wake")) {
      return false;
    }
    let operation: Promise<void>;
    if (message.type === "ensure-host") {
      operation = offscreenDocument.ensure();
    } else {
      const projection = parseBrowserAlarmProjection(message.projection);
      operation =
        projection === null
          ? Promise.reject(new TypeError("invalid projected wake message"))
          : alarms.project(projection);
    }
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
  void alarms.fire(alarm.scheduledTime).catch((error: unknown) => {
    console.error("[do-runtime example] the alarm wake was not delivered:", error);
  });
});

/**
 * Start the host on install and on browser startup, without waiting for a popup.
 */
chrome.runtime.onInstalled.addListener(() => {
  void offscreenDocument.ensure();
});
chrome.runtime.onStartup.addListener(() => {
  void offscreenDocument.ensure();
});
