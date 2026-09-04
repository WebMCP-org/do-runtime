import { describe, it, expect } from "vitest";
import type { Connection } from "agents";
import {
  ResumeHandshake,
  type PendingChatTerminal,
  type ResumeHandshakeHost
} from "../resume-handshake";
import { ContinuationState } from "../continuation-state";
import type { ResumableStream } from "../resumable-stream";
import { PreStreamTurns } from "../pre-stream-turns";
import { STREAM_RESUME_NONE_REASONS } from "../protocol";
import {
  replayDoneFrame,
  streamPendingFrame,
  streamResumeNoneFrame,
  streamResumingFrame,
  terminalErrorFrame
} from "./resume-handshake-frames";

/**
 * Drives the REAL {@link ResumeHandshake} against a fake host and asserts the
 * control frames it emits `toEqual` the golden builders in
 * `resume-handshake-frames.ts`. This is what makes the golden fixture an actual
 * byte-identical GATE rather than a self-referential spec: the frames-builder
 * test freezes the shapes; THIS test proves the shared module reproduces them.
 *
 * It is host-agnostic on purpose — both `@cloudflare/ai-chat` and
 * `@cloudflare/think` route through this one driver, so covering every branch
 * here once is the strongest guard for think (whose native browser reconnect is
 * not exercised by an e2e). The chunk-content replay (`replayChunks` etc.) is
 * `ResumableStream`'s job and tested there; here we script those calls and only
 * assert the driver's OWN handshake frames.
 */

const RESPONSE_TYPE = "cf_agent_use_chat_response";

type SentFrame = Record<string, unknown>;

function makeConnection(id: string, sink: SentFrame[]): Connection {
  return {
    id,
    send: (message: string) => {
      sink.push(JSON.parse(message) as SentFrame);
    }
  } as unknown as Connection;
}

interface FakeStreamState {
  active: boolean;
  activeRequestId: string | null;
  activeStreamId: string | null;
  /** Orphaned stream id `replayChunks` returns ("" = not orphaned). */
  orphanedStreamId: string;
  replayCompletedReturn: boolean;
  replayErroredReturn: boolean;
  knownRequestIds: Set<string>;
  erroredRequestIds: Set<string>;
  calls: {
    replayChunks: string[];
    replayCompleted: string[];
    replayErrored: string[];
  };
}

function makeStream(over: Partial<FakeStreamState> = {}): {
  state: FakeStreamState;
  resumableStream: ResumableStream;
} {
  const state: FakeStreamState = {
    active: false,
    activeRequestId: null,
    activeStreamId: null,
    orphanedStreamId: "",
    replayCompletedReturn: false,
    replayErroredReturn: true,
    knownRequestIds: new Set<string>(),
    erroredRequestIds: new Set<string>(),
    calls: { replayChunks: [], replayCompleted: [], replayErrored: [] },
    ...over
  };
  const resumableStream = {
    hasActiveStream: () => state.active,
    get activeRequestId() {
      return state.activeRequestId;
    },
    get activeStreamId() {
      return state.activeStreamId;
    },
    replayChunks: (_c: Connection, requestId: string) => {
      state.calls.replayChunks.push(requestId);
      return state.orphanedStreamId;
    },
    replayCompletedChunksByRequestId: (
      _connection: Connection,
      requestId: string
    ) => {
      state.calls.replayCompleted.push(requestId);
      return state.replayCompletedReturn;
    },
    replayErroredChunksByRequestId: (_c: Connection, requestId: string) => {
      state.calls.replayErrored.push(requestId);
      return state.replayErroredReturn;
    },
    hasRequest: (requestId: string) => state.knownRequestIds.has(requestId),
    hasErroredRequest: (requestId: string) =>
      state.erroredRequestIds.has(requestId)
  } as unknown as ResumableStream;
  return { state, resumableStream };
}

function makeHost(opts: {
  resumableStream: ResumableStream;
  continuation?: ContinuationState<Connection>;
  preStream?: PreStreamTurns<Connection>;
  pendingTerminal?: PendingChatTerminal | null;
  pendingTerminalPromise?: Promise<PendingChatTerminal | null>;
  pendingResumeConnections?: Set<string>;
  persistCalls?: string[];
  presentConnectionIds?: Set<string>;
}): ResumeHandshakeHost {
  return {
    responseMessageType: RESPONSE_TYPE,
    resumableStream: opts.resumableStream,
    continuation: opts.continuation ?? new ContinuationState<Connection>(),
    preStream: opts.preStream ?? new PreStreamTurns<Connection>(),
    pendingResumeConnections:
      opts.pendingResumeConnections ?? new Set<string>(),
    pendingChatTerminal: () =>
      opts.pendingTerminalPromise ??
      Promise.resolve(opts.pendingTerminal ?? null),
    persistOrphanedStream: async (id: string) => {
      opts.persistCalls?.push(id);
    },
    isConnectionPresent: opts.presentConnectionIds
      ? (id: string) => opts.presentConnectionIds!.has(id)
      : undefined
  };
}

