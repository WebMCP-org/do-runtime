# Rook: consuming the 0.23 fork

Status: written against fork branch `alex/agents-0.23-refresh` @ `3f8f444b`; the Think (portion B) notes were available.

This is a work plan for the Rook side of the `agents@0.22.0` → `agents@0.23.0`
refresh. The evidence behind it is the consumption inventory taken on
2026-09-12; this document does not repeat it. Every Rook claim cites
`file:line` in `/Users/alexmnahas/personalRepos/WebMCP-org/think-browser-host`.
Every SDK claim cites a path under `vendor/agents/` in the `do-runtime` repo,
plus the upstream PR where the origin helps.

---

## 1. Status and prerequisites

### What this covers

Five commits on `alex/agents-0.23-refresh`, all of them inside `vendor/agents/`
(`git -C <do-runtime> diff --name-only origin/main..alex/agents-0.23-refresh`
lists nothing outside that directory), oldest first:

```
c947880a  Refresh vendored Agents SDK to 0.23.0: import and agents package
fda2bdf3  Restore compaction floors and expose the facet WebSockets capability
04c1cb95  Refresh vendored Agents SDK to 0.23.0: ai-chat, voice, shell, codemode
40683276  Refresh vendored Agents SDK to 0.23.0: think package
3f8f444b  Read a lifted row with an unparsable creation time as undated
```

Package versions after the refresh (`vendor/agents/VENDOR.md`):

| package                | 0.22 pin | 0.23 pin                          |
| ---------------------- | -------- | --------------------------------- |
| `agents`               | 0.22.0   | 0.23.0                            |
| `@cloudflare/think`    | 0.17.0   | 0.18.0                            |
| `@cloudflare/ai-chat`  | 0.11.0   | 0.12.0                            |
| `@cloudflare/voice`    | 0.4.0    | 0.5.0 (deprecated re-export shim) |
| `@cloudflare/shell`    | 0.4.3    | 0.4.3 (unchanged upstream)        |
| `@cloudflare/codemode` | 0.5.1    | 0.5.2                             |

`@cloudflare/think@0.18.0` declares `peerDependencies.agents: ">=0.23.0 <1.0.0"`
(`vendor/agents/packages/think/package.json`). The two packages move together;
there is no partial upgrade.

### Before Rook consumes it

1. **The fork gate is green on the merged commit.** From `vendor/agents`:
   `pnpm build && pnpm check && pnpm test` (`vendor/agents/VENDOR.md`). From the
   repo root the same lanes are `pnpm sdk:build`, `pnpm sdk:check`,
   `pnpm sdk:test`.
2. **A `rook-sdk-<sha>` pre-release is cut from the merged commit.**
   `pnpm sdk:pack` builds and packs the six packages into `dist/sdk/` under
   their upstream names; attach those tarballs to a GitHub release tagged
   `rook-sdk-<source-commit>` at the tested commit (`do-runtime/README.md:509-515`).
   Publish a new tag rather than replacing an existing release's assets.
3. **A rollback lever exists.** That means the previous `rook-sdk-<sha>`
   tarballs _and_ exported OPFS database files for any profile that will wake on
   the new build. See §4; code rollback alone does not work.

### The storage migrations are one-way

0.23 runs its storage lifts on the first wake of each actor, then **drops the
source tables**. There are no tombstones. Once a profile's conversation actor
has started on 0.23, downgrading the extension to a 0.22 build leaves that
actor's Agent unable to find `assistant_messages`, `cf_agents_schedules`,
`cf_ai_chat_stream_*` or `assistant_config`, because they no longer exist.
The drop sites are `sessions/core.ts:241` (the `drop()` helper, reached from
`:288, 305, 314, 315`), `schedules/scheduler.ts:289`,
`chat/resumable-stream.ts:467-468` and `think/src/think.ts:4470`. Upstream's own
note: the sources are "DROPPED: keeping tombstones would leave every upgraded
object holding its history twice inside the same 10 GB"
(`sessions/core.ts:230-231`).

---

## 2. Required changes (compile breaks)

### 2.1 The ten `agents/experimental/memory/*` import sites

