---
"@mcp-b/do-runtime": minor
---

Add a telemetry entry point for OpenTelemetry worker spans, inference metrics, and bounded OTLP batches. Hosts supply the destination, resource attributes, and export policy.

Worker span policies can drop attributes after all values are available. Flush and shutdown drain trace and log batches before collecting the final export health metrics.
