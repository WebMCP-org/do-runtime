---
"@mcp-b/do-runtime": patch
---

Report active alarm deliveries and retain their projected deadlines through `projectWake` until completion, retry persistence, and abandonment finish. This keeps browser recovery armed when the native scheduler timer fires first or unrelated alarms change. Browser hosts can use the activity count with the acknowledged pending wake to confirm delivery cleanup. Preserve recoverable alarms when deletion, scheduler bookkeeping, or projection callbacks fail.
