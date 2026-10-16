---
"@mcp-b/do-runtime": minor
---

Add browser actor-tree and worker-supervisor primitives with native activity observation.

`BrowserActorTree` owns facet placement, scoped capabilities, storage handles and hibernation restoration. `BrowserWorkerSupervisor` owns worker bootstrap and readiness, Cap’n Web sessions, transport rebinding across real worker termination, and deletion-fenced logical references. Its lifecycle reporting context is bound to the physical worker generation.

`ActorContainer` now exposes full-event quiescence and activity leases independently of input/output gate ownership, plus activity-change observation. Browser hosts can use these facts to hibernate idle workers without maintaining parallel event counters.