Upstream PR [#2196](https://github.com/cloudflare/agents/pull/2196) moved
Sessions into a Lifecycle capability and deleted the experimental memory stack.
`agents/experimental/memory/session` and `agents/experimental/memory/utils` are
absent from the fork's `exports` map (`vendor/agents/packages/agents/package.json`);
`packages/agents/src/experimental/` now holds only `webmcp.ts`.

Ten `import` statements across six Rook files, listed here one row per symbol
(two of the statements carry two symbols each):

| Rook `file:line`                                                                          | symbol                                       | new home                                    | verified at                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| `packages/extension/src/offscreen/worker/agents/conversation-agent.ts:19`                 | `AgentContextProvider`                       | `agents/context`                            | `src/context/index.ts:21`            |
| `packages/extension/src/offscreen/worker/agents/conversation-agent.ts:19`                 | `type Session`                               | `@cloudflare/think`                         | `packages/think/src/think.ts:379`    |
| `packages/extension/src/offscreen/worker/agents/worker-agent.ts:32`                       | `type Session`                               | `@cloudflare/think`                         | `packages/think/src/think.ts:379`    |
| `packages/extension/src/offscreen/worker/agents/worker-agent.ts:33`                       | `createCompactFunction`                      | `agents/sessions`                           | `src/sessions/index.ts:12`           |
| `packages/extension/src/offscreen/worker/conversation/compaction.ts:2`                    | `type CompactOptions`                        | `agents/sessions`                           | `src/sessions/index.ts:14`           |
| `packages/extension/src/offscreen/worker/conversation/workspace-context.ts:1`             | `type ContextConfig`                         | `agents/context`                            | `src/context/index.ts:16`            |
| `packages/extension/src/offscreen/worker/conversation/workspace-context.ts:2`             | `estimateStringTokens`                       | **no public export**                        | inline it, §2.2                      |
| `packages/extension/src/offscreen/worker/fixtures/compaction-boundary.contract.test.ts:3` | `COMPACTION_PREFIX`, `createCompactFunction` | `agents/sessions`                           | `src/sessions/index.ts:11-12`        |
| `packages/extension/src/offscreen/worker/fixtures/workspace-context.contract.test.ts:2`   | `type SessionMessage`                        | `agents/sessions` (but delete, §2.3)        | `src/sessions/index.ts:26`           |
| `packages/extension/src/offscreen/worker/fixtures/workspace-context.contract.test.ts:2`   | `type SessionProvider`                       | **removed, no replacement**                 | absent from `packages/agents/src/**` |
| `packages/extension/src/offscreen/worker/fixtures/workspace-context.contract.test.ts:3`   | `Session` (value)                            | `ContextBlocks` from `agents/context`, §2.3 | `src/context/index.ts:14`            |
| `packages/extension/src/offscreen/worker/fixtures/workspace-context.contract.test.ts:4`   | `estimateStringTokens`                       | re-export from `workspace-context.ts`, §2.2 |                                      |

`ThinkSession` is exported under both names, so the `Session` alias keeps the
existing annotations compiling:

```ts
// vendor/agents/packages/think/src/think.ts:379
export { ThinkSession, ThinkSession as Session } from "./session";
```

The exact edits:

```ts
// conversation-agent.ts:1 — fold the type into the existing @cloudflare/think import
import {
  action,
  type Action,
  type Session,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
// conversation-agent.ts:19 — before
import {
  AgentContextProvider,
  type Session
} from "agents/experimental/memory/session";
// conversation-agent.ts:19 — after
import { AgentContextProvider } from "agents/context";
```

```ts
// worker-agent.ts:1-8 — fold `type Session` into the existing @cloudflare/think import
import {
  Think,
  defaultContextOverflowClassifier,
  type ChatErrorContext,
  type Session,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
// worker-agent.ts:32-33 — before
import type { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
// worker-agent.ts:32-33 — after
import { createCompactFunction } from "agents/sessions";
```

```ts
// conversation/compaction.ts:2 — before
import type { CompactOptions } from "agents/experimental/memory/utils";
// after
import type { CompactOptions } from "agents/sessions";
```

```ts
// conversation/workspace-context.ts:1-2 — before
import type { ContextConfig } from "agents/experimental/memory/session";
import { estimateStringTokens } from "agents/experimental/memory/utils";
// after
import type { ContextConfig } from "agents/context";
```

```ts
// fixtures/compaction-boundary.contract.test.ts:3 — before
import {
  COMPACTION_PREFIX,
  createCompactFunction
} from "agents/experimental/memory/utils";
// after
import { COMPACTION_PREFIX, createCompactFunction } from "agents/sessions";
```

`AgentContextProvider`'s constructor is unchanged:
`constructor(agent: SqlProvider, label?: string)` (`src/context/sqlite-provider.ts:24`),
and `SqlProvider` is just the tagged-template `sql` surface
(`src/context/sqlite-provider.ts:11-16`), which `Agent` satisfies. The backing
table `cf_agents_context_blocks` is unchanged
(`src/context/sqlite-provider.ts:38-43`). `new AgentContextProvider(this, "memory")`
at `conversation-agent.ts:281` needs no edit beyond the import move.

`ContextConfig`'s field shape is compatible: `label` / `description?` /
`maxTokens?` / `provider?` (`src/context/blocks.ts:84-97`). Only the
`SkillProvider` arm of the `provider` union was dropped, which Rook does not use.

### 2.2 `estimateStringTokens` is inlined

It exists only at `vendor/agents/packages/agents/src/sessions/tokens.ts:28` and
is **not** re-exported by `sessions/index.ts` in the fork or in pristine
upstream. Its only public consumer is `src/context/blocks.ts:19`, which imports
it by relative path. The fork deliberately does not add a re-export; Rook
inlines it.

Add this to `packages/extension/src/offscreen/worker/conversation/workspace-context.ts`,
replacing the deleted import, and **export it** so the contract test uses the
same function:

```ts
// Byte-for-byte the SDK's own heuristic (vendor/agents/packages/agents/src/
// sessions/tokens.ts:13-34). ContextBlocks measures every block with it
// (blocks.ts:172, 251), so the `[N% — n/m tokens]` header it renders is only
// honest while this clamp counts the same way. A different estimator makes the
// header lie about the budget this file actually enforces.
const CHARS_PER_TOKEN = 4;
const WORDS_TOKEN_MULTIPLIER = 1.3;

export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  const charEstimate = text.length / CHARS_PER_TOKEN;
  const wordEstimate =
    text.split(/\s+/).filter(Boolean).length * WORDS_TOKEN_MULTIPLIER;
  return Math.ceil(Math.max(charEstimate, wordEstimate));
}
```

Why byte-identical matters: Rook's clamp (`workspace-context.ts:63-87`) keeps
the longest leading run that fits `maxTokens`, and the block declares the same
`maxTokens` to `ContextBlocks`. `ContextBlocks.loadBlock` computes
`tokens: estimateStringTokens(content)` (`src/context/blocks.ts:172`) and
renders `[${pct}% — ${block.tokens}/${block.maxTokens} tokens]`
(`src/context/blocks.ts:349-352`). If the two estimators disagree, a clamped
file can render above 100%, which is exactly the signal
`workspace-context.ts:36-42` says the nightly consolidation run prunes against.

Then in the fixture:

```ts
// fixtures/workspace-context.contract.test.ts:4 — before
import { estimateStringTokens } from "agents/experimental/memory/utils";
// after: import it alongside the other workspace-context symbols at :6-13
import {
  MEMORY_INDEX_CONTEXT_MAX_TOKENS,
  SOUL_CONTEXT_MAX_TOKENS,
  WORKING_STATE_CONTEXT_MAX_TOKENS,
  WORKING_STATE_WORKSPACE_PATH,
  estimateStringTokens,
  formatWorkingStatePrompt,
  workspaceFileContext
} from "../conversation/workspace-context";
```

### 2.3 The `SessionProvider` contract test rewrite

`packages/extension/src/offscreen/worker/fixtures/workspace-context.contract.test.ts`
(212 lines) is the only file that needs real rework. Three things it used are
gone:

- `SessionProvider` does not exist anywhere in 0.23. Sessions is
  DO-SQLite-only; the only remaining mention is a comment at
  `src/chat/orphan-persist.ts:34`.
- `Session.create()` does not exist. 0.23's `Session`
  (`src/sessions/handle.ts:33`) is `@internal Constructed by the Sessions
capability only` (`:41`), and its whole builder is `onCompaction` and
  `compactAfter` (`:55, :65`).
- `Session.withContext()` / `Session.freezeSystemPrompt()` are gone from the
  handle. Prompt context moved to `agents/context`.

**What it can assert against now.** The one `it` that used `Session` is
`"renders inside the real system prompt, where maxTokens alone would not have
capped anything"` (`:146-183`). It never needed storage: it renders blocks and
freezes a prompt. `ContextBlocks` does exactly that with no capability, no
lifecycle and no provider stub, because `promptStore` is optional
(`src/context/blocks.ts:132-140`) and `freezeSystemPrompt()` lazily calls
`load()` (`src/context/blocks.ts:371-382`).

```ts
// fixtures/workspace-context.contract.test.ts:2-4 — before
import type {
  SessionMessage,
  SessionProvider
} from "agents/experimental/memory/session";
import { Session } from "agents/experimental/memory/session";
import { estimateStringTokens } from "agents/experimental/memory/utils";
// after
import { ContextBlocks } from "agents/context";
```

Delete `createPromptOnlySessionStorage()` entirely (`:47-70`). It has no
replacement and needs none: `SessionMessage` was imported only to type that
stub (`:59, :61`), so that import goes too.

```ts
// :154-160 — before
const uncapped = await Session.create(createPromptOnlySessionStorage())
  .withContext("memory_index", {
    description: "Index of durable memory",
    maxTokens: MEMORY_INDEX_CONTEXT_MAX_TOKENS,
    provider: { get: () => workspace.readFile(MEMORY_INDEX_WORKSPACE_PATH) }
  })
  .freezeSystemPrompt();
// after
const uncapped = await new ContextBlocks([
  {
    label: "memory_index",
    description: "Index of durable memory",
    maxTokens: MEMORY_INDEX_CONTEXT_MAX_TOKENS,
    provider: { get: () => workspace.readFile(MEMORY_INDEX_WORKSPACE_PATH) }
  }
]).freezeSystemPrompt();
```

```ts
// :167-176 — before
const capped = await Session.create(createPromptOnlySessionStorage())
  .withContext("memory_index", {
    description: "Index of durable memory",
    ...workspaceFileContext({
      workspace,
      path: MEMORY_INDEX_WORKSPACE_PATH,
      maxTokens: MEMORY_INDEX_CONTEXT_MAX_TOKENS
    })
  })
  .freezeSystemPrompt();
// after
const capped = await new ContextBlocks([
  {
    label: "memory_index",
    description: "Index of durable memory",
    ...workspaceFileContext({
      workspace,
      path: MEMORY_INDEX_WORKSPACE_PATH,
      maxTokens: MEMORY_INDEX_CONTEXT_MAX_TOKENS
    })
  }
]).freezeSystemPrompt();
```

Every assertion in that case survives unchanged, including `renderedBlock()`'s
`"═".repeat(46)` split and the `[readonly]` marker: the renderer still emits
`sep\nLABEL (description) [N% — n/m tokens] [readonly]\nsep\ncontent`
(`src/context/blocks.ts:338-361`), and a `get`-only provider is still classified
readonly (`src/context/blocks.ts:354`). The other six cases in the file only
touch `workspaceFileContext` / `formatWorkingStatePrompt` and need no edit.

**What has no replacement.** A storage-backed `Session` you can construct in a
node contract test. `Sessions` reads `this.lifecycle.storage.sql`
(`src/sessions/sessions.ts:44-59`) and must be installed with `Lifecycle.use()`.
Anything Rook wants to assert at the Sessions level now belongs in the browser
integration lane, not in `vitest.contract.config.ts`.

### 2.4 `delegated-run-agent.ts`'s `broadcast` override

0.23 moved WebSockets out of Lifecycle into an opt-in capability
([#2169](https://github.com/cloudflare/agents/pull/2169)). `Lifecycle` no longer
has `broadcast` / `getConnection` / `getConnections`
(`src/lifecycle/durable-object-lifecycle.ts`). The fork restores the missing
capability as a protected accessor (`fda2bdf3`,
`.changeset/facet-websockets-accessor.md`):

```ts
// vendor/agents/packages/agents/src/index.ts:1225-1227
protected get webSockets(): WebSockets {
  return this._webSockets;
}
```

`WebSockets` has no `broadcast()`; it exposes `getConnections(tag?)` and
`getConnection(id)` (`src/websockets/websockets.ts:188-197`). So the mechanical
translation is a loop:

```ts
// delegated-run-agent.ts:91-94 — before
override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
  super.broadcast(message, without);
  this.lifecycle.broadcast(message, without);
}
// after
override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
  super.broadcast(message, without);
  for (const connection of this.webSockets.getConnections()) {
    if (without?.includes(connection.id)) continue;
    connection.send(message);
  }
}
```

**Verify first, and prefer deleting the override.** The second broadcast only
earns its place if Rook's host puts a _physical_ socket on a delegated-run
facet. Evidence that it does not:

- The supervisor refuses to place any worker address whose last class is not the
  conversation class, and says why: "Delegated runs and messenger state are
  in-realm facets now, so they never reach a worker address at all"
  (`packages/extension/src/offscreen/host.ts:1240-1245`).
- `runtimePortAddress()` parses only the root and conversation class names out
  of a connect URL (`host.ts:1248-1258`); a delegated-run class is not a
  possible parse.
- The worker's only socket entry point is
  `connectWebSocketToAgent(live.env, socket, message.url)`
  (`think-host.worker.ts:1075-1078`), which routes through `routeAgentRequest`
  on the worker-address agent (`worker/host/transport.ts:14-17`). A `/sub/` hop
  from there reaches a facet as a _virtual_ bridged connection, and virtual
  connections are served by `Agent.getConnections()`, whose facet branch yields
  `this._dynamicAgents.getVirtualConnections(tag)` (`src/index.ts:5358-5373`),
  not `this._webSockets.getConnections()`.

The set is nonetheless real on this host: every facet container is built with
its own `webSockets: hibernation.snapshot()` (`think-host.worker.ts:315`), which
is why the accessor is meaningful here and inert on workerd.

The verification step, once the branch typechecks: add a temporary probe to
`BrowserThinkDelegatedRun` that returns `[...this.webSockets.getConnections()].length`,
run `agent-tool-delegation.integration.test.ts` and
`agent-tool-stop.integration.test.ts`, and assert it stays 0 across a full
delegated run including a Stop. If it does, delete the whole override and let
`Agent.broadcast`'s facet branch (`src/index.ts:5325-5328`, which routes to the
parent) stand alone. Do not keep a loop that never sends.

### 2.5 The compaction boundary constants compile again

`protectHead` and `minTailMessages` were upstream 0.22 options that upstream
0.23 deleted, leaving `PROTECT_HEAD = 3` / `MIN_TAIL_MESSAGES = 2` as module
constants. The fork restores them (`fda2bdf3`,
`.changeset/compaction-boundaries.md`):

```ts
// vendor/agents/packages/agents/src/sessions/compaction-helpers.ts:278-294
// (doc comments abridged; the field list is exact)
export interface CompactOptions {
  summarize: (prompt: string) => Promise<string>;
  keepRecentTokens?: number;
  /** Head messages kept verbatim so the conversation's opening survives. Default 3. */
  protectHead?: number;
  /** Tail messages kept verbatim regardless of the token budget. Default 2. */
  minTailMessages?: number;
}
```

They are threaded into the short-circuit and both boundary helpers
(`compaction-helpers.ts:321-336`). So
`packages/extension/src/offscreen/worker/conversation/compaction.ts:15-18`
needs **only** the import move from §2.1:

```ts
export const CONVERSATION_COMPACTION_BOUNDARY = {
  protectHead: 1,
  minTailMessages: 1
} satisfies Pick<CompactOptions, "protectHead" | "minTailMessages">;
```

`tailTokenBudget` was **not** restored: 0.23's `keepRecentTokens`
(`compaction-helpers.ts:285`, default 20,000 at `:321`) is the same knob and
Rook never set it. `tokenCounter` was not restored either; see §3.5.

**The three failing cases in `compaction-boundary.contract.test.ts` pass.** At
head-3/tail-2 the guard `if (messages.length <= protectHead + minTailMessages) return null`
(`compaction-helpers.ts:327`) short-circuits every fixture in that file, because
none feeds more than four messages:

| case (`file:line`)                                                              | messages | at head 3 / tail 2                                           | at head 1 / tail 1                                                               |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `"compacts a conversation of a few enormous messages"` (`:40-49`)               | 4        | `null`, so `expect(result).not.toBeNull()` **fails**         | `fromMessageId === "a1"`                                                         |
| `"keeps compacting once an overlay occupies the head of the middle"` (`:51-60`) | 4        | `null`, **fails**                                            | overlay filtered at `compaction-helpers.ts:344-348`, so `fromMessageId === "u2"` |
| `"protects the opening request and the newest message"` (`:62-70`)              | 3        | `null`, so `result?.fromMessageId` is `undefined`, **fails** | `from === to === "a1"`                                                           |
| `"compacts to nothing when the summarizer returns only whitespace"` (`:89-101`) | 4        | passes **vacuously** (null for the wrong reason)             | null at `compaction-helpers.ts:363`, the reason the case is written for          |

The other two cases (`:29-38`, `:72-83`) never call `compact` and are unaffected.
Note the fourth row: if anyone ever drops the fork delta, that case goes green
while proving nothing. Its value depends on the restored floors.

`UIMessage` stays assignable to `SessionMessage`, so the fixture's `huge()`
helper (`:22-26`) needs no retyping: "Vercel AI SDK's `UIMessage` is
structurally compatible" (`src/sessions/types.ts:30-34`).

Rook's `frameCompactionSummary` and `COMPACTION_SUMMARY_PROMPT_RULES`
(`compaction.ts:32-48`) have no upstream equivalent and stay as they are.

---

## 3. Required changes (behaviour and packaging)

### 3.1 Duplicate-request receipt retention

At 0.22 a completed-request receipt lived for `ResumableStream`'s ten-minute
completed-buffer window, reclaimed by a cleanup alarm. 0.23 has neither: the
cleanup alarm is gone, finished chat rows are reclaimed at the persist cutover
and by the next `ResumableStream.start()`, and because the cutover _discards_
the streamed turn's row, the fork now writes a chunkless receipt after **every**
persisted turn, not only after turns that never streamed.

Net effect: duplicate protection spans "until this agent starts its next
stream", not ten minutes. Admission reads `hasRequest(requestId)` before any
`start()`, so a re-delivered request for the turn that just settled is still
caught. A duplicate arriving after an unrelated later turn has begun is not.

No Rook code change. Rook imports none of `hasRequest` /
`hasErroredRequest` / `recordCompletedRequest` (grep across `packages/` is
empty) and has no assertion on the ten-minute window. What to watch: a chat
request replayed across a long reconnect gap could now run inference twice.
Rook's own admission gate (`think-host.worker.ts:869-898`) suppresses _stopped_
frames by generation, not duplicates, so it does not cover this. The relevant
browser suite is `thread-lifecycle.integration.test.ts`.

### 3.2 `hydrationByteBudget`: set it explicitly

Two changes, and the second matters more than the first.

1. The default moved from 24 MiB to 32 MiB
   (`base-0.22 think.ts:2760` → `vendor/agents/packages/think/src/think.ts:2947`).
2. **The message-count floor is gone.** 0.22 guaranteed at least
   `MODEL_RECENT_WINDOW` messages regardless of size. 0.23 does not:

   > The budget is a hard ceiling with no message-count floor beneath it — a
   > floor that admitted rows regardless of size would defeat the bound it sits
   > under. A window of unusually large messages can therefore be shorter than
   > `MODEL_RECENT_WINDOW`; `getHistory()` still reads the full path.
   > (verbatim, `packages/think/src/think.ts:3913-3916`)

   The field's own doc comment at `think.ts:2926-2935` still describes the old
   floor. That staleness is upstream's, not a fork edit. Trust
   `_syncMessages` (`think.ts:3918-3939`), which just calls
   `session.getRecentHistory(budget)`; the only floor left is "the newest
   message is always returned" (`packages/think/src/session.ts:181-185`).

Also, the budget is now charged against _inflated_ bytes: "A pointer row is
therefore charged its payload, not its ~100 stored bytes"
(`think.ts:2937-2941`). The same numeric value is stricter than it was for a
media-heavy conversation.

**Recommendation: set `hydrationByteBudget` explicitly on
`BrowserThinkWorker`** rather than inheriting the default. Rook's conversations
are precisely the shape this hurts, for the same reason it lowered the
compaction floors: one code-execution turn persists as a single enormous
assistant row (`conversation/compaction.ts:7-14`). A handful of those plus one
image attachment can now hydrate as few as one message.

Value class: keep it in the tens of megabytes, and treat it as a _memory_
bound, not a history bound. The offscreen worker is not a 128 MB workerd
isolate, so the #1710 reasoning that set 32 MiB does not transfer directly;
pick a number against Rook's own worker memory headroom and pin it in a
constant next to `CONVERSATION_INPUT_TOKEN_BUDGET`. Setting it to
`Number.POSITIVE_INFINITY` disables windowing entirely (`think.ts:2941-2943`,
`think.ts:3923-3932`), which restores 0.22's unbounded behaviour but gives up
the #1710 protection; do not do that without a memory measurement.

`upstream-config.integration.test.ts:88-93` reads the live value and derives its
row count from it (`:93`), so the arithmetic survives the default change. Its
SQL does not; see §3.6.

### 3.3 `@cloudflare/voice` is deprecated

Upstream PR [#2225](https://github.com/cloudflare/agents/pull/2225) moved Voice
and Channels into the `agents` package. `@cloudflare/voice@0.5.0` is four
two-line re-export files:

```ts
// vendor/agents/packages/voice/src/voice.ts
/** @deprecated Import from "agents/voice" instead. */
export * from "agents/voice";
```

Every Rook symbol resolves through the shim and also exists at the canonical
path, so the move can be staged. Verified present: `withVoiceInput`
(`src/voice/index.ts:98`), `VoiceClientMessage` / `Transcriber` /
`TranscriberSession` / `TranscriberSessionOptions` (`src/voice/index.ts:86, 94`;
`src/voice/types.ts:149, 258, 263`), `UseVoiceInputReturn`
(`src/voice/react.tsx:94`). Rook's voice-mixin overrides (`beforeCallStart`,
`onCallStart`, `onCallEnd`, `onTranscript`, `onAudioLevel`, `transcriber`) all
survive in `src/voice/index.ts` and `src/voice/voice-input.ts`.

| Rook `file:line`                                                                              | before                                                                                                 | after                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `packages/extension/src/offscreen/dictation-feeder.ts:13`                                     | `import type { VoiceClientMessage } from "@cloudflare/voice";`                                         | `... from "agents/voice";`       |
| `packages/extension/src/offscreen/worker/agents/root-agent.ts:9`                              | `import { withVoiceInput } from "@cloudflare/voice";`                                                  | `... from "agents/voice";`       |
| `packages/extension/src/offscreen/worker/dictation/codex-oauth-transcriber.ts:1`              | `import type { Transcriber, TranscriberSession, TranscriberSessionOptions } from "@cloudflare/voice";` | `... from "agents/voice";`       |
| `packages/extension/src/offscreen/worker/fixtures/codex-oauth-transcriber.contract.test.ts:1` | `import type { TranscriberSession } from "@cloudflare/voice";`                                         | `... from "agents/voice";`       |
| `packages/think-app/host/think-host.ts:9`                                                     | `import type { UseVoiceInputReturn } from "@cloudflare/voice/react";`                                  | `... from "agents/voice/react";` |

Build config follows, and both moves are **deletions**, not re-points, because
the `agents` entries already cover the new home:

| Rook `file:line`                                                            | change                                                                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/extension/src/offscreen/worker/host/vite-aliases.ts:32`           | delete `"**/node_modules/@cloudflare/voice/dist/**"` from `actorAwaitTransformInclude`; `"**/node_modules/agents/dist/**"` at `:30` already covers the moved implementation |
| `packages/extension/src/offscreen/worker/host/vitest.browser.config.ts:185` | delete `"@cloudflare/voice"` from `optimizeDeps.exclude`; `"agents"` at `:188` already keeps the await transform reaching it                                                |

There is no `@cloudflare/voice` alias to re-point: a repo-wide grep finds only
those two config entries plus the five imports and the package.json/catalog
declarations. Once the imports move, drop `@cloudflare/voice` from
`packages/{extension,think-app,companion}/package.json` and from the catalog.

### 3.4 `withContext` is deprecated and throws outside `configureSession`

```ts
// vendor/agents/packages/think/src/session.ts:101-110
withContext(label: string, options: SessionContextOptions = {}): this {
  if (!this.#pendingContext) {
    throw new Error(
      "withContext() is only available inside configureSession(). " +
        "After startup, add a block with this.context.addBlock()."
    );
  }
  this.#pendingContext.push({ label, ...options });
  return this;
}
```

Rook calls it only inside `configureSession` (`worker-agent.ts:471-478`,
`conversation-agent.ts:271-299`), so nothing throws today. The replacement is
`configureContext(): ContextConfig[] | Promise<ContextConfig[]>`
(`packages/think/src/think.ts:5600-5602`). This is not a required change; it is
§5.1. But note the ordering constraint now, because it makes a half-migration
wrong: blocks from `configureContext()` are prepended to those queued by
`withContext()`.

```ts
// vendor/agents/packages/think/src/think.ts:3188-3192
this.#contextBlocks = new ContextBlocks(
  [
    ...(await this.configureContext()),
    ...this.session.internal_takePendingContext()
  ],
```

`configureSession`'s own signature widened to
`configureSession(session: ThinkSession): ThinkSession | Promise<ThinkSession>`
(`think.ts:5577-5581`). Rook's synchronous `override configureSession(session: Session): Session`
(`worker-agent.ts:468`) stays legal, and `conversation-agent.ts:269-270`'s
`super.configureSession(session).withContext(...)` still chains because its
`super` is `BrowserThinkWorker`, whose override is declared synchronous.

`withCachedPrompt()` is also deprecated and now a no-op except for a custom
provider (`session.ts:115-121`). Rook does not call it.

### 3.5 `compactAfter`'s ignored `tokenCounter`

```ts
// vendor/agents/packages/think/src/session.ts:54-60
/**
 * @deprecated `compactAfter()` gates on the token estimate Sessions stamps on
 * each row; a custom counter is no longer consulted. Accepted so existing
 * calls compile.
 */
export interface CompactAfterOptions {
  tokenCounter?: unknown;
}
```

The option is accepted and dropped (`session.ts:142-145`). Rook passes no
counter (`worker-agent.ts:498`), so there is **no behaviour change**. There is a
documentation change: the comment above that line is now wrong and must go.

```ts
// worker-agent.ts:492-498 — the last three comment lines are now false
// ponytail: the heuristic counter undercounts tool-heavy history so
// this check can fire late; the proactive/reactive guards above still
// bound the turn. Wire a usage-based tokenCounter if that gap matters.
.compactAfter(CONVERSATION_INPUT_TOKEN_BUDGET)
```

Replace the last sentence: a usage-based counter can no longer be wired.
Auto-compaction gates on the per-row `token_estimate` Sessions stamps
(`src/sessions/core.ts:135` declares the column; `src/sessions/handle.ts:60-64`
states the rule). The proactive and reactive guards at `worker-agent.ts:315-318`
remain the bound on a single turn.

### 3.6 Fixtures that write legacy tables directly

Three browser fixtures reach into SDK-owned tables. All three break.

| fixture                                                                                | current SQL                                                                                                                                                                             | must become                                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.../host/fixtures/browser/upstream-config.integration.test.ts:100-178` and `:190-204` | 3 recursive `INSERT INTO assistant_messages (id, session_id, parent_id, role, content)`, a `count(*)`, and `SELECT instr(content, '[evicted image/png') ... WHERE id = 'bounded-media'` | `cf_agents_session_messages`, new column set, see below                                                         |
| `.../host/fixtures/browser/routine-reconciliation.integration.test.ts:140-143`         | `FROM cf_agents_schedules AS schedules ... WHERE schedules.callback = '_runDeclaredScheduledTask'`                                                                                      | `FROM cf_agents_jobs AS jobs ... WHERE jobs.fn = '_runDeclaredScheduledTask'`                                   |
| `.../host/fixtures/browser/alarm-facet-reentry.integration.test.ts:172, 186`           | `SELECT time FROM cf_agents_schedules LIMIT 1`, then `expect(repaired.when!).toBeLessThanOrEqual(time * 1_000)`                                                                         | `SELECT time FROM cf_agents_jobs WHERE capability = 'scheduler' LIMIT 1`, then `... .toBeLessThanOrEqual(time)` |

**`upstream-config`.** The new schema is

```sql
-- vendor/agents/packages/agents/src/sessions/core.ts:126-138
CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL DEFAULT 'message',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_chunks INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID
```

Four consequences for the rewrite:

1. `seq` and `created_at` are `NOT NULL` with no default. Every insert must
   supply them. `created_at` is epoch **milliseconds** as an INTEGER, not the
   datetime string 0.22 used (compare the migration's
   `COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000` at
   `core.ts:283`).
2. The table is `WITHOUT ROWID`, so the leaf lookup at `:110-118`
   (`ORDER BY message.created_at DESC, message.rowid DESC`) fails: there is no
   `rowid` column to order by.
   Order by `seq DESC` instead; `seq` is the explicit ordering column the
   migration synthesizes with `ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC)`
   (`core.ts:280`).
3. `content_chunks` stays 0 for an inline row, which is what the fixture wants:
   it writes 1.6 MB rows directly and expects them read back whole.
4. The session id is still `''`: `Sessions.session(sessionId = "")`
   (`src/sessions/sessions.ts:93`).

The eviction poll at `:196-198` keeps its shape and only changes table name.

**The two schedule fixtures.** `cf_agents_schedules` is migrated into
`cf_agents_jobs` on first wake and dropped
(`src/schedules/scheduler.ts:231-290`, PR
[#2175](https://github.com/cloudflare/agents/pull/2175)). Mapping:

- id preserved (`scheduler.ts:270`)
- `callback` becomes `fn` (`scheduler.ts:271`)
- **`time` converts from epoch seconds to epoch milliseconds**
  (`scheduler.ts:272`: `time: row.time * 1000`). `cf_agents_jobs.time` is
  already ms (`src/lifecycle/job-queue.ts:209`), so the `* 1_000` at
  `alarm-facet-reentry.integration.test.ts:186` must be deleted, not moved.
- `_cf_keepAliveHeartbeat` rows are discarded rather than migrated
  (`scheduler.ts:245-247`)
- the row gains a `capability` column, `'scheduler'` for schedule-owned jobs
  (`src/schedules/scheduler.ts:197`), and the user payload is nested under
  `payload.payload` (`scheduler.ts:273-282`). `cf_agents_jobs` is shared by every
  capability that queues work, so a bare `LIMIT 1` that used to be unambiguous on
  `cf_agents_schedules` now needs `WHERE capability = 'scheduler'`.

For `routine-reconciliation` the join key is unchanged (`jobs.id` still equals
`declared.schedule_id`), so only the table and column names move. Its
`BEFORE INSERT` trigger on `cf_think_scheduled_tasks` (`:107-113`) is untouched:
that table's schema is identical between think 0.17 and 0.18.

While in `conversation-agent.ts`, note the comment at `:582-583` ("Second
resolution, because that is what the schedule row stores"). Re-verify it against
`cf_agents_jobs.time` before leaving it in place.

### 3.7 `docs/release-upgrade.md` corrections

`/Users/alexmnahas/personalRepos/WebMCP-org/think-browser-host/docs/release-upgrade.md`
needs three edits:

- `:23` currently reads: "The pinned scheduler retains `cf_agents_schedules` and
  seconds-based rows; its extracted initializer adds the schema marker. The
  historical seconds-to-milliseconds checklist does not describe this fork."
  Both sentences become false. Replace the SDK SQL row with one row per lift
  (§4.1) and state plainly that they are one-way.
- `:12-13` names `rook-sdk-ccd31be60cd5`; the tree actually resolves a different
  tarball (§3.8). Name the new tag once and make the catalog, the overrides and
  this doc agree.
- `:58-59` says "A downgrade to older code after v2 migration is refused rather
  than rewriting newer data." That describes Rook's _application state_
  migration (`browser-runtime/directory-state-migrations.ts`). It does not
  describe the SDK tables, which are simply gone. Add the distinction.

### 3.8 `pnpm.overrides` and the catalog

All in `/Users/alexmnahas/personalRepos/WebMCP-org/think-browser-host/pnpm-workspace.yaml`:

| line     | now                                                                                                                                                                                                                              | change                                                                                                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:26-31` | catalog anchors at `rook-sdk-3fe32bca0297` with `agents-0.22.0.tgz`, `cloudflare-think-0.17.0.tgz`, `cloudflare-voice-0.4.0.tgz`, `cloudflare-shell-0.4.3.tgz`, `cloudflare-ai-chat-0.11.0.tgz`, `cloudflare-codemode-0.5.1.tgz` | repoint to the new `rook-sdk-<sha>` tag and the new filenames: `agents-0.23.0.tgz`, `cloudflare-think-0.18.0.tgz`, `cloudflare-voice-0.5.0.tgz` (or drop, §3.3), `cloudflare-shell-0.4.3.tgz`, `cloudflare-ai-chat-0.12.0.tgz`, `cloudflare-codemode-0.5.2.tgz`. Shell's version is unchanged but its asset lives at the new tag. |
| `:51`    | `"agents": file:/tmp/rook-sdk-packages/agents-0.22.0-efc45034.tgz`                                                                                                                                                               | **delete the local escape hatch.** This is what `packages/extension/node_modules/agents` actually resolves to today, so the catalog URL above it has been decorative. Restore `*agents` so the override and the catalog agree and the lockfile pins one integrity hash.                                                           |
| `:58-60` | `"@cloudflare/think@0.17.0>workers-ai-provider"`, `>@ai-sdk/anthropic`, `>@ai-sdk/openai`                                                                                                                                        | re-version the selector to `@cloudflare/think@0.18.0>`. The selector is version-qualified; left at `0.17.0` these three overrides silently stop applying and the tree resolves think's declared `^4.0.0` ranges instead of Rook's pinned 3.x providers. The ranges themselves are unchanged between 0.17 and 0.18.                |
| `:85-87` | `"@mcp-b/react-components@0.54.0>agents": "0.22.0"`, `>@cloudflare/think": "0.17.0"`, `>@cloudflare/voice": "0.4.0"`                                                                                                             | bump to `0.23.0` / `0.18.0` / `0.5.0`, or re-release react-components against the new peers. See §7 Q3.                                                                                                                                                                                                                           |

`@mcp-b/do-runtime` stays at `0.8.1` (`:11`). This refresh changes nothing in
the runtime: every commit in §1 touches only `vendor/agents/`.
`@mcp-b/do-runtime@0.8.1` already implements `abort(reason, { retryAlarm })`,
which 0.23's no-retry abort path needs.

No new required peer. `agents`' `peerDependencies` map is byte-identical
between 0.22.0 and 0.23.0; `@cloudflare/think@0.18.0` adds `@chat-adapter/discord`
and `@chat-adapter/slack` at `4.37.0` as _optional_ peers, which Rook already
pins (`pnpm-workspace.yaml:10`, `packages/extension/package.json:19-20`). Expect
these regular-dependency additions in Rook's lockfile diff: `agents` gains
`postal-mime@^2.7.5` (email channels) and moves `capnweb` to `^0.12.0`;
`@cloudflare/think` moves `chat` to `^4.37.0`.

---

## 4. Rollout

### 4.1 What runs on first wake, per actor

| lift                                                                                                                                   | runs in                                                                            | source, after                                                                                           | Rook actors affected                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `assistant_messages` → `cf_agents_session_messages` (+ `cf_agents_session_message_chunks`, `cf_agents_session_fts`)                    | `Sessions.onStart` (`src/sessions/sessions.ts:65-83`)                              | `INSERT OR IGNORE ... SELECT`, row-by-row verify, then `DROP TABLE` (`src/sessions/core.ts:275-292`)    | every conversation and delegated-run actor    |
| `assistant_compactions` → `cf_agents_session_compactions`                                                                              | same                                                                               | same (`core.ts:294-309`)                                                                                | conversations that have compacted             |
| `assistant_sessions`, `assistant_fts`                                                                                                  | same                                                                               | dropped outright, not migrated (`core.ts:314-315`)                                                      | all                                           |
| `cf_agents_schedules` → `cf_agents_jobs`                                                                                               | `Scheduler` schema migration (`src/schedules/scheduler.ts:219`)                    | `DROP TABLE cf_agents_schedules` (`:289`); `time` seconds → ms; `_cf_keepAliveHeartbeat` rows discarded | root (routines, follow-ups) and conversations |
| `cf_ai_chat_stream_metadata`, `cf_ai_chat_stream_chunks` → `cf_agents_streams` / `cf_agents_stream_blocks` / `cf_agents_stream_chunks` | `ResumableStream` cutover (`src/chat/resumable-stream.ts:375-469`)                 | `DROP TABLE IF EXISTS` both (`:467-468`)                                                                | every actor that has streamed a turn          |
| `assistant_config` (or `assistant_config__lifted_v1`) → `think_config`                                                                 | `Think._migrateLegacyConfigToThinkTable` (`packages/think/src/think.ts:4431-4471`) | `DROP TABLE ${source}` (`:4470`)                                                                        | every Think actor                             |

A partial Sessions migration is retried rather than stamped: the version key is
written only when every source verified (`sessions/sessions.ts:70-82`,
`core.ts:263-272`), and the lift is idempotent. That is a safety property, not a
rollback.

One visible detail of the message lift: a legacy row whose `created_at` string
`strftime` could not parse is stored as `0` and read back as **undated**, not as
1970 (`sessions/core.ts:68-78`, fork commit `3f8f444b`). If Rook renders a
timestamp per message, expect a small number of pre-upgrade rows to have none.
Render them as unknown rather than as the epoch.

Two drops in the shape delta are inert for Rook. `cf_ai_chat_agent_messages`
belongs to `AIChatAgent`, which Rook does not use (zero `@cloudflare/ai-chat`
imports). `cf_agents_search_entries` is dropped only when an
`AgentSearchProvider` is constructed (`src/context/search.ts:85`); Rook
constructs none.

### 4.2 The backup hook Rook does not have yet

There is no `exportFile` / `importDb` path anywhere in Rook today. Storage is
OPFS SAH-pool databases opened in place, one directory per actor:

```ts
// packages/extension/src/offscreen/worker/think-host.worker.ts:655-666
async function installPool(address: AgentWorkerAddress): Promise<SqliteWasmHost> {
  const sqlite3 = await sqlite3InitModule();
  const actorKey = encodeURIComponent(agentWorkerAddressKey(address));
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: ACTOR_VFS_NAME,
    directory: `${BROWSER_HOST_STORAGE_ROOT}/${BROWSER_HOST_ACTORS_DIRECTORY}/${actorKey}`,
    clearOnInit: false,
    initialCapacity: POOL_CAPACITY,
  });
```

**The smallest hook that works.** The pool handle that call already returns
exposes `getFileNames(): string[]`, `exportFile(filename): Promise<Uint8Array>`,
`importDb(name, data): Promise<number>` and `unlink(filename): boolean`
(`@sqlite.org/sqlite-wasm@3.53.0-build1`, `dist/index.d.mts:1033, 1053, 1084, 1122`).
So a backup is: open the pool for one actor directory, walk `getFileNames()`,
`exportFile()` each, and keep the bytes. Restore is the same pool plus
`importDb()` per file.

Rook already has the exact precedent for doing this outside the live actor:
`packages/extension/src/offscreen/worker/host/fixtures/browser/persisted-state-inspection.worker.ts:18-43`
opens the same directory with `clearOnInit: false` and `initialCapacity: 0` and
reads it with no Agent constructed. Model the backup worker on that file.

Scope it to what the canary needs: export before the first wake on the new
build, for the canary profile's conversation actors plus the root; keep the
bytes until the canary passes. Do not build a general backup product here.
The alarms worker's pool (`worker/alarms.worker.ts:67-72`, directory
`rook/alarms[/<scope>]`) holds only `__rook_alarm_projection`, a derived
projection, and does not need exporting.

Deletion is unrelated and already exists: `deleteAgentStorage` removes the whole
actor directory (`packages/extension/src/offscreen/supervisor-agent-deletion.ts:54-60`).

### 4.3 Canary plan

One profile, on a build carrying the new tarballs, with its databases exported
first.

1. Export the profile's actor databases (§4.2). Record the file list and sizes.
2. Install the candidate into that same profile. The existing lane does this:
   `THINK_UPGRADE_BUILD_DIR` plus `packages/extension/e2e/release.spec.ts`
   (`docs/release-upgrade.md:41-52`).
3. Wake the root and at least one pre-existing conversation.
4. Verify, in this order, because each depends on a different lift:
   - **Conversations.** Open a conversation created on 0.22. Its full history
     renders, the compaction checkpoint (if any) still reads back, and
     `search_history` returns hits from before the checkpoint. That covers the
     `assistant_messages` / `assistant_compactions` / FTS lift.
   - **Schedules.** A routine created on 0.22 still appears in the routines
     list, still has a native schedule, and fires at the expected wall-clock
     time. This is the one where a unit error is silent and shows up only as a
     wake that is 1000x early or late.
   - **Delegated runs.** Start a delegated run, watch progress frames reach the
     composer, then Stop it. This exercises the `broadcast` change from §2.4 and
     the Tasks-based recovery path.
   - **Dictation.** Start and stop a dictation session; confirm the audio meter
     moves and a transcript lands. This exercises the `agents/voice` import
     move and the await-transform config change from §3.3.
5. Cold start the profile again and re-check the conversation and the routine.
   The second wake is where an unstamped (retried) migration would show.

### 4.4 Rollback

The lever is **both** halves:

1. Re-pin `pnpm-workspace.yaml` to the previous `rook-sdk-<sha>` tarballs and
   rebuild.
2. Restore the exported database files into each affected actor directory with
   `importDb()`.

**Step 2 is not optional.** The migrations are one-way and the source tables are
dropped, not tombstoned (§1, §4.1). A 0.22 build pointed at a database that has
already migrated finds no `assistant_messages`, no `cf_agents_schedules` and no
`cf_ai_chat_stream_*`. It will not rebuild them from `cf_agents_session_messages`
or `cf_agents_jobs`; nothing in 0.22 knows those tables exist. The observable
result is a conversation that reads as empty and a routine that never fires,
with the data still on disk under names the old code does not look for.

If a profile woke on 0.23 without an export, there is no rollback for that
profile. Say so in the release notes rather than implying one.

---

## 5. Optional simplifications

Do all of these **after** the required changes have landed and the canary in §4.3
has passed. None of them is needed to ship 0.23.

### 5.1 `configureContext()` / `ContextBlocks` (clean win, do this first)

Rook's context blocks are already literal `ContextConfig` objects assembled at
config time, so moving them from a fluent chain to a returned array is close to
mechanical. It also separates two concerns 0.23 split apart:
`configureSession` is compaction policy, `configureContext` is the prompt.

Target shape for `conversation-agent.ts:268-300`:

```ts
override configureContext(): ContextConfig[] {
  return [
    ...super.configureContext(),
    {
      label: "browser_agent",
      description: "Browser agent operating contract",
      provider: { get: async () => BROWSER_AGENT_PROMPT },
    },
    {
      label: "memory",
      description:
        "This conversation's own durable notes; no other conversation sees them. " +
        "A fact every conversation should know belongs in the shared file memory under " +
        `${MEMORY_DIR_WORKSPACE_PATH} instead (see memory_index).`,
      maxTokens: 1_100,
      provider: new AgentContextProvider(this, "memory"),
    },
    {
      label: "memory_index",
      description: /* unchanged text from :284-293 */,
      ...workspaceFileContext({
        workspace: this.workspace,
        path: MEMORY_INDEX_WORKSPACE_PATH,
        maxTokens: MEMORY_INDEX_CONTEXT_MAX_TOKENS,
      }),
    },
  ];
}
```

and `worker-agent.ts:468-500` splits in two: the `soul` block moves into its own
`configureContext()` returning one entry, and `configureSession` keeps only
`.onCompaction(...).compactAfter(...)`.

Depends on: §2.1 (the `ContextConfig` import already moved to `agents/context`).
Size: about 45 lines reshaped, net LOC roughly flat. The win is clarity plus
getting off a deprecated path that throws outside `configureSession`.

**Do it in one commit.** `configureContext()` blocks are prepended to
`withContext()` blocks (`think.ts:3188-3192`), so migrating some blocks and not
others silently reorders the system prompt, which invalidates the frozen prefix
cache and moves content the model was reading in a fixed place.

### 5.2 `dynamicAgents.*` (cosmetic)

`hasSubAgent`, `deleteSubAgent` and `listSubAgents` are now `@deprecated` pure
delegates to `this.dynamicAgents.*` (`src/index.ts:8939-8943, 8966-8974,
8976-8990`), reached through `get dynamicAgents(): DynamicAgents`
(`src/index.ts:1361-1364`). `onBeforeSubAgent` itself is untouched and is still
the intended gate; upstream's own doc example (`src/index.ts:8957-8964`) is
Rook's exact pattern.

Migrate the three local gates now if you want the deprecations silenced:
`root-agent.ts:1006-1012`, `conversation-agent.ts:457-468`,
`delegated-run-agent.ts:97-99`; plus `fixtures/test-think-agents.ts:96`
(`deleteSubAgent` → `dynamicAgents.delete`).

**Do not blind-migrate the seven RPC sites.** `.../browser/{agent-tool-delegation,
agent-tool-stop}.integration.test.ts` and `think-worker-harness.ts:84` reach
`hasSubAgent` as a flat method on a capnweb `RpcTarget` (`AgentRpc`,
`think-worker-harness.ts:71-84`, session opened at `:213`). `dynamicAgents` is a
plain getter returning a plain class (`src/dynamic-agents/api.ts:18-24`), not an
`RpcTarget`, so capnweb traversal is not established. Either leave those sites
on the deprecated method or add a `@callable()` shim on the test agent.

Size: ~12 call sites renamed, 0 lines deleted, 0 runtime change.

### 5.3 `RoutedAgents` (recommend against)

`RoutedAgents` (`src/routing/routed-agents.ts`, exported from `agents/routing`,
PR [#2198](https://github.com/cloudflare/agents/pull/2198)) codifies exactly the
topology Rook already has: a hub Agent with one Durable Object per chat. It
would replace the create/list/delete half of the root's thread catalog
(`root-agent.ts:2453-2495`), about 60 lines.

**Do not adopt it in this migration.** The blocking reason is storage identity:
`RoutedAgents` maps public ids to opaque UUID physical names, while Rook's
physical names _are_ the thread ids and are baked into the OPFS directory layout
(`agentWorkerAddressKey` feeding `installPool`, `think-host.worker.ts:655-663`),
the supervisor's port URLs, the client's `/agents/<class>/<name>` connect URLs
(`host.ts:1248-1258`), and every persisted agent address. Adopting it is a
directory-renaming migration on every installed profile, on top of the one-way
table migrations this release already carries.

Three secondary mismatches: Rook's catalog rows carry title, status, origin,
`workingContextPath` and timestamps and are broadcast through `setState`, while
`RoutedAgentEntry.metadata` is an opaque blob with no change feed; Rook does not
route through the root at all (the supervisor bridges a `MessagePort` straight
to each conversation worker, `host.ts:861-880`), so the forwarding half has
nothing to do; and `RoutedAgentsOptions.namespace` wants a real
`DurableObjectNamespace` from `env`, while Rook synthesizes namespaces per
worker realm.

Worth one line in Rook's architecture doc: Rook already implements the pattern
upstream now blesses.

### 5.4 Job queue and `agents/tasks` vs `alarms.worker.ts` (not a replacement)

These are different layers and it is worth being explicit, because the names
collide.

- `cf_agents_jobs` (PR #2175) replaces `cf_agents_schedules`: the SDK's own
  bookkeeping of due work **inside one Durable Object**. It derives the physical
  alarm time from queue state (`src/lifecycle/job-queue.ts`), then calls
  `ctx.storage.setAlarm()`.
- `packages/extension/src/offscreen/worker/alarms.worker.ts` (175 lines) is the
  **platform** that makes `ctx.storage.setAlarm()` mean anything in a browser.
  It runs `@mcp-b/do-runtime`'s `AlarmScheduler` over its own OPFS pool
  (`alarms.worker.ts:62-80`), persists a generation-stamped projection, and
  drives `chrome.alarms` so the extension wakes at all.

  0.23 sits on top of it unchanged. Zero lines of `alarms.worker.ts`,
  `AlarmsHostTarget` or `rootAlarmOutlet` (`think-host.worker.ts:668-675`) go
  away. The one contract Rook depends on still holds:
  `live.agent.lifecycle.rearmAlarm()` survives
  (`src/lifecycle/durable-object-lifecycle.ts:752`) and Rook reads the result
  through `container.state.storage.getAlarm()` (`think-host.worker.ts:787-789`).
  What changed underneath is only where the next alarm time comes from.

Separately, `agents/tasks` (`Tasks extends LifecycleCapability`, no `env` or
binding dependency, `src/tasks/tasks.ts`) _is_ usable on Rook's host, and Think
already uses it internally for chat recovery (PR
[#2194](https://github.com/cloudflare/agents/pull/2194)). But Rook has no
hand-rolled durable-workflow code for it to replace: long-running work is
delegated runs (already `startAgentToolRun`) and routines (already
`getScheduledTasks`). No candidate.

### 5.5 `clampToBudget` stays

`packages/extension/src/offscreen/worker/conversation/workspace-context.ts`
(151 lines) exists because `ContextBlocks` enforces `maxTokens` in exactly one
place, and a readonly block never reaches it. That is still true in 0.23:

- `setBlock` is the only enforcement point, and it throws
  `Block "${label}" is readonly` (`src/context/blocks.ts:241-243`) **before**
  reaching the token comparison at `:254-258`.
- `loadBlock` computes `tokens: estimateStringTokens(content)`
  (`src/context/blocks.ts:172`) and never compares it to `maxTokens`.
- `addBlock` goes through `loadBlock` (`:187-196`), same gap.

So the read-side clamp must stay. Zero lines removed. Its only change is the
inlined estimator from §2.2.

### 5.6 Nothing to do for streams, replay, or alarm contributions

Three surfaces that changed a lot upstream and cost Rook nothing:

- `getNextAlarm()` / `onAlarm()` capability contributions,
  `LifecycleServices.alarms` and `AlarmContribution` were removed in PR #2175.
  Rook never used them; a repo-wide grep across `packages/` is empty.
- `ResumableStream`, `cleanupStreamBuffers` and `STREAM_CLEANUP_DELAY_SECONDS`
  were replatformed onto `agents/streams`. Rook never imported them. Its only
  stream-protocol contact is `CHAT_MESSAGE_TYPES` /
  `STREAM_RESUME_NONE_REASONS` in
  `.../browser/alarm-facet-reentry.integration.test.ts:2, 40, 45, 53-54`, and
  the chat wire protocol, replay handshake and recovery behaviour are
  explicitly unchanged.
- `onAlarmMemoryLimit`, `isDurableObjectMemoryLimitReset`,
  `maxAlarmMemoryLimitStrikes` and `ctx.abort(reason, { retryAlarm })` are
  new or changed host surface. Rook overrides none of them, and
  `@mcp-b/do-runtime@0.8.1` already implements `abort(reason, options)` with
  `retryAlarm`.

Also already satisfied, so nothing to change: all four Rook agent constructors
call `super(ctx, env)` first (`root-agent.ts:391-392`,
`worker-agent.ts:286-287`, `conversation-agent.ts:377-378`,
`delegated-run-agent.ts:61-62`), which 0.23 requires because `Think.sessions`
and the new public `Think.streams` are `lifecycle.use()`d in the constructor.
And 0.23's media eviction writes evicted bytes to the Workspace via
`writeFileBytes`; Rook's `createBrowserWorkspace` has it
(`root-agent.ts:249, 1142`), so eviction keeps working.

---

## 6. Verification checklist (Rook side)

Run in this order. Each line is a real command in the Rook checkout.

1. **Typecheck.** `vp run typecheck` (root `package.json`), which fans out to
   `vp exec wxt prepare && vp exec tsc --noEmit` per package. This is what
   catches every §2 import site.
2. **Contract tests.** `vp run @rook/extension#test:integration-contract`
   (`packages/extension/vite.config.ts:44-48`). Named files that must change or
   must newly pass:
   - `fixtures/compaction-boundary.contract.test.ts` (§2.5): all six cases green,
     including the three that fail without the restored floors.
   - `fixtures/workspace-context.contract.test.ts` (§2.3): all seven cases green
     after the `ContextBlocks` rewrite; `createPromptOnlySessionStorage` gone.
   - `fixtures/codex-oauth-transcriber.contract.test.ts` (§3.3): unchanged
     behaviour, new import path.
3. **Offscreen and host lanes.** `vp run @rook/extension#test:integration-host`
   and `#test:integration-offscreen`.
4. **Browser integration.** `vp run @rook/extension#test:integration-browser`
   (`packages/extension/vite.config.ts:25-38`). The suites this migration
   actually moves:
   - `.../browser/upstream-config.integration.test.ts` (§3.6 rewrite, §3.2)
   - `.../browser/routine-reconciliation.integration.test.ts` (§3.6)
   - `.../browser/alarm-facet-reentry.integration.test.ts` (§3.6)
   - `.../browser/agent-tool-delegation.integration.test.ts` and
     `agent-tool-stop.integration.test.ts` and
     `delegated-skills.integration.test.ts` (§2.4)
   - `.../browser/dictation-meter.integration.test.ts` (§3.3)
   - `.../browser/await-transform.integration.test.ts` (§3.3 config deletions:
     this is the suite that proves the transform still reaches actor code)
   - `.../browser/messenger-ingest.integration.test.ts` (`cf_agents_sub_agents`
     is unchanged; this is the negative control)
5. **Full gate.** `vp run ci:verify` then `vp run ci:e2e`.
6. **One manual check per migration**, on the canary profile (§4.3): a 0.22
   conversation renders its full history and `search_history` finds a
   pre-checkpoint message (sessions lift); a 0.22 routine still fires at the
   right wall-clock time (schedules lift, and the seconds-to-ms unit); a
   conversation that was mid-stream when the old build closed resumes or
   terminates cleanly rather than replaying a duplicate (streams lift); and
   Think's model or provider configuration survives the wake (the
   `assistant_config` → `think_config` lift).

---

## 7. Open questions

**Q1. What `hydrationByteBudget` value is right for the browser host?**
The 32 MiB default is sized against a workerd isolate's 128 MB budget
(`think.ts:2921-2924`, issue #1710). Rook's actors are Web Workers, not workerd
isolates, and each owns its own OPFS pool. Nobody has measured what a Rook
conversation worker can hydrate before it is in trouble. Settled by: a memory
measurement on a profile with a large media-heavy conversation, comparing
worker heap at steady state across a few budget values. Until then the §3.2
recommendation is "set it explicitly", not a number.

**Q2. Does `installAgentSocketCallbacks` still intercept every chat frame?**
`think-host.worker.ts:785, 869-898` patches `live.agent.onMessage` after
`getAgentByName()` returns. In 0.23 socket dispatch runs inside the `WebSockets`
capability, but its handlers late-bind through `this.onMessage`
(`src/index.ts:1198-1205`), and the comment at `src/index.ts:1188-1197` says the
inner wrap is kept precisely so non-capability paths (facet bridging, direct
calls) also hit the wrapped hooks. It should still work. Settled by: running
`agent-tool-stop.integration.test.ts`, which depends on the admission-generation
gate that patch installs. Nobody has run it.

**Q3. Does `@mcp-b/react-components@0.54.0` work against 0.23?**
`packages/think-app/host/think-host.ts:13` imports `useSessionCompaction` from
`@mcp-b/react-components/components/agents-sdk/SessionCompaction`, and the
package declares peers on `agents@0.22.0` / `@cloudflare/think@0.17.0` /
`@cloudflare/voice@0.4.0`, pinned open in `pnpm-workspace.yaml:85-87`. Whether
0.54.0's compiled code touches anything that moved is outside the fork and
Rook. Settled by: reading 0.54.0's dist for `agents/experimental/memory`,
`lifecycle.broadcast` and `Session.create`, or by re-releasing it against the
new peers.

**Q4. Does the `{ fallback: true }` WebSockets ordering interact correctly with
do-runtime's upgrade claim?**
PR #2198 made `Agent` install its own `WebSockets` as a fallback capability so
subclass middleware dispatches first (`src/index.ts:2087`). Rook installs no
capabilities, so this should be inert. But Rook's `RookFacetHost` drives
upgrades through `ports.facets` (`think-host.worker.ts:725-734`), and the
interaction with the fallback ordering has not been exercised. Settled by: the
browser lane, specifically `agent-tool-delegation` and `root-agent-reentry`.

**Q5. Is the delegated-run local broadcast reachable at all?**
§2.4 gives strong static evidence that it is not, and a probe that would settle
it in one run. Until that probe runs, the safe move is the mechanical
translation (keep the loop); once it runs, delete the override.

**Q6. Should `conversation-agent.ts:582-583`'s "second resolution" comment
change?**
It describes what `cf_agents_schedules` stored. `cf_agents_jobs.time` is
milliseconds. Whether Rook's follow-up payload timestamps need to change, or
only the comment, depends on where the rounding happens in
`schedule(date, cb, payload)`. Settled by: reading the payload round-trip in
`src/schedules/scheduler.ts` against the follow-up `list`/`cancel` paths at
`conversation-agent.ts:562-579`.
