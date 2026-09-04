# Upstream diff log

Every retained edit to `vendor/agents` must be listed here with the file, why a
shim could not cover it, and whether it is upstreamable. The measured footprint
lives in [the vendor fork audit](audit/vendor-fork-audit.md); do not duplicate a count
here that drifts on every refresh.

## 2026-08-31 — Reconcile the 0.22 audit with current Rook

- Replay the release refresh onto Rook `a8547bd3`, retaining the newer
  `prepareModel` hook, model-history capability tests, replay-buffer overflow
  reconciliation, and the current ManagerOffice/EmployeeChrome consumer.
  The source pin remains the released SDK commit below.
- Rebuild the Agents package from this combined source so unaliased clients
  and declarations include the retained fixes. Keep the existing packaged
  dependency boundary: a direct link exposes the vendor workspace's Vite
  peer types to Rook's different Vite version. Both local package overrides
  remain release blockers.
- The host transcriber now calls Voice's public `onFatalError` once when the
  audio ceiling ends a live session. Its existing completion promise rejects
  with the same error. Graceful closure still owns upload failures; the
  contract test covers both paths. No new vendor callback or state is needed.
- Remove the host's explicit `experimental_throttle: 50`; SDK 0.22 supplies
  that default. Add upstream default-throttle, replay-burst, chat-throttle,
  replay-batch, and sub-agent RPC bridge suites to the existing vendor gate.
- Cleanup recheck: `voice/src/voice-input.ts` forwards startup errors to the
  retained `onCallEnd(connection, error)` hook. The private startup-failure
  handler discarded the cause before the host could record it; a host shim
  cannot recover that value. This completes the upstreamable error-hook patch.
  The existing browser dictation test failed with `idle`/`error: null` before
  the one-line fix, then passed with the sign-in error and successful metering
  after credentials became available.
- Remove two unused type imports from `think/src/messengers/chat-sdk.ts`.
  Add the existing upstream linter for Agents, Think, and Voice source to
  `test:vendor`; application lint does not inspect the vendored tree.
- Post-release Cap'n Web and persistent job-queue changes are not adopted.

## 2026-08-30 — Agents 0.22.0 refresh

- Base: released commit `676b3d35a82db3147c7aa1505f7f2d5ef48f359b`;
  Think 0.17.0, AI Chat 0.11.0, Voice 0.4.0. Shell and Codemode are unchanged.
  No post-release Cap'n Web transport work is included.
- Vendored GitHub workflow timeouts remain at the prior snapshot's values;
  upstream requires separate approval for workflow changes. Rook's test scripts
  are updated below, but no GitHub workflow is changed.
- `agents/src/lifecycle/durable-object-lifecycle.ts`: start the existing alarm
  queue task synchronously and await its predecessor before reading storage.
  The previous `.then(async ...)` entered without a do-runtime input lock.
  The private queue cannot be repaired by a host shim. Ordering and rejection
  recovery are unchanged; native Workers can use the same implementation.
- Retire the native bridge `dup`/`dispose` patch below: upstream now routes
  delayed operations through the root instead of retaining expired RPC
  arguments. Keep its regressions and registry cleanup on failed connect,
  close, and a late connect completion.
- Remove `Agent.__unsafe_reconcileAlarm`; the host now invokes the public
  `agent.lifecycle.rearmAlarm()` inside its container. Delegated-run physical
  broadcasts use `lifecycle.broadcast`, replacing `Server.prototype.broadcast`.
  PartyServer imports and the direct dependency are removed.
- `agents/src/chat/{broadcast-state,stream-accumulator}.ts`: retain immutable
  replay seeds when upstream's continuation accumulator first reads current
  messages, rather than at construction. The existing stream-accumulator suite
  covers replay after delayed seeding without lost history or duplicate output.
- `agents/src/experimental/memory/session/providers/agent.ts`: preserve Rook's
  explicit compaction projection and upstream's new `rowid` tie-breaker.
- Think keeps cancellation cutoffs, atomic replay, continuation metadata, and
  configured truncation. Recovery fibers are now unconditional, as upstream
  requires. Provider-safe outcome projection is applied before local truncation.
- Voice retains gated background startup, audio levels, and awaited close
  flushing. Its background helper captures context before an `await` while
  preserving upstream microtask order; otherwise detached failures are reported
  as startup failures. The session token stays valid until close flushing ends.
  The native VoiceInput suite reproduces dropped final text before this fix.
  The new fatal-transcriber path passes its error to Rook's existing
  `onCallEnd` hook. The root dictation UI exposes `turnMetrics: null` because it
  does not forward that new telemetry.
- All other retained changes below remain in place unless already marked
  retired. Storage and verification evidence belongs in `vendor-fork-audit.md`.
- The maintained vendor gate includes Lifecycle alarm arbitration, Scheduler
  capability tests, and VoiceInput; its install closure includes Voice.

## 2026-08-30 — Delegated work cancellation

- Files: `agents/src/index.ts`, `agent-tool-types.ts`,
  `chat/turn-queue.ts`, `chat/recovery.ts`, `chat/recovery-incident.ts`,
  `chat/recovery-engine.ts`, and
  `think/src/think.ts` under `vendor/agents/packages`.
- Why a shim cannot cover it: parent admission, retained terminal results,
  child recovery controllers, and automatic recovery are private SDK owners.
  Aborting only the browser's observed chat request cannot fence those paths.
- Change: bind awaited cancellation before fresh admission or reattachment;
  persist cancellation before signalling a child; return, broadcast, and notify
  hooks with the retained SQL winner. Pre-aborted run IDs remain aborted.
  Interrupted or aborted children reserve capacity until shutdown is confirmed.
  Cancel RPC failure, an absent acknowledgement, or the existing two-second
  delivery deadline leaves liveness uncertain and exposes a retryable control
  error. Late confirmation updates the same row; startup retries retained
  cancellation. Detached delivery policy is unchanged.
- `listAgentToolRuns`, `inspectAgentTool`, `cancelAgentTools`, and
  `onAgentToolRunChanged` expose the existing parent SQL owner. They do not
  create another registry. `agentToolRunMayExecute` is shared by capacity and
  presentation code; terminal status alone does not establish shutdown.
  Batch cancellation reports an explicit fulfilled or rejected result per run;
  an empty error message cannot turn an unconfirmed Stop into success. Explicit
  cancellation and recovery teardown share the same bounded acknowledgement
  handling and late liveness update, while retaining their different failure
  policies. Confirmed shutdown is retained even before interruption is sealed;
  later replay or terminal writes cannot replace that confirmation with an older
  running or unknown observation.
- Think's `stopCurrentWork` records a cutoff in its existing config table,
  invalidates pending admission, aborts current work and owned Agent Tools,
  preserves partial history and queued submission text, and waits for the
  queue captured at Stop. Later inputs are independent. Fiber snapshots and
  recovery callbacks carry the cutoff; legacy snapshots predate the first Stop.
  Child cancellation also aborts the request controller created by recovery,
  persists when delivered before start, and waits for admitted child work.
  Recovery-chain identity is carried in the existing admitted-turn context.
  Recovery indicator cleanup is scoped to the same request owner, so a late
  stopped callback cannot erase a newer recovery; explicit Stop clears it.
  Tool wrappers recheck cancellation after asynchronous decisions. Stop and
  child cancellation also capture the existing in-flight tool executions:
  scalar calls, streaming iteration, and raw actions behind abort races. A
  closed model stream alone cannot acknowledge their cleanup. The small live
  promise set owns those operations only; retained run facts remain in SQL.
  Approved actions register with the existing abort registry before asynchronous
  lookup. Their accepted outcomes still persist after Stop, but cannot restart
  inference. History-preserving Stop retains the existing interaction apply
  chain so accepted results cannot overwrite sibling results through concurrent
  message updates. Admissions capture their queue generation before acquiring an
  asynchronous keep-alive lease. Interactive and continuation admissions check
  the captured cancellation signal before lifecycle hooks or turn preparation;
  `saveMessages` retains its upstream contract of persisting accepted user input
  even when its inference signal is already aborted. Native chat stopped while its
  start callback awaits closes normally without preparing a turn. Connected
  continuation cleanup releases only its own request, preserving a newer
  pending continuation. Dedicated child
  cancellation also reaches approved actions without rewriting completed rows.
  `skipChatRequest` lets buffered host admissions settle through Think's native
  completion and request-deduplication path.
- Coverage: `agents/src/tests/agent-tool-lifecycle.test.ts` drives real parent
  SQL, child RPC, deadline/late-ack races, and a parent crash. Held child replay
  reads verify that a late acknowledgement survives both a running row and an
  already-interrupted row, and releases capacity;
  `think/src/tests/agent-tool-reattach-recovery.test.ts` drives actual mock-model
  abort signals, native admission, partial persistence, queued text, and
  eviction before recovery/start. The existing durable-pause suite covers
  cancellation during action lookup, execution cleanup, and post-turn approval.
  Native chat and real-facet regressions hold the actual startup callback or
  parent keep-alive lease across Stop and child cancellation; a later independent
  turn still runs. `client-tools.test.ts` holds the actual Session write across
  Stop and proves sibling results survive; its Clear control proves deleted
  history stays deleted. The native batch and Think Agent Tool suites also
  cover an empty child cancellation error, retained uncertainty, and successful
  retry. The Think Workers config aliases Agents source
  so these assertions cannot silently exercise old built code. Browser-host and
  packed Chrome coverage compose the same APIs with Rook's controls.
- Supporting test edits: `agents/src/tests/agents/agent-tool-lifecycle.ts`,
  `src/tests/worker.ts`, `src/tests/wrangler.jsonc`, and the existing shared
  `chat/__tests__/recovery-engine.test.ts` and `recovery-incident.test.ts`;
  `think/src/tests/agents/think-session.ts`, `src/tests/vitest.config.ts`,
  `agents/client-tools.ts`, `client-tools.test.ts`, `hooks.test.ts`,
  `actions-attach-reply.test.ts`, and
  `actions-durable-pause.test.ts`. The raw-socket approval fixtures acknowledge
  the existing resume notification before awaiting continuation frames, matching
  the real client. Two arbitrary Codemode descriptor expectations are retired
  with the August 16 removal below; retained action descriptors stay covered.
  A controlled unchanged-source comparison reproduced those fixture failures,
  so neither correction changes production approval or Codemode behavior.
- Declaration assertions: worker `host/think-vendor-augment.d.ts` mirrors
  Think's additive API; Agents uses its built public package declarations.
  This does not promise rollback of external actions or recursive cancellation
  beyond Rook's one-level delegation boundary. Future scheduled checkpoints are
  not current work.
- Upstreamable: yes. Neither lifecycle correctness nor recovery cancellation
  depends on Chrome.

## 2026-08-30 — Think retains continuation metadata on resume

- Files: `think/src/think.ts` and `think/src/tests/client-tools.test.ts` under
  `vendor/agents/packages`.
- Why a shim cannot cover it: Think starts the private resumable stream before
  broadcasting its continuation. The shared stream owner can persist and replay
  the continuation flag only if Think passes it at creation.
- Change: forward the existing continuation option to `ResumableStream.start`
  and derive the wrapper's options from that native method. No new stream state,
  protocol, or continuation scheduler is introduced.
- Coverage: the raw WebSocket test client acknowledges the native resume
  handshake. Both existing approved and denied server-tool continuation tests
  failed on the pre-cleanup source because replay lost the flag; their original
  assertions are retained. Tool execution, denial, and durable results remain
  covered by the same tests.
- Upstreamable: yes; this is a missing argument at the native Think boundary.

## 2026-08-30 — Native facet connection bridge lifetime

- Files: `src/index.ts`, `src/tests/sub-agent.test.ts`, and
  `src/tests/agents/sub-agent.ts` under `vendor/agents/packages/agents`.
- Why a shim cannot cover it: the SDK's existing virtual connection registry
  retains the bridge for replies after the inbound handler returns. Workers
  disposes RPC parameter stubs at that return unless the receiver duplicates
  them ([Workers RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call)).
  Think or a browser shim cannot repair this native SDK ownership boundary.
- Change: the existing connection record owns one duplicated native bridge,
  disposing it on replacement, close, or failed setup. Metadata writes preserve
  that owner, ordinary reads do not duplicate it, and local hydration bridges
  keep their existing lifetime. A completed connect hook cannot recreate a
  record removed during its await.
- Coverage: actual parent/sub-agent WebSockets followed by a separate RPC send
  reproduced `RPC stub used after being disposed` after both connect and
  message handlers returned. Both regressions and the complete 99-test native
  sub-agent suite pass without retries. This suite is included in Rook's
  maintained vendor gate.
- Scope: demonstrated in native Workers. Rook currently uses in-realm
  do-runtime facets; this finding does not establish a browser transport
  failure or justify restoring the historical Cap'n Web bridge shim below.
- Upstreamable: yes; this is native RPC resource ownership.

## 2026-08-30 — Retained roster and atomic replay

- Files: `agents/src/index.ts`, `agent-tool-types.ts`, `react.tsx`,
  `chat/agent-tools.ts`, and `think/src/think.ts` under `vendor/agents/packages`.
- Why a shim cannot cover it: the SDK owns connection replay, live frame
  attribution, retained rows, and the React accumulator. Deduplicating rendered
  cards cannot recover missing metadata or correct a lost stream boundary.
- Change: enumerate every retained parent row before reading child details,
  explicitly complete even an empty roster, and never create a missing facet
  to inspect it. Each replay has an identity; the hook exposes loading, ready,
  error, and stale state. Source switches clear the old projection immediately;
  reconnect keeps last-known rows while reconciling. Collection events are
  discriminated by status: ready requires the complete run ID list (including
  an empty list), and error requires its diagnostic. The hook and standalone
  reducer therefore agree on when a roster replaces retained rows.
- Child inspection optionally returns one atomic stored-chunk and live-cursor
  snapshot with progress and milestones. Snapshot hydration preserves newer live
  events and original timestamps; milestones retain identity. Producer and
  persisted-stream cursors have different epochs, so only a proven same-epoch
  overlap is discarded. Think registers a tail before the snapshot, preserves
  transient progress, and does not renumber the producer when a reader attaches.
  Closing a reader detaches it without cancelling the child.
