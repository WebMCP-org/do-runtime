/**
 * End-to-end proof that the runtime works inside a real MV3 extension.
 *
 * Plain node, no test framework: it builds the extension, loads the built
 * `dist/` into a headless Chromium with a throwaway profile, creates the real
 * offscreen document, and drives it through extension messages.
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

/** One operation sent from the service worker to the real offscreen host. */
async function op(page, name, args = []) {
  return await page.evaluate(
    async ([opName, opArgs]) => {
      const response = await chrome.runtime.sendMessage({
        type: "host-op",
        op: opName,
        args: opArgs,
      });
      if (response?.ok !== true) throw new Error(response?.error ?? "no host answered");
      return response.value;
    },
    [name, args],
  );
}

async function ensureHost(page) {
  await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: "ensure-host" });
    if (response?.ok !== true) throw new Error(response?.error ?? "host creation failed");
  });
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

    const popup = await context.newPage();
    popup.on("pageerror", (error) => {
      console.log(`      [popup error] ${error.message}`);
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await ensureHost(popup);

    const storage = await op(popup, "storageStatus");
    if (!/^storage: (persistent|best-effort), \d+ B used of \d+ B$/.test(storage)) {
      fail("the extension reports origin persistence and quota", storage);
    } else {
      pass(`the extension reports origin persistence and quota (${storage})`);
    }

    const contender = await context.newPage();
    try {
      await contender.goto(`chrome-extension://${extensionId}/offscreen.html`, {
        timeout: BOOT_TIMEOUT_MS,
      });
      await contender
        .getByText("another extension page owns this Durable Object host")
        .waitFor({ timeout: 10_000 });
      pass("a duplicate extension supervisor is refused before it reaches OPFS");
    } catch (error) {
      fail("a duplicate extension supervisor is refused before it reaches OPFS", error.message);
    } finally {
      await contender.close();
    }

    // ---------------------------------------------------------------------
    // 1. Three gated events, each one committing before its reply leaves.
    context.setDefaultTimeout(BOOT_TIMEOUT_MS);
    const first = await op(popup, "increment");
    check("first increment answers 1", first, 1);
    await op(popup, "increment");
    await op(popup, "increment");

    let snapshot = await op(popup, "snapshot");
    check("snapshot after three increments", snapshot.value, 3);
    check(
      "three increment events recorded",
      snapshot.events.filter((event) => event.kind === "increment").length,
      3,
    );

    const synced = await op(popup, "sdkState");
    check("the Agents client received state over a live socket", synced.value, 3);

    const called = await op(popup, "sdkIncrement");
    check("the Agents client called a decorated method", called, 4);

    const stubbed = await op(popup, "directStubIncrement");
    check("getAgentByName returned a direct SDK stub", stubbed, 5);

    const streamed = await op(popup, "sdkStream");
    check("the streaming callable delivered every chunk", streamed.chunks.join(","), "5,6");
    check("the streaming callable delivered its final value", streamed.final, "done");

    const clientState = await op(popup, "sdkSetState", [10]);
    check("the Agents client accepted a local state update", clientState.value, 10);
    for (let attempts = 0; attempts < 20; attempts += 1) {
      snapshot = await op(popup, "snapshot");
      if (snapshot.value === 10) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("the client state update reached the Agent", snapshot.value, 10);

    const tools = await op(popup, "mcp", ["tools/list", {}]);
    check(
      "the current Agents MCP handler listed its tool",
      tools.result.tools.some((tool) => tool.name === "counter-value"),
      true,
    );
    const tool = await op(popup, "mcp", ["tools/call", { name: "counter-value", arguments: {} }]);
    check("the MCP tool read Agent state", tool.result.content[0].text, "10");

    await op(popup, "email", ["Hello Agent", "This came through Email Routing."]);
    snapshot = await op(popup, "snapshot");
    check(
      "routeAgentEmail delivered to the Agent hook",
      snapshot.events.filter((event) => event.kind === "sdk-email:Hello Agent").length,
      1,
    );

    await op(popup, "enqueueIncrement", [2]);
    snapshot = await op(popup, "snapshot");
    check("the SDK queue callback updated Agent state", snapshot.value, 12);
    check(
      "the SDK queue callback completed",
      snapshot.events.filter((event) => event.kind === "sdk-queue").length,
      1,
    );

    const subAgents = await op(popup, "subAgents");
    check(
      "two concurrent Agents SDK sub-agents keep independent durable state",
      JSON.stringify(subAgents),
      JSON.stringify([
        { name: "alpha", value: 1, parentValue: 12 },
        { name: "beta", value: 1, parentValue: 12 },
      ]),
    );
    const overlappedSubAgents = await op(popup, "overlapSubAgents");
    check(
      "overlapping sub-agent awaits resume in the owning Agent contexts",
      JSON.stringify(overlappedSubAgents),
      JSON.stringify([
        { name: "alpha", value: 2, parentValue: 12 },
        { name: "beta", value: 2, parentValue: 12 },
      ]),
    );

    const subAgentLifecycle = await op(popup, "subAgentLifecycle");
    check(
      "sub-agent abort preserves storage and delete wipes it",
      subAgentLifecycle.join(","),
      "1,2,1",
    );

    const nestedSubAgent = await op(popup, "nestedSubAgent");
    check(
      "a nested sub-agent keeps its own state and reaches its direct parent",
      JSON.stringify(nestedSubAgent),
      JSON.stringify({ childValue: 1, leafValue: 1 }),
    );

    // ---------------------------------------------------------------------
    // 2. A real alarm: armed in the actor's storage, delivered by the
    //    AlarmScheduler's own database in the same worker.
    const childArmedFor = await op(popup, "armSubAgentWake", [5000]);
    if (typeof childArmedFor !== "number") {
      fail("a sub-agent answers its scheduled time", String(childArmedFor));
    } else {
      pass(`a sub-agent answers its scheduled time (${childArmedFor - Date.now()}ms out)`);
    }

    const armedFor = await op(popup, "armWake", [5000]);
    if (typeof armedFor !== "number") fail("armWake answers a scheduled time", String(armedFor));
    else pass(`armWake answers a scheduled time (${armedFor - Date.now()}ms out)`);

    const projectedWake = await worker.evaluate(async () => {
      if (chrome.alarms === undefined) return null;
      return (await chrome.alarms.get("do-runtime-wake"))?.scheduledTime ?? null;
    });
    if (typeof projectedWake !== "number") {
      fail("the durable wake is projected onto chrome.alarms", String(projectedWake));
    } else {
      pass(`the durable wake is projected onto chrome.alarms (${projectedWake - Date.now()}ms out)`);
    }

    await worker.evaluate(async () => chrome.offscreen.closeDocument());
    pass("the offscreen host was removed before the durable wake");

    const deadline = Date.now() + ALARM_TIMEOUT_MS;
    let alarms = 0;
    while (Date.now() < deadline) {
      try {
        snapshot = await op(popup, "snapshot");
        alarms = snapshot.events.filter((event) => event.kind === "sdk-schedule").length;
        if (alarms > 0) break;
      } catch {
        // Expected until chrome.alarms wakes the service worker and it recreates the host.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("chrome.alarms recreated the host and delivered the alarm", alarms, 1);
    check("the alarm handler's write landed", snapshot.value, 13);
    check(
      "the recreated host delivered durable work to the sub-agent",
      await op(popup, "scheduledSubAgentValue"),
      1,
    );

    // ---------------------------------------------------------------------
    // 3. Persistence across offscreen recreation: a new document, a new worker, a new
    //    container, the same OPFS files.
    await worker.evaluate(async () => chrome.offscreen.closeDocument());
    await ensureHost(popup);
    snapshot = await op(popup, "snapshot");
    check("the Agent state survived offscreen recreation", snapshot.value, 13);
    check(
      "the alarm event survived offscreen recreation",
      snapshot.events.filter((event) => event.kind === "sdk-schedule").length,
      1,
    );

    const reconnectedState = await op(popup, "sdkState");
    check("a recreated Agents client resynced durable state", reconnectedState.value, 13);
    const afterReload = await op(popup, "sdkIncrement");
    check("a recreated Agents client called a decorated method", afterReload, 14);

    const restartedSubAgents = await op(popup, "subAgents");
    check(
      "sub-agent state survived offscreen recreation",
      JSON.stringify(restartedSubAgents),
      JSON.stringify([
        { name: "alpha", value: 3, parentValue: 14 },
        { name: "beta", value: 3, parentValue: 14 },
      ]),
    );
    check(
      "nested sub-agent state survived offscreen recreation",
      JSON.stringify(await op(popup, "nestedSubAgent")),
      JSON.stringify({ childValue: 2, leafValue: 2 }),
    );
    check(
      "scheduled sub-agent state survived offscreen recreation",
      await op(popup, "scheduledSubAgentValue"),
      1,
    );

    // ---------------------------------------------------------------------
    // 4. Nothing broke in the background.
    const status = await op(popup, "status");
    check("the container never broke", status.broken, null);
    check("the alarm scheduler had no background failure", status.alarmTaskFailure, null);

    // ---------------------------------------------------------------------
    // 5. The popup reaches that same real offscreen host.
    await popup.click("#increment");
    const printed = await waitForOutput(popup, /^[^\n]+  increment\n/, BOOT_TIMEOUT_MS);
    const viaOffscreen = Number(printed.split("\n")[1]);
    check("the offscreen document continues the same storage", viaOffscreen, 15);

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
