---
"@mcp-b/do-runtime": patch
---

Name the last gated site in the "no input lock available in this context" error. The throw lands at the next storage call, which can be several layers past the foreign await that actually dropped the lock; the error now carries where the gate was last engaged — an `awaitIo` call site with its stack, an `entry` dispatch with its method name, a re-entry callback's registration site — and how many milliseconds before the throw, which brackets the offending await between two coordinates.