describe("ResumeHandshake (driver → golden frames)", () => {
  it("parks a duplicate pre-stream request without admitting another turn", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream();
    const preStream = new PreStreamTurns<Connection>();
    preStream.begin("req-duplicate");
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream })
    );
    const connection = makeConnection("duplicate", frames);

    expect(await handshake.claimRequest(connection, "req-duplicate")).toBe(
      false
    );
    expect(frames).toEqual([streamPendingFrame("req-duplicate")]);
    expect(preStream.awaitingConnections.get("duplicate")).toBe(connection);
  });

  it("offers retained stream replay for a duplicate completed request", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      knownRequestIds: new Set(["req-completed"])
    });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );

    expect(
      await handshake.claimRequest(
        makeConnection("replacement", frames),
        "req-completed"
      )
    ).toBe(false);
    expect(frames).toEqual([streamResumingFrame("req-completed")]);
    expect(pendingResumeConnections).toEqual(new Set(["replacement"]));
  });

  it("offers terminal replay for a duplicate request without a stream", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream();
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingResumeConnections,
        pendingTerminal: {
          requestId: "req-terminal",
          body: "turn failed"
        }
      })
    );

    expect(
      await handshake.claimRequest(
        makeConnection("replacement", frames),
        "req-terminal"
      )
    ).toBe(false);
    expect(frames).toEqual([streamResumingFrame("req-terminal")]);
    expect(pendingResumeConnections).toEqual(new Set(["replacement"]));
  });

  it("claims one concurrent first delivery after the terminal read", async () => {
    const firstFrames: SentFrame[] = [];
    const secondFrames: SentFrame[] = [];
    const { resumableStream } = makeStream();
    const preStream = new PreStreamTurns<Connection>();
    let resolveTerminal!: (terminal: PendingChatTerminal | null) => void;
    const pendingTerminalPromise = new Promise<PendingChatTerminal | null>(
      (resolve) => {
        resolveTerminal = resolve;
      }
    );
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream, pendingTerminalPromise })
    );

    const first = handshake.claimRequest(
      makeConnection("first", firstFrames),
      "req-race"
    );
    const second = handshake.claimRequest(
      makeConnection("second", secondFrames),
      "req-race"
    );
    resolveTerminal(null);

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(preStream.hasRequest("req-race")).toBe(true);
    expect(firstFrames).toEqual([]);
    expect(secondFrames).toEqual([streamPendingFrame("req-race")]);
  });

  // ── notifyStreamResuming ───────────────────────────────────────────

  it("notify emits STREAM_RESUMING and parks the connection as pending", () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );

    handshake.notifyStreamResuming(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-1")]);
    expect(pendingResumeConnections.has("c1")).toBe(true);
  });

  it("notify is a no-op with no active stream", () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const pendingResumeConnections = new Set<string>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections })
    );

    handshake.notifyStreamResuming(makeConnection("c1", frames));

    expect(frames).toEqual([]);
    expect(pendingResumeConnections.size).toBe(0);
  });

  // ── handleResumeRequest ────────────────────────────────────────────

  it("#1733: REQUEST while active re-sends the SAME STREAM_RESUMING (no dedupe)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));
    const conn = makeConnection("c1", frames);

    // Proactive notify has no probe id; the explicit response echoes its
    // correlation id while preserving the same stream request id.
    handshake.notifyStreamResuming(conn);
    await handshake.handleResumeRequest(conn, "probe-1");

    expect(frames).toEqual([
      streamResumingFrame("req-1"),
      streamResumingFrame("req-1", "probe-1")
    ]);
  });

  it("REQUEST while a DIFFERENT connection owns the active continuation → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationState<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "other";
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );

    await handshake.handleResumeRequest(
      makeConnection("c1", frames),
      "probe-owned"
    );

    expect(frames).toEqual([
      streamResumeNoneFrame(
        STREAM_RESUME_NONE_REASONS.CONTINUATION_OWNED,
        "probe-owned"
      )
    ]);
  });

  it("REQUEST with no active stream but a matching pending continuation parks + keeps waiting (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const continuation = new ContinuationState<Connection>();
    // `connectionId` is read by the driver's pending check; `requestId` is
    // echoed into the keep-waiting frame.
    continuation.pending = {
      connectionId: null,
      requestId: "cont-1"
    } as ContinuationState<Connection>["pending"];
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, continuation })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    // Now parks AND tells the client to keep waiting so its short resume probe
    // doesn't resolve "no stream" before the continuation stream starts.
    expect(frames).toEqual([streamPendingFrame("cont-1")]);
    expect(continuation.awaitingConnections.get("c1")).toBe(conn);
  });

  it("REQUEST with no active stream but a pending TERMINAL → STREAM_RESUMING for the terminal (#1645)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-term")]);
  });

  it("REQUEST with nothing to resume → correlated idle RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeRequest(
      makeConnection("c1", frames),
      "probe-idle"
    );

    expect(frames).toEqual([
      streamResumeNoneFrame(STREAM_RESUME_NONE_REASONS.IDLE, "probe-idle")
    ]);
  });

  it("REQUEST with no active stream but a pre-stream turn in flight parks + keeps waiting (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const preStream = new PreStreamTurns<Connection>();
    preStream.begin("req-pre");
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream })
    );
    const conn = makeConnection("c1", frames);

    await handshake.handleResumeRequest(conn);

    expect(frames).toEqual([streamPendingFrame("req-pre")]);
    expect(preStream.awaitingConnections.get("c1")).toBe(conn);
  });

  it("REQUEST with an idle pre-stream tracker → RESUME_NONE (nothing in flight)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({ active: false });
    const preStream = new PreStreamTurns<Connection>();
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, preStream })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumeNoneFrame()]);
    expect(preStream.awaitingConnections.size).toBe(0);
  });

  it("active continuation owned by an ABSENT connection can be resumed by a new one (#1784)", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationState<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "old-owner";
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        continuation,
        // "old-owner" is NOT present → the new connection may take over.
        presentConnectionIds: new Set<string>(["c1"])
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([streamResumingFrame("req-1")]);
  });

  it("active continuation owned by a PRESENT connection is NOT hijacked → RESUME_NONE", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const continuation = new ContinuationState<Connection>();
    continuation.activeRequestId = "req-1";
    continuation.activeConnectionId = "old-owner";
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        continuation,
        presentConnectionIds: new Set<string>(["old-owner", "c1"])
      })
    );

    await handshake.handleResumeRequest(makeConnection("c1", frames));

    expect(frames).toEqual([
      streamResumeNoneFrame(STREAM_RESUME_NONE_REASONS.CONTINUATION_OWNED)
    ]);
  });

  // ── handleResumeAck ────────────────────────────────────────────────

  it("ACK for the active stream replays chunks and persists an orphaned stream", async () => {
    const frames: SentFrame[] = [];
    const persistCalls: string[] = [];
    const { state, resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1",
      orphanedStreamId: "stream-9"
    });
    const pendingResumeConnections = new Set<string>(["c1"]);
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, pendingResumeConnections, persistCalls })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-1");

    // The driver emits no control frame here (chunk replay is ResumableStream's
    // job); it clears the pending set and persists the orphaned partial.
    expect(frames).toEqual([]);
    expect(state.calls.replayChunks).toEqual(["req-1"]);
    expect(persistCalls).toEqual(["stream-9"]);
    expect(pendingResumeConnections.has("c1")).toBe(false);
  });

  it("ACK for the active stream that is NOT orphaned does not persist", async () => {
    const frames: SentFrame[] = [];
    const persistCalls: string[] = [];
    const { resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1",
      orphanedStreamId: ""
    });
    const handshake = new ResumeHandshake(
      makeHost({ resumableStream, persistCalls })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-1");

    expect(persistCalls).toEqual([]);
  });

  it("ACK for a DIFFERENT active request id is ignored (no frame, no replay)", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: true,
      activeRequestId: "req-1"
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "stale-req");

    expect(frames).toEqual([]);
    expect(state.calls.replayChunks).toEqual([]);
  });

  it("ACK for completed request A replays A while different request B is active", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: true,
      activeRequestId: "request-b",
      replayCompletedReturn: true
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(
      makeConnection("replacement", frames),
      "request-a"
    );

    expect(state.calls.replayChunks).toEqual([]);
    expect(state.calls.replayCompleted).toEqual(["request-a"]);
    expect(frames).toEqual([]);
  });

  it("ACK with a pending terminal replays errored content then the terminal error frame (#1575)", async () => {
    const frames: SentFrame[] = [];
    const { state, resumableStream } = makeStream({
      active: false,
      replayErroredReturn: true
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");

    expect(state.calls.replayErrored).toEqual(["req-term"]);
    expect(frames).toEqual([
      terminalErrorFrame("req-term", "boom", RESPONSE_TYPE)
    ]);
  });

  it("ACK with a pending terminal whose replay connection dropped skips the terminal frame", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayErroredReturn: false
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-term");

    // Connection dropped mid-replay: no terminal frame; the record is retained
    // for the next reconnect to retry.
    expect(frames).toEqual([]);
  });

  it("ACK for a pending terminal with a DIFFERENT request id falls through to replay-done", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false
    });
    const handshake = new ResumeHandshake(
      makeHost({
        resumableStream,
        pendingTerminal: { requestId: "req-term", body: "boom" }
      })
    );

    await handshake.handleResumeAck(makeConnection("c1", frames), "other-req");

    expect(frames).toEqual([replayDoneFrame("other-req", RESPONSE_TYPE)]);
  });

  it("ACK with completed chunks to replay emits no extra close frame", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: true
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    expect(frames).toEqual([]);
  });

  it("ACK with nothing left to replay emits a clean replay-done close", async () => {
    const frames: SentFrame[] = [];
    const { resumableStream } = makeStream({
      active: false,
      replayCompletedReturn: false
    });
    const handshake = new ResumeHandshake(makeHost({ resumableStream }));

    await handshake.handleResumeAck(makeConnection("c1", frames), "req-done");

    expect(frames).toEqual([replayDoneFrame("req-done", RESPONSE_TYPE)]);
  });
});