- Coverage: the existing Agents reducer, `useAgentToolEvents`, real-Worker
  `agent-tool-replay`, and Think `agent-tools` suites cover empty and missing
  children, source switches, metadata-only snapshots, stale hydration, overlapping
  stream delivery, and recovery to a different stream epoch.
  Snapshot cursor coverage remains available after hydration to reject delayed
  covered frames even with fresh parent revisions. Strict Mode effect re-entry
  retains pending replay on the same transport; a real source change resets it.
- Supporting test edits: `agents/src/chat/__tests__/agent-tools.test.ts`,
  `src/react-tests/useAgentToolEvents.test.tsx`, `agent-tool-replay.test.tsx`,
  `setup.ts`, and `src/tests/agents/agent-tool-replay.ts`. The existing
  `src/tests/state.test.ts` selects state errors by message type so an empty
  roster frame cannot be mistaken for the response. Think's `think-session`
  test and fixture also verify stored chunk cursor provenance.
- `vendor/agents/examples/agents-as-tools/src/client.tsx` handles the newly
  exposed native `starting` status in its background, inline, and drill-in
  displays. Its former five-state projection otherwise treated a retained
  starting run as an error. The example's exhaustive label typecheck covers the
  additive status contract; cancellation still treats starting as nonterminal.
- The existing React test setup and shared Wrangler config resolve published
  Codemode so the real-Worker regression runs under the CI install closure.
  Paired local validation uses built Agents and design-system public packages,
  including their canonical declarations. The design system builds against
  released Agents; Rook passes collection state and the execution predicate
  explicitly. Rook's runtime still requires the patched Agents contract until
  these lifecycle and replay fixes are published upstream.
  Required collection fields are checked in the existing
  `src/tests-d/agent-tool-schema.test-d.ts` contract; the maintained vendor gate
  runs the Agents source typecheck before its runtime suites.
- Upstreamable: yes. No host protocol or parallel client run store was added.

## 2026-08-30 — Prepare the inference model before history rendering

- File: `vendor/agents/packages/think/src/think.ts`, covered by the production
  worker's `model-history-capabilities.integration.test.ts`.
- Why a shim cannot cover it: Think privately constructs workspace tools and
  converts persisted UI messages into provider messages before calling
  `beforeTurn`. By then `read.toModelOutput` has already included or withheld
  image/PDF bytes. A wrapper around the eventual provider cannot recover a
  withheld file, and a `beforeTurn` override cannot establish the earlier order.
- Change: `prepareModel()` runs once before tool/history assembly for each
  inference attempt. A returned model becomes the assembled context's model;
  returning nothing preserves the existing `getModel()` resolution point.
  Existing `beforeTurn` overrides remain supported. Rook uses this early hook
  to capture the model, identity and media flags together. Workspace reads,
  saved display outputs, and code execution consult that Agent's inference
  snapshot; compaction and starter-suggestion model lookups have no rendering
  policy side effects. Proactive compaction retains the active inference's
  snapshot when rebuilding history; continuations/retries prepare a new one.
  Sandbox capture policy is an explicit per-execution value: model tools use
  that inference's flag, while manual workspace execution can display images
  without model authorization or changing an active inference. The real-worker
  `workspace-execution-policy.integration.test.ts` crosses the existing iframe
  executor to cover cold/restarted and concurrent manual calls.
- Upstreamable: yes, as an asynchronous model-selection hook before history
  materialization. The published declaration gap is recorded in
  `host/think-vendor-augment.d.ts`; remove it when the upstream declaration
  includes this hook. No provider selection, state format, or default model
  behavior changes for subclasses that do not override it.

## 2026-08-30 — Reconcile an overflowing chat replay buffer

- Files: `vendor/agents/packages/agents/src/react.tsx`, covered by
  `src/react-tests/resume-overlap-race.test.tsx`.
- Why a shim cannot cover it: the socket owner buffers frames before the chat
  hook attaches. A host shim cannot discard that private incomplete replay log
  before it overwrites the freshly hydrated transcript.
- Change: retain the existing 4,096-frame bound, but discard the incomplete
  prefix on overflow and ignore subsequent stream fragments until a subscriber
  attaches. Only the latest transcript snapshot or clear with no later stream
  response or message update survives; normal hydration and the existing resume
  handshake reconcile completed and active streams. Both the live socket and test/custom-socket entry point use
  the same buffer operation. Address changes and drains reset the overflow flag.
- Validation: the real Chromium hook regression sends 5,000 text deltas while
  chat is unmounted, then checks visible text after a final snapshot, an idle
  terminal without a snapshot, and an active-stream resume. All three failed
  before this change and pass afterward. A fourth case covers a stale snapshot
  followed by a terminal frame. Completed tool-state cases cover a pending
  snapshot followed by a standalone `MESSAGE_UPDATED`, with low-volume and
  overflowing buffers; no buffer limit was raised.
- Upstreamable: yes — any retained socket can outlive its chat subscriber.

## 2026-08-29 — Tool-output truncation keeps a tail

- Files: `vendor/agents/packages/agents/src/chat/tool-output-truncation.ts`,
  covered by `src/tests/experimental/memory/utils/compaction.test.ts`.
- Why a shim cannot cover it: `truncateString` is a module-private function
  inside `truncateToolOutput`, which `truncateOlderMessages` applies during
  think's read-time replay and `enforceRowSizeLimit` (`chat/sanitize.ts`)
  applies when persisting a message past the SQLite row budget; nothing
  configurable reaches the cut shape.
- Change: a truncated string keeps a head, the `[truncated N chars]` marker,
  and a tail (split 4:1, head to tail) instead of head-only — the end of a
  long output is where an error message lands, and the 500-char replay cap was
  cutting exactly that (docs/future/context-system.md, change 7). Total length
  still lands exactly on `maxChars` in UTF-16 code units (callers measuring
  JSON or byte budgets re-measure and fall back themselves); budgets too small
  for a tail keep the head-only shape.
- Upstreamable: yes. The marker text is unchanged and no caller parses the
  cut's position.

## 2026-08-29 — Chat replay buffering follows hook subscribers

- Files: `vendor/agents/packages/agents/src/react.tsx` and
  `src/chat/react.tsx`, covered by
  `src/react-tests/resume-overlap-race.test.tsx`. Its socket-boundary regression
  runs real `useAgent`, PartySocket, and `useAgentChat`, replacing only the
  browser WebSocket; detailed replay cases also exercise the buffering helpers.
- Why a shim cannot cover it: `useAgent` owns frame parsing and buffering while
  `useAgentChat` owns listener mount and cleanup. A host shim would have to
  duplicate the private chat protocol or keep an unused chat surface mounted.
- Change: replace the chat buffer's one-shot drained flag with a subscriber
  count. Frames are buffered whenever no chat hook is listening, then drained
  on the next mount. The existing 4,096-frame bound remains unchanged. The
  address-key reset clears that buffer's frames in place rather than replacing
  the object, because a chat hook that stayed mounted holds its release closure
  over the old one: a replacement would read as unsubscribed while the hook
  still listens (delivering and buffering every frame, so the next mount
  replays duplicates) and would never see the hook's release.
- Validation: rendered messages survive chat unmount/remount without replaying
  frames already delivered live, and queued frames never cross an address
  change. Resolving the default host to an explicit host keeps the same socket
  and mounted chat, covering subscriber ownership during the in-place reset.
- Upstreamable: yes. Any app can keep `useAgent` mounted while swapping chat
  surfaces on the same connection.

## 2026-08-27 — Workspace read tool sends PDFs the model can actually receive

- Files: `vendor/agents/packages/think/src/tools/workspace.ts`, plus the
  `workspaceAcceptsPdfs` property that threads it in
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: the same reason as the 2026-08-03 image entry —
  the decision belongs inside `createReadTool()`'s `toModelOutput`, which
  re-renders the stored result on every request, and Think constructs the
  workspace tools itself. The capability rides `createWorkspaceTools`' options
  object exactly as `acceptsImages` already does.
- Change: `ReadToolOptions.acceptsPdfs` (a boolean or a thunk, defaulting to
  the current always-send behavior) gates the PDF `file-data` branch. An
  OpenAI-compatible gateway without PDF `file` parts fails in one of two ways,
  both worse than an error: it rejects the part — and because `toModelOutput`
  re-renders it on every later request, one read poisons the conversation from
  then on — or it strips the part, leaving the model a note naming a document
  it never received, which the model answers by hand-rolling PDF extraction in
  checked code (observed in the field as a ~200-step pako-from-CDN excursion
  against a 67 KB resume). Such an endpoint now gets `error-text` naming the
  path, media type, and size; the encode is skipped, so the base64 leaves the
  wire too. Same thunk-per-render contract as images, so a model swap changes
  the next request without rewriting the transcript. Contract coverage:
  `fixtures/read-tool-model-output.contract.test.ts` drives the withheld
  render and the per-render swap.
- Upstreamable: yes — same argument as the image entry: any host that lets a
  user point Think at an arbitrary OpenAI-compatible endpoint can face a
  gateway without `file` content parts, and upstream cannot express that today.

## 2026-08-25 — PartyServer transport patch retired

- Deleted package patch: `patches/partyserver@0.5.10.patch`.
- Replacement: stock PartyServer now receives sockets through Agents' public
  `routeAgentRequest()` path. A browser-only shim supplies the missing
  `WebSocketPair`, status-101 response field, and request-clone upgrade marker;
  do-runtime accepts the server half through its existing WebSocket boundary.
- Result: PartyServer owns connection construction, tags, sub-agent admission,
  request rewriting, and handlers again. The private
  `__unsafe_acceptConnection()` API and its pnpm patch are gone.
- Supersedes: the 2026-08-21 entry below. Its conclusion that a host shim could
  not cover the gap predated the do-runtime browser primitives.

## 2026-09-02 — Agents can migrate application state during hydration

- Files: `vendor/agents/packages/agents/src/index.ts`, with the regression in
  `src/tests/state.test.ts` and its `TestStateAgent` fixture.
- Why a shim cannot cover it: the Agent state getter privately owns the
  persisted row, hydration cache, and first protocol publication. Migrating in
  a subclass constructor happens after hydration and can only persist through
  `setState()`, which treats boot repair as a user update.
- Change: replace the validation-only seam with synchronous protected
  `migratePersistedState()`. The hook receives parsed JSON before exposure. A
  changed value is stored directly without write validation, broadcasts, or
  state-change hooks; a throw leaves the original row untouched for retry.
- Upstreamable: yes. It gives application state the same hydrate-then-stamp
  lifecycle as Agents' internal SQLite schema without exposing the private
  table or imposing a migration framework.

## 2026-08-25 — Think can reconcile code-declared messenger channels

- Files: `vendor/agents/packages/think/src/think.ts`, with the regression in
  `src/tests/messengers.test.ts` and its messenger route fixture.
- Why a shim cannot cover it: Think's channel registry and
  `ThinkMessengerRuntime` are private. Rotating app-owned credentials or
  removing a declaration otherwise requires constructing a second runtime and
  duplicating Think's request and fiber-recovery dispatch.
- Change: add `internal_reconcileChannels()` beside the existing scheduled-task
  reconciliation seam and a narrow
  `internal_resolveMessengerDeliverySurface()` operation for product-specific
  proactive sends. Reconciliation constructs the next channel/runtime pair
  before publishing it and clears a removed runtime. Rook now contributes its
  Slack/Discord definitions through `configureChannels()`; Think's built-in
  runtime owns ingress, recovery, routing, and delivery.
- Upstreamable: yes. Both are additive lifecycle/access operations over state
  Think already owns, with startup and ordinary Workers behavior unchanged.

## 2026-08-25 — Voice background work retains its actor event context

- File: `vendor/agents/packages/voice/src/audio-pipeline.ts`.
- Why a shim cannot cover it: the private Voice mixins dispatch `start_call`,
  `end_call`, interruption, and transcript work through `runBackground()`; a
  subclass cannot reach those calls or return their promises from `onMessage`.
- Change: invoke the background function inside the rejection-capturing Promise
  constructor instead of deferring its invocation through `.then()`. The work
  remains fire-and-forget after its first await, while alternate Durable Object
  hosts can capture the socket event's actor context at that await. Rook's await
  transform now includes pinned Voice source, and its browser lane excludes the
  package from dependency prebundling so the transform actually reaches it.
- Upstreamable: yes. Starting the async function synchronously preserves its
  error handling and is required by any alternate host whose event identity is
  captured at the first await.

## 2026-08-24 — Think recovery test retries use fresh actor storage

- File: `vendor/agents/packages/think/src/tests/think-session.test.ts`.
- Why a shim cannot cover it: this is upstream's Workers-pool test harness; it
  constructs its Durable Object stub directly and never enters Rook's browser
  host.
- Change: `freshRecoveryAgent()` now gives each test attempt a unique actor so
  Vitest retries cannot collide with SQL left by a timed-out attempt. The two
  `persist: false` cases assert that their recovery hook ran instead of spying
  on process-global warnings from unrelated recovery work.
- Upstreamable: yes — retries should be isolated on every Durable Object host.

## 2026-08-23 — Agent-tool tails can replay a running child's early backlog

- Files: `vendor/agents/packages/think/src/think.ts`, with the regression in
  `src/tests/think-session.test.ts` and its `ThinkTestAgent` fixture.
- Why a shim cannot cover it: Think privately owns the request-to-child-run
  map, the child-run SQL row, and resumable-stream creation. The browser host
  sees neither side of that join before chunks are persisted, so a host shim
  could only duplicate Think's private stream protocol and bookkeeping.
- Change: when an agent-tool turn opens its resumable stream, Think immediately
  binds that stream id to the still-running child row, before the first chunk
  can be stored. A parent that attaches after early live broadcasts can now
  drain those persisted chunks; ordinary chat turns have no map entry and do
  no child-run SQL.
- Upstreamable: yes — this closes a runtime-independent attach race in Think's
  own durable tail protocol.

## 2026-08-23 — Think keeps completed assistant content server-authoritative

- Files: `vendor/agents/packages/think/src/think.ts`, with direct Session and
  full next-turn coverage in `src/tests/think-session.test.ts` and
  `src/tests/message-reconciliation.test.ts`.
