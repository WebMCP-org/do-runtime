import {
  ROOT_CONTEXT,
  SpanStatusCode,
  isSpanContextValid,
  trace,
  type Span,
} from "@opentelemetry/api";
import { globalErrorHandler } from "@opentelemetry/core";
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { MeterProvider, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { TracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { ATTR_ERROR_TYPE, ATTR_SERVICE_INSTANCE_ID } from "@opentelemetry/semantic-conventions";
import { installWorkerTracing, type WorkerSpanRecorder } from "../api/cloudflare-workers";
import { platform, platformFetch, platformTimer } from "../api/platform";
import type {
  OtlpExportNotice,
  OtlpTelemetry,
  OtlpTelemetryOptions,
  WorkerSpanPolicy,
} from "../telemetry";

const rejectedRecords = {
  traces: (bytes: Uint8Array) =>
    JsonTraceSerializer.deserializeResponse(bytes).partialSuccess?.rejectedSpans,
  metrics: (bytes: Uint8Array) =>
    JsonMetricsSerializer.deserializeResponse(bytes).partialSuccess?.rejectedDataPoints,
  logs: (bytes: Uint8Array) =>
    JsonLogsSerializer.deserializeResponse(bytes).partialSuccess?.rejectedLogRecords,
};
type Signal = OtlpExportNotice["signal"];
type DeliveryResult =
  | { outcome: "accepted" | "policy" | "serialization" | "http" | "network" | "timeout" }
  | { outcome: "rejected"; rejected: number };
type DropReason = Exclude<DeliveryResult["outcome"], "accepted"> | "queue_full";

const queueLimit = 128;
const batchDelayMs = 250;
const metricsDelayMs = 5_000;
const noticeIntervalMs = 30_000;
const responseLimit = 8_192;

async function readRejectedRecords(signal: Signal, body: Response["body"]): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  const bytes = new Uint8Array(responseLimit);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > responseLimit) return 0;
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length === 0) return 0;
  try {
    const raw = rejectedRecords[signal](bytes.subarray(0, length));
    const count = typeof raw === "string" ? Number(raw) : raw;
    return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

function exportHealth() {
  return {
    dropped: 0,
    failures: 0,
    nextFailureNotice: 0,
    reportedFailure: false,
  };
}

class PlatformMetricReader extends MetricReader {
  private timer: ReturnType<typeof platform.setTimeout> | undefined;
  private sending = Promise.resolve();
  private closed = false;

  constructor(private readonly send: (metrics: ResourceMetrics) => Promise<void>) {
    super({ cardinalitySelector: () => 128 });
  }

  schedule(): void {
    if (this.closed || this.timer !== undefined) return;
    const timer = platform.setTimeout(() => {
      void this.onForceFlush(timer).catch(() => {
        globalErrorHandler(new Error("OTLP metric collection failed"));
      });
    }, metricsDelayMs);
    this.timer = timer;
  }

  protected onForceFlush(scheduled?: ReturnType<typeof platform.setTimeout>): Promise<void> {
    const collect = async () => {
      // An explicit flush can consume the work of a timer queued behind another export.
      if (scheduled !== undefined && (this.closed || this.timer !== scheduled)) return;
      if (this.timer !== undefined) {
        platform.clearTimeout(this.timer);
        this.timer = undefined;
      }
      const { resourceMetrics } = await this.collect();
      if (resourceMetrics.scopeMetrics.length) await this.send(resourceMetrics);
    };
    return (this.sending = this.sending.then(collect, collect));
  }

  protected onShutdown(): Promise<void> {
    this.closed = true;
    return this.onForceFlush();
  }
}

class OtelWorkerSpan implements WorkerSpanRecorder {
  constructor(
    private readonly span: Span,
    private readonly policy: WorkerSpanPolicy,
  ) {}

  get isTraced(): boolean {
    return this.span.isRecording();
  }

  spanContext() {
    return this.span.spanContext();
  }

  setAttribute(key: string, value: Parameters<WorkerSpanRecorder["setAttribute"]>[1]): void {
    const safe = this.policy.attribute(key, value);
    if (safe !== undefined) this.span.setAttribute(key, safe);
  }

  setStatus({ code }: Parameters<WorkerSpanRecorder["setStatus"]>[0]): void {
    if (code === "error") this.span.setStatus({ code: SpanStatusCode.ERROR });
    if (code === "ok") this.span.setStatus({ code: SpanStatusCode.OK });
  }

  updateName(name: string): void {
    this.span.updateName(this.policy.describe(name).name);
  }

  recordException(): void {
    this.setAttribute(ATTR_ERROR_TYPE, "error");
    this.setStatus({ code: "error" });
  }

  end(): void {
    this.span.end();
  }
}

export function configureOtlpTelemetry({
  configuration,
  readConfiguration,
  resourceAttributes,
  scope,
  exportMetricPrefix = "do_runtime.telemetry.export",
  onExportNotice,
  observeSpans,
  workerSpans,
}: OtlpTelemetryOptions): OtlpTelemetry {
  const { endpoint } = configuration;
  const url = new URL(endpoint);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError("OTLP requires an HTTP(S) endpoint without credentials or a fragment");
  }
  if ((configuration.metrics || configuration.logs) && !url.pathname.endsWith("/v1/traces")) {
    throw new TypeError("OTLP metrics and logs require a trace endpoint ending in /v1/traces");
  }
  const resource = resourceFromAttributes(resourceAttributes);
  const health = { traces: exportHealth(), metrics: exportHealth(), logs: exportHealth() };

  // Export outside actor scopes and recheck the host's destination before encoding a batch.
  async function deliver(
    signal: Signal,
    serialize: () => Uint8Array | undefined,
  ): Promise<DeliveryResult> {
    const current = await readConfiguration();
    if (current?.endpoint !== endpoint || (signal !== "traces" && !current[signal])) {
      return { outcome: "policy" };
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = serialize();
    } catch {
      return { outcome: "serialization" };
    }
    if (!bytes) return { outcome: "serialization" };
    const deadline = AbortSignal.timeout(2_000);
    try {
      const url = new URL(endpoint);
      if (signal !== "traces")
        url.pathname = url.pathname.replace(/\/v1\/traces$/u, "/v1/" + signal);
      const response = await platformFetch(url.href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(bytes),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { outcome: "http" };
      }
      const rejected = await readRejectedRecords(signal, response.body);
      return rejected > 0 ? { outcome: "rejected", rejected } : { outcome: "accepted" };
    } catch {
      return { outcome: deadline.aborted ? "timeout" : "network" };
    }
  }

  const reader = configuration.metrics
    ? new PlatformMetricReader(async (metrics) => {
        const result = await deliver("metrics", () =>
          JsonMetricsSerializer.serializeRequest(metrics),
        );
        recordDelivery("metrics", result, 0);
      })
    : undefined;
  const meter = reader
    ? new MeterProvider({
        // A realm owns its cumulative stream. Use an ephemeral exporter ID
        // so overlapping workers and extension pages are distinct writers.
        resource: resource.merge(
          resourceFromAttributes({ [ATTR_SERVICE_INSTANCE_ID]: platform.crypto.randomUUID() }),
        ),
        readers: [reader],
      }).getMeter(scope)
    : undefined;
  const drops = meter?.createCounter(`${exportMetricPrefix}.dropped`, { unit: "{record}" });
  const failures = meter?.createCounter(`${exportMetricPrefix}.failures`, { unit: "{request}" });

  function localHealth(signal: Signal, outcome: OtlpExportNotice["outcome"]) {
    const { dropped, failures } = health[signal];
    const queue = signal === "metrics" ? undefined : queues[signal];
    try {
      onExportNotice?.({
        signal,
        outcome,
        queued: queue?.queued ?? 0,
        inFlight: queue?.inFlight ?? 0,
        dropped,
        failures,
      });
    } catch {
      globalErrorHandler(new Error("OTLP export notice handler failed"));
    }
  }

  function recordDrop(signal: Signal, reason: DropReason, count: number) {
    health[signal].dropped += count;
    drops?.add(count, { signal, reason });
    reader?.schedule();
  }

  function recordDelivery(signal: Signal, result: DeliveryResult, count: number) {
    const state = health[signal];
    const { outcome } = result;
    if (outcome === "accepted") {
      if (state.reportedFailure) {
        state.reportedFailure = false;
        localHealth(signal, "recovered");
      }
      return;
    }
    const dropped = outcome === "rejected" ? Math.min(count, result.rejected) : count;
    if (dropped) recordDrop(signal, outcome, dropped);
    if (outcome === "policy") return;
    state.failures += 1;
    failures?.add(1, { signal, reason: outcome });
    const now = performance.now();
    if (now >= state.nextFailureNotice) {
      state.reportedFailure = true;
      state.nextFailureNotice = now + noticeIntervalMs;
      localHealth(signal, outcome);
    }
  }

  function queue<T>(
    signal: "traces" | "logs",
    serialize: (records: T[]) => Uint8Array | undefined,
  ) {
    let pending: T[] | undefined;
    let sending: T[] | undefined;
    let lastBatch = Promise.resolve();
    let closed = false;
    let nextQueueNotice = 0;

    return {
      get queued() {
        return pending?.length ?? 0;
      },
      get inFlight() {
        return sending?.length ?? 0;
      },
      add(record: T) {
        if (closed) return;
        if (pending) {
          if (pending.length < queueLimit) {
            pending.push(record);
          } else {
            recordDrop(signal, "queue_full", 1);
            const now = performance.now();
            if (now >= nextQueueNotice) {
              nextQueueNotice = now + noticeIntervalMs;
              localHealth(signal, "queue_full");
            }
          }
          return;
        }
        const records = [record];
        pending = records;
        const send = async () => {
          await platformTimer.afterDelay(batchDelayMs);
          pending = undefined;
          sending = records;
          let result: DeliveryResult;
          try {
            result = await deliver(signal, () => serialize(records));
          } finally {
            sending = undefined;
          }
          recordDelivery(signal, result, records.length);
        };
        lastBatch = lastBatch.then(send, send);
        void lastBatch.catch(() => undefined);
      },
      forceFlush() {
        return lastBatch;
      },
      shutdown() {
        closed = true;
        return lastBatch;
      },
    };
  }

  const queues = {
    traces: queue<ReadableSpan>("traces", JsonTraceSerializer.serializeRequest),
    logs: configuration.logs
      ? queue<ReadableLogRecord>("logs", JsonLogsSerializer.serializeRequest)
      : undefined,
  };
  const { traces, logs } = queues;
  meter
    ?.createObservableGauge(`${exportMetricPrefix}.queue.depth`, { unit: "{record}" })
    .addCallback((result) => {
      for (const signal of ["traces", "logs"] as const) {
        const queue = queues[signal];
        result.observe(queue?.queued ?? 0, { signal, state: "pending" });
        result.observe(queue?.inFlight ?? 0, { signal, state: "in_flight" });
      }
    });
  const logger = logs
    ? new LoggerProvider({
        resource,
        processors: [{ onEmit: logs.add, forceFlush: logs.forceFlush, shutdown: logs.shutdown }],
      }).getLogger(scope)
    : undefined;

  const onSpanEnd = observeSpans?.({ meter, logger });
  const workerRecordings = new WeakSet<Span>();
  let stopping: Promise<void> | undefined;
  const spanProcessor: SpanProcessor = {
    onStart() {},
    onEnding(span) {
      if (!workerRecordings.has(span)) return;
      const { attributes } = span;
      if (workerSpans?.finalizeAttributes) {
        // The host can remove attributes without rewriting the values the policy admitted.
        const finalized = { ...attributes };
        try {
          workerSpans.finalizeAttributes(finalized);
          for (const key of Object.keys(attributes)) {
            if (!Object.hasOwn(finalized, key)) delete attributes[key];
          }
        } catch {
          for (const key of Object.keys(attributes)) delete attributes[key];
          globalErrorHandler(new Error("OTLP worker attribute policy failed"));
        }
      }
      Object.freeze(attributes);
    },
    onEnd(span) {
      if (stopping) return;
      traces.add(span);
      if (!onSpanEnd) return;
      try {
        onSpanEnd(span);
      } catch {
        globalErrorHandler(new Error("OTLP span observer failed"));
      }
      reader?.schedule();
    },
    async forceFlush() {
      await Promise.all([traces.forceFlush(), logs?.forceFlush()]);
      await (stopping ?? reader?.forceFlush());
    },
    shutdown() {
      return (stopping ??= Promise.all([traces.shutdown(), logs?.shutdown()]).then(() =>
        reader?.shutdown(),
      ));
    },
  };
  const tracerProvider = new TracerProvider({ resource, spanProcessors: [spanProcessor] });
  if (workerSpans) {
    installWorkerTracing((name, parent) => {
      const span = workerSpans.describe(name);
      const context =
        parent && isSpanContextValid(parent)
          ? trace.setSpanContext(ROOT_CONTEXT, parent)
          : ROOT_CONTEXT;
      const tracer = tracerProvider.getTracer(span.scope);
      const options = span.kind === undefined ? undefined : { kind: span.kind };
      const recording = tracer.startSpan(span.name, options, context);
      workerRecordings.add(recording);
      return new OtelWorkerSpan(recording, workerSpans);
    });
  }
  return { tracerProvider, logger, meter, scheduleMetrics: () => reader?.schedule() };
}
