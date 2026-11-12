import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import { tracing, withWorkerTraceparent } from "../api/cloudflare-workers";
import {
  createGenAiInferenceMetrics,
  createOtlpTelemetry,
  type OtlpExportNotice,
  type OtlpHttpConfiguration,
} from "../telemetry";

async function receiver(
  receive: (path: string, body: string) => Promise<object> | object,
) {
  const server = createServer(async (request, response) => {
    try {
      const result = await receive(request.url ?? "", await text(request));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch {
      if (!response.destroyed) response.writeHead(503).end();
    }
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it("reports partial OTLP rejection counts without sending a batch twice", async () => {
  const rejected = new Map([
    ["/v1/traces", { rejectedSpans: "1" }],
    ["/v1/logs", { rejectedLogRecords: "100" }],
    ["/v1/metrics", { rejectedDataPoints: "2" }],
  ]);
  const requests = new Map<string, number>();
  const remoteDiagnostic = "private-collector-diagnostic";
  const server = await receiver((path) => {
    const attempt = (requests.get(path) ?? 0) + 1;
    requests.set(path, attempt);
    const partialSuccess =
      attempt === 1
        ? rejected.get(path)
        : path === "/v1/metrics"
          ? { rejectedDataPoints: "0" }
          : undefined;
    return partialSuccess
      ? { partialSuccess: { ...partialSuccess, errorMessage: remoteDiagnostic } }
      : {};
  });
  const configuration = { endpoint: server.endpoint, metrics: true, logs: true };
  const notices: OtlpExportNotice[] = [];
  const { tracerProvider, logger } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => configuration,
    resourceAttributes: {},
    scope: "test",
    onExportNotice: (notice) => notices.push(notice),
  });
  const tracer = tracerProvider.getTracer("test");
  try {
    for (let count = 0; count < 3; count += 1) {
      tracer.startSpan("operation").end();
      logger?.emit({ eventName: "operation" });
    }
    await tracerProvider.forceFlush();
    await tracerProvider.forceFlush();
    for (const [signal, dropped] of [
      ["traces", 1],
      ["logs", 3],
      ["metrics", 0],
    ] as const) {
      expect(notices).toContainEqual(
        expect.objectContaining({ signal, outcome: "rejected", dropped, failures: 1 }),
      );
    }
    expect(notices).toContainEqual(
      expect.objectContaining({ signal: "metrics", outcome: "recovered", failures: 1 }),
    );
    expect(JSON.stringify(notices)).not.toContain(remoteDiagnostic);
  } finally {
    await tracerProvider.shutdown();
    await server.close();
  }
  expect(requests.get("/v1/traces")).toBe(1);
  expect(requests.get("/v1/logs")).toBe(1);
}, 12_000);

it("flushes the current batch and drains later queued spans on shutdown", async () => {
  const firstReceived = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const received: string[] = [];
  const server = await receiver(async (_path, body) => {
    received.push(body);
    if (received.length === 1) {
      firstReceived.resolve();
      await releaseFirst.promise;
    }
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: false, logs: false };
  const { tracerProvider } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => configuration,
    resourceAttributes: {},
    scope: "test",
  });
  const tracer = tracerProvider.getTracer("test");
  try {
    tracer.startSpan("initial").end();
    await firstReceived.promise;
    const flushing = tracerProvider.forceFlush();
    tracer.startSpan("queued-behind-first").end();
    releaseFirst.resolve();
    await flushing;
    expect(received).toHaveLength(1);
  } finally {
    releaseFirst.resolve();
    await tracerProvider.shutdown();
    await server.close();
  }
  expect(received).toHaveLength(2);
  expect(received[1]).toContain('"name":"queued-behind-first"');
});

it("records worker spans under the host policy and rechecks the destination before export", async () => {
  const received: string[] = [];
  const server = await receiver((_path, body) => {
    received.push(body);
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: false, logs: false };
  let current: OtlpHttpConfiguration | null = configuration;
  const { tracerProvider } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => current,
    resourceAttributes: { "service.name": "test-worker" },
    scope: "test",
    workerSpans: {
      describe: () => ({ name: "worker-operation", scope: "test-worker" }),
      attribute: (key, value) =>
        ["operation.count", "operation.detail", "error.type"].includes(key) ? value : undefined,
      finalizeAttributes(attributes) {
        if (attributes["operation.count"] === 1) delete attributes["operation.detail"];
      },
    },
  });
  const traceId = "1234567890abcdef1234567890abcdef";
  const spanId = "1234567890abcdef";
  try {
    withWorkerTraceparent(`00-${traceId}-${spanId}-01`, (attached) => {
      expect(attached).toBe(true);
      tracing.enterSpan("private operation", (span) => {
        span.setAttribute("operation.detail", "private in this combination");
        span.setAttribute("operation.count", 1);
        span.setAttribute("private.attribute", "private value");
        span.recordException(new Error("private exception"));
      });
    });
    await tracerProvider.forceFlush();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0] ?? "{}")).toMatchObject({
      resourceSpans: [{
        scopeSpans: [{
          scope: { name: "test-worker" },
          spans: [{
            name: "worker-operation",
            traceId,
            parentSpanId: spanId,
            status: { code: 2 },
          }],
        }],
      }],
    });
    expect(received[0]).toContain('"key":"operation.count"');
    expect(received[0]).toContain('"key":"error.type"');
    expect(received[0]).not.toContain("private");

    tracing.startSpan("revoked").end();
    current = null;
    await tracerProvider.forceFlush();
    expect(received).toHaveLength(1);
  } finally {
    await tracerProvider.shutdown();
    await server.close();
  }
});

it("exports inference measurements independently of recorded spans", async () => {
  const received = new Map<string, string>();
  const server = await receiver((path, body) => {
    received.set(path, body);
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: true, logs: false };
  const { tracerProvider, meter } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => configuration,
    resourceAttributes: {},
    scope: "test",
  });
  try {
    if (!meter) throw new Error("Expected enabled metrics");
    const record = createGenAiInferenceMetrics(meter);
    record({ provider: "unknown", durationMs: 2_000, firstOutputMs: 500, inputTokens: 8, outputTokens: 5 });
    record({ provider: "unknown", durationMs: 1_000 });
    await tracerProvider.forceFlush();
    expect([...received.keys()]).toEqual(["/v1/metrics"]);
    expect(JSON.parse(received.get("/v1/metrics") ?? "{}")).toMatchObject({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: expect.arrayContaining([
            expect.objectContaining({
              name: "gen_ai.client.inference.duration",
              unit: "s",
              histogram: { aggregationTemporality: 2, dataPoints: [expect.objectContaining({ count: 2, sum: 3 })] },
            }),
            expect.objectContaining({
              name: "gen_ai.client.inference.time_to_first_chunk",
              unit: "s",
              histogram: { aggregationTemporality: 2, dataPoints: [expect.objectContaining({ count: 1, sum: 0.5 })] },
            }),
            ...(["input", "output"] as const).map((direction) => expect.objectContaining({
              name: `gen_ai.client.inference.usage.${direction}_tokens`,
              unit: "{token}",
              sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [expect.objectContaining({
                asInt: direction === "input" ? 8 : 5,
              })] },
            })),
          ]),
        }],
      }],
    });
  } finally {
    await tracerProvider.shutdown();
    await server.close();
  }
});
