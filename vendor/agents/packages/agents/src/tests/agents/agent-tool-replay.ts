import { Agent, callable, type Connection } from "../../index.ts";
import type {
  AgentToolEvent,
  AgentToolEventMessage,
  AgentToolInterruptedReason,
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  AgentToolTerminalStatus,
  RunAgentToolResult
} from "../../agent-tool-types.ts";

/**
 * Input the parent forwards to {@link TestAgentToolStubChild.startAgentToolRun}
 * when driving a deterministic agent-tool run for the browser replay test.
 */
type StubRunInput = {
  /** JSON-encoded UI message chunk bodies, emitted in order. */
  chunkBodies: string[];
  summary?: string;
  /** Durable milestones the run reached, reported by `inspectAgentToolRun`. */
  milestones?: AgentToolMilestone[];
  progress?: AgentToolProgressSnapshot;
};

/**
 * Private framework internals this fixture drives directly to reproduce the
 * #1630 follow-up bug: the typed interrupted cause (`reason` /
 * `childStillRunning`) must survive a reconnect replay, not just live events.
 * Also used to exercise the detached-run delivery ledger (#1752) directly.
 */
type AgentToolInternals = {
  _updateAgentToolTerminal(
    runId: string,
    result: RunAgentToolResult,
    completedAt?: number
  ): void;
  _readAgentToolRun(runId: string): unknown;
  _resultFromAgentToolRow(row: unknown): RunAgentToolResult;
  _replayAgentToolRuns(connection: Connection): Promise<void>;
  _deliverDetachedTerminal(
    runId: string,
    kind: "finish" | "give_up",
    result: RunAgentToolResult,
    options?: { sequence?: number; serialize?: boolean },
    completedAt?: number
  ): Promise<void>;
  _armDetachedBackbone(options?: { resetCadence?: boolean }): Promise<void>;
  _observeForwardedProgress(runId: string, body: string): void;
  _detachedFastPath(
    runInfo: AgentToolRunInfo,
    cls: unknown,
    runId: string
  ): Promise<void>;
};

type DetachedDeliveryLogEntry = {
  hook: "onAgentToolFinish" | "onDetachedDone";
  runId: string;
  status: AgentToolTerminalStatus;
  reason?: AgentToolInterruptedReason;
};

type DetachedMilestoneLogEntry = {
  runId: string;
  name: string;
  mode: "react" | "narrate";
};

type DetachedBackboneSchedule = {
  delayInSeconds?: number;
  payload: unknown;
};

export class TestAgentToolReplayAgent extends Agent {
  private get _agentTool(): AgentToolInternals {
    return this as unknown as AgentToolInternals;
  }

