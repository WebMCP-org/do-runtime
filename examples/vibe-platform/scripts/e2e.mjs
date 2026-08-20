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
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const TITLE_BEFORE = "The fern that lives in a Durable Object";
const TITLE_AFTER = `A fern that survived a reload at ${new Date().toISOString().slice(11, 19)}`;
const TIMEOUT = 60_000;
const execFileAsync = promisify(execFile);

let failures = 0;
let skipped = 0;

const pass = (line) => console.log(`PASS  ${line}`);
const skip = (line) => {
  skipped += 1;
  console.log(`SKIP  ${line}`);
};
const fail = (line, error) => {
  failures += 1;
  const detail = String(error?.stderr || error?.stdout || error?.message || error)
    .trim()
    .split("\n")
    .slice(0, 8)
    .join("\n      ");
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

async function extractStoreZip(bytes, directory) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  let extracted = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if ((flags & 0x08) !== 0 || method !== 0) throw new Error("export ZIP is not store-only");
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const destination = path.resolve(directory, name);
    if (!destination.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw new Error(`unsafe ZIP path: ${name}`);
    }
    const dataStart = nameStart + nameLength + extraLength;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
    extracted += 1;
  }
  if (extracted === 0) throw new Error("export ZIP had no local entries");
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

const previewApi = (method = "GET") =>
  preview()
    .locator("body")
    .evaluate(async (_body, verb) => {
      const response = await fetch("/api/visits", {
        method: verb,
        headers: { "content-type": "application/json" },
        ...(verb === "POST" ? { body: JSON.stringify({ note: "e2e" }) } : {}),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status}: ${text}`);
      return JSON.parse(text);
    }, method);

let agentSourceForExport;
let exportDirectory;

try {
  // 1 -----------------------------------------------------------------------
  await step("page loads and the actor seeded its starter files", async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    for (const seeded of [
      "/server/agent.ts",
      "/src/main.tsx",
      "/src/App.tsx",
      "/src/plant.ts",
    ]) {
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

  await step("the seeded front-end reaches the user Agent through /api/*", async () => {
    await page.waitForFunction(
      () => document.querySelector("#log").textContent.includes("user agent placed: MyAgent"),
      undefined,
      { timeout: TIMEOUT },
    );
    const before = await previewApi();
    if (before.visits !== 0) throw new Error(`initial visit count is ${String(before.visits)}`);
    const after = await previewApi("POST");
    if (after.visits !== 1) throw new Error(`visit count after POST is ${String(after.visits)}`);
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

  await step("editing server/agent.ts respawns the Agent and preserves SDK state", async () => {
    await file("/server/agent.ts").click();
    await page.waitForFunction(
      () => document.querySelector("#editor").value.includes("export class MyAgent"),
      undefined,
      { timeout: TIMEOUT },
    );
    const source = await page.locator("#editor").inputValue();
    agentSourceForExport = source.replace("a quiet hello", "a cheerful hello");
    if (agentSourceForExport === source) throw new Error("agent edit marker was missing");
    await page.locator("#editor").fill(agentSourceForExport);
    await page.locator("#save").click();
    await builtOk();
    await page.waitForFunction(
      () => document.querySelector("#log").textContent.includes("agent restarted; storage intact"),
      undefined,
      { timeout: TIMEOUT },
    );
    if (!(await page.locator("#log").innerText()).includes("agent storage released")) {
      throw new Error("the replaced agent did not acknowledge OPFS release");
    }
    const state = await previewApi();
    if (state.visits !== 1) throw new Error(`visit count after respawn is ${String(state.visits)}`);
  });

  await step("a user DO syntax error reaches the log and recovers after it is fixed", async () => {
    const broken = agentSourceForExport.replace("export class", "export clss");
    await page.locator("#editor").fill(broken);
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent === "saving failed",
      undefined,
      { timeout: TIMEOUT },
    );
    const log = await page.locator("#log").innerText();
    if (!log.includes("saving failed:") || !log.match(/Parse|Expected|Unexpected|syntax/i)) {
      throw new Error("the syntax error message did not reach the UI log");
    }

    await page.locator("#editor").fill(agentSourceForExport);
    await page.locator("#save").click();
    await builtOk();
    const state = await previewApi();
    if (state.visits !== 1) throw new Error(`visit count after recovery is ${String(state.visits)}`);
  });

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
    await builtOk();
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
    const state = await previewApi();
    if (state.visits !== 1) throw new Error(`user agent state after reload is ${String(state.visits)}`);
  });

  await step("Export preserves server bytes and passes wrangler deploy --dry-run", async () => {
    const downloadStarted = page.waitForEvent("download", { timeout: TIMEOUT });
    await page.locator("#export").click();
    const download = await downloadStarted;
    const archivePath = await download.path();
    if (archivePath === null) throw new Error("Playwright did not retain the export download");
    exportDirectory = await mkdtemp(path.join(tmpdir(), "vibe-export-"));
    await extractStoreZip(await readFile(archivePath), exportDirectory);
    const exportedAgent = await readFile(path.join(exportDirectory, "server/agent.ts"), "utf8");
    if (exportedAgent !== agentSourceForExport) {
      throw new Error("exported server/agent.ts differs from the workspace bytes");
    }

    const repoRoot = path.resolve(root, "../..");
    const outdir = path.join(exportDirectory, "dry-run");
    const exportedPackage = JSON.parse(
      await readFile(path.join(exportDirectory, "package.json"), "utf8"),
    );
    if (exportedPackage.dependencies?.agents !== "0.21.0") {
      throw new Error("exported package.json does not pin agents@0.21.0");
    }
    await symlink(path.join(root, "node_modules"), path.join(exportDirectory, "node_modules"));
    const result = await execFileAsync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir],
      {
        cwd: exportDirectory,
        env: {
          ...process.env,
          PATH: `${path.join(repoRoot, "node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
        },
        timeout: TIMEOUT,
      },
    );
    const transcript = `${result.stdout}\n${result.stderr}`.trim();
    console.log(`      ${transcript.split("\n").slice(-4).join("\n      ")}`);
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
  if (exportDirectory !== undefined) await rm(exportDirectory, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}` +
    (skipped > 0 ? ` (${skipped} skipped: no network)` : ""),
);
process.exit(failures === 0 ? 0 : 1);