- Why a shim cannot cover it: Think owns both the private browser-request
  persistence boundary and the Session row update. A Rook transport shim would
  have to inspect and rewrite Think's private transcript protocol.
- Change: when a browser request replays an assistant message that resolves to
  an existing server row, Think keeps the stored parts while retaining its
  existing client-metadata policy. A duplicated 39-tool snapshot can no longer
  replace a completed 50-tool response and its final text on the next send.
- Upstreamable: yes — the bug is present on Cloudflare Agents `main` and is
  independent of Rook and alternate Durable Object hosting.

## 2026-08-23 — Alternate Durable Object hosts can restore Agents state

- Files: `vendor/agents/packages/agents/src/index.ts` and
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: alarm reconciliation and persisted Agent Tool
  milestone reads were private members. Rook had to reflect into both after
  restoring a browser-hosted actor, coupling the host to private names.
- Change: add the internal `Agent.__unsafe_reconcileAlarm()` host hook and the
  protected `Think.getAgentToolMilestones()` subclass hook. Rook now uses those
  typed seams and do-runtime's `createDurableObjectNamespace()` instead of its
  bespoke Durable Object id, namespace, stub, and private-member adapters.
- Upstreamable: yes; both are additive seams for alternate Durable Object hosts
  and leave Workers behavior unchanged.

## 2026-08-20 — Messenger conversations may resolve to root actors

- Files: `vendor/agents/packages/think/src/messengers/chat-sdk.ts` and one new
  case in `src/tests/messengers.test.ts`.
- Why a shim cannot cover it: `ThinkMessengerRuntime.resolveTarget` owned the
  closed `self | subagent` target union and called `host.subAgent()` internally.
  The do-runtime cutover makes Rook conversations namespace-addressed root
  actors, so a product shim would have to impersonate that upstream method.
- Change: conversation resolvers may return an explicit `resolved` target that
  already implements `MessengerThinkTarget`; default `self` and `thread`
  behavior is unchanged. Rook supplies its namespace stub directly.
- Upstreamable: yes; this is an additive routing seam for hosts whose
  conversations are independently addressed actors rather than facets.

## 2026-08-19 — Vendor refresh to agents@0.21.0 / think@0.16.0

- Baseline: Cloudflare Agents release commit
  `d42494503efe836a073fbf911fae1fbd12253198`, matching published
  `agents@0.21.0`, `@cloudflare/think@0.16.0`, `@cloudflare/ai-chat@0.10.2`,
  `@cloudflare/voice@0.3.6`, `@cloudflare/codemode@0.5.1`, and
  `@cloudflare/shell@0.4.3`. Think 0.16.0 and Voice 0.3.6 both declare
  `agents >=0.20.2`, so 0.21.0 is the first coherent set that satisfies them —
  the previous pin could not advance one package at a time.
- Scope: replace the complete vendored upstream snapshot and rebase the logged
  Rook changes onto it. The per-commit reading of all 37 first-parent commits,
  and the six unreleased commits that follow the release, are in
  [the vendor fork audit](vendor-fork-audit.md).
