---
"@mcp-b/do-runtime": patch
---

Add `ActorContainer.resolveLoopback()` so in-realm actor bindings use the raw instance only for exact self-calls. Other calls enter the target gate and resume through the exact current, transformed, or structurally supplied caller, including separately bundled runtime copies.

Verify await-transform coverage against final build modules and warn on development fail-open paths. Reject failed critical sections with `BrokenActorError`, expose queued-entry cancellation, align the `cloudflare-workers` declaration path with its JavaScript entry, and remove the ineffective scheduler WAL pragma.
