---
"agents": minor
---

Restore the `protectHead` and `minTailMessages` options on
`createCompactFunction`. 0.22 exposed both floors; a host whose turns are
single enormous rows needs them below the head-3/tail-2 defaults, or the
compressible middle is always empty and compaction never runs.
