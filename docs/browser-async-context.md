# Browser SDK async context

Add `...browserHost({ include: actorModules })` from `@mcp-b/do-runtime/vite` to
the application's Vite `plugins`. It aliases bare and `node:` `async_hooks` to
`@mcp-b/do-runtime/browser/async-hooks` and runs
`doRuntimeAwaitTransform({ include, asyncContext: true })` in Worker bundles. It
also runs the transform in the application plugins, but only while serving:
unbundled development serves Worker modules through them. Include the actor and
every SDK module whose async functions need context, and keep those modules out
of `optimizeDeps` in development, because pre-bundling skips plugin transforms.
A build that bundles actor code outside `worker`, as the extension example's
facet passes do, adds the transform itself. The extension example has a complete
setup.

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
explains. The opt-in Vite transform first gates awaits, then uses Babel's
[async function](https://babeljs.io/docs/babel-plugin-transform-async-to-generator)
and [async generator](https://babeljs.io/docs/babel-plugin-transform-async-generator-functions)
plugins to lower only asynchronous syntax to Promise callbacks. Other syntax,
including optional calls on callable RPC capabilities, stays native. Lowering
all syntax to ES2016 would introduce `.call()` property access on those
capabilities and dispatch a remote `method.call` instead of invoking `method`.
Importing the shim installs context binding on `Promise.prototype.then` once per
realm. Importing the runtime alone does not patch Promise.

Babel's async transform captures `super` properties in getter arrows. Before
lowering, a small selector binds only an optional `super` callee through
`__bindOptionalSuperMethod` in the injected gate module. The helper reads the
method once and returns either undefined or a callable using its captured
`Reflect.apply`. The entire optional chain stays native, including short-circuit
behavior, computed keys, awaited/yielded arguments, delete, grouped method
receivers and later remote calls. A non-nullish non-callable still throws only
when invoked after argument evaluation. Ordinary optional calls are unaffected.
The canonical Babel generator helper also resumes awaited `finally`
cleanup correctly on early return, including delegated `yield*`; no generated
helper patch is required.

Async method shells retain native `AsyncFunction` identity for SDK lifecycle
dispatch, while their bodies contain no native await. Their restoration map is
composed with Babel's map and the preceding gate-insertion map, so stack traces
still refer to the original source.

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
