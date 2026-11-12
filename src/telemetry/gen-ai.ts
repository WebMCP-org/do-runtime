import { ValueType, type Meter } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_RESPONSE_MODEL,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from "@opentelemetry/semantic-conventions/incubating";

interface GenAiInferenceMeasurement {
  readonly provider: string;
  readonly responseModel?: string | undefined;
  readonly durationMs: number;
  readonly firstOutputMs?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly failed?: boolean;
}

// OpenTelemetry GenAI draft e6658f14. The standalone JS constants are not published yet.
// https://github.com/open-telemetry/semantic-conventions-genai/tree/e6658f14c9d9ea0760825f029cb82e7673f48fab/docs/gen-ai
export function createGenAiInferenceMetrics(meter: Meter) {
  const latency = {
    unit: "s",
    advice: {
      explicitBucketBoundaries: [
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
      ],
    },
  };
  const duration = meter.createHistogram("gen_ai.client.inference.duration", latency);
  const firstChunk = meter.createHistogram(
    "gen_ai.client.inference.time_to_first_chunk",
    latency,
  );
  const tokens = { unit: "{token}", valueType: ValueType.INT };
  const input = meter.createCounter("gen_ai.client.inference.usage.input_tokens", tokens);
  const output = meter.createCounter("gen_ai.client.inference.usage.output_tokens", tokens);

  // Record once per provider result. The SDK does not report token modality.
  return (measurement: GenAiInferenceMeasurement): void => {
    const attributes = {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_PROVIDER_NAME]: measurement.provider,
      [ATTR_GEN_AI_RESPONSE_MODEL]: measurement.responseModel,
      [ATTR_ERROR_TYPE]: measurement.failed ? "_OTHER" : undefined,
    };
    if (Number.isFinite(measurement.durationMs) && measurement.durationMs >= 0) {
      duration.record(measurement.durationMs / 1_000, attributes);
    }
    const firstOutputMs = measurement.firstOutputMs;
    if (firstOutputMs !== undefined && Number.isFinite(firstOutputMs) && firstOutputMs >= 0) {
      firstChunk.record(firstOutputMs / 1_000, attributes);
    }
    const tokenAttributes = { ...attributes, "gen_ai.token.modality": "unknown" };
    for (const [counter, value] of [
      [input, measurement.inputTokens],
      [output, measurement.outputTokens],
    ] as const) {
      if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
        counter.add(value, tokenAttributes);
      }
    }
  };
}
