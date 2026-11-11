import { expect, test, vi } from "vitest";
import {
  captureWorkerTraceparent,
  installWorkerTracing,
  observeWorkerOperation,
  tracing,
  withWorkerTraceparent,
} from "./cloudflare-workers";

const end = vi.fn();
const setStatus = vi.fn();
const recordedContext = { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 };
const startSpan = vi.fn(() => ({
  isTraced: true,
  spanContext: () => recordedContext,
  setAttribute() {},
  recordException() {},
  updateName() {},
  setStatus,
  end,
}));
const exportedTracing = tracing;
installWorkerTracing(startSpan);

test("a host recorder follows Workerd's automatic and manual span lifetimes", async () => {
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
  expect(facet.tracing.Span).toBe(exportedTracing.Span);
  await exportedTracing.enterSpan("outer", async (outer) => {
    await Promise.resolve();
    expect(facet.tracing.getActiveSpan()).toBe(outer);
    facet.tracing.startSpan("facet").end();
    expect(startSpan).toHaveBeenLastCalledWith("facet", outer.spanContext());
  });
});

test("a serialized parent survives a detached handoff and restores the caller's scope", async () => {
  expect(captureWorkerTraceparent()).toBeUndefined();
  expect(tracing.enterSpan("capture", captureWorkerTraceparent)).toBe(
    "00-" + recordedContext.traceId + "-" + recordedContext.spanId + "-01",
  );

  const parent = { traceId: "3".repeat(32), spanId: "4".repeat(16), traceFlags: 1 };
  const carrier = JSON.parse(JSON.stringify("00-" + parent.traceId + "-" + parent.spanId + "-01"));
  await tracing.enterSpan("unrelated", async (active) => {
    await withWorkerTraceparent(carrier, async (attached) => {
      expect(attached).toBe(true);
      await Promise.resolve();
      tracing.startSpan("delivered").end();
      expect(startSpan).toHaveBeenLastCalledWith("delivered", { ...parent, isRemote: true });
    });
    expect(tracing.getActiveSpan()).toBe(active);
    const invalid = "00-" + "0".repeat(32) + "-" + parent.spanId + "-01";
    withWorkerTraceparent(invalid, () => expect(tracing.getActiveSpan()).toBe(active));
  });
});

test("trusted handoffs preserve both digits of the trace flags", () => {
  const carrier = "00-" + recordedContext.traceId + "-" + recordedContext.spanId + "-81";
  expect(withWorkerTraceparent(carrier, captureWorkerTraceparent)).toBe(carrier);
});

test.each([
  undefined,
  null,
  "",
  "00-" + "0".repeat(32) + "-" + "4".repeat(16) + "-01",
  "00-" + "3".repeat(32) + "-" + "0".repeat(16) + "-01",
  "00-" + "3".repeat(32) + "-" + "4".repeat(16) + "-zz",
  "01-" + "3".repeat(32) + "-" + "4".repeat(16) + "-01",
  "00-" + "3".repeat(32) + "-" + "4".repeat(16) + "-01\n",
  new Uint8Array(55),
])("invalid trace context preserves the active caller (%s)", (value) => {
  exportedTracing.enterSpan("caller", (caller) => {
    let invoked = 0;
    const result = withWorkerTraceparent(value, (attached) => {
      invoked += 1;
      expect(attached).toBe(false);
      expect(tracing.getActiveSpan()).toBe(caller);
      return 42;
    });
    expect(result).toBe(42);
    expect(invoked).toBe(1);
  });
});

test("runtime observations preserve the failure and record an error outcome", async () => {
  const failure = new Error("actor failed");
  setStatus.mockClear();
  await expect(observeWorkerOperation("do_runtime.actor.rpc", async () => {
    throw failure;
  })).rejects.toBe(failure);
  expect(setStatus).toHaveBeenLastCalledWith({ code: "error" });
});

test("a recorder start failure leaves the operation runnable", () => {
  startSpan.mockImplementationOnce(() => {
    throw new Error("recorder could not start");
  });
  expect(observeWorkerOperation("do_runtime.actor.rpc", () => 42)).toBe(42);
});

test("a failed recorder preserves the incoming parent through the operation", async () => {
  const parent = { traceId: "3".repeat(32), spanId: "4".repeat(16), traceFlags: 1 };
  const carrier = `00-${parent.traceId}-${parent.spanId}-01`;
  startSpan.mockImplementationOnce(() => {
    throw new Error("recorder could not start");
  });

  await withWorkerTraceparent(carrier, () =>
    observeWorkerOperation("intermediate", async (span) => {
      expect(span?.isTraced).toBe(false);
      await Promise.resolve();
      expect(captureWorkerTraceparent()).toBe(carrier);
      tracing.startSpan("nested").end();
      expect(startSpan).toHaveBeenLastCalledWith("nested", { ...parent, isRemote: true });
    }),
  );
});

test.each([
  ["marking an error", setStatus],
  ["ending the span", end],
] as const)("a recorder failure while %s preserves the original error", async (_operation, record) => {
  record.mockImplementationOnce(() => {
    throw new Error("recorder could not complete");
  });
  const error = new Error("actor RPC failed");
  await expect(observeWorkerOperation("do_runtime.actor.rpc", async () => {
    throw error;
  })).rejects.toBe(error);
});
