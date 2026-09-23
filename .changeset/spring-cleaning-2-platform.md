---
"@mcp-b/do-runtime": minor
---

Export `platformTimer` and `platformFetch` from `@mcp-b/do-runtime`: a `Timer` and a `FetchPort`
over the platform's own `setTimeout`, `clearTimeout` and `fetch`, for `ports.timer`,
`ports.fetch` and `AlarmScheduler`. The package captures them when it loads, which is before
any `installActorScope` can replace the globals with gated ones built on those ports. A host no
longer has to capture the timers at the top of its worker module before anything else runs. A
port that read the installed globals would recurse. An aborted `afterDelay`, including one whose
signal was already aborted, never settles.
