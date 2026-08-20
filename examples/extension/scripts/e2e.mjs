/**
 * End-to-end proof that the runtime works inside a real MV3 extension.
 *
 * Plain node, no test framework: it builds the extension, loads the built
 * `dist/` into a headless Chromium with a throwaway profile, and drives the
 * offscreen document through `window.__host`.
 *
 * **It drives a TAB, not the offscreen document.** Playwright has no page handle
 * for an offscreen document — it is not a tab, not a frame, and not a worker
 * target — so the same `offscreen.html` is opened at its `chrome-extension://`
 * URL instead. Nothing in that page is conditional on being offscreen, so the
 * tab boots the same module worker over the same OPFS pool in the same extension
 * origin. What it does not exercise is `chrome.offscreen.createDocument` itself;
 * that path is covered by loading the extension and clicking the popup by hand.
 *
 *     node scripts/e2e.mjs
 *
 * `playwright` resolves from the repo root's `node_modules`, which is why this
 * file is `.mjs` with a dynamic import rather than a dependency of the example.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const example = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dist = `${example}dist`;
const profile = `${example}.e2e-profile`;

/** How long to wait for the alarm to be delivered. It is armed for 2s. */
const ALARM_TIMEOUT_MS = 15_000;
/** How long to wait for the first op, which pays for wasm init and the OPFS pool. */
const BOOT_TIMEOUT_MS = 30_000;

let failures = 0;

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message, detail) {
  failures += 1;
  console.log(`FAIL  ${message}`);
  if (detail !== undefined) console.log(`      ${detail}`);
}

function check(message, actual, expected) {
  if (actual === expected) pass(`${message} (${JSON.stringify(actual)})`);
  else fail(message, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The build is a precondition, so this script owns it rather than assuming it. */
function build() {
  const result = spawnSync(
    process.execPath,
    [`${repoRoot}node_modules/vite/bin/vite.js`, "build"],
    { cwd: example, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.log("FAIL  vite build");
    process.exit(1);
  }
}

/** One `window.__host` call in the page, with the arguments serialised in. */
async function op(page, name, args = []) {
  return await page.evaluate(
    async ([opName, opArgs]) => {
      const host = window.__host;
      if (host === undefined) throw new Error("window.__host is not installed");
      return await host[opName](...opArgs);
    },
    [name, args],
  );
}

/** Poll the popup's output pane until it shows something matching `pattern`. */
async function waitForOutput(page, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.querySelector("#output")?.textContent ?? "");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return text;
}

async function main() {
  build();

  // A fresh profile per run, so the counter starts at zero and the assertions
  // below are absolute rather than relative to whatever a previous run left.
  rmSync(profile, { recursive: true, force: true });

  const { chromium } = await import("playwright");

  const context = await chromium.launchPersistentContext(profile, {
    // `headless: false` plus `--headless=new` is the combination that loads an
    // unpacked extension: Chromium's old headless mode has no extension system
    // at all, and Playwright's `headless: true` still selects it for this launch
    // path.
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  });

  // Surface everything the extension says, so a failure below is diagnosable
  // without re-running by hand.
  context.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.log(`      [page ${message.type()}] ${message.text()}`);
    }
  });
  context.on("weberror", (error) => {
    console.log(`      [page error] ${error.error().message}`);
  });

  try {
    // The service worker target is where the extension id comes from; there is
    // no other API that reports it for an unpacked load.
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: BOOT_TIMEOUT_MS }));
    const extensionId = new URL(worker.url()).host;
    pass(`service worker up, extension id ${extensionId}`);

    const page = await context.newPage();
    page.on("pageerror", (error) => {
      console.log(`      [page error] ${error.message}`);
    });
    await page.goto(`chrome-extension://${extensionId}/offscreen.html`, {
      timeout: BOOT_TIMEOUT_MS,
    });

    // ---------------------------------------------------------------------
    // 1. Three gated events, each one committing before its reply leaves.
    page.setDefaultTimeout(BOOT_TIMEOUT_MS);
    const first = await op(page, "increment");
    check("first increment answers 1", first, 1);
    await op(page, "increment");
    await op(page, "increment");

    let snapshot = await op(page, "snapshot");
    check("snapshot after three increments", snapshot.value, 3);
    check(
      "three increment events recorded",
      snapshot.events.filter((event) => event.kind === "increment").length,
      3,
    );

    // ---------------------------------------------------------------------
    // 2. A real alarm: armed in the actor's storage, delivered by the
    //    AlarmScheduler's own database in the same worker.
    const armedFor = await op(page, "armWake", [2000]);
    if (typeof armedFor !== "number") fail("armWake answers a scheduled time", String(armedFor));
    else pass(`armWake answers a scheduled time (${armedFor - Date.now()}ms out)`);

    const deadline = Date.now() + ALARM_TIMEOUT_MS;
    let alarms = 0;
    while (Date.now() < deadline) {
      snapshot = await op(page, "snapshot");
      alarms = snapshot.events.filter((event) => event.kind === "alarm").length;
      if (alarms > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("the alarm was delivered", alarms, 1);
    check("the alarm handler's write landed", snapshot.value, 4);

    // ---------------------------------------------------------------------
    // 3. Persistence across a page reload: a new document, a new worker, a new
    //    container, the same OPFS files.
    await page.reload({ timeout: BOOT_TIMEOUT_MS });
    snapshot = await op(page, "snapshot");
    check("the counter survived the reload", snapshot.value, 4);
    check(
      "the alarm event survived the reload",
      snapshot.events.filter((event) => event.kind === "alarm").length,
      1,
    );

    const afterReload = await op(page, "increment");
    check("increment after the reload continues the count", afterReload, 5);

    // ---------------------------------------------------------------------
    // 4. Nothing broke in the background.
    const status = await op(page, "status");
    check("the container never broke", status.broken, null);
    check("the alarm scheduler had no background failure", status.alarmTaskFailure, null);

    // ---------------------------------------------------------------------
    // 5. The shipped path, last because it needs the pool this tab is holding.
    //
    //    An OPFS SAH pool takes an EXCLUSIVE sync access handle on every one of
    //    its files, so exactly one context in the extension may hold it. Closing
    //    this tab is what releases it; the popup then goes popup → service
    //    worker → `chrome.offscreen.createDocument` → a worker inside the real
    //    offscreen document, and finds the same durable counter this tab left.
    await page.close();

    const popup = await context.newPage();
    popup.on("pageerror", (error) => {
      console.log(`      [popup error] ${error.message}`);
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await popup.click("#increment");
    const printed = await waitForOutput(popup, /"increment"|increment failed/, BOOT_TIMEOUT_MS);
    const viaOffscreen = /^\s*6\s*$/m.test(printed) ? 6 : printed.split("\n").slice(0, 3).join(" ");
    check("the offscreen document continues the same storage", viaOffscreen, 6);

    const offscreenContexts = await worker.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length,
    );
    check("the service worker created one offscreen document", offscreenContexts, 1);
  } catch (error) {
    fail("the run threw", error?.stack ?? String(error));
  } finally {
    await context.close();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