- Dissolved upstream: `AgentPathStep` (the local `export type` from the
  2026-07-31 sub-agent connection seams entry) — upstream
  [#2037](https://github.com/cloudflare/agents/pull/2037) now exports it from
  `agents` alongside `buildAgentPath`, `buildAgentUrl`, `BuildAgentPathOptions`,
  and `SubAgentPathMatch`. Also the `image-data` half of the 2026-07-25
  workspace-read entry, adopted by
  [#2082](https://github.com/cloudflare/agents/pull/2082); the fork's hunk in
  `think/src/tests/assistant-tools.test.ts` merged to zero delta because it was
  byte-identical to upstream's new test.
- Retired here, not upstreamed: the Agent Tool `prepareRun()` dispatch seam
  (`AgentToolRunPreparation`, `PreparedAgentToolFactoryOptions`) has had no host
  consumer since the subagent rework made `delegate` a plain `tool()` over
  `runAgentTool`, so `src/tests/agent-tools-failure.test.ts` is upstream
  byte-identical again. The `isBlockedHost` export in `think/src/tools/fetch.ts`
  lost its last consumer in the Codemode cut and is gone with the file's whole
  delta; its `think-vendor-augment.d.ts` block went with it. Both are recorded
  under Historical cleanup.
- Rebase adaptations: `projectAgentToolResult()` is re-extracted from
  `agentTool()`'s `execute` on top of upstream's new async `validateOutput`
  ([#2091](https://github.com/cloudflare/agents/pull/2091)), so the projection
  is now `async` and `AgentToolOutputSchema` is exported with it; the host
  consumer (`offscreen/worker/think-agents.ts:34`) sits inside async
  functions and needed no change.
  The retained workspace edit is now the `acceptsImages` gate plus the
  `MODEL_IMAGE_MEDIA_TYPES` raster allowlist sitting inside upstream's own image
  branch. The `agents` and `think` `src/tests/vitest.config.ts` files keep the
  fork's Codemode aliases; upstream's new `resolve.dedupe: ["vitest"]`
  ([#2097](https://github.com/cloudflare/agents/pull/2097)) rides along in the
  `agents` one, `ai-chat`'s copy carrying it byte-identical to upstream, and
  `src/react-tests/resume-overlap-race.test.tsx` keeps the fork's early-offer
  case alongside upstream's observer-error cases from
  [#2023](https://github.com/cloudflare/agents/pull/2023).
- Not carried: the fork never held a messenger word-gluing workaround, so
  [#2049](https://github.com/cloudflare/agents/pull/2049)'s shared
  `TextSegmentJoiner` path is taken verbatim. Its removal of
  `textDeltaFromStreamChunk` from `@cloudflare/think/messengers` has no host
  consumer, and the host-facing `TextStreamCallback` API is unchanged.
- Host adaptation: npm pins move to `@cloudflare/think@0.16.0` in the extension,
  think-app, and companion and `@cloudflare/voice@0.3.6` in the extension and
  think-app, with the workspace catalog's `agents` entry at 0.21.0. No shim row
  was added by the refresh. Think 0.16.0's removed `./framework`, `./server-entry`,
  and `./vite` subpaths had no importer here. Two alias rows lost their last
  consumer — `aywson` and `yargs`, which reached the bundle only through
  think's deleted CLI — and are gone from `vite-aliases.ts`, the extension's
  dependencies, and its fallow suppressions; `smol-toml` stays because bundled
  `just-bash` depends on it.
- Tests: `vp run test:vendor` passed all five vendored suites on the final
  tree (after the `skill-runner.test.ts` deletion and the `fetch.ts` restore,
  neither of which is on the lane's list). Upstream's own suites remain the
  coverage for every retained edit.
- Upstreamable: not applicable to the refresh itself. Each retained source edit
  keeps its entry below.

## 2026-08-19 — Submission metadata is stamped on the turn's user message

- Files: `vendor/agents/packages/think/src/think.ts` (`submitMessages`), one new
  case in `src/tests/submissions.test.ts`.
- Why a shim cannot cover it: `_stampChannel` is a private member and the
  submission row is written inside the same admission body; nothing outside the
  class sees the messages between the call and the row.
- Change: `SubmitMessagesOptions.metadata` (and `runTurn({ mode: "submit",
metadata })`, which routes through `submitMessages`) was stored on the
  submission row and exposed through `inspectSubmission`, but never reached the
  persisted user message — only the `chat()` path stamped `metadata.turnMetadata`
  (the contract documented on `ChatOptions.metadata`, which `activeTurnMetadata`
  reads). `submitMessages` already stamps the channel onto its user messages so
  the later drain re-resolves it from history; the metadata now rides the same
  call, in the same argument order `chat()` uses. Detached-run notices
  (`_cfDetachedNotifyFinish`, `_deliverDetachedMilestone` in `react` mode) and
  Rook's scheduled-follow-up wakes therefore carry their `source` on the message
  clients receive, which is what lets the design system render them by
  provenance instead of as user bubbles. Upstream's own `examples/agents-as-tools`
  client already assumes this (it classifies by `metadata.source`), so this also
  makes that example truthful.
- Side effect to know when upstreaming: the stamp is unconditional, so every
  internal `submitMessages` caller now writes a `turnMetadata` blob into durable
  history — visible in `getMessages()`, `exportConversations`, and
  `activeTurnMetadata`, not only in `inspectSubmission`. That is
  `_cfDetachedNotifyFinish`, `_deliverDetachedMilestone` (`react` mode), the
  declared-scheduled-task drain (`{...task.metadata, source: "scheduled-task",
ownerKey, taskId, scheduledFor, schedule}`), Rook's `#runScheduledFollowUp`
  (`source: "scheduled-follow-up"`), and workflow `step.prompt`, which smuggles
  its internal `__thinkWorkflowPrompt` envelope — output JSON Schema included —
  through the same public `metadata` field. Nothing misrenders (the design
  system keys on two known `source` values and ignores the rest), and Rook runs
  no `step.prompt` workflow; upstream may still prefer to move that envelope off
  the public option rather than filter it at the stamp.
- Upstreamable: yes.

## 2026-08-19 — A replayed `started` rebuilds the run on the client

- Files: `vendor/agents/packages/agents/src/react.tsx` (`useAgentToolEvents`,
  `agentToolDedupeKey`), `src/chat/agent-tools.ts` (`applyToRun`), two new cases
  in `src/react-tests/useAgentToolEvents.test.tsx`.
- Why a shim cannot cover it: the client-side dedupe set and the run reducer
  are upstream internals of the hook every consumer uses; there is no seam
  between the socket and the reducer to intercept a replay.
- Change: the hook keys frames by `(parentToolCallId, runId, sequence)` and
  kept every key across socket reconnects. Live numbering counts every
  forwarded frame, including transient `reportProgress` frames that are never
  stored, while a connect-time replay renumbers over stored chunks only — so
  once a run has emitted progress, a replayed frame can carry a sequence the
  client already saw live and be dropped; a dropped replayed terminal leaves
  the row running forever. Now a `started` frame marked `replay: true` purges
  every key seen for that run (`agentToolDedupeKey` is split so the run prefix
  it purges by is the key's own head) and the reducer rebuilds the run's `parts`
  from the replay instead of appending to what already streamed. The rebuild
  covers a settled run too — `_replayAgentToolRuns` replays every retained run,
  finished ones included, so leaving their parts in place doubled the text of
  every completed run on reconnect — while the terminal guard still refuses to
  resurrect the status.
- Upstreamable: yes; the same key and numbering exist on upstream `main`.

## 2026-08-16 — Active Think and skill barrels no longer reach Codemode

- Files: `vendor/agents/packages/think/src/think.ts`
  and `vendor/agents/packages/agents/src/{skills/index.ts,skills/registry.ts,tests/skills.test.ts}`.
- Why a shim cannot cover it: the live Think source imported its retired
  execute helper and exported the complete skills namespace. That namespace
  eagerly reached Agents' optional Codemode-backed script runner, so a clean
  extension install could not bundle even though Rook never called either
  path. Restoring an alias or optional peer would keep a second execution
  runtime reachable behind the hard cutover.
- Change: remove Think's Codemode approval/runtime members and the upstream
  `run_skill_script` injection/export. Skill discovery, loading, references,
  and the Rook-owned saved-script `execute({ path })` path remain. The removed
  paths' cases in `agents/src/tests/skills.test.ts` are deleted with them;
  think's own execute suites (`tests/execute-hitl.test.ts` and its fixture
  agents) stay upstream byte-identical, and their red state under the cut is
  recorded in the fork audit. A clean WXT
  build now succeeds with every package-local Codemode link absent.
- Completed 2026-08-19: `src/tests/skill-runner.test.ts` (948 lines) was missed
  when this entry claimed the runner tests were deleted. It targets the
  `skills.runner` / `SkillWorkspace` surface removed above, and it was what made
  upstream's `src/tests/tsconfig.json` typecheck red. Deleted at the 0.21.0
  refresh, under this entry rather than as a new one.
- Upstreamable: no. This is the browser host's intentional single-runtime cut;
  upstream continues to support Codemode and its Worker Loader skill runner.

## 2026-08-16 — Rook no longer carries a Codemode product fork

- Files: `vendor/agents/packages/codemode`,
  `vendor/agents/packages/think/src/tools/execute.ts`, the matching Think
  execute/approval fixtures, and the Codemode approval-resume hunks in
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: no shim is needed. Rook's checked-code runtime is
  extension-owned and no longer calls the upstream Codemode product surface.
- Change: restore the complete tracked Codemode package to pinned upstream
  commit `413011e5b282ce215598223d4c2df5e9dbfaff03`. The tracked package is
  still identical after the 2026-08-19 refresh: upstream changed one line of
  `packages/codemode/package.json` between that commit and `d4249450` and no
  source at all, so `@cloudflare/codemode` remains 0.5.1 at both pins.
  Four Rook-only Codemode source/test files were deleted rather than retained
  behind an unused compatibility path. The exact upstream package remains as
  vendored reference and for its own upstream suites; the active Rook bundle no
  longer imports it.
- Upstreamable: not applicable; this removes the Rook-specific Codemode fork.
  Codemode entries below this one are historical provenance, not descriptions
  of retained Rook behavior.

## 2026-08-15 — Oversized Codemode arguments do not dispatch

- File: `vendor/agents/packages/codemode/src/runtime-tests/runtime.test.ts`.
- Why a shim cannot cover it: Codemode owns both durable call admission and the
  connector dispatch boundary; the regression exercises that owner directly.
- Change: coverage now proves that an oversized second call is rejected before
  dispatch, the execution becomes `error`, and an earlier applied call remains
  visible in both its side effect and model-facing call receipt.
- Upstreamable: yes — this locks the existing runtime-independent size guard and
  partial-effect receipt semantics without changing runtime behavior.

## 2026-08-14 — Unacknowledged chat requests replay across route changes

- Files: `vendor/agents/packages/agents/src/chat/ws-chat-transport.ts`,
  `src/chat/pre-stream-turns.ts`, `src/chat/resumable-stream.ts`,
  `src/chat/resume-handshake.ts`, `src/chat/wire-types.ts`,
  `src/chat/react.tsx`, `src/react-tests/resume-overlap-race.test.tsx`,
  `vendor/agents/packages/ai-chat/src/index.ts`, and
  `vendor/agents/packages/think/src/think.ts`. Coverage is in the focused chat
  transport, pre-stream, and resume-handshake tests plus AIChat's request-id and
  Think's on-connect WebSocket suites. `src/chat/__tests__/ws-chat-transport.test.ts`
  is fork-new (upstream has no transport suite); the same transport signature
  change also adapts `ai-chat/src/tests/ws-transport-resume.test.ts`'s
  `handleStreamPending(pendingFrame)` call shape and adds the `noResponse`
  fixture branch to `ai-chat/src/tests/worker.ts` for the request-id suite.
- Why a shim cannot cover it: the shared chat transport owns the request stream,
  while AIChatAgent and Think own the point after message persistence. A browser
  shim can detect a dead pipe, but cannot know whether a chat request crossed
  that persistence boundary.
- Change: the transport retains the exact serialized request in a module-owned
  outbox keyed by stable `chatId`. A replacement hook and transport replay that
  byte-identical frame through `reconnectToStream` until a correlated
  `STREAM_PENDING { persisted: true }` receipt or response proves acceptance.
  Ordinary pre-stream pending frames remain advisory and cannot clear delivery
  state. AIChat and Think reject duplicate request IDs through the existing live
  `PreStreamTurns` owner before a stream starts and retained `ResumableStream`
  metadata afterward, returning the normal pending/resume frames instead of
  running inference twice. Turns that settle without creating a stream retain
  an empty completed receipt in that same metadata owner and arm its existing
  cleanup alarm; terminal-error IDs remain in the existing terminal owner.
  Explicit cancellation, terminal completion, and local or server-driven chat
  clear remove the outbox entry. The outbox deliberately survives hook/route
  replacement, but not destruction of the whole client JavaScript realm; it
  adds no storage or second wire protocol. Completed-request duplicate
  protection, including empty receipts, follows `ResumableStream`'s existing
  ten-minute completed-buffer retention; no independent idempotency ledger is
  introduced.
- Upstreamable: yes — request acknowledgement and stream completion semantics
  are runtime-independent, and the persisted discriminator makes the existing
  pending frame's acceptance meaning explicit.

## 2026-08-13 — Continuation replay cannot persist duplicate tool parts

- Files: `vendor/agents/packages/agents/src/chat/broadcast-state.ts`,
  `src/chat/stream-accumulator.ts`, `src/chat/message-builder.ts`,
  `src/chat/sanitize.ts`, and `vendor/agents/packages/think/src/think.ts`.
  Coverage is in the matching chat `broadcast-state`, `stream-accumulator`, and
  `sanitize` tests (`src/chat/__tests__/sanitize.test.ts` is fork-new; upstream
  has no sanitize suite) plus Think's provider-replay continuation case in
  `vendor/agents/packages/think/src/tests/think-session.test.ts` and its fixture
  Agent.
- Why a shim cannot cover it: the vendored chat state machine owns replay,
  accumulation, continuation merge, and persistence sanitization, while Think
  owns provider continuation before it reaches the host. A transport shim would
  have to interpret private AI SDK chunks and duplicate both state machines.
- Change: repeated continuation delivery rebuilds from an immutable original
  seed; Think ignores regressive provider-replayed tool chunks already
  represented by that seed; when a continuation's message ID misses and falls
  back to the latest assistant message, it adopts that ID and removes duplicate
  tool parts from superseded snapshots without discarding sibling content; and
  accumulation plus persistence keep one tool part per `toolCallId`, preferring
  the more settled copy and warning when the persistence guard removes duplicates.
- Upstreamable: yes — reconnect and provider replay are runtime-independent;
  reconnect replay must not duplicate reasoning or tool parts, and provider tool
  replay must not regress an already-advanced call.

## 2026-08-13 — An updated message's stored role stays current

_Reduced 2026-08-21. This entry used to be "Session messages and their derived
rows commit together": three `assistant_messages_fts_\*`triggers that derived
each search row inside its message's own statement, a compaction cleanup in the
delete trigger, and the removal of upstream's JavaScript FTS writes. The
rationale was that the pre-cutover host wrapper saw individual SQL statements
and could not group them.`@mcp-b/do-runtime`implements workerd's implicit
transaction, which commits the provider's adjacent no-await`sql`writes
together, so the whole trigger half was reverted to upstream:`indexFTS()`/`deleteFTS()`, their call sites in `appendMessage`, `updateMessage`, and
`deleteMessages`, and `clearMessages()`'s FTS sweep are upstream's text again.
The delete trigger's compaction cleanup was dropped rather than reimplemented —
nothing outside the vendored tree calls `Session.deleteMessages`, so no host
path reaches the orphaned-compaction state it covered. Only the `role` repair
below survives, and it is unrelated to atomicity.\_

- File: `vendor/agents/packages/agents/src/experimental/memory/session/providers/agent.ts`
  (one added column in `updateMessage`'s `UPDATE`). No test asserts it; the
  vendored `agents/src/tests/experimental/memory/session/provider.test.ts` on
  the `test:vendor` list covers the surrounding update and search behavior.
- Why a shim cannot cover it: the provider owns the private `role` column and
  the single statement that rewrites a stored message. A host wrapper would
  have to issue a second `UPDATE` against Session's private schema after every
  update it did not originate.
- Change: `updateMessage` sets `role` alongside `content`, so the row's column
  matches the message it stores. Upstream rewrites only `content`, leaving the
  column at its insert-time value; `pathRowStats()` reads that column, and
  `Session`'s skill-restore scan uses it to decide which rows to open
  (`experimental/memory/session/session.ts` skips every row whose `role` is not
  `"assistant"`), so a message that became an assistant message on update is
  skipped there.
- Upstreamable: yes — the provider already has the value in hand, and every
  reader of the column is upstream's own.

## 2026-08-12 — Chat replay frames survive the pre-subscription gap

- Files: `vendor/agents/packages/agents/src/react.tsx` and
  `src/chat/react.tsx`, covered by the active-stream offer case in
  `src/react-tests/resume-overlap-race.test.tsx`.
- Why a shim cannot cover it: both extension and companion now resolve the
  vendored `agents/react` source. Keeping a host buffer would duplicate the
  socket's state, recognize private protocol frames, and re-dispatch synthetic
  events. The socket owner can preserve the real event before React effects run.
- Change: `useAgent` buffered server chat frames that arrived while no
  `useAgentChat` listener had attached yet, drained once through the chat
  hook's ordinary message handler behind a one-shot flag. The buffer was
  bounded; the 2026-08-29 entry above replaced that one-shot drain with a
  subscriber count.
- Upstreamable: yes — a fast transport can deliver an active-stream offer
  before React's passive effects, leaving a new thread blank until terminal
  transcript hydration.

## 2026-08-12 — Session and turn timing reach chat metadata

- Note (2026-08-19 refresh): the retained assertion at
  `src/tests/experimental/memory/session/provider.test.ts:356` now narrows
  `getCompactions()` to `Array<{ createdAt: number }>`. It was raising TS18046
  under upstream's own typecheck before the refresh; the fix is test-only and
  changes nothing about the behavior below.
- Files: `vendor/agents/packages/agents/src/experimental/memory/session/providers/agent.ts`
  and `vendor/agents/packages/think/src/think.ts`, covered by the provider read
  tests and Think Session integration tests for live writes, terminal outcomes,
  browser replay, and hydration.
- Why a shim cannot cover it: Agent Session owns the private SQL `created_at`
  column and Think owns both its live message cache and persistence boundary.
  A host shim would need a parallel clock or transcript ledger and still could
  not recover the timestamp that Session discards during hydration.
- Change: Agent Session restores its existing SQL creation time as the typed
  `SessionMessage.createdAt`. Think projects that fact into
  `metadata.createdAt`, records terminal assistant `durationMs` and `status`,
  and exports their closed `ThinkMessageMetadata` contract. Browser-supplied
  timing is stripped at intake, while replay preserves the matching server
  row's authoritative values. `@mcp-b/react-components` formats those
  facts through the existing timestamp and Activity owners.
- Upstreamable: yes — Session already declares `createdAt`, and Think already
  owns assistant persistence. Keeping the fact there avoids a host transcript
  ledger.

## 2026-08-11 — Agent-tool replay frames survive the pre-subscription gap

- File: `vendor/agents/packages/agents/src/react.tsx` (`useAgent` buffers,
  `useAgentToolEvents` drains, new internal export
  `_bufferAgentToolReplayFrame`), covered by three new cases in
  `src/react-tests/useAgentToolEvents.test.tsx` (pre-mount drain,
  buffered/live overlap dedupe, buffering stops after first drain).
- Why a shim cannot cover it: a host buffer would stand outside the library,
  re-derive protocol framing with a string-prefix check, and re-inject
  synthetic events. Both hosts resolve the vendored `agents/react`, so the
  socket owner is the single place that needs to preserve the replay.
- Change: the server replays retained runs once per socket connect, but
  `useAgentToolEvents` attaches its listener in a passive effect, after
  paint. On an in-process transport (this host's port bridge) the connect and
  replay complete first — reliably on a hot return from a run drill-in — and
  the frames were lost, so the run chips vanished. `useAgent` now stashes
  parsed `agent-tool-event` frames in a bounded per-socket buffer from
  construction; `useAgentToolEvents` drains it when its listener attaches
  (listener first, so a frame landing mid-drain is deduped by the existing
  `(parent, run, sequence)` set, not lost). One-shot: after the first drain
  the live listener owns delivery. `_bufferAgentToolReplayFrame` is the seam
  for a host driving a non-`useAgent` socket, and for tests.
- Upstreamable: yes — any sufficiently fast transport (same-process workers,
  loopback, a warm HTTP/3 connection racing a busy main thread) can deliver
  the connect-time replay before React's passive effects; the fix is
  client-only, changes no protocol or server behavior, and is invisible to
  consumers that never hit the race.

## 2026-08-11 — Reconnecting streams receive replay before terminal

- File: `vendor/agents/packages/think/src/think.ts`, covered by
  `vendor/agents/packages/think/src/tests/onconnect-broadcast.test.ts`, which
  connects during a real gated chat turn and delays the resume ACK until after
  the success/error terminal path has run.
- Why a shim cannot cover it: Think owns the private pending-resume set and the
  terminal broadcast. The host only supplies the socket and cannot reorder
  those frames after Think emits them.
- Change: terminal paths keep reconnecting clients excluded from the live
  terminal broadcast until after it is sent. Their queued resume ACK therefore
  replays the completed buffer and its terminal frame instead of seeing an
  early empty `done` frame and closing before replay.
- Upstreamable: yes. The race is runtime-independent and reproduced under a
  loaded host test lane.

## 2026-08-10 — Vendor refresh to agents@0.20.1 / think@0.15.1

- Baseline: Cloudflare Agents release commit
  `413011e5b282ce215598223d4c2df5e9dbfaff03`, matching published
  `agents@0.20.1`, `@cloudflare/think@0.15.1`,
  `@cloudflare/codemode@0.5.1`, and `@cloudflare/voice@0.3.5`.
- Scope: replace the complete vendored upstream snapshot and rebase the logged
  Rook changes onto it. No retained runtime edit dissolved in this release.
  The release adds stable MCP SDK v2 client/server support and fixes AI SDK v7
  telemetry invocation ownership; Codemode remains on its SDK-neutral,
  three-argument MCP boundary.
- Host adaptation: the root Agent MCP manager now receives
  `callTool(params, { signal })`, its released v2 signature. The Codemode
  connector still calls its structural legacy shape
  `callTool(params, undefined, { signal })`; the existing shared-MCP adapter is
  the single translation point between those two owners. Rook adds no MCP
  protocol, registry, or storage shape.
- Tests: the retained workspace-image patch already emits `image-data`, the
  behavior upstream later adopted in `9d35e81e`. Its two stale release
  assertions now expect that real output. The rebuilt upstream Agents worker
  suite passes 1,759 tests; Think's two affected files pass 235 tests, with the
  full Think worker suite run as the release gate.
- Upstreamable: not applicable to the refresh itself. Each retained source edit
  keeps its entry below.

## 2026-08-03 — Workspace read tool renders images per model capability

- File: `vendor/agents/packages/think/src/tools/workspace.ts`, plus the
  `workspaceAcceptsImages` property that threads it in
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: the same reason as the 2026-07-25 entry below —
  the decision belongs inside `createReadTool()`'s `toModelOutput`, which closes
  over `ReadOperations` and re-reads the file on every request, and the
  workspace tools are constructed by Think itself rather than reaching the host
  through `getTools()`. The capability rides `createWorkspaceTools`' existing
  options object exactly as `bash`/`workspaceBash` already does.
- Change: `ReadToolOptions.acceptsImages` (a boolean or a thunk, defaulting to
  the current always-send behavior) gates the image branch. A model with no
  image input does not refuse an `image-data` part — it accepts it, bills the
  base64 as input, and answers from a picture it never saw, which is a wrong
  answer rather than a failed request. Such a model now gets `error-text`
  naming the path, media type, and size; the encode is skipped, so the payload
  leaves the wire too. The note names the file and stops there rather than
  prescribing a recovery: `read` takes a path and a line window, with no mode
  that returns an image as text, so any alternative it named would come back to
  this branch. It is a thunk rather
  than a value because `toModelOutput` re-renders a stored result on every
  later request: reading capability per render lets a model swap change the
  next request without rewriting the transcript behind it, and a read whose
  image was withheld becomes visible again on a model that can see it.
  Contract coverage: `fixtures/read-tool-model-output.contract.test.ts` drives
  the real vendored tool through the withheld render and the per-render swap.
- Upstreamable: yes — any host that lets a user point Think at an arbitrary
  OpenAI-compatible endpoint can be configured with a text-only model, and
  upstream has no way to express that today.

## 2026-07-31 — Agent Tool cancellation fences child admission

- File: `vendor/agents/packages/agents/src/index.ts`, with the existing awaited
  cancellation assertion in `src/tests/agent-tool-detached.test.ts` and the
  real-browser cancellation boundary in
  `packages/extension/src/offscreen/worker/host/fixtures/browser/agent-tool-delegation.integration.test.ts`.
- Why a shim cannot cover it: `runAgentTool()` publishes its parent row before
  awaiting child creation and durable child admission. An explicit cancel can
  therefore reach `cancelAgentToolRun()` before the child has a row and be a
  documented no-op; a host retry loop would duplicate private lifecycle state
  and guess when admission finished. The same private event producer also
  projected capacity-rejected parent rows as drill-in children even though no
  child existed; a UI predicate would contradict Agent Tool's retained-child
  state contract.
- Change: persist the parent's `aborted` terminal as the cancellation fence
  before crossing into the child. Immediately after child admission,
  `runAgentTool()` observes that existing row and repeats the idempotent child
  teardown before any tail is attached. Awaited finish projection remains on
  the normal awaiting path; detached delivery still uses its guarded ledger.
  A detached cancellation that precedes child admission claims and runs its
  durable finish delivery immediately, but defers only the live terminal event
  until the runner has published `started`; the runner derives that ordering
  through a worker-local marker. A restart therefore neither loses the finish
  hook nor mints a child, while a surviving runner preserves reducer event order
  without inventing a drill-in target.
  A normal `started` event now follows child creation, capacity failures remain
  visible on their originating tool result without publishing a nonexistent
  retained run, and reconnect replay skips parent rows with no retained child.
- Upstreamable: yes. Separate Agent invocations can interleave at every await in
  Workers too, so cancel-before-child-admission must not restart cancelled work.

## 2026-07-31 — Codemode exposes the durable connector-call sequence

- File: `vendor/agents/packages/codemode/src/connectors/types.ts` and
  `src/proxy-tool.ts`, with host boundary coverage in
  `packages/extension/src/offscreen/worker/fixtures/agents-run.contract.test.ts`.
- Why a shim cannot cover it: Codemode already allocates and durably replays one
  sequence per connector call, but the value is private to `runPass()` and was
  absent from `ToolExecuteContext`. Hashing a call's arguments outside Codemode
  made two intentional identical calls share one Agent run.
- Change: include the decided `sequence` in `ToolExecuteContext` for execution
  and rollback. The `ctx.agents` adapter scopes that value under the outer
  Think tool-call or Codemode execution id, so replay reattaches the same call
  while `Promise.all` fan-out keeps identical calls distinct.
- Upstreamable: yes. Durable call identity is generally useful to connectors
  whose external work must be idempotent across replay.

## 2026-07-31 — Agent Tool factory owns dispatch preparation and result projection

_Half retired at the 2026-08-19 refresh. `prepareRun()` and its
`AgentToolRunPreparation` / `PreparedAgentToolFactoryOptions` types are gone:
the subagent rework made `delegate` a plain `tool()` over `runAgentTool`, so
nothing here selected dispatch through the factory any more, and
`src/tests/agent-tools-failure.test.ts` is upstream byte-identical again. The
exported `projectAgentToolResult()` is retained and is now `async`, wrapping the
`validateOutput` that upstream added for flexible schemas in
[#2091](https://github.com/cloudflare/agents/pull/2091); `AgentToolOutputSchema`
is exported with it. Read the dispatch-preparation paragraphs below as the
argument for a seam this host no longer needs._

- File: `vendor/agents/packages/agents/src/agent-tools.ts`, with focused cases
  in `src/tests/agent-tools-failure.test.ts`.
- Why a shim cannot cover it: `agentTool()` closes over its AI SDK `execute`
  function. Rook's `background` choice and prose-only child input previously
  required spreading the returned tool and replacing that function, which
  duplicated upstream run IDs, parent-tool association, display metadata,
  abort behavior, detached semantics, and lifecycle-result projection. A host
  wrapper cannot extend the closed factory without becoming a second factory.
- Change: an optional `prepareRun()` maps validated tool input to child input
  and selects detached execution; the original path is unchanged when omitted.
  The factory retains ownership of `toolCallId`-derived run identity, signals,
  display metadata, and `runAgentTool()`. Its existing terminal projection is
  exported as `projectAgentToolResult()` so Codemode delegation consumes the
  same success/failure semantics instead of copying them.
- Upstreamable: yes. Dispatch-only fields and per-call detached selection are
  general Agent Tool needs, and the default overload remains source-compatible.

## 2026-07-31 — A refused sub-agent gate is a consumed routing result

_Split 2026-08-21; this entry keeps the refusal half. The bridge-installation
half — the `export` on `SubAgentConnectionMeta` and
`SubAgentConnectionBridgeLike`, that shape's Promise-like operations, and the
first-install-wins `_cf_setDefaultSubAgentBridge()` seam — existed for a
Cap'n Web bridge: the browser wrapper implemented the bridge shape in another
worker, so its operations returned promises, and it installed itself into the
ambient slot the host previously reached by casting a private field. In-realm
facets replaced that bridge in the do-runtime cutover and took
`host/shims/retained-sub-agent-connection-bridge.ts` with them, leaving the
seam with no implementor and no caller anywhere in the workspace, so all three
went back to upstream's text. Upstream's own `SubAgentConnectionBridge` and
`RootSubAgentConnectionBridge` return `void`, so the narrowed shape still
describes both. An earlier half dissolved at the 2026-08-19 refresh: the local
`export type AgentPathStep`, which upstream
[#2037](https://github.com/cloudflare/agents/pull/2037) now declares in
`./sub-routing` and re-exports from the root._

- File: `vendor/agents/packages/agents/src/index.ts`
  (`_cf_resolveSubAgentConnection` and its three forwarders).
- Why a shim cannot cover it: bridged-routing fallthrough is private Agent
  control flow. The host pre-ran `onBeforeSubAgent` and upstream then ran the
  hook again, while a refusal could still fall through to an ungated local
  accept.
- Change: a refusal from `onBeforeSubAgent` resolves to the `"rejected"`
  routing result instead of `null`. The connect path returns without falling
  through to `onConnect`, and the message and close forwarders consume the
  frame, so a rejected sub-agent connection is never mistaken for a request
  addressed to the current Agent. (`"deleted"` alongside it belongs to the
  2026-07-30 stale-frame entry.) The refusal is live in this host: three
  `onBeforeSubAgent` overrides in `offscreen/worker/think-agents.ts` gate
  depth-two hops, one of which refuses unconditionally.
- Upstreamable: yes. A gate refusal must not be bypassed on any transport.

## 2026-07-31 — Recovery ordering preserves retryable Agent Tool turns

- Files: `vendor/agents/packages/agents/src/index.ts`
  (`_waitForAgentToolRunRecovery`) and
  `vendor/agents/packages/think/src/think.ts` (`waitUntilStable` and
  `_handleRecoveryCallbackError`), with focused status coverage in
  `vendor/agents/packages/think/src/tests/think-session.test.ts`.
- Why a shim cannot cover it: Agents owns the private startup-reconciliation
  promise for parent-side Agent Tool rows, while Think owns both its stability
  loop and chat-recovery incident state. A browser wrapper cannot order those
  operations or correct the incident transition without duplicating recovery
  machinery.
- Change: Agents exposes a protected one-purpose waiter for its active startup
  reconciliation. Think joins it under `waitUntilStable`'s existing deadline
  before waiting on the turn queue, so chat recovery does not run ahead of
  parent-side Agent Tool reconciliation. When a recovery callback rethrows a
  platform transient, its incident remains `scheduled`, matching the preserved
  one-shot schedule row; it is not mislabeled terminal while the platform still
  owns a retry.
- Upstreamable: yes. The ordering and incident state describe upstream-owned
  recovery on Workers as well as in the browser host.

## 2026-07-30 — Structured agent-tool output through the workflow final-answer pipeline

- File: `vendor/agents/packages/think/src/think.ts` (Agent Tool launch and
  recovery), plus focused coverage in `src/tests/think-session.test.ts` and a
  test-only addition in `src/tests/agents/think-session.ts` (`ThinkTestAgent`
  gains `setFinalAnswerResponseForTest`, reusing the file's existing
  `createFinalAnswerMockModel`).
- Why a shim cannot cover it: Think already owns the hard parts of a structured
  turn — collision-safe `think_final_answer` naming, forced tool choice,
  stop-on-answer, missing-answer failure, output capture, and stripping the
  internal tool parts from persisted history — but that machinery is keyed off
  `workflowPrompt.output`/`captureOutput` options that only workflow
  submissions pass, and `startAgentToolRun` composes its
  `_runProgrammaticMessagesTurn` call privately with no seam in between. The
  browser host's structured delegation (`ctx.agents.run` with `outputSchema`)
  previously reimplemented the whole pipeline host-side (own `complete_task`
  tool, prompt injection, durable output table, extraction), which review
  correctly flagged as duplicating Think.
- Change: widen the options to `{ runId, output?: { schema } }`. When `output`
  is present, pass the existing `workflowPrompt`/`captureOutput` turn options
  with a synthetic Agent Tool workflow identity and prefer the turn's captured
  `result.output` over the `getAgentToolOutput()` subclass seam when writing the
  run row. The schema is
  stored on that same upstream child-run row, rebound into recovered continue
  and retry turns, and the captured output is persisted before recovery
  reconciliation can classify the child. Callers that pass only `{ runId }`
  keep the same model-turn behavior. The host subclass supplies the output
  option; upstream's parent-side `runAgentTool` remains the dispatch owner.
  Declared for tsc in `think-vendor-augment.d.ts`
  (published-dist types, vendored behavior). Contract coverage drives ordinary
  structured completion, missing-answer failure, and structured continue/retry
  recovery.
- Upstreamable: yes — `RunAgentToolResult<Output>`/`getAgentToolOutput` are
  upstream's own structured-child design with no built-in way for a child to
  produce the output; routing agent-tool runs through the existing workflow
  machinery closes that gap for every host instead of each subclass
  reimplementing it.

## 2026-07-30 — Detached completion labels honor Agent Tool display metadata

- File: `vendor/agents/packages/think/src/think.ts`
  (`formatDetachedCompletion`).
- Why a shim cannot cover it: the label is composed inside Think's protected
  formatter. A host override can only replace the entire status formatter,
  duplicating every upstream completion/error/interruption branch merely to
  change one label; there is no label-only compatibility seam.
- Change: prefer `run.display.name`, already supplied by `agentTool()` as the
  user-facing Agent Tool name, and fall back to the implementation class name.
  Detached notifications now use the same name as the retained-run UI without
  a browser-host formatter parallel.
- Upstreamable: yes. Display metadata should be honored by upstream's own
  generic notification formatter on Workers and browser hosts alike.

## 2026-07-30 — A stale frame cannot resurrect a deleted sub-agent

- Files: `vendor/agents/packages/agents/src/index.ts`
  (`_cf_resolveSubAgentConnection`, `_cf_forwardSubAgentWebSocketMessage`,
  `_cf_forwardSubAgentWebSocketClose`). Logged 2026-08-20; the edit itself
  landed 2026-07-30 alongside the host's thread deletion and was missed here.
- Why a shim cannot cover it: `_cf_resolveSubAgent` is create-on-access and is
  called from inside upstream's own forward loop; nothing outside the class
  sits between an arriving frame and the resolution that re-registers the
  child.
- Change: `_cf_resolveSubAgentConnection` accepts `requireRegistered`, under
  which a route whose child is no longer in `hasSubAgent` resolves to the new
  `"deleted"` routing result instead of lazily re-creating the child (the
  `"rejected"` result alongside it belongs to the 2026-07-31 connection-seams
  entry). The message and close forwarders pass the flag and consume such
  frames — the message forwarder also closes the connection with 1008
  "Sub-agent deleted" — because a frame arriving on a stale connection after
  `deleteSubAgent` would otherwise resurrect the child it targets, falling
  through would hand a child-protocol frame to the parent, and leaving the
  socket open would strand the sender's pending call forever. Fresh connects
  do not pass the flag, so legitimate lazy creation is unchanged.
- Upstreamable: yes; `deleteSubAgent` exists upstream, and a frame racing it
  re-creates the deleted child there today.

## 2026-07-29 — A rejected hydration promise is not cached forever

- File: `vendor/agents/packages/agents/src/chat/react.tsx`
  (`doGetInitialMessages`). Logged 2026-08-20; the edit landed 2026-07-29 and
  was named only in the fork audit's upstreamable-bug list until now.
- Why a shim cannot cover it: `requestCache` and the fill are module-private
  to `useAgentChat`; no consumer seam sees the promise between creation and
  reuse.
- Change: the cached initial-messages promise attaches a `catch` that evicts
  the entry while it is still the cached one. `use()` throws the rejection
  during render, so the component never commits and the unmount effect that
  would evict the entry never runs — without the catch, every later attempt,
  error-boundary retries included, rethrows the same settled rejection
  instead of reaching the agent again. A newer in-flight promise under the
  same key is left alone.
- Upstreamable: yes; upstream caches the rejection today and only evicts on
  unmount.

## 2026-07-26 — Browser Git scans leave the index read-only

- File: `vendor/agents/packages/shell/src/git/index.ts` (the three
  `statusMatrix` calls used by `status`, `diff`, and `add(".")` discovery).
- Why a shim cannot cover it: `createGit` closes over its adapted filesystem
  and calls `statusMatrix` privately. Its exported methods expose neither the
  walker nor the `refresh` option, so a host shim would have to duplicate the
  Git module or replace `isomorphic-git` globally.
- Change: pass `refresh: false` for these read-only scans. Browser
  `FileSystemHandle` stats provide size, modification time, and type while the
  Shell adapter must synthesize the remaining native stat fields. When the
  cached stat differs but content still matches, `statusMatrix` otherwise
  serializes and writes the whole `.git/index` once per matching tracked file.
  The scans still hash drifted files and report real content changes; explicit
  `git.add` and `git.remove` calls still update the index.
- Upstreamable: yes — preferably as a `createGit` option so browser-backed
  consumers can select read-only scans without changing the upstream default
  for native filesystems.

## 2026-07-26 — Read-time truncation sized for one-message turns

- File: `vendor/agents/packages/think/src/think.ts` (`CONTEXT_TRUNCATION` next
  to `MODEL_RECENT_WINDOW`, passed to `truncateOlderMessages` in
  `_assembleModelMessages`).
- Why a shim cannot cover it: `_assembleModelMessages` is private and takes no
  options, and upstream calls `truncateOlderMessages(history)` with no seam to
  intercept. The obvious upstream shape — a public `contextTruncation` field —
  cannot be set from this host: `@cloudflare/think` types resolve to the
  published dist while behavior resolves to this vendored source, so a new
  public field is invisible to `tsc` and `override` fails to compile.
- Change: `keepRecent` 4 → 2. Upstream's default suits many small messages. A
  whole codemode turn persists here as ONE assistant message, so four
  full-fidelity messages are the last two entire tool loops — enough on their
  own to exceed the 200k budget, and the newest of them is exactly what
  compaction may not touch. Two replays the preceding turn whole and caps every
  turn before it at 500-char tool outputs. Read-time only: stored history keeps
  the full text, and the `search_history` action reads it back. Both memory
  bounds anchored to `MODEL_RECENT_WINDOW` (hydration floor, media-eviction
  clamp) stay correct because the replayed span only shrinks; the comment on
  that constant now states the invariant instead of asserting the two values
  are the same.
- Upstreamable: yes, as the `contextTruncation` option this pin stands in for —
  the fixed default is wrong for any agent whose turns are one message each.

## 2026-07-26 — A connector failure names itself

- File: `vendor/agents/packages/codemode/src/proxy-tool.ts`, plus a fixture and
  a case in `src/runtime-tests/{worker,runtime.test}.ts`.
- Why a shim cannot cover it: this is the single choke point where every
  connector failure becomes both the host log line and the message the model
  reads. Nothing wraps it.
- Change: upstream reports `err.message`, which is empty for the DOMExceptions
  that carry aborts, timeouts, and structured-clone failures — their meaning
  lives in `name`. A `ctx.ai.generate` abort therefore reached the model as an
  empty error, and the host log as the bare object, which single-string log
  surfaces (the extension error page) render "[object DOMException]". One
  `failureMessage()` helper reads `name`/`message` by shape and never returns
  "" or "[object …]"; the host log interpolates it rather than passing only the
  object. Applied at the four sites in this file that produce a model-facing or
  operator-facing string. `boom_dom` in the runtime-test worker throws a
  message-less DOMException and the run must still report `AbortError`.
- Upstreamable: yes — same motivation as the 2026-07-25 submission-failure log
  entry below, and an empty model-facing error is wrong on any runtime.

## 2026-07-25 — Stop works while observing a broadcast turn

- File: `vendor/agents/packages/agents/src/chat/react.tsx`
  (`CF_AGENT_USE_CHAT_RESPONSE` handler, non-local branch).
- Why a shim cannot cover it: the fix is one call inside `useAgentChat`'s
  private socket message handler, between the broadcast state transition and
  the transport it must register with — no host seam sees either.
- Change: a client that joins a turn through broadcast chunks (server-initiated
  turns: a `follow_up` wake, a routine, another surface's submit, reopening the
  panel mid-turn) renders a stop button from `isStreaming`, but `stop()` was a
  no-op in that state: AI SDK status is `"ready"` so `Chat.stop()`
  early-returns, and the transport had no `_activeServerTurnId` so
  `cancelActiveServerTurn()` sent no frame. Register the observed request id
  with `customTransport.observeServerTurn(data.id)` whenever the broadcast
  transition reports streaming — exactly what the `CF_AGENT_STREAM_RESUMING`
  fallback path already does. The `done` frame clears it via the existing
  `handleServerTurnCompleted`.
- Coexistence with `agents@0.21.0`: upstream
  [#2023](https://github.com/cloudflare/agents/pull/2023) added an error branch
  in the same handler, but it breaks before reaching the broadcast transition
  this edit hangs off, and it clears the observed turn through the same
  `handleServerTurnCompleted`. A terminal error therefore releases the
  registration this edit makes rather than stranding it.
- Upstreamable: yes — any multi-surface host (cross-tab, server-driven turns)
  reproduces "stop does nothing until you switch threads and back".

## 2026-07-25 — A cancel in the settle window still reports "aborted"

- File: `vendor/agents/packages/think/src/think.ts` (chat stream loop).
- Why a shim cannot cover it: `streamAborted` is a local of the private
  streaming turn body; the abort flag's only observation point was a chunk
  boundary inside that loop.
- Change: a user cancel that lands after the final chunk (during
  persistence/settle) left `streamAborted` false, so the turn fired
  `onChatResponse` with `status: "completed"` — and a host that gates an
  autonomous continuation on that status would start the next turn the user
  just stopped. Re-check `abortSignal.aborted` once after the loop drains.
- Upstreamable: yes — the status contract ("how the turn ended") is simply
  wrong for late-arriving cancels.

## 2026-07-25 — Submission-failure log carries its error string in the message

- File: `vendor/agents/packages/think/src/think.ts`
  (`_emitSubmissionStatus`).
- Why a shim cannot cover it: the `console.error` call sits inside a private
  Think method with no seam around it.
- Change: `inspection.error` is a string, but upstream logs it inside the
  structured second console argument — which single-string log surfaces (the
  extension error page) coerce to "[object Object]", leaving the one
  user-visible line about a failed submission with no diagnostic. Fold the
  error string into the message (`Submission failed: <error>`); the structured
  object stays as the second argument for DevTools.
- Upstreamable: yes — same motivation as the host's own messenger logger
  flattening (`messengers/runtime.ts`), applied to upstream's log site.

## 2026-07-25 — Workspace read tool sends images the model can actually receive

_Partly dissolved at the 2026-08-19 refresh. think 0.16.0 took the `image-data`
branch itself in
[#2082](https://github.com/cloudflare/agents/pull/2082) — with the same
reasoning, now in upstream's own comment — so the fork's hunk in
`src/tests/assistant-tools.test.ts` merged to zero delta. What is still retained
is the `MODEL_IMAGE_MEDIA_TYPES` raster allowlist inside upstream's image block:
SVG, TIFF, or a mislabeled stat `mimeType` still reach OpenAI as an unreadable
`input_image` on upstream, and here they degrade to `error-text` at render time.
The capability gate stays in the 2026-08-03 entry above._

- File: `vendor/agents/packages/think/src/tools/workspace.ts`.
- Why a shim cannot cover it: the fix belongs inside `createReadTool()`'s
  `toModelOutput`, which closes over the tool's `ReadOperations` to re-read the
  file bytes on every request. A wrapper at the host seam would have to
  re-implement that whole replay path (byte re-read, size ceiling, eviction
  wording) just to swap one content-part type, and the workspace tools are
  wired inside the Think framework rather than through `getTools()`.
- Change: upstream returns every non-text read — images and PDFs alike — as a
  `file-data` part. `@ai-sdk/openai` maps `file-data` to `input_file` with
  `file_data:`, and OpenAI rejects image MIME types there, so one `read` of a
  PNG failed the request — and, because `toModelOutput` re-renders stored tool
  results on every later request, every request after it too ("Invalid file
  data … unsupported MIME type 'image/png'"). Images now return an
  `image-data` part (mapped to `input_image`), restricted to the raster types
  the model reads (PNG, JPEG, WebP, GIF); other image/\* types (SVG, TIFF, a
  mislabeled stat mimeType) degrade to `error-text` at render time instead of
  poisoning the transcript. PDFs keep the `file-data` form, which is correct
  for `input_file`. Contract coverage:
  `fixtures/read-tool-model-output.contract.test.ts` drives the real vendored
  tool through all three paths.
- Upstreamable: yes — it is a straight bug against the OpenAI Responses API in
  think 0.15.0; any host pairing the workspace tools with an OpenAI model hits
  it on the first image read.

## 2026-07-24 — Completed-reply hook on the messenger delivery policy

_Corrected 2026-07-27. The original entry justified this edit with a claim the
packages contradict: that widening `post()` "would require changes in
`@chat-adapter/*`". It does not. `MessengerDeliverySurface` is a local
structural interface declared in this same file, and every value passed as one
is a chat-sdk `Thread`, whose `post()` already takes `files` on each of its
postable shapes (`PostableMarkdown`, `PostableRaw`, `PostableAst`,
`PostableCard` in `chat@4.34.0`) and hands them to the adapter's own uploader —
`files.uploadV2` on Slack, multipart `postMessageWithFiles` on Discord. That
wrong sentence cost real behavior: it sent outbound files down a hand-written
Slack REST path that no other provider could use, so Discord replies delivered
no attachments at all. The hook itself was right; only the delivery inside it
was not._

- Files: `vendor/agents/packages/think/src/messengers/delivery.ts` and
  `vendor/agents/packages/think/src/messengers/index.ts` (public type
  re-exports).
- Why a shim cannot cover it: `chat-sdk.ts` reaches `deliverMessengerReply`
  through a relative `./delivery` import, so the vite-alias shims (which
  intercept package specifiers) cannot replace it, and the hook has to fire
  inside that function's private success sequencing — after the `splitText`
  posts, once the completed reply is actually on the provider. The policy
  object is the only host-supplied value that reaches the function.
- Why the hook is still needed now that `post()` carries files: the reply is
  delivered as a stream — `options.surface.post(callback.stream())` — and no
  adapter attaches files to a streamed message. Files can only be sent once the
  stream has closed and the text is known, and `deliverMessengerReply` owns that
  moment privately. **Do not delete this hook on the grounds that `post()` takes
  files; the two are not alternatives.**
- Change: add optional `onReplyComplete(text, event, surface)` to
  `MessengerDeliveryPolicy` and await it in `deliverMessengerReply()`'s success
  path, immediately after the `"completed"` checkpoint. It receives
  `callback.textSoFar()` (the full accumulated reply), `snapshotEvent` (the
  serializable event), and the live delivery surface. Passing the surface is
  what keeps a host out of provider REST APIs: it follows up through the adapter
  that just delivered the reply, with no token, endpoint, or thread-id decoding
  of its own. Also widens `MessengerDeliverySurface.post()` (and the RpcTarget
  wrapper that mirrors it) to accept `{ markdown, files? }`, which only restates
  what the underlying `Thread` already accepts — streams stay text-only. The
  RpcTarget wrapper carries the wider type. The pinned capnweb can serialize its
  binary forms, but files are still read on the side that owns the surface —
  which is why `onReplyComplete` receives the live one — instead of copying an
  attachment through Agent RPC before the provider adapter uploads it.
  Ordering is deliberate: the hook runs after the checkpoint because it performs
  host I/O that can take seconds, and a fiber left at `"streaming"` across a
  teardown recovers as an apology posted underneath an already-delivered reply.
  A throw is caught by the existing handler, which — because
  `callback.wasCompleted()` is true by then — reports through
  `isExpectedDeliveryCompletion` and still completes the turn, so a host that
  needs its failure to be user-visible must surface it itself.
- Not changed: `postEphemeral` is on chat-sdk's `Postable` and would be the same
  one-line widening, but nothing here calls it. This repo's own rule is that a
  think seam with no test covering it has nothing checking it at all
  (`docs/known-gaps.md`), so it stays off the surface until a caller exists.
- Types: invisible to `tsc`, which types `@cloudflare/think` from the published
  0.15.0 package rather than this source — see the type-resolution gap in
  `docs/known-gaps.md`. Declared alongside the other think augmentations in
  `packages/extension/src/offscreen/worker/host/think-vendor-augment.d.ts`. The
  widened `post()` is declared there as a merged overload typed against chat's
  own `FileUpload`, since method merging adds an overload rather than replacing
  the published text-only signature. Delete that block when upstream ships both.
- Upstreamable: yes — an optional policy member with no behavior change when
  unset, plus a surface widening that only admits what the runtime object
  already accepts. Useful to any host that needs to enrich a finished messenger
  reply, and strictly more useful with the surface passed than without it.

## 2026-07-24 — Preserve method identity through Agent context wrapping

- Files: `vendor/agents/packages/agents/src/index.ts` and
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: the Agents constructor rewrites inherited
  methods on the concrete Agent prototype before Think initializes skills, so
  the host cannot recover the pre-wrap method identity at either subclass
  seam.
- Change: retain each context wrapper's original method in a private WeakMap
  and compare that original when Think decides whether `getSystemPrompt()` was
  overridden. Inherited `Think.getSystemPrompt()` no longer triggers the
  fallback-only warning, while real overrides still do.
- Upstreamable: yes — Cloudflare
  [PR #1949](https://github.com/cloudflare/agents/pull/1949) introduced the
  identity check without accounting for the Agents SDK's existing automatic
  context wrapper.

## 2026-07-24 — Backfill: reasoning parts keep OpenAI replay fields

- File: `vendor/agents/packages/agents/src/chat/sanitize.ts`.
- Why a shim cannot cover it: `sanitizeMessage()` strips provider-ephemeral
  fields inside upstream's persistence path; no host hook runs between
  sanitation and storage.
- Change: reasoning parts retain `itemId`/`reasoningEncryptedContent`. Every
  host responses path runs `store: false`, where the encrypted content is what
  lets the next turn replay reasoning instead of the provider skipping it with
  a "Non-OpenAI reasoning parts" warning.
- Upstreamable: partially — any `store: false` consumer loses reasoning replay
  without it, but upstream would want it behind a flag rather than an
  unconditional keep.
- Ledger backfill: the edit landed with commit `745e43e2` and was marked
  in-source but never logged here; recorded now so the next vendor rebase
  preserves it.

## 2026-07-24 — Backfill: step usage stamped onto message metadata

- File: `vendor/agents/packages/think/src/think.ts` (now `turnMessageMetadata`
  and the `messageMetadata` forwarding in the inference-stream adapter).
- Why a shim cannot cover it: the UI message stream is assembled inside
  think's inference path; no host seam observes finish-step usage before the
  persisted message is built.
- Change: each completed step's usage is stamped onto `message.metadata.usage`
  (last step wins, so the persisted value is the final request's usage —
  current context occupancy rather than a turn-wide sum). The context ring
  reads this persisted value.
- Upstreamable: yes — it follows the AI SDK metadata convention think already
  forwards elsewhere.
- Ledger backfill: previously mentioned only inside the 2026-07-23 vendor
  refresh entry ("the usage-metadata divergence's `messageMetadata` forwarding
  was re-applied"); it now has its own row per this doc's contract.

## 2026-07-23 — Reuse the Agents JavaScript-stub probe classifier

- File: `vendor/agents/packages/agents/src/index.ts`.
- Why a shim cannot cover it: restart-safe browser facet proxies need the same
  JavaScript probe filtering as upstream Agent proxies, but the owning helper
  was not exported from the package entry point.
- Change: re-export the existing `isInternalJsStubProp()` helper so the browser
  adapter does not copy its probe list or dispatch serialization, coercion, and
  test-framework property reads as Agent RPC calls.
- Upstreamable: yes. Alternate runtime adapters need the same public classifier
  to remain aligned with the SDK's proxy behavior.

## 2026-07-23 — Keep messenger delivery inside one Agent RPC

- Files: `vendor/agents/packages/think/src/messengers/chat-sdk.ts`,
  `vendor/agents/packages/think/src/messengers/delivery.ts`, and
  `vendor/agents/packages/think/src/think.ts`; the fake messengers in
  `src/tests/messengers.test.ts` rename `chat` to
  `chatWithMessengerDelivery` to match.
- Why a shim cannot cover it: `ThinkMessengerRuntime` privately resolves the
  destination conversation and `deliverMessengerReply()` owns the
  bind/chat/restore sequence. A host wrapper cannot make that sequence atomic
  without replacing upstream messenger routing.
- Change: require every messenger Think target to expose the atomic delivery
  call, pass the surface as an `RpcTarget` capability, and bind, execute, and
  restore it within that one destination-Agent call. This preserves
  `deliverNotice()` during the turn without probing optional methods on a
  remote stub, serializing Chat SDK's `ChatThread`, or returning a restore
  callback across Cap'n Web.
- Upstreamable: yes. Native sub-agent delivery has the same RPC serialization
  and capability-lifetime boundary.

## 2026-07-23 — Vendor refresh to agents@0.19.0 / think@0.15.0

- Rebased `vendor/agents` from upstream commit `03cdc828` (think 0.13.0 /
  agents 0.17.4 / codemode 0.4.3 / voice 0.3.4) to `ffc2d958` (think 0.15.0 /
  agents 0.19.0 / codemode 0.5.0 / voice 0.3.5) by cherry-picking the retained
  edits onto the new tag. Conflicts in four files
  (`think/src/think.ts`, `voice/src/types.ts`, `codemode/src/runtime-handle.ts`,
  `codemode/src/runtime-tests/worker.ts`) were all additive-insertion overlaps
  except one: upstream moved the inference `streamResult` construction into a
  per-call closure, so the usage-metadata divergence's `messageMetadata`
  forwarding was re-applied at the new construction site.
- Dissolved upstream: voice 0.3.5 added a `waitUntilReady()` readiness await of
  its own, but only in `voice.ts`'s full `withVoice` mixin — `withVoiceInput`
  still has none upstream, so the 2026-07-22 voice entry's readiness await in
  `voice-input.ts` remains a retained edit (correcting this entry's original
  claim that the portion was no longer ours). The `waitUntilClosed()` flush
  await, the `onCallEnd` error argument, `endCall()`, and the mixin
  `onAudioLevel` hook remain retained.
- Merge adaptations inside `vendor/agents` (both marked with vendor-divergence
  comments): upstream's new framework-neutral
  `codemode/src/runtime-handle.ts#execute()` now resolves with the first
  streamed output when the fork's live-approval runtime returns an
  AsyncIterable, keeping upstream's promise contract; upstream's new
  `codemode/src/runtime-tests/codemode-eviction.test.ts` asserts the fork's
  attempt-stamped `passEnds` shape (test-only).
- Host-side changes riding the refresh: new `agents/observability/ai` alias in
  `vite-aliases.ts` (think 0.15.0 imports it for AI SDK dual-version
  telemetry); npm typecheck pins bumped to match the vendor tree; the
  extension tsconfig maps `ai` to the host's installed `ai@6` so vendored
  source typechecks against one AI SDK (upstream dev-installs `ai@7`). Test
  fixtures adapted to the alarm-owned drain: the routine-root Node fixture
  pumps the root's due alarm while waiting (sub-agent schedules are
  parent-owned), and the browser alarm harness auto-delivers due ungated
  projections, mirroring chrome.alarms. The `ai@6` stack and
  `workers-ai-provider@3.3.1` are intentionally unchanged — think 0.15.0
  supports `ai@^6 || ^7` and the host always supplies its own `LanguageModel`.
- Adopted think 0.15.0's `includeMcpTools` flag: `BrowserThinkConversation`
  sets it to `false`. MCP servers live on the root agent and reach the model
  exclusively through Codemode's `ctx.mcp` namespace; the flag makes that
  architecture explicit and guards against accidental direct tool merging.

## 2026-07-22 — Bound model-facing Codemode call logs

- Files: `vendor/agents/packages/think/src/tools/execute.ts` and
  `vendor/agents/packages/think/src/think.ts`.
- Why a shim cannot cover it: `createExecuteRuntime()` privately wraps both
  promise and streamed tool outputs, while `Think.approveExecution()` applies a
  resumed runtime result to the transcript through private methods. A host tool
  wrapper could cover the initial execution but not the approval path.
- Change: keep full connector arguments and results in Codemode's durable audit
  log, but project the model-facing `calls` array to call identity and state.
  Paused arguments retain their existing bounded preview. The exported execute
  tool output type describes that projection instead of claiming the removed
  fields remain present.
- Upstreamable: yes. Model-facing output should not repeat unbounded connector
  payloads that are already retained by the runtime facet.

## 2026-07-22 — Voice-input observes transcriber lifecycle and accepted PCM levels

- Files: `vendor/agents/packages/voice/src/types.ts`,
  `vendor/agents/packages/voice/src/audio-pipeline.ts`, and
  `vendor/agents/packages/voice/src/voice-input.ts`.
- Why a shim cannot cover it: `withVoiceInput()` privately owns binary PCM,
  `start_call`, and `end_call`. A browser-host transcriber can expose readiness
  and graceful-close promises, but no subclass or runtime shim can make those
  private lifecycle points await them or observe only PCM accepted by a live
  call.
- Change: await optional `waitUntilReady()` before publishing `listening`, and
  optional `waitUntilClosed()` before publishing `idle`. `onCallEnd` receives
  any close failure so the host can retain an authoritative error instead of
  losing it during cleanup. Existing synchronous transcribers retain immediate
  behavior.
  The mixin also computes normalized RMS from accepted PCM16 frames and exposes
  it through a no-op `onAudioLevel` hook; the browser host uses that hook for a
  transient sidepanel waveform event rather than synchronized state. The Agent
  integration proves startup, finalization, the flushed final utterance, and
  the meter projection. The Codex endpoint contract proves the completed-audio
  multipart request, OAuth and account headers, browser credentials, WAV
  framing, final-only delivery, missing-session failure, rejected-upload
  behavior, and authoritative finalization errors. The host aliases only the
  exact
  `@cloudflare/voice` package main to this pinned source, leaving the matching
  installed React and client subpaths intact.
- Upstreamable: yes. This makes `withVoiceInput()` honor the existing public
  `TranscriberSession` readiness contract and matches the sibling voice
  mixin's established behavior.

## 2026-07-20 — Idempotent chat-sdk cleanup reconciliation on startup

- File: `vendor/agents/packages/agents/src/chat-sdk/agent.ts`.
- Why a shim cannot cover it: `ChatSdkStateAgent.onStart()` owns the private
  `scheduleNextCleanup()` → `ensureCleanupScheduled()` chain. The former
  browser subclass could intercept every public `schedule()` call only by
  maintaining a second lifecycle flag and callback classifier outside that
  owner.
- Change: pass `{ idempotent: true }` through the private cleanup helpers only
  from `onStart()`. A cleanup callback still calls the helpers without options,
  so its successor remains a fresh delayed schedule after the executing row is
  removed. The browser host now routes the shipped `ThinkMessengerStateAgent`
  directly, with no subclass or constructor-name rewrite.
- Upstreamable: yes. Agents documents delayed-schedule idempotency specifically
  for `onStart()` reconciliation, and chat-sdk already stores one
  earliest-cleanup authority.

## 2026-07-19 — Include the emitted disconnected MCP state in its public type

- File: `vendor/agents/packages/agents/src/index.ts` (add `"not-connected"` to
  `MCPServer.state`). Type-only; zero runtime behavior change.
- Why a shim cannot cover it: `Agent.getMcpServers()` in the same module emits
  `"not-connected"` whenever a stored server has no live connection, but its
  exported `MCPServer` contract omits that value. Consumers otherwise have to
  widen the state to `string`, losing exhaustiveness for every other state.
- Upstreamable: yes — the public type now describes the implementation's
  existing output.

## 2026-07-19 — Export the fetch tool's private-host predicate

_Retired at the 2026-08-19 refresh. The consumer this export existed for was
removed with the Codemode cut, as the entry below already notes, so the edit was
dropped rather than rebased: `think/src/tools/fetch.ts` is upstream-identical
again and the `isBlockedHost` declaration is gone from
`think-vendor-augment.d.ts`. Kept here as provenance and as the standing
upstream request; restore the one-word export if a host network surface needs
the predicate again._

- File: `vendor/agents/packages/think/src/tools/fetch.ts` (one `export`
  keyword on `isBlockedHost`). Visibility-only; zero behavior change.
- Why a shim cannot cover it: the host's `ctx.net` codemode connector (the
  authenticated-mutations path upstream's read-only `createFetchTools`
  deliberately does not provide) must apply the same private/local-address
  rules to script-supplied URLs. The predicate is module-private, so without
  the export the host carries a verbatim copy that silently drifts on vendor
  refreshes. Both the consumer and its unit suite were removed with the
  Codemode cut; the export request stands on its own merits.
- Upstreamable: yes — a plain export of an existing pure predicate; any
  embedder adding its own network surface next to `createFetchTools` has the
  same SSRF-hygiene need.

## 2026-07-18 — Restore deleted Codemode unit-test files (glob-excluded)

- Files: the 17 files under `vendor/agents/packages/codemode/src/tests/`
  deleted by the 2026-07-13 integration-only test portfolio (`codec`,
  `connectors`, `executor`, `json-schema-types`, `mcp`, `normalize`,
  `resolve`, `runtime-handle`, `schema-conversion`, `shared`, `tanstack-ai`,
  `tool-types`, `tool`, `toolset-connector`, `truncate`, `utils` `.test.ts`
  plus `__snapshots__/mcp.test.ts.snap`), restored byte-identical from pinned
  commit `03cdc828c0bc3c6bb1d9aa636bb46ceb00a4e0ea`.
- Why: the vendored-copy rule — dead code is acceptable in an upstream copy;
  keeping the diff-vs-upstream small makes vendor refreshes cheap. The file
  deletions had to be re-applied on every refresh (the 2026-07-15 refresh
  re-deleted the changed `runtime-handle` suite by hand). The
  integration-only verification policy is unchanged and now lives entirely
  in the three vitest config globs (`*.integration.test.ts`,
  `src/runtime-tests/**`, `*.browser.test.ts`), which the restored files do
  not match — verified against Codemode's own suites (same suites, same
  counts) and root `vp check` (green) with the files present.
- Upstreamable: n/a — this removes local divergence rather than adding it.
  `src/runtime-tests/` was audited in the same pass and is already in sync
  with the pinned commit.

## 2026-07-18 — Export the declared-task schedule parser

- File: `vendor/agents/packages/think/src/think.ts` (three `export` keywords:
  `tryParseDeclaredTaskSchedule`, `ParsedDeclaredSchedule`,
  `ParseDeclaredScheduleResult`). Visibility-only; zero behavior change.
- Why a shim cannot cover it: routine schedules are stored and edited as raw
  Think schedule-DSL strings authored by the agent action and the sidepanel
  editor, and Think only parses them later inside reconcile. The grammar lives
  only in these internal functions, so without the export the host could not
  fail closed at the catalog write boundary or project `ParsedDeclaredSchedule`
  for editor prefill, and grammar drift on a vendor refresh would surface only
  as runtime reconcile failures. Consumers: the routine catalog
  (`conversation/routines.ts`) and contract tests
  (`scheduled-routines.contract.test.ts`,
  `scheduled-routines-state.contract.test.ts`) asserting every host-buildable DSL
  shape parses and every grammar-rejected string is refused before persisting.
- Upstreamable: yes — a plain export of an existing pure function; any
  embedder that declares schedules from app-owned data has the same
  validation need.

## 2026-07-17 — Codemode pass cancellation and durable result fencing

- Files:
  `vendor/agents/packages/codemode/src/{proxy-tool,runtime,runtime-attempts}.ts`,
  `vendor/agents/packages/codemode/src/connectors/{base,index,mcp,types}.ts`,
  the matching connector documentation, and focused Workers-runtime tests.
- Why a shim cannot cover it: Codemode's private connector binding creates the
  `ToolExecuteContext` and writes connector results through its private runtime
  facet. An executor or browser-host wrapper can cancel the sandbox, but it
  cannot give the exact pass signal to a connector or atomically prevent a
  callback that outlives its pass from changing the durable replay log.
- Change: give every sandbox pass one local `AbortSignal`, forward explicit
  request cancellation, replay pauses, and error teardown to it, and pass it to connector
  tools. `McpConnector` supplies that signal as the MCP SDK `callTool` request
  option. A SQL-backed attempt generation travels through every durable
  decision/result pair and guards result, completion, failure, and in-run error
  writes. Resuming a paused execution advances the generation before the new
  sandbox pass starts, rejecting every late mutation from the superseded pass.
  Completed/error status guards fence terminal writes immediately. While an
  execution remains paused, callbacks from that same attempt may still record;
  they become stale when resume advances the generation. Pass lifecycle
  callbacks carry the attempt identity (`PassEndContext` on `onPassEnd`);
  `proxy-tool` produces it and the retained runtime tests assert the attempt
  values as coverage of the fence. No in-tree connector consumes it today —
  the 2026-07-18 cleanup reverted the browser-connector pass-ownership
  hardening because `BrowserConnector` has no construction path in this
  product; the plumbing dissolves at the #1769 vendor refresh. Existing
  executions are backfilled at attempt zero, and deletion/pruning removes the
  attempt row.
- Provenance: the signal context, attempt-store shape, decision identity, and
  conditional result update are adapted from Cloudflare Agents draft
  [PR #1769](https://github.com/cloudflare/agents/pull/1769), commit
  `f82430ecceae8219447df1bbf6cf85bb019ad23c`. This port deliberately excludes
  that PR's retry, backoff, timeout, and model-facing policy. This host aborts
  cancelled, errored, and replay-paused passes, but preserves its established
  contract allowing fire-and-forget provider work to outlive a successful
  sandbox while retaining the worker activity lease. Successful work is fenced
  by terminal status without being killed. Non-cooperative paused work may
  still finish until resume advances the attempt and rejects its result.
  Neither outcome is represented as rolled back. The `paused`-accepting pass
  predicates and the no-abort-on-success fire-and-forget policy predate this
  port and belong to the live-approval fork (see the 2026-07-13 optional live
  per-call approval entry); this port only threads the attempt fence through
  those existing paths.
- Upstreamable: yes for the cooperative signal and durable attempt fence; the
  precise successful fire-and-forget lifetime is a browser-host compatibility
  policy that should remain explicit when reconciling with the draft.

## 2026-07-15 — Vendor baseline refresh

- Baseline: `@cloudflare/think@0.13.0` and `agents@0.17.4`, both released from
  Cloudflare Agents commit `03cdc828c0bc3c6bb1d9aa636bb46ceb00a4e0ea`.
- Matching packages: `@cloudflare/codemode@0.4.3` and
  `@cloudflare/voice@0.3.4`.
- Refresh method: reconstruct the browser-host adaptation commit against the
  former `2e50e6610514aa00e3979a86bcdd278616209cab` baseline, cherry-pick it onto
  `03cdc828c0bc3c6bb1d9aa636bb46ceb00a4e0ea`, and resolve only the new upstream
  Codemode tool-call-log test alongside the retained live-approval tests. The
  integration-only test policy still deletes the changed mock-heavy
  `runtime-handle` suite.
- Audit result: the four logged production changes remain necessary on the new
  baseline; no new production fork was introduced by the refresh.

## 2026-07-15 — Completed messenger replies ignore later bookkeeping failure

- File: `vendor/agents/packages/think/src/messengers/delivery.ts`.
- Why a shim cannot cover it: `deliverMessengerReply()` constructs its private
  `TextStreamCallback` internally, and the public delivery policy receives no
  signal distinguishing a partial stream from one whose `onDone()` already
  fired. A host policy could suppress all post-text failures only by also
  hiding genuine interrupted partial replies.
- Change: retain one boolean when the existing callback receives `onDone()`.
  If `chat()` later rejects during terminal bookkeeping, treat delivery as
  complete instead of appending the interruption apology. Errors before normal
  completion keep the existing error/apology behavior, and the host policy
  still logs the underlying exception.
- Upstreamable: yes. `onDone()` is the existing terminal success signal, so a
  later exception cannot truthfully mean the model reply was interrupted.

## 2026-07-13 — Codemode integration-only test portfolio

- Files: deleted the unit and mock-driven suites under
  `vendor/agents/packages/codemode/src/tests`; retained explicitly named real
  Worker Loader executor and MCP integration suites plus the real-browser
  iframe suite.
- Why a shim cannot cover it: this is test-policy cleanup, not a runtime
  compatibility gap. No production source or package behavior changed.
- Change: the vendored Codemode gate now exercises 51 Worker Loader integrations,
  46 Workers-runtime, and 35 browser cases without pure-unit, private-field,
  fake-executor, or internal-mock suites. Its discovery glob accepts only
  `*.integration.test.ts`, and the repository's normal `vp run test` gate invokes
  the pinned nested workspace explicitly.
- Upstreamable: no. This is the browser host's deliberately integration-first
  verification policy for its pinned source copy, not a proposed upstream
  Codemode default.

## 2026-07-13 — Codemode executor cancellation

- Files:
  `vendor/agents/packages/codemode/src/{abort-result,executor-types,executor,iframe-executor,proxy-tool,run-code}.ts`
  and focused tests.
- Why a shim cannot cover it: Codemode's private `runPass()` and `runCode()`
  discarded the AI SDK tool call's abort signal before invoking the public
  executor. A browser-host wrapper sees only the already-started executor call
  and cannot recover which request signal owns it or propagate that signal
  into nested `codemode.run()` executions.
- Change: add optional `abortSignal` to `ExecuteOptions`, carry it through live
  and ordinary proxy-tool calls plus nested snippets, and make both upstream
  iframe and dynamic-worker executors dispose their exact sandbox when it
  aborts. A shared internal result owner keeps abort formatting identical;
  Dynamic Worker cleanup is once-guarded across abort and finalization, and
  settled iframes ignore provider replies that arrive after teardown. Omitting
  the signal preserves existing behavior and timeouts.
- Browser-host composition: `HostRpcTarget` binds cancellation to its immutable
  Agent address and exact sandbox execution id. The offscreen iframe owner
  settles once; the worker's existing finish path closes execution-scoped
  Playwright transports but leaves persistent tab claims intact.
- Upstreamable: yes. This extends the existing executor options with standard
  cancellation, is optional for callers, and gives executor implementations
  ownership of resource teardown instead of racing and abandoning their
  result.

## 2026-07-13 — Optional live per-call Codemode approval

- Files:
  `vendor/agents/packages/codemode/src/{index,proxy-tool,runtime-handle,runtime}.ts`,
  `vendor/agents/packages/think/src/tools/execute.ts`, their focused runtime and
  execute tests.
- Why a shim cannot cover it: the approval decision and pause sentinel live
  inside Codemode's private connector binding, while Think's private execute
  wrapper owns whether AI SDK preliminary outputs survive result shaping. A
  browser-host wrapper can observe only the already-aborted final pause; it
  cannot keep the original sandbox connector Promise alive or stream nested
  progress through the same tool invocation.
- Change: add one optional `approval(action, { abortSignal })` callback. A
  synchronous approval executes without emitting a pause. A promised decision
  keeps the current sandbox pass open, emits Codemode's existing paused action
  followed by running as preliminary outputs, and then executes or rejects the
  original call. Live-mode decision/approval handoffs serialize so concurrent
  authored calls present one decision at a time without serializing the
  connector work after approval. The durable runtime returns the canonical
  `PendingAction` with its approval decision and atomically transitions that
  exact action from pending to executing, so approval and rejection cannot both
  win. A rejected live decision carries one required reason that is reused for
  both the model result and durable audit. A platform `ReadableStream` owns
  preliminary-output buffering, completion, errors, and consumer cancellation;
  no private async queue or wake loop is retained. Think preserves the async
  iterable through `execute`; the default path is unchanged when the callback
  is absent.
- Provenance: this surgical extension originated against Agents commit
  `2e50e6610514aa00e3979a86bcdd278616209cab` and was reapplied to pinned commit
  `03cdc828c0bc3c6bb1d9aa636bb46ceb00a4e0ea` with installed Codemode `0.4.3`.
  Cloudflare's pinned source still provides only the abort-and-replay path; no
  external live-approval implementation was copied.
- Browser-host composition: the host uses this callback only for
  `ctx.human.waitFor`; all ordinary connectors execute immediately. Codemode
  owns the durable action/history and a worker-local coordinator owns the live
  human-wait resolver. The client-callable approve/reject surface and
  conversation permission mode are absent. The root's exact human-wait
  dispatcher resolves the Promise off-tail. A stale durable pause after forced
  restart is rejected as interrupted instead of replayed. The existing tool
  part carries preliminary output, so there is no parallel pending-request
  protocol. The repository-owned Vite and TypeScript aliases resolve the
  pinned edited Codemode main entry; Codemode subpaths remain on the installed
  matching version.
- Upstreamable: yes. The callback is optional, preserves the existing public
  behavior by default, uses canonical `PendingAction`, and gives hosts an
  explicit choice between durable replay and request-local suspension.
- Attribution note (2026-07-18): the `paused`-accepting pass predicates and
  the policy of not aborting fire-and-forget provider work on a successful
  sandbox originate here — a pass that pauses for a live human wait must keep
  per-execution resources alive — not in the later #1769 attempt-fence port
  that threads through the same code paths.

## 2026-07-13 — Codemode paused-again approvals remain parked

- File: `vendor/agents/packages/think/src/think.ts`
- Why a shim cannot cover it: after `approveExecution()` replays a Codemode
  execution, Think's private `_applyExecutionOutcome()` both replaces the
  transcript output and schedules the next model continuation. The public
  `beforeTurn.stopWhen` seam can stop the initial tool loop after a pause, but
  it cannot prevent this continuation from being scheduled when replay pauses
  again on the next approval-gated connector call.
- Change: recognize only Codemode's canonical paused output, update the paused
  transcript output when it still exists, and schedule no model continuation
  until approve/reject produces a settled outcome. If compaction already
  removed the tool call, keep provisional pause state out of a fallback system
  note; the Codemode runtime remains the durable approval source.
- Upstreamable: yes. Codemode's replay contract says a paused execution is
  still awaiting human input; the model should next see only a completed,
  rejected, or errored outcome.

Repository-owned vendor metadata edit:

- `vendor/agents/VENDOR.md` (2026-07-12): refreshed the shim location after the
  host package was colocated under the extension worker. A shim cannot correct
  a stale repository instruction; this file is not part of the pinned upstream
  tree and the change is not upstreamable.

Verified 2026-07-05 against pinned commit
`2e50e6610514aa00e3979a86bcdd278616209cab`:

```bash
diff -q vendor/agents/packages/think/src/think.ts <(curl -fsSL https://raw.githubusercontent.com/cloudflare/agents/2e50e6610514aa00e3979a86bcdd278616209cab/packages/think/src/think.ts)
diff -q vendor/agents/packages/think/src/tests/execute-hitl.test.ts <(curl -fsSL https://raw.githubusercontent.com/cloudflare/agents/2e50e6610514aa00e3979a86bcdd278616209cab/packages/think/src/tests/execute-hitl.test.ts)
```

## Historical cleanup

- 2026-08-26: deleted the 2026-08-19 detached-milestone warm-path entry and
  its two vendor tests/fixture helpers. Rook no longer exposes detached
  delegation, so no live product path justified carrying a private upstream
  fork for its milestone notifications. The pinned SDK's stock detached-run
  machinery remains untouched and can be inherited again if upstream adds the
  mailbox semantics Rook needs.
- 2026-08-21: deleted the 2026-08-19 replay-at-most-once entry. Both of its
  premises died in the do-runtime cutover, so `_replayAgentToolRuns` is
  upstream's again, without the `WeakSet` guard, and its fork case in
  `src/tests/agent-tool-replay.test.ts` and `captureRepeatedReplayStartsForTest`
  in `src/tests/agents/agent-tool-replay.ts` are gone with it. The host no
  longer serializes agent events on one tail — the runtime's input gates own
  per-actor ordering — so a connect arriving mid-turn is not queued behind the
  turn, and nothing outside the vendored tree calls `_replayAgentToolRuns`, so
  no early replay can precede the connect wrapper's. The mid-turn case in
  `host/fixtures/browser/agent-tool-delegation.integration.test.ts` still
  asserts exactly one replayed `started` per connection, which is now upstream
  behavior rather than the guard's.
- 2026-08-21: deleted the 2026-07-25 `RootFacetRpcSurface` entry. The type is
  `type` again in `vendor/agents/packages/agents/src/index.ts`, with its
  exported-for-adapters paragraph. Its only consumer was
  `think-host.worker.ts`'s MCP root-RPC dispatch table, which proved itself
  complete with `satisfies Record<keyof RootFacetRpcSurface, …>`; the
  do-runtime cutover deleted the table along with the single-tail event
  serialization that made per-method dispatch modes necessary, and the runtime
  re-enters a root while it awaits its own facet the way workerd does.
- 2026-08-19: dropped two retained edits at the `agents@0.21.0` refresh rather
  than rebasing them. The Agent Tool `prepareRun()` dispatch seam
  (`vendor/agents/packages/agents/src/agent-tools.ts`) lost its last host
  consumer when the subagent rework made `delegate` a plain `tool()` over
  `runAgentTool`; `projectAgentToolResult()` in the same entry is retained. The
  `isBlockedHost` export (`vendor/agents/packages/think/src/tools/fetch.ts`)
  lost its consumer in the Codemode cut, and that file is upstream-identical
  again. Also deleted `agents/src/tests/skill-runner.test.ts`, which the
  2026-08-16 skills-barrel entry should have removed and did not.
- 2026-07-18: reverted the browser-connector pass-ownership fork
  (`vendor/agents/packages/agents/src/browser/connector.ts` +234/−57 and its
  164-line test additions) to pristine pinned upstream. `BrowserConnector`
  has no construction path in this product — the extension never passes a
  `browser` option to `createExecuteRuntime` and imports nothing from
  `agents/browser`. The codemode `PassEndContext`/`attempt` pass-lifecycle
  plumbing is retained (see the 2026-07-17 entry) and dissolves at the #1769
  vendor refresh.
- 2026-07-05: removed the local paused-again approval fork from
  `vendor/agents/packages/think/src/think.ts` and its timing-based negative test
  assertion during a zero-feature-change cleanup. Phase 60 deliberately
  restored the behavior as a selected product correction with a real-browser
  model-boundary regression.

## 2026-08-21 — PartyServer accepts host-owned browser sockets (superseded)

- **Package patch:** `patches/partyserver@0.5.10.patch`
- **Change:** Add `Server.__unsafe_acceptConnection()` using PartyServer's
  existing private connection manager and event handlers. An optional host gate
  re-enters `onMessage`, `onClose`, and `onError` callbacks. Normalize the
  browser's `WebSocket.OPEN`/`CONNECTING`/`CLOSING`/`CLOSED` constants to the
  `READY_STATE_*` names PartyServer's connection manager reads.
- **Browser gap:** Extension `MessagePort` sockets arrive after the HTTP-upgrade boundary, while stock PartyServer exposes connection registration only inside `fetch()`. Re-entering through `fetch()` requires browser-missing `WebSocketPair`/101 responses and crosses an ungated async initialization hop.
- **Why a host shim cannot cover it:** both connection registration and event
  attachment are private PartyServer methods. Reimplementing them was the local
  PartyServer fork this cutover deletes.
- **Constraint:** The server must already be initialized and connection tags
  must be synchronous (all Rook overrides are); the method registers and
  attaches synchronously before returning `onConnect()`.
- **Upstream path:** Propose the narrow framework transport seam upstream; drop the patch when PartyServer ships an equivalent.
