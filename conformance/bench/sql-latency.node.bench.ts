/**
 * Run:
 *   npx vitest run --config conformance/bench/vitest.node.config.ts
 *
 * The CONTRAST, not the answer. `node:sqlite` is a native build writing to a
 * real filesystem; the extension runs sqlite-wasm over an OPFS sync access
 * handle. Any number from this file has to be labelled as node whenever it is
 * quoted, because the two substrates do not agree and only the other one ships.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createNodeSqlProvider } from "../../backends/node-sqlite";
import { runMessageStoreBench } from "./message-store";
import { formatReport } from "./report";

const directory = mkdtempSync(join(tmpdir(), "do-runtime-bench-"));

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

test("synchronous sql.exec latency over the real message store, node:sqlite", async () => {
  const provider = createNodeSqlProvider({ directory });
  const report = await runMessageStoreBench({
    substrate: `node:sqlite ${process.version} on ${process.platform}, on-disk`,
    treeDepth: 4,
    open: (name) => provider.open(name),
    now: () => performance.now(),
  });
  console.log(formatReport(report));
  expect(report.ok).toBe(true);
}, 900_000);
