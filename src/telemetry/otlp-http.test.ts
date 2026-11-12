import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { ValueType, type Attributes } from "@opentelemetry/api";
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

it.each(["forceFlush", "shutdown"] as const)("exports final batch drops during %s", async (finish) => {
  const metrics: string[] = [];
  const server = await receiver((path, body) => {
    if (path === "/v1/traces") return { partialSuccess: { rejectedSpans: "1" } };
    if (path === "/v1/metrics") metrics.push(body);
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: true, logs: false };
  const { tracerProvider } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => configuration,
    resourceAttributes: {},
    scope: "test",
  });
  try {
    tracerProvider.getTracer("test").startSpan("operation").end();
    await tracerProvider[finish]();
    expect(metrics).toHaveLength(1);
    expect(JSON.parse(metrics[0] ?? "{}")).toMatchObject({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: expect.arrayContaining(["dropped", "failures"].map((instrument) =>
            expect.objectContaining({
              name: `do_runtime.telemetry.export.${instrument}`,
              sum: expect.objectContaining({ dataPoints: [expect.objectContaining({ asDouble: 1 })] }),
            }),
          )),
        }],
      }],
    });
  } finally {
    if (finish === "forceFlush") await tracerProvider.shutdown();
    await server.close();
  }
}, 12_000);

it("flushes measurements recorded during an in-flight metric export", async () => {
  const firstReceived = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const received: string[] = [];
  const server = await receiver(async (path, body) => {
    if (path === "/v1/metrics") {
      received.push(body);
      if (received.length === 1) {
        firstReceived.resolve();
        await releaseFirst.promise;
      }
    }
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: true, logs: false };
  const { meter, tracerProvider } = await createOtlpTelemetry({
    configuration,
    readConfiguration: async () => configuration,
    resourceAttributes: {},
    scope: "test",
  });
  try {
    if (!meter) throw new Error("Expected enabled metrics");
    const count = meter.createCounter("test.measurements", { valueType: ValueType.INT });
    count.add(1);
    const first = tracerProvider.forceFlush();
    await firstReceived.promise;
    count.add(2);
    const second = tracerProvider.forceFlush();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1] ?? "{}")).toMatchObject({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: expect.arrayContaining([
            expect.objectContaining({
              name: "test.measurements",
              sum: expect.objectContaining({ dataPoints: [expect.objectContaining({ asInt: 3 })] }),
            }),
          ]),
        }],
      }],
    });
  } finally {
    releaseFirst.resolve();
    await tracerProvider.shutdown();
    await server.close();
  }
});

it("records worker spans under the host policy and rechecks the destination before export", async () => {
  const received: string[] = [];
  const server = await receiver((_path, body) => {
    received.push(body);
    return {};
  });
  const configuration = { endpoint: server.endpoint, metrics: false, logs: false };
  let current: OtlpHttpConfiguration | null = configuration;
  let finalized: Attributes | undefined;
  let observed: Attributes | undefined;
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
        attributes["operation.count"] = "private replacement";
        finalized = attributes;
      },
    },
    observeSpans: () => (span) => {
      observed = span.attributes;
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
    if (!finalized || !observed) throw new Error("Expected finalized and observed attributes");
    finalized["operation.detail"] = "private late attribute";
    Reflect.set(observed, "private.attribute", "private observed attribute");
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
            attributes: [
              { key: "operation.count", value: { intValue: 1 } },
              { key: "error.type", value: { stringValue: "error" } },
            ],
          }],
        }],
      }],
    });
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
    const attributes = [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "unknown" } },
    ];
    expect(JSON.parse(received.get("/v1/metrics") ?? "{}")).toMatchObject({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: expect.arrayContaining([
            expect.objectContaining({
              name: "gen_ai.client.inference.duration",
              unit: "s",
              histogram: { aggregationTemporality: 2, dataPoints: [expect.objectContaining({
                attributes, count: 2, sum: 3,
              })] },
            }),
            expect.objectContaining({
              name: "gen_ai.client.inference.time_to_first_chunk",
              unit: "s",
              histogram: { aggregationTemporality: 2, dataPoints: [expect.objectContaining({
                attributes, count: 1, sum: 0.5,
              })] },
            }),
            ...(["input", "output"] as const).map((direction) => expect.objectContaining({
              name: `gen_ai.client.inference.usage.${direction}_tokens`,
              unit: "{token}",
              sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [expect.objectContaining({
                attributes: [...attributes, { key: "gen_ai.token.modality", value: { stringValue: "unknown" } }],
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