  /**
   * Seed a stranded `interrupted` agent-tool run row through the REAL persist
   * path (`_updateAgentToolTerminal`) — exactly what parent recovery does when
   * it gives up re-attaching to a still-running child (#1630). This is the write
   * side of the round-trip the bug regressed.
   */
  @callable()
  async seedInterruptedRunForTest(
    runId: string,
    reason?: AgentToolInterruptedReason,
    childStillRunning?: boolean
  ): Promise<void> {
    // Reconnect projection is a drill-in surface, so seed the retained child
    // registry just as a real run did before its parent became interrupted.
    await this.subAgent(TestAgentToolStubChild, runId);
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order, started_at
      ) VALUES (
        ${runId}, ${`call-${runId}`}, 'TestAgentToolStubChild', 'starting', 0, ${Date.now()}
      )
    `;
    this._agentTool._updateAgentToolTerminal(runId, {
      runId,
      agentType: "TestAgentToolStubChild",
      status: "interrupted",
      error: "parent recovery gave up re-attaching to the child",
      ...(reason !== undefined ? { reason } : {}),
      ...(childStillRunning !== undefined ? { childStillRunning } : {})
    });
  }

  /**
   * Repair an `interrupted` row to `completed`, exactly as a later re-attach
   * does once the child self-heals. Asserts the persisted cause is CLEARED.
   */
  completeRunForTest(runId: string, summary: string): void {
    this._agentTool._updateAgentToolTerminal(runId, {
      runId,
      agentType: "Child",
      status: "completed",
      summary
    });
  }

  /** Round-trip: re-read the stored row back into a result object. */
  readPersistedResultForTest(runId: string): RunAgentToolResult | null {
    const row = this._agentTool._readAgentToolRun(runId);
    return row ? this._agentTool._resultFromAgentToolRow(row) : null;
  }

  /**
   * Simulate a client reconnect: drive `_replayAgentToolRuns` against a capture
   * connection and return the TERMINAL agent-tool events it would receive — the
   * exact wire frames a reconnecting client sees.
   */
  async captureReplayTerminalEventsForTest(): Promise<AgentToolEvent[]> {
    const captured: AgentToolEvent[] = [];
    const connection = {
      id: "replay-capture",
      send(body: string | ArrayBuffer | ArrayBufferView) {
        if (typeof body !== "string") return;
        try {
          const message = JSON.parse(body) as AgentToolEventMessage;
          if (message.type === "agent-tool-event") {
            captured.push(message.event);
          }
        } catch {
          // Ignore non-JSON frames.
        }
      }
    } as unknown as Connection;
    await this._agentTool._replayAgentToolRuns(connection);
    const terminalKinds = new Set([
      "finished",
      "error",
      "aborted",
      "interrupted"
    ]);
    return captured.filter((event) => terminalKinds.has(event.kind));
  }

  // ── Detached-run delivery ledger (#1752) ──────────────────────────────

  /** Records every delivery so a test can assert exactly-once / two-slot. */
  detachedDeliveryLog: DetachedDeliveryLogEntry[] = [];
  private detachedFailOnceRuns = new Set<string>();

  /** The global metering hook still fires for detached runs. */
  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.detachedDeliveryLog.push({
      hook: "onAgentToolFinish",
      runId: run.runId,
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {})
    });
  }

  /** The targeted, durable per-run callback wired via `detached.onFinish`. */
  async onDetachedDone(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.detachedDeliveryLog.push({
      hook: "onDetachedDone",
      runId: run.runId,
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {})
    });
  }

  async onDetachedFailsOnce(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    if (!this.detachedFailOnceRuns.has(run.runId)) {
      this.detachedFailOnceRuns.add(run.runId);
      throw new Error("detached callback failed once");
    }
    await this.onDetachedDone(run, result);
  }

  getDetachedDeliveryLog(): DetachedDeliveryLogEntry[] {
    return this.detachedDeliveryLog;
  }

  /**
   * Records every `detached: { onMilestones }` notification. The base `Agent`
   * seam is a no-op (chat hosts override it), so a plain subclass is how the
   * framework suite observes which milestones actually reached delivery.
   */
  detachedMilestoneLog: DetachedMilestoneLogEntry[] = [];

  protected override async _deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ): Promise<void> {
    this.detachedMilestoneLog.push({
      runId: run.runId,
      name: milestone.name,
      mode
    });
  }

  getDetachedMilestoneLog(): DetachedMilestoneLogEntry[] {
    return this.detachedMilestoneLog;
  }

  /** Seed a `running` detached run row with the `onDetachedDone` hook wired. */
  seedDetachedRunForTest(
    runId: string,
    maxBudgetAt?: number,
    notifySource?: string,
    onFinishName = "onDetachedDone"
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_notify_source,
        detached_max_budget_at
      ) VALUES (
        ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
        ${onFinishName}, ${notifySource ?? null}, ${maxBudgetAt ?? null}
      )
    `;
  }

  /**
   * Seed a `running` detached run that has reported progress (`lastProgressAt`)
   * and then gone silent, with a resetting no-progress budget but NO absolute
   * ceiling — so the backbone reconcile gives up ONLY on the no-progress window.
   */
  seedDetachedRunWithStaleProgressForTest(
    runId: string,
    noProgressBudgetMs: number,
    lastProgressAt: number
  ): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached, detached_on_finish, detached_max_budget_at,
        detached_no_progress_budget_ms, last_progress_at
      ) VALUES (
        ${runId}, ${null}, 'Child', 'running', 0, ${Date.now()}, 1,
        'onDetachedDone', ${null}, ${noProgressBudgetMs}, ${lastProgressAt}
      )
    `;
  }

  /** Seed a non-detached `running` row to prove cancel ownership stays awaited. */
  seedAwaitedRunForTest(runId: string): void {
    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, status, display_order,
        started_at, detached
      ) VALUES (
        ${runId}, ${null}, 'TestAgentToolStubChild', 'running', 0,
        ${Date.now()}, 0
      )
    `;
  }

  readRunNotifySourceForTest(runId: string): string | null {
    const row = this._agentTool._readAgentToolRun(runId) as {
      detached_notify_source?: string | null;
    } | null;
    return row?.detached_notify_source ?? null;
  }

  expireDetachedFinishClaimForTest(runId: string): void {
    this.sql`
      UPDATE cf_agent_tool_runs
      SET finish_claimed_at = 0
      WHERE run_id = ${runId}
    `;
  }

  async cancelRunForTest(runId: string): Promise<void> {
    await this.cancelAgentTool(runId);
  }

  /**
   * Capture the TERMINAL `agent-tool-event` frames a detached delivery
   * broadcasts to connected clients. Proves that paths without a tail sequence
   * (explicit cancel, budget give-up) still flip the background-runs tray to
   * its final state live (#1752 fix #1), not just the warm fast path.
   */
  async captureDeliveryTerminalBroadcastsForTest(
    action: "cancel" | "giveUp",
    runId: string
  ): Promise<AgentToolEvent[]> {
    const captured: AgentToolEvent[] = [];
    const self = this as unknown as {
      broadcast: (
        body: string | ArrayBuffer | ArrayBufferView,
        without?: string[]
      ) => void;
    };
    const original = self.broadcast.bind(this);
    self.broadcast = (body, without) => {
      if (typeof body === "string") {
        try {
          const message = JSON.parse(body) as AgentToolEventMessage;
          if (message.type === "agent-tool-event") captured.push(message.event);
        } catch {
          // Ignore non-JSON frames.
        }
      }
      return original(body, without);
    };
    try {
      if (action === "cancel") await this.cancelAgentTool(runId);
      else await this.deliverGiveUpForTest(runId);
    } finally {
      self.broadcast = original;
    }
    const terminalKinds = new Set([
      "finished",
      "error",
      "aborted",
      "interrupted"
    ]);
    return captured.filter((event) => terminalKinds.has(event.kind));
  }

  /**
   * Arm the detached backbone `count` times concurrently (the fan-out a turn
   * dispatching several detached runs at once produces) and return the live
   * backbone schedules. The mutex must collapse them to exactly one.
   */
  async armDetachedBackboneConcurrentlyForTest(
    count: number
  ): Promise<DetachedBackboneSchedule[]> {
    await Promise.all(
      Array.from({ length: count }, () =>
        this._agentTool._armDetachedBackbone({ resetCadence: true })
      )
    );
    return this.detachedBackboneSchedulesForTest();
  }

  async detachedReconcileTickForTest(cadenceIndex?: number): Promise<void> {
    await this._cfDetachedReconcileTick(
      cadenceIndex !== undefined ? { cadenceIndex } : undefined
    );
  }

  async detachedBackboneSchedulesForTest(): Promise<
    DetachedBackboneSchedule[]
  > {
    const schedules = await this.listSchedules();
    return schedules
      .filter((schedule) => schedule.callback === "_cfDetachedReconcileTick")
      .map((schedule) => ({
        delayInSeconds:
          "delayInSeconds" in schedule ? schedule.delayInSeconds : undefined,
        payload: schedule.payload
      }));
  }

  async deliverFinishForTest(
    runId: string,
    status: AgentToolTerminalStatus,
    text: string
  ): Promise<void> {
    await this._agentTool._deliverDetachedTerminal(runId, "finish", {
      runId,
      agentType: "Child",
      status,
      ...(status === "completed" ? { summary: text } : { error: text })
    });
  }

  async deliverFinishCatchingForTest(
    runId: string,
    status: AgentToolTerminalStatus,
    text: string
  ): Promise<string | null> {
    try {
      await this.deliverFinishForTest(runId, status, text);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async deliverGiveUpForTest(runId: string): Promise<void> {
    await this._agentTool._deliverDetachedTerminal(runId, "give_up", {
      runId,
      agentType: "Child",
      status: "interrupted",
      error: "detached run exceeded its budget before completing",
      reason: "budget-exceeded",
      childStillRunning: true
    });
  }

  readRunStatusForTest(runId: string): string | null {
    const row = this._agentTool._readAgentToolRun(runId) as {
      status: string;
    } | null;
    return row ? row.status : null;
  }

  /**
   * Drive a REAL `runAgentTool` against the deterministic, LLM-free
   * {@link TestAgentToolStubChild}. This emits live `started` / `chunk` /
   * `finished` frames to every connected client (the framework numbers them
   * `started`@0, chunks@1..N, terminal@N+1) and persists the run row. A later
   * connection reconstructs it from retained metadata and a child snapshot.
   */
  @callable()
  async runDeterministicAgentToolForTest(options: {
    runId: string;
    parentToolCallId?: string;
    chunkBodies: string[];
    summary?: string;
    milestones?: AgentToolMilestone[];
    progress?: AgentToolProgressSnapshot;
  }): Promise<RunAgentToolResult> {
    return this.runAgentTool<StubRunInput>(TestAgentToolStubChild, {
      runId: options.runId,
      parentToolCallId: options.parentToolCallId,
      input: {
        chunkBodies: options.chunkBodies,
        summary: options.summary,
        milestones: options.milestones,
        progress: options.progress
      }
    });
  }

  @callable()
  async deleteRetainedChildForTest(runId: string): Promise<void> {
    await this.deleteSubAgent(TestAgentToolStubChild, runId);
  }

  @callable()
  hasRetainedChildForTest(runId: string): boolean {
    return this.hasSubAgent(TestAgentToolStubChild, runId);
  }
}

/**
 * A deterministic, LLM-free agent-tool CHILD. A plain `Agent` subclass is a
 * legal agent-tool child: the framework's adapter gate only requires the four
 * methods below (`tailAgentToolRun` is optional; omitting it takes the batch
 * path). Chunks are persisted in SQL — NOT in memory — so a reconnect that
 * wakes a hibernated DO can still replay them via `getAgentToolChunks`.
 */
export class TestAgentToolStubChild extends Agent {
  private _ensureTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_test_stub_chunks (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_test_stub_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        milestones_json TEXT,
        progress_json TEXT
      )
    `;
  }

  async startAgentToolRun(
    input: StubRunInput,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    this._ensureTables();
    const startedAt = Date.now();
    const chunkBodies = input?.chunkBodies ?? [];
    chunkBodies.forEach((body, seq) => {
      this.sql`
        INSERT OR REPLACE INTO cf_test_stub_chunks (run_id, seq, body)
        VALUES (${options.runId}, ${seq}, ${body})
      `;
    });
    const completedAt = Date.now();
    const summary = input?.summary ?? null;
    const milestones = input?.milestones?.length
      ? JSON.stringify(input.milestones)
      : null;
    const progress = input?.progress ? JSON.stringify(input.progress) : null;
    this.sql`
      INSERT OR REPLACE INTO cf_test_stub_runs
        (run_id, status, summary, error, started_at, completed_at,
         milestones_json, progress_json)
      VALUES
        (${options.runId}, 'completed', ${summary}, ${null}, ${startedAt}, ${completedAt},
         ${milestones}, ${progress})
    `;
    return {
      runId: options.runId,
      status: "completed",
      summary: input?.summary,
      startedAt,
      completedAt,
      ...(input?.progress ? { progress: input.progress } : {}),
      ...(input?.milestones?.length ? { milestones: input.milestones } : {})
    };
  }

  async cancelAgentToolRun(runId: string): Promise<void> {
    this._ensureTables();
    this.sql`
      UPDATE cf_test_stub_runs
      SET status = 'aborted', completed_at = ${Date.now()}
      WHERE run_id = ${runId}
    `;
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    this._ensureTables();
    const rows = this.sql<{
      status: string;
      summary: string | null;
      error: string | null;
      started_at: number;
      completed_at: number | null;
      milestones_json: string | null;
      progress_json: string | null;
    }>`
      SELECT status, summary, error, started_at, completed_at, milestones_json, progress_json
      FROM cf_test_stub_runs WHERE run_id = ${runId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      runId,
      status: row.status as AgentToolRunInspection["status"],
      summary: row.summary ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      ...(row.progress_json !== null
        ? {
            progress: JSON.parse(row.progress_json) as AgentToolProgressSnapshot
          }
        : {}),
      ...(row.milestones_json !== null
        ? {
            milestones: JSON.parse(row.milestones_json) as AgentToolMilestone[]
          }
        : {})
    };
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    this._ensureTables();
    const after = options?.afterSequence ?? -1;
    return this.sql<{ seq: number; body: string }>`
      SELECT seq, body FROM cf_test_stub_chunks
      WHERE run_id = ${runId} AND seq > ${after}
      ORDER BY seq ASC
    `.map((row) => ({ sequence: row.seq, body: row.body }));
  }

  /**
   * Live stream used by `runAgentTool`'s forward path. A facet RPC stub makes
   * EVERY property access truthy, so the parent always takes the
   * `tailAgentToolRun` branch (never the batch fallback) for an RPC child — it
   * must exist. The run is already complete by the time `startAgentToolRun`
   * returns, so this simply replays the persisted chunks as a newline-delimited
   * JSON byte stream (the wire format `_forwardAgentToolStream` decodes) and
   * closes. (`getAgentToolChunks` above still serves the reconnect replay path,
   * which fetches chunks in a batch rather than tailing.)
   */
  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const chunks = await this.getAgentToolChunks(runId, options);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (options?.signal?.aborted) {
          controller.close();
          return;
        }
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }
}
