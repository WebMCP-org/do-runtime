import { expect, test, vi } from "vitest";
import { installWorkerTracing, tracing } from "./cloudflare-workers";

test("a host recorder follows Workerd's automatic and manual span lifetimes", async () => {
  const end = vi.fn();
  const startSpan = vi.fn(() => ({
    isTraced: true,
    spanContext: () => ({ traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }),
    setAttribute() {},
    recordException() {},
    updateName() {},
    setStatus() {},
    end,
  }));
  const exportedTracing = tracing;
  installWorkerTracing(startSpan);

  const manual = exportedTracing.startActiveSpan("manual", (span) => span);
  const error = new Error("rejected callback");
  const failed = exportedTracing.enterSpan("auto", async (span) => {
    expect(span.isTraced).toBe(true);
    await Promise.resolve();
    throw error;
  });
  expect(end).not.toHaveBeenCalled();
  await expect(failed).rejects.toBe(error);
  expect(end).toHaveBeenCalledTimes(1);
  expect(manual.isTraced).toBe(true);
  manual.end();
  manual.end();
  expect(manual.isTraced).toBe(false);
  expect(end).toHaveBeenCalledTimes(2);
  expect(manual.spanContext()).toEqual({
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: 1,
  });

  vi.resetModules();
  const facet = await import("./cloudflare-workers");
  await exportedTracing.enterSpan("outer", async (outer) => {
    await Promise.resolve();
    expect(facet.tracing.getActiveSpan()).toBe(outer);
    facet.tracing.startSpan("facet").end();
    expect(startSpan).toHaveBeenLastCalledWith("facet", outer.spanContext());
  });
});
