# Browser SDK async context

Alias `node:async_hooks` (and bare `async_hooks` when needed) to
`@mcp-b/do-runtime/browser/async-hooks`, and enable
`doRuntimeAwaitTransform({ include: actorModules, asyncContext: true })` in both
the application and Worker Vite plugins. Include the actor and every SDK module
whose async functions need context. The extension example has a complete setup.

The shim supports the Agents SDK's `AsyncLocalStorage`: independent stores,
`run`, `getStore`, `exit`, `enterWith`, `disable`, `bind` and static `snapshot`.
Snapshots capture the current set of stores. Each synchronous callback restores
its caller's scope in `finally`; it never leaves one mutable store active while
a promise is pending. Actor entry, reentry, critical sections and timer callbacks
capture that scope before the runtime waits for its input lock.

`installActorScope` also binds native `ReadableStream` and `TransformStream`
callbacks. Sources and transformers created inside an actor retain its actor
and async stores when later demand or network chunks arrive. Pull, transform,
flush and cancel re-enter through the existing input gate; start remains synchronous.
Streams constructed outside an actor retain native behavior. This covers the
AI SDK's streamed tool execution, whose callbacks bypass transformed awaits.

This requires compilation. Native `await` bypasses `Promise.prototype.then`, as
the [TC39 async-context proposal](https://github.com/tc39/proposal-async-context)
explains. The opt-in Vite transform first gates awaits, then uses Vite's installed
Oxc transformer to lower async functions and generators to Promise callbacks.
Importing the shim installs context binding on `Promise.prototype.then` once per
realm. Importing the runtime alone does not patch Promise.

The opt-in transform also corrects Vite's bundled Oxc 0.144.0 generator helper:
an early return must resume awaited `finally` cleanup with `next`, while a
delegated `yield*` may still require `return`. This follows the
[upstream Babel helper](https://github.com/babel/babel/blob/main/packages/babel-helpers/src/helpers/wrapAsyncGenerator.ts).
The correction checks the helper's exact code shape and fails with a review
message if it changes, so a compiler upgrade cannot silently retain a stale fix.

Untransformed native async functions and top-level module awaits do not propagate
this context. Bind callbacks registered with external event APIs explicitly;
ordinary actor timers already capture it. This is not a complete Node
`async_hooks` implementation: async-hook instrumentation and `AsyncResource`
are unsupported and resource construction throws.

Run `pnpm --dir vendor/agents --filter @cloudflare/think test:browser` for real
Chromium regressions covering overlapping entries in one actor and separate
actors, rejection, `getCurrentAgent()`, tracing parentage, and deferred generator
completion/early-return cleanup. The native test caller stays untransformed to
detect scopes escaping into unrelated work. The extension e2e additionally
checks two overlapping PKCE scopes in the built Agents SDK inside an MV3 Worker.
