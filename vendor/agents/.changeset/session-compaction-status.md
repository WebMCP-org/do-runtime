---
"agents": patch
---

Restore the existing session compaction status and error frames after the
Sessions capability migration. Sessions owns compacting/idle phases and
before/after estimates; Agent forwards the capability events to connected
clients, including virtual facets. Successful idle follows the awaited change
feed, so Think's cache is refreshed before clients reload their transcript.
Overlapping compactions stay busy until all settle; no-op and failed calls
return to idle without reporting a successful overlay. Direct addCompaction
retains its existing change-feed-only behavior.
