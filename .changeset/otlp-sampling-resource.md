---
"@mcp-b/do-runtime": minor
---

OTLP telemetry records spans under an unsampled parent so `observeSpans`,
metrics and logs no longer depend on a caller's sampling decision; only sampled
spans are exported. Every signal now carries the default `telemetry.sdk.*`
resource attributes and one ephemeral `service.instance.id` per recording
session. A worker span's `recordException` sets `error.type` to the exception's
class name, or `_OTHER`, instead of the literal `error`.
