---
"agents": patch
---

Re-drive interrupted agent-tool runs whose child liveness was never confirmed.
Recovery seals `interrupted` without observing the child, and such a row keeps
reserving a concurrency slot, so it is now re-inspected like a running row: a
child that has since reached terminal repairs the row, and a still-running child
is re-attached. Only an explicit stop could release those slots before.

Skip the per-run detail read for a retained row that has no child, and remove the
per-run collection error frame. A collection error now reports a failed roster
enumeration only, so one unreadable child transcript no longer marks the whole
delegated-work collection failed and stale.

Validate Agent-tool projection frames through the shared SDK parser before
updating the React collection, preserving the retained roster when a malformed
ready frame omits its run ids.
