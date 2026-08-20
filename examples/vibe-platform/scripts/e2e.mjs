/**
 * The example, driven end to end in a real browser.
 *
 * Plain node: a Vite dev server started in-process (so the COOP/COEP headers the
 * bundler needs are exactly the ones a developer gets), and headless Chromium
 * from the repo's own Playwright.
 *
 *   node scripts/e2e.mjs
 *
 * Three of the steps render React, which the preview fetches from esm.sh. If
 * that host is unreachable the run says SKIP for those and still asserts
 * everything that does not leave the machine: the actor placed, the seed landed,
 * the bundler ran, the edit was saved, and the edit survived a reload.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const TITLE_BEFORE = "The fern that lives in a Durable Object";
const TITLE_AFTER = `A fern that survived a reload at ${new Date().toISOString().slice(11, 19)}`;
const TIMEOUT = 60_000;

let failures = 0;
let skipped = 0;

const pass = (line) => console.log(`PASS  ${line}`);
const skip = (line) => {
  skipped += 1;
  console.log(`SKIP  ${line}`);
};
const fail = (line, error) => {
  failures += 1;
  const detail = String(error?.message ?? error).split("\n")[0];
  console.log(`FAIL  ${line}\n      ${detail}`);
};

async function step(name, run) {
  try {
    await run();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

/** esm.sh in under three seconds, or this run is offline. */
async function esmShReachable() {
  try {
    const response = await fetch("https://esm.sh/react@19.2.7", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** `VIBE_E2E_OFFLINE=1` exercises the no-network path deliberately. */
const forcedOffline = process.env.VIBE_E2E_OFFLINE === "1";
const online = forcedOffline ? false : await esmShReachable();
console.log(
  online
    ? "network: esm.sh reachable"
    : `network: esm.sh ${forcedOffline ? "blocked by VIBE_E2E_OFFLINE=1" : "unreachable"} — the three preview steps will SKIP`,
);

const { createServer } = await import("vite");
const { chromium } = await import("playwright");

const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  // Port 0 lets the OS pick, so a developer's own dev server is never in the way
  // and two runs cannot collide.
  server: { port: 0, strictPort: false },
  logLevel: "warn",
});
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`dev server: ${url}`);

const browser = await chromium.launch({ headless: true });
// A fresh context per run, so OPFS starts empty and the seed is always the
// thing under test.
const page = await browser.newPage();
if (forcedOffline) await page.route("https://esm.sh/**", (route) => route.abort());

const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});

const preview = () => page.frameLocator("#preview");
const file = (path) => page.locator(`#files button[data-path="${path}"]`);
const builtOk = () =>
  page.waitForFunction(() => /^built in \d+ms$/.test(document.querySelector("#status").textContent), {
    timeout: TIMEOUT,
  });

try {
  // 1 -----------------------------------------------------------------------
  await step("page loads and the actor seeded its starter files", async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    for (const seeded of ["/src/main.tsx", "/src/App.tsx", "/src/plant.ts"]) {
      await file(seeded).waitFor({ timeout: TIMEOUT });
    }
  });

  // 2 -----------------------------------------------------------------------
  await step("the page is cross-origin isolated", async () => {
    const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
    if (isolated !== true) throw new Error(`crossOriginIsolated === ${String(isolated)}`);
  });
  console.log(
    "      the COOP/COEP headers behind that are for @rolldown/browser (WASI threads →\n" +
      "      SharedArrayBuffer). The actor, the runtime and the OPFS SAH pool need none of it.",
  );

  // 3 -----------------------------------------------------------------------
  await step("build & run bundles the workspace out of the Durable Object", async () => {
    await page.locator("#build").click();
    await builtOk();
  });

  if (!online) {
    skip("the preview renders the starter app (needs esm.sh)");
    skip("clicking inside the preview updates React state (needs esm.sh)");
  } else {
    await step("the preview renders the starter app", async () => {
      const title = preview().getByTestId("title");
      await title.waitFor({ timeout: TIMEOUT });
      const text = await title.innerText();
      if (text !== TITLE_BEFORE) throw new Error(`preview title is ${JSON.stringify(text)}`);
    });

    // 4 ---------------------------------------------------------------------
    await step("clicking inside the preview updates React state", async () => {
      const stage = preview().getByTestId("stage");
      const before = await stage.innerText();
      await preview().getByRole("button", { name: "water it" }).click();
      await stage.filter({ hasText: "watered 1" }).waitFor({ timeout: TIMEOUT });
      if ((await stage.innerText()) === before) throw new Error("the preview did not re-render");
    });
  }

  // 5 -----------------------------------------------------------------------
  await step("editing a file in the UI, saving it, and rebuilding", async () => {
    await file("/src/App.tsx").click();
    const editor = page.locator("#editor");
    await page.waitForFunction(
      (marker) => document.querySelector("#editor").value.includes(marker),
      TITLE_BEFORE,
      { timeout: TIMEOUT },
    );
    const source = await editor.inputValue();
    await editor.fill(source.replace(TITLE_BEFORE, TITLE_AFTER));
    await page.locator("#save").click();
    await builtOk();
  });

  if (!online) {
    skip("the preview shows the edited string (needs esm.sh)");
  } else {
    await step("the preview shows the edited string", async () => {
      await preview()
        .getByTestId("title")
        .filter({ hasText: TITLE_AFTER })
        .waitFor({ timeout: TIMEOUT });
    });
  }

  // 6 -----------------------------------------------------------------------
  await step("the edit survives a page reload (OPFS persistence)", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await file("/src/App.tsx").waitFor({ timeout: TIMEOUT });
    await file("/src/App.tsx").click();
    await page.waitForFunction(
      () => document.querySelector("#editor").value.includes("export function App"),
      undefined,
      { timeout: TIMEOUT },
    );
    const source = await page.locator("#editor").inputValue();
    if (!source.includes(TITLE_AFTER)) {
      throw new Error("the reloaded workspace does not contain the edit");
    }
    if (source.includes(TITLE_BEFORE)) {
      throw new Error("the reloaded workspace was re-seeded instead of reopened");
    }
  });

  if (failures > 0) {
    console.log("\n--- page log ---");
    console.log(await page.locator("#log").innerText());
    if (pageErrors.length > 0) {
      console.log("--- page errors ---");
      for (const error of pageErrors) console.log(error);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}` +
    (skipped > 0 ? ` (${skipped} skipped: no network)` : ""),
);
process.exit(failures === 0 ? 0 : 1);
