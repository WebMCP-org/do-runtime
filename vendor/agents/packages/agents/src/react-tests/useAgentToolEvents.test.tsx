/**
 * Browser tests for the `useAgentToolEvents` hook.
 *
 * The hook's whole job is to fold a stream of `agent-tool-event` frames into a
 * stable per-run view while surviving the two ways a frame can arrive twice:
 *   1. LIVE then REPLAY — the server re-sends a run's frames to a
 *      reconnecting/late socket with `replay: true`. Replayed frames are
 *      renumbered over the run's STORED chunks, so a replayed sequence may
 *      match a live one or collide with a different live frame; a replayed
 *      `started` heads an authoritative rebuild of the whole run.
 *   2. terminal then a stray `started` replay — the reducer must not resurrect a
 *      finished run.
 *
 * Dedupe is client-side and keyed by `(parentToolCallId, runId, sequence)` via a
 * `seenRef`, so it is exercised here with a fake `EventTarget` "agent" (the hook
 * only needs `addEventListener`/`removeEventListener`) — the same lightweight
 * pattern `@cloudflare/ai-chat` uses for `useAgentChat`. No Worker required.
 *
 * Locks the live-vs-replay dedupe invariant that previously had ZERO React-test
 * coverage.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import { StrictMode } from "react";
import { useAgentToolEvents, _bufferAgentToolReplayFrame } from "../react";
import type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolCollectionMessage,
  AgentToolCollectionState,
  AgentToolProjectionMessage,
  AgentToolRunState
} from "../agent-tool-types";

// Async event dispatch lands outside act(), exactly like the real WebSocket
// path — mirror the agents `useAgent` suite and disable the act() environment
// after mount, then assert via `vi.waitFor` against a deterministic end-state.
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

afterEach(() => {
  cleanup();
});

type ToolAgent = Parameters<typeof useAgentToolEvents>[0]["agent"];

function createToolAgent(): {
  agent: ToolAgent;
  dispatch: (message: AgentToolProjectionMessage) => void;
  raw: (data: unknown) => void;
  close: () => void;
  error: () => void;
} {
  const target = new EventTarget();
  const agent = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  } as ToolAgent;
  const raw = (data: unknown) =>
    target.dispatchEvent(new MessageEvent("message", { data }));
  const dispatch = (message: AgentToolProjectionMessage) =>
    raw(JSON.stringify(message));
  return {
    agent,
    dispatch,
    raw,
    close: () => {
      target.dispatchEvent(new Event("close"));
    },
    error: () => {
      target.dispatchEvent(new Event("error"));
    }
  };
}

function evt(
  sequence: number,
  event: AgentToolEvent,
  opts?: { parentToolCallId?: string; replay?: true }
): AgentToolEventMessage {
  return {
    type: "agent-tool-event",
    sequence,
    ...(opts?.parentToolCallId !== undefined && {
      parentToolCallId: opts.parentToolCallId
    }),
    ...(opts?.replay && { replay: true }),
    event
  };
}

function collectionFrame(
  replayId: string,
  event: AgentToolCollectionMessage["event"]
): AgentToolCollectionMessage {
  return {
    type: "agent-tool-event",
    replay: true,
    replayId,
    sequence: 0,
    event
  };
}

type RenderedState = {
  runsById: Record<string, AgentToolRunState>;
  unboundRuns: AgentToolRunState[];
  runsByToolCallId: Record<string, AgentToolRunState[]>;
  collection: AgentToolCollectionState;
};

function Harness({
  agent,
  onReset
}: {
  agent: ToolAgent;
  onReset?: (reset: () => void) => void;
}) {
  const projection = useAgentToolEvents({ agent });
  onReset?.(projection.resetLocalState);
  return <div data-testid="state">{JSON.stringify(projection)}</div>;
}

function readState(container: HTMLElement): RenderedState {
  const text =
    container.querySelector('[data-testid="state"]')?.textContent ?? "{}";
  return JSON.parse(text) as RenderedState;
}

function runText(run: AgentToolRunState | undefined): string {
  if (!run) return "";
  return run.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

const TEXT_START = JSON.stringify({ type: "text-start", id: "t1" });
function delta(text: string): string {
  return JSON.stringify({ type: "text-delta", id: "t1", delta: text });
}

describe("useAgentToolEvents", () => {
  it("keeps last-known rows stale after disconnect and ignores the old replay", async () => {
    const source = createToolAgent();
    const { container } = await render(<Harness agent={source.agent} />);
    source.dispatch(
      collectionFrame("old", { kind: "collection", status: "loading" })
    );
    source.dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    source.dispatch(
      collectionFrame("old", {
        kind: "collection",
        status: "ready",
        runIds: ["r1"]
      })
    );
    await vi.waitFor(() =>
      expect(readState(container).collection).toEqual({
        status: "ready",
        stale: false
      })
    );

    source.close();
    source.dispatch(
      collectionFrame("old", {
        kind: "collection",
        status: "ready",
        runIds: []
      })
    );
    await vi.waitFor(() => {
      expect(readState(container).collection).toEqual({
        status: "loading",
        stale: true
      });
      expect(Object.keys(readState(container).runsById)).toEqual(["r1"]);
    });
    source.error();
    await vi.waitFor(() => {
      expect(readState(container).collection).toMatchObject({
        status: "error",
        stale: true
      });
      expect(Object.keys(readState(container).runsById)).toEqual(["r1"]);
    });
    source.dispatch(
      collectionFrame("new", { kind: "collection", status: "loading" })
    );
    source.dispatch(
      collectionFrame("new", {
        kind: "collection",
        status: "error",
        error: "Child transcript unavailable",
        runId: "r1"
      })
    );
    await vi.waitFor(() => {
      expect(readState(container).collection).toEqual({
        status: "error",
        stale: true,
        error: "Child transcript unavailable"
      });
      expect(Object.keys(readState(container).runsById)).toEqual(["r1"]);
    });
    source.dispatch(
      collectionFrame("new", {
        kind: "collection",
        status: "ready",
        runIds: []
      })
    );
    await vi.waitFor(() => {
      expect(readState(container).collection).toEqual({
        status: "ready",
        stale: false
      });
      expect(readState(container).runsById).toEqual({});
    });
  });

  it("clears the roster when the event source changes and ignores the old source", async () => {
    const first = createToolAgent();
    const second = createToolAgent();
    const view = await render(<Harness agent={first.agent} />);
    first.dispatch(
      evt(0, { kind: "started", runId: "old-run", agentType: "A", order: 0 })
    );
    await vi.waitFor(() =>
      expect(Object.keys(readState(view.container).runsById)).toEqual([
        "old-run"
      ])
    );
    await view.rerender(<Harness agent={second.agent} />);
    first.dispatch(
      evt(1, {
        kind: "started",
        runId: "wrong-source",
        agentType: "A",
        order: 1
      })
    );
    first.close();
    first.error();
    await vi.waitFor(() => {
      expect(readState(view.container).runsById).toEqual({});
      expect(readState(view.container).collection).toEqual({
        status: "loading",
        stale: false
      });
    });
    second.dispatch(
      evt(0, { kind: "started", runId: "new-run", agentType: "A", order: 0 })
    );
    await vi.waitFor(() =>
      expect(Object.keys(readState(view.container).runsById)).toEqual([
        "new-run"
      ])
    );
  });

  it("dedupes stored cursors while preserving a restarted producer's low sequence", async () => {
    const { agent, dispatch, raw } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);
    raw(
      JSON.stringify({
        type: "agent-tool-event",
        replay: true,
        replayId: "epochs",
        sequence: 0,
        event: { kind: "collection", status: "loading" }
      } satisfies AgentToolCollectionMessage)
    );
    const run = {
      runId: "r1",
      agentType: "A",
      status: "running" as const,
      displayOrder: 0,
      startedAt: 1
    };
    dispatch({
      ...evt(0, { kind: "snapshot", runId: "r1", run }),
      replay: true,
      replayId: "epochs"
    });
    dispatch({
      ...evt(1, {
        kind: "chunk",
        runId: "r1",
        body: delta("saved"),
        cursor: { epoch: "stored", sequence: 1 }
      }),
      revision: 1
    });
    dispatch({
      ...evt(2, {
        kind: "chunk",
        runId: "r1",
        body: delta(" new"),
        cursor: { epoch: "new-producer", sequence: 0 }
      }),
      revision: 2
    });
    dispatch({
      ...evt(2, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          replay: {
            cursor: { epoch: "old-producer", sequence: 99 },
            chunks: [
              {
                sequence: 0,
                body: TEXT_START,
                cursor: { epoch: "stored", sequence: 0 }
              },
              {
                sequence: 1,
                body: delta("saved"),
                cursor: { epoch: "stored", sequence: 1 }
              }
            ]
          }
        }
      }),
      replay: true,
      replayId: "epochs"
    });
    await vi.waitFor(() =>
      expect(runText(readState(container).runsById.r1)).toBe("saved new")
    );
  });

  it("dedupes covered live chunks delivered after hydration without crossing runs or sources", async () => {
    const first = createToolAgent();
    const view = await render(<Harness agent={first.agent} />);
    const run = {
      runId: "r1",
      agentType: "A",
      status: "running" as const,
      displayOrder: 0,
      startedAt: 1
    };
    first.raw(
      JSON.stringify({
        type: "agent-tool-event",
        replay: true,
        replayId: "delayed-live",
        sequence: 0,
        event: { kind: "collection", status: "loading" }
      } satisfies AgentToolCollectionMessage)
    );
    first.dispatch({
      ...evt(0, { kind: "snapshot", runId: "r1", run }),
      replay: true,
      replayId: "delayed-live"
    });
    first.raw(
      JSON.stringify({
        type: "agent-tool-event",
        replay: true,
        replayId: "delayed-live",
        sequence: 0,
        event: { kind: "collection", status: "ready", runIds: ["r1"] }
      } satisfies AgentToolCollectionMessage)
    );
    first.dispatch({
      ...evt(2, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          replay: {
            cursor: { epoch: "producer", sequence: 2 },
            chunks: [
              {
                sequence: 0,
                body: TEXT_START,
                cursor: { epoch: "stored", sequence: 0 }
              },
              {
                sequence: 1,
                body: delta("saved"),
                cursor: { epoch: "stored", sequence: 1 }
              }
            ]
          }
        }
      }),
      replay: true,
      replayId: "delayed-live"
    });
    await vi.waitFor(() =>
      expect(runText(readState(view.container).runsById.r1)).toBe("saved")
    );

    // The child inspection can finish before the parent's tail forwards
    // chunks it already covers. These have fresh parent revisions, so only
    // the retained child cursor can prove that their text is duplicated.
    for (const [revision, epoch, sequence, text] of [
      [1, "producer", 1, "saved"],
      [2, "stored", 1, "saved"],
      [3, "producer", 2, " live"],
      [4, "restarted-producer", 0, " restarted"]
    ] as const) {
      first.dispatch({
        ...evt(revision, {
          kind: "chunk",
          runId: "r1",
          body: delta(text),
          cursor: { epoch, sequence }
        }),
        revision
      });
    }
    first.dispatch({
      ...evt(5, {
        kind: "started",
        runId: "r2",
        agentType: "A",
        order: 1
      }),
      revision: 5
    });
    first.dispatch({
      ...evt(6, {
        kind: "chunk",
        runId: "r2",
        body: TEXT_START,
        cursor: { epoch: "producer", sequence: 0 }
      }),
      revision: 6
    });
    first.dispatch({
      ...evt(7, {
        kind: "chunk",
        runId: "r2",
        body: delta("other run"),
        cursor: { epoch: "producer", sequence: 1 }
      }),
      revision: 7
    });
    await vi.waitFor(() => {
      const state = readState(view.container);
      expect(runText(state.runsById.r1)).toBe("saved live restarted");
      expect(runText(state.runsById.r2)).toBe("other run");
    });

    // The same identifiers and cursors belong to a different conversation
    // after a source switch and must not inherit the old snapshot coverage.
    const second = createToolAgent();
    await view.rerender(<Harness agent={second.agent} />);
    second.dispatch({
      ...evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 }),
      revision: 0
    });
    second.dispatch({
      ...evt(1, {
        kind: "chunk",
        runId: "r1",
        body: TEXT_START,
        cursor: { epoch: "producer", sequence: 0 }
      }),
      revision: 1
    });
    second.dispatch({
      ...evt(2, {
        kind: "chunk",
        runId: "r1",
        body: delta("new source"),
        cursor: { epoch: "producer", sequence: 1 }
      }),
      revision: 2
    });
    await vi.waitFor(() =>
      expect(runText(readState(view.container).runsById.r1)).toBe("new source")
    );
  });

  it("joins an atomic snapshot with live chunks without doubling or losing them", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);
    const run = {
      runId: "r1",
      agentType: "A",
      status: "running" as const,
      displayOrder: 0,
      startedAt: 1
    };
    dispatch(
      collectionFrame("first", { kind: "collection", status: "loading" })
    );
    dispatch({
      ...evt(0, { kind: "snapshot", runId: "r1", run }),
      replay: true,
      replayId: "first"
    });
    dispatch(
      collectionFrame("first", {
        kind: "collection",
        status: "ready",
        runIds: ["r1"]
      })
    );
    dispatch({
      ...evt(1, {
        kind: "chunk",
        runId: "r1",
        body: TEXT_START,
        cursor: { epoch: "live", sequence: 0 }
      }),
      revision: 1
    });
    dispatch({
      ...evt(2, {
        kind: "chunk",
        runId: "r1",
        body: delta("Hello"),
        cursor: { epoch: "live", sequence: 1 }
      }),
      revision: 2
    });
    dispatch({
      ...evt(1, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          progress: { message: "Read sources", at: 123 },
          milestones: [{ name: "report-1", sequence: 0, at: 123 }],
          replay: {
            cursor: { epoch: "live", sequence: 2 },
            chunks: [
              {
                sequence: 0,
                body: TEXT_START,
                cursor: { epoch: "stored", sequence: 0 }
              },
              {
                sequence: 1,
                body: delta("Hello"),
                cursor: { epoch: "stored", sequence: 1 }
              }
            ]
          }
        }
      }),
      replay: true,
      replayId: "first"
    });
    dispatch({
      ...evt(3, {
        kind: "chunk",
        runId: "r1",
        body: delta(" world"),
        cursor: { epoch: "live", sequence: 2 }
      }),
      revision: 3
    });

    await vi.waitFor(() => {
      const state = readState(container);
      expect(runText(state.runsById.r1)).toBe("Hello world");
      expect(state.runsById.r1?.progress).toEqual({
        message: "Read sources",
        at: 123
      });
      expect(state.runsById.r1?.milestones).toHaveLength(1);
    });

    dispatch(
      collectionFrame("second", { kind: "collection", status: "loading" })
    );
    dispatch({
      ...evt(0, { kind: "snapshot", runId: "r1", run }),
      replay: true,
      replayId: "second"
    });
    dispatch({
      ...evt(4, {
        kind: "chunk",
        runId: "r1",
        body: JSON.stringify({
          type: "data-agent-progress",
          transient: true,
          data: { message: "New live progress", at: 456 }
        }),
        cursor: { epoch: "live", sequence: 3 }
      }),
      revision: 4
    });
    dispatch({
      ...evt(1, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          progress: { message: "Older snapshot", at: 123 },
          replay: {
            cursor: { epoch: "live", sequence: 3 },
            chunks: [
              { sequence: 0, body: TEXT_START },
              { sequence: 1, body: delta("Hello world") }
            ]
          }
        }
      }),
      replay: true,
      replayId: "second"
    });
    // A delayed result from the previous connection must not clear the new one.
    dispatch(
      collectionFrame("first", {
        kind: "collection",
        status: "ready",
        runIds: []
      })
    );
    dispatch({
      ...evt(2, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          progress: { message: "Obsolete response", at: 999 }
        }
      }),
      replay: true,
      replayId: "first"
    });
    dispatch(
      collectionFrame("second", {
        kind: "collection",
        status: "ready",
        runIds: ["r1"]
      })
    );
    await vi.waitFor(() => {
      const state = readState(container);
      expect(runText(state.runsById.r1)).toBe("Hello world");
      expect(state.runsById.r1?.progress).toEqual({
        message: "New live progress",
        at: 456
      });
    });
  });

  it("preserves a live run added after enumeration began when reconciling the roster", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);
    dispatch(
      evt(0, { kind: "started", runId: "removed", agentType: "A", order: 0 })
    );
    dispatch(
      collectionFrame("roster", { kind: "collection", status: "loading" })
    );
    dispatch({
      ...evt(0, {
        kind: "started",
        runId: "new-live",
        agentType: "A",
        order: 1
      }),
      revision: 1
    });
    dispatch(
      collectionFrame("roster", {
        kind: "collection",
        status: "ready",
        runIds: []
      })
    );
    await vi.waitFor(() => {
      expect(Object.keys(readState(container).runsById)).toEqual(["new-live"]);
    });
  });

  it("drops a REPLAY frame whose (parent, run, sequence) was already seen LIVE", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    // Live: start → text-start → "Hello"
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hello") }));

    // Replay the SAME seq-2 chunk (reconnect re-sends from the buffer), then a
    // genuinely new seq-3 chunk. If the replay were applied the text would read
    // "HelloHello world"; dedupe keeps it at "Hello world".
    dispatch(
      evt(
        2,
        { kind: "chunk", runId: "r1", body: delta("Hello") },
        { replay: true }
      )
    );
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta(" world") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hello world");
    });
  });

  it("applies distinct sequences for the same run (no over-dedupe)", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("foo") }));
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta("bar") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("foobar");
    });
  });

  it("ignores a stray `started` replay after the run reached a terminal", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "finished", runId: "r1", summary: "done" }));

    await vi.waitFor(() => {
      expect(readState(container).runsById.r1?.status).toBe("completed");
    });

    // A replayed `started` carries a NEW sequence (so the seenRef dedupe does
    // NOT drop it) — the reducer's terminal guard must keep the run `completed`
    // rather than resurrecting it to `running` or wiping its summary.
    dispatch(
      evt(
        2,
        { kind: "started", runId: "r1", agentType: "A", order: 0 },
        { replay: true }
      )
    );

    // Settle, then assert the terminal stuck.
    await new Promise((r) => setTimeout(r, 30));
    const run = readState(container).runsById.r1;
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("done");
  });

  it("rebuilds a run from a reconnect replay whose sequences collide with live ones", async () => {
    // Live numbering counts every forwarded frame, including a transient
    // progress frame that is never stored; a reconnect replay renumbers over
    // stored chunks only. So the replayed terminal below carries seq 3, which
    // the live "Hello" delta already used. Dropping it by the seen-key alone
    // would leave the row running forever and, had the replayed chunks been
    // applied, double the text. A replayed `started` must instead reset what
    // was seen for the run and rebuild it from the replay.
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(
      evt(2, {
        kind: "chunk",
        runId: "r1",
        body: JSON.stringify({
          type: "data-agent-progress",
          transient: true,
          data: { message: "halfway" }
        })
      })
    );
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta("Hello") }));
    await vi.waitFor(() => {
      const run = readState(container).runsById.r1;
      expect(runText(run)).toBe("Hello");
      expect(run?.progress?.message).toBe("halfway");
    });

    // Reconnect: the server replays the whole run — started, the two stored
    // chunks renumbered 1..2, and the terminal it reached meanwhile at 3.
    dispatch(
      evt(
        0,
        { kind: "started", runId: "r1", agentType: "A", order: 0 },
        { replay: true }
      )
    );
    dispatch(
      evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }, { replay: true })
    );
    dispatch(
      evt(
        2,
        { kind: "chunk", runId: "r1", body: delta("Hello") },
        { replay: true }
      )
    );
    dispatch(
      evt(
        3,
        { kind: "finished", runId: "r1", summary: "done" },
        { replay: true }
      )
    );

    await vi.waitFor(() => {
      const run = readState(container).runsById.r1;
      expect(run?.status).toBe("completed");
      expect(run?.summary).toBe("done");
      expect(runText(run)).toBe("Hello");
    });
  });

  it("rebuilds a COMPLETED run from a reconnect replay without doubling it", async () => {
    // Every retained run is replayed at connect, finished ones included. The
    // replay is authoritative for the run's text, so the terminal guard must
    // let it rebuild the parts while still refusing to resurrect the status.
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hello") }));
    dispatch(evt(3, { kind: "finished", runId: "r1", summary: "done" }));
    await vi.waitFor(() => {
      expect(readState(container).runsById.r1?.status).toBe("completed");
    });

    for (const frame of [
      evt(
        0,
        { kind: "started", runId: "r1", agentType: "A", order: 0 },
        { replay: true }
      ),
      evt(
        1,
        { kind: "chunk", runId: "r1", body: TEXT_START },
        { replay: true }
      ),
      evt(
        2,
        { kind: "chunk", runId: "r1", body: delta("Hello") },
        { replay: true }
      ),
      evt(
        3,
        { kind: "finished", runId: "r1", summary: "done" },
        { replay: true }
      )
    ]) {
      dispatch(frame);
    }

    await new Promise((r) => setTimeout(r, 30));
    const run = readState(container).runsById.r1;
    expect(runText(run)).toBe("Hello");
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("done");
  });

  it("re-applies replayed frames after resetLocalState() clears the seen set", async () => {
    const { agent, dispatch } = createToolAgent();
    let reset: () => void = () => {};
    const { container } = await render(
      <Harness agent={agent} onReset={(r) => (reset = r)} />
    );

    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi");
    });

    // Reset (e.g. the consumer cleared local UI state on a hard reload).
    reset();
    await vi.waitFor(() => {
      expect(Object.keys(readState(container).runsById)).toHaveLength(0);
    });

    // The identical frames now re-apply — dedupe was cleared with the state.
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }));
    dispatch(evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi");
    });
  });

  it("groups runs by parentToolCallId and surfaces parentless runs as unbound", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    // Two children of one tool call (distinct order) + one parentless run.
    dispatch(
      evt(
        0,
        { kind: "started", runId: "child-b", agentType: "A", order: 1 },
        { parentToolCallId: "call-1" }
      )
    );
    dispatch(
      evt(
        1,
        { kind: "started", runId: "child-a", agentType: "A", order: 0 },
        { parentToolCallId: "call-1" }
      )
    );
    dispatch(
      evt(2, { kind: "started", runId: "loose", agentType: "A", order: 0 })
    );

    await vi.waitFor(() => {
      const s = readState(container);
      expect(s.runsByToolCallId["call-1"]?.map((r) => r.runId)).toEqual([
        "child-a",
        "child-b"
      ]);
      expect(s.unboundRuns.map((r) => r.runId)).toEqual(["loose"]);
    });
  });

  it("reflects each terminal status (finished / error / aborted / interrupted)", async () => {
    const { agent, dispatch } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    dispatch(
      evt(0, { kind: "started", runId: "ok", agentType: "A", order: 0 })
    );
    dispatch(evt(1, { kind: "finished", runId: "ok", summary: "all good" }));
    dispatch(
      evt(2, { kind: "started", runId: "boom", agentType: "A", order: 1 })
    );
    dispatch(evt(3, { kind: "error", runId: "boom", error: "kaboom" }));
    dispatch(
      evt(4, { kind: "started", runId: "stop", agentType: "A", order: 2 })
    );
    dispatch(evt(5, { kind: "aborted", runId: "stop", reason: "cancelled" }));
    dispatch(
      evt(6, { kind: "started", runId: "evicted", agentType: "A", order: 3 })
    );
    dispatch(
      evt(7, {
        kind: "interrupted",
        runId: "evicted",
        error: "deploy evicted the child",
        reason: "no-progress",
        childStillRunning: true
      })
    );

    await vi.waitFor(() => {
      const { runsById } = readState(container);
      expect(runsById.ok?.status).toBe("completed");
      expect(runsById.ok?.summary).toBe("all good");
      expect(runsById.boom?.status).toBe("error");
      expect(runsById.boom?.error).toBe("kaboom");
      expect(runsById.stop?.status).toBe("aborted");
      expect(runsById.stop?.error).toBe("cancelled");
      expect(runsById.evicted?.status).toBe("interrupted");
      expect(runsById.evicted?.reason).toBe("no-progress");
      expect(runsById.evicted?.childStillRunning).toBe(true);
    });
  });

  it("drains frames buffered before the subscriber mounted", async () => {
    // The pre-subscription race: the server replays retained runs at socket
    // connect, and an in-process transport delivers them before this hook's
    // passive effect attaches its listener. `useAgent` buffers such frames
    // via `_bufferAgentToolReplayFrame`; the hook must drain them on mount.
    const { agent, dispatch } = createToolAgent();
    const frames = [
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 }),
      evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }),
      evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") })
    ];
    for (const frame of frames) {
      _bufferAgentToolReplayFrame(agent, JSON.stringify(frame));
    }

    const { container } = await render(<Harness agent={agent} />);

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi");
    });

    // Live delivery continues seamlessly after the drain.
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta("!") }));
    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi!");
    });
  });

  it("preserves a buffered async replay through StrictMode effect restart", async () => {
    const { agent, dispatch } = createToolAgent();
    const run = {
      runId: "r1",
      agentType: "A",
      status: "running" as const,
      displayOrder: 0,
      startedAt: 1
    };
    const replayId = "strict-mode";
    // A stable external transport has already enumerated the retained rows,
    // but child inspection is still pending when React mounts the hook.
    const frames: (AgentToolCollectionMessage | AgentToolEventMessage)[] = [
      {
        type: "agent-tool-event",
        replay: true,
        replayId,
        sequence: 0,
        event: { kind: "collection", status: "loading" }
      },
      {
        ...evt(0, { kind: "snapshot", runId: "r1", run }),
        replay: true,
        replayId
      },
      {
        type: "agent-tool-event",
        replay: true,
        replayId,
        sequence: 0,
        event: { kind: "collection", status: "ready", runIds: ["r1"] }
      }
    ];
    for (const frame of frames)
      _bufferAgentToolReplayFrame(agent, JSON.stringify(frame));

    const { container } = await render(
      <StrictMode>
        <Harness agent={agent} />
      </StrictMode>
    );
    await vi.waitFor(() =>
      expect(readState(container).collection).toEqual({
        status: "ready",
        stale: false
      })
    );

    // No reconnect or second loading frame: cleanup/setup belongs to React,
    // not to the transport that owns this still-pending replay.
    dispatch({
      ...evt(2, {
        kind: "snapshot",
        runId: "r1",
        run,
        snapshot: {
          progress: { message: "Loaded evidence", at: 123 },
          milestones: [{ name: "report-1", sequence: 0, at: 123 }],
          replay: {
            cursor: { epoch: "producer", sequence: 2 },
            chunks: [
              { sequence: 0, body: TEXT_START },
              { sequence: 1, body: delta("retained transcript") }
            ]
          }
        }
      }),
      replay: true,
      replayId
    });
    await vi.waitFor(() => {
      const state = readState(container);
      expect(runText(state.runsById.r1)).toBe("retained transcript");
      expect(state.runsById.r1?.progress).toEqual({
        message: "Loaded evidence",
        at: 123
      });
      expect(state.runsById.r1?.milestones).toHaveLength(1);
    });
  });

  it("dedupes a live frame that was also buffered pre-mount", async () => {
    // A frame can arrive both ways: buffered before mount AND re-delivered
    // live (a reconnect replay). The (parent, run, sequence) dedupe must
    // collapse the overlap regardless of which copy applied first.
    const { agent, dispatch } = createToolAgent();
    _bufferAgentToolReplayFrame(
      agent,
      JSON.stringify(
        evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
      )
    );
    _bufferAgentToolReplayFrame(
      agent,
      JSON.stringify(evt(1, { kind: "chunk", runId: "r1", body: TEXT_START }))
    );
    _bufferAgentToolReplayFrame(
      agent,
      JSON.stringify(evt(2, { kind: "chunk", runId: "r1", body: delta("Hi") }))
    );

    const { container } = await render(<Harness agent={agent} />);

    // Same seq-2 chunk again, live, with replay marking.
    dispatch(
      evt(
        2,
        { kind: "chunk", runId: "r1", body: delta("Hi") },
        { replay: true }
      )
    );
    dispatch(evt(3, { kind: "chunk", runId: "r1", body: delta(" there") }));

    await vi.waitFor(() => {
      expect(runText(readState(container).runsById.r1)).toBe("Hi there");
    });
  });

  it("stops buffering after the first drain (live listener owns delivery)", async () => {
    const { agent, dispatch } = createToolAgent();
    const first = await render(<Harness agent={agent} />);

    // First subscriber attaches and drains (an empty buffer still marks
    // `drained`), then sees a live frame.
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );
    await vi.waitFor(() => {
      expect(readState(first.container).runsById.r1?.status).toBe("running");
    });

    // Buffering after the drain is a no-op...
    _bufferAgentToolReplayFrame(
      agent,
      JSON.stringify(evt(1, { kind: "finished", runId: "r2", summary: "x" }))
    );

    // ...so a second, later subscriber's drain must find nothing — it starts
    // from whatever the server replays to it, not from a stale local stash.
    const second = await render(<Harness agent={agent} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(readState(second.container).runsById).toEqual({});
  });

  it("ignores non-string and malformed frames without throwing", async () => {
    const { agent, dispatch, raw } = createToolAgent();
    const { container } = await render(<Harness agent={agent} />);

    raw(123); // non-string data
    raw("{ not json");
    raw(JSON.stringify({ type: "something-else" })); // wrong type
    dispatch(
      evt(0, { kind: "started", runId: "r1", agentType: "A", order: 0 })
    );

    await vi.waitFor(() => {
      expect(readState(container).runsById.r1?.status).toBe("running");
    });
  });
});
