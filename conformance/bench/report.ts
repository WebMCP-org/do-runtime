/**
 * Printing, kept apart from measuring so both substrates emit the same table and
 * a number can be compared across them without re-reading two formatters.
 *
 * The budget line is the point of the whole exercise: two constants from the
 * extension, quoted here with their files so the headroom in the table is not a
 * number a reader has to go and re-derive.
 */

import type { BenchReport, Stat } from "./message-store";

/**
 * `PIPE_PING_INTERVAL_MS` / `PIPE_SILENCE_LIMIT_MS`,
 * `packages/extension/src/shared/messaging/chrome-port-websocket.ts:24-25`.
 *
 * **Read this budget as an upper bound that a blocked worker cannot actually
 * reach, and the reason is a thread boundary.** The ping is answered by the
 * offscreen DOCUMENT, not forwarded to the worker
 * (`packages/extension/src/offscreen/host.ts:537-540`: "Answered here rather
 * than forwarded: this document being gone is exactly what the client is
 * testing for"), and the actor tree lives in a dedicated worker
 * (`packages/extension/src/offscreen/host.ts:428`). So a long synchronous
 * statement stalls payload replies and leaves the pong on time. It is kept here
 * anyway because it is the liveness budget a reader will reach for, and because
 * a future host that answered the probe from the worker would inherit it for
 * real.
 */
export const PIPE_PING_INTERVAL_MS = 2_000;
export const PIPE_SILENCE_LIMIT_MS = 6_000;

/**
 * The MV3 transport watchdog's first re-arm delay: `alarmRetryDelayMs(0)` under
 * the watchdog's own ceiling, armed in
 * `packages/extension/src/background/host/alarm.ts` before an alarm delivery
 * crosses the offscreen seam.
 */
export const WATCHDOG_REARM_MS = 2_000;

const KEY_WIDTH = 26;

function ms(value: number): string {
  return value >= 100 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

function row(key: string, stat: Stat): string {
  return [
    key.padEnd(KEY_WIDTH),
    String(stat.n).padStart(6),
    ms(stat.p50).padStart(10),
    ms(stat.p90).padStart(10),
    ms(stat.p99).padStart(10),
    ms(stat.max).padStart(10),
  ].join("");
}

export function formatReport(report: BenchReport): string {
  if (!report.ok) return `BENCH FAILED: ${report.error}`;
  const lines: string[] = [
    ``,
    `substrate      ${report.substrate}`,
    `tree depth     ${report.treeDepth} (root + ${report.treeDepth} facet levels, all open, one loop)`,
    `clock floor    ${report.clockResolutionMs.toPrecision(3)} ms`,
    `budgets        pipe silence limit ${PIPE_SILENCE_LIMIT_MS} ms (ping every ${PIPE_PING_INTERVAL_MS} ms)` +
      `; MV3 watchdog re-arm ${WATCHDOG_REARM_MS} ms`,
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      ``,
      `── ${scenario.scenario} ${"─".repeat(Math.max(0, 56 - scenario.scenario.length))}`,
      `   ${scenario.messages} messages, ${(scenario.storedBytes / 1024 / 1024).toFixed(1)} MiB of content, ` +
        `database ${(scenario.databaseSize / 1024 / 1024).toFixed(1)} MiB, built in ${ms(scenario.buildMs)} ms`,
      ``,
      `${"statement".padEnd(KEY_WIDTH)}${"n".padStart(6)}${"p50".padStart(10)}${"p90".padStart(10)}${"p99".padStart(10)}${"max".padStart(10)}`,
    );
    for (const [key, stat] of Object.entries(scenario.statements)) lines.push(row(key, stat));

    // Every `*/span` is one uninterruptible run of statements — the statements
    // are synchronous and nothing awaits between them — so the largest of them
    // is how long this actor tree makes its worker unavailable to everything
    // else sharing it.
    const spans = Object.entries(scenario.statements).filter(([key]) => key.endsWith("/span"));
    const worst = Math.max(...spans.map(([, stat]) => stat.max));
    lines.push(
      ``,
      `   worst contiguous block ${ms(worst)} ms  →  ` +
        `${(PIPE_SILENCE_LIMIT_MS / worst).toFixed(1)}x under the pipe silence limit, ` +
        `${(WATCHDOG_REARM_MS / worst).toFixed(1)}x under the watchdog re-arm`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}
