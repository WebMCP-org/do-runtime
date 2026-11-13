import type { Attributes, Meter, SpanKind } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, TracerProvider } from "@opentelemetry/sdk-trace";
import type { WorkerSpanRecorder } from "./api/cloudflare-workers";
import { platformTimer } from "./api/platform";

export { createGenAiInferenceMetrics } from "./telemetry/gen-ai";

export interface OtlpHttpConfiguration {
  readonly endpoint: string;
  readonly metrics: boolean;
  readonly logs: boolean;
}

export type OtlpConfigurationReader = () => Promise<OtlpHttpConfiguration | null>;

type WorkerAttribute = Parameters<WorkerSpanRecorder["setAttribute"]>[1];

/** The host chooses the operation names and attributes safe to export. */
export interface WorkerSpanPolicy {
  describe(name: string): { name: string; scope: string; kind?: SpanKind };
  attribute(key: string, value: WorkerAttribute): WorkerAttribute | undefined;
  /** Delete attributes from this copy to omit them from the span. */
  finalizeAttributes?(attributes: Attributes): void;
}

export interface OtlpExportNotice {
  signal: "traces" | "metrics" | "logs";
  outcome:
    | "serialization"
    | "http"
    | "network"
    | "timeout"
    | "rejected"
    | "queue_full"
    | "recovered";
  queued: number;
  inFlight: number;
  dropped: number;
  failures: number;
}

interface OtlpInstruments {
  meter: Meter | undefined;
  logger: ReturnType<LoggerProvider["getLogger"]> | undefined;
}

export interface OtlpTelemetryOptions {
  configuration: OtlpHttpConfiguration;
  readConfiguration: OtlpConfigurationReader;
  resourceAttributes: Attributes;
  scope: string;
  /** Revokes recording and cancels any pending delivery for this session. */
  signal?: AbortSignal;
  exportMetricPrefix?: string;
  onExportNotice?(notice: OtlpExportNotice): void;
  workerSpans?: WorkerSpanPolicy;
  observeSpans?(instruments: OtlpInstruments): ((span: ReadableSpan) => void) | undefined;
}

export interface OtlpTelemetry extends OtlpInstruments {
  tracerProvider: TracerProvider;
  scheduleMetrics(): void;
}

/** A stalled or failed destination lookup disables this export attempt. */
export async function readOtlpConfiguration<Configuration extends OtlpHttpConfiguration>(
  read: () => Promise<Configuration | null>,
): Promise<Configuration | null> {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      read(),
      platformTimer.afterDelay(1_000, timeout.signal).then(() => null),
    ]);
  } catch {
    return null;
  } finally {
    timeout.abort();
  }
}

/** Load the SDK when a host enables OTLP. Worker recording is opt-in per realm. */
export async function createOtlpTelemetry(options: OtlpTelemetryOptions): Promise<OtlpTelemetry> {
  const { configureOtlpTelemetry } = await import("./telemetry/otlp-http");
  const { readConfiguration, ...setup } = options;
  return configureOtlpTelemetry({
    ...setup,
    readConfiguration: () => readOtlpConfiguration(readConfiguration),
  });
}
