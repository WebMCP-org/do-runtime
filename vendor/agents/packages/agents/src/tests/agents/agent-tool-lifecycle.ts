import {
  Agent,
  type AgentToolEventMessage,
  type AgentToolLifecycleResult,
  type AgentToolRunInfo,
  type AgentToolRunInspection,
  type AgentToolRunSnapshot,
  type AgentToolStoredChunk,
  type RunAgentToolResult
} from "../../index";
import { z } from "zod";

const childInput = z.object({
  complete: z.boolean().optional(),
  cancellationError: z.string().optional(),
  unconfirmedCancellation: z.boolean().optional(),
  holdCancellation: z.boolean().optional(),
  holdInspection: z.boolean().optional(),
  holdReplayAfterCancellation: z.boolean().optional()
});
type ChildInput = z.infer<typeof childInput>;

/** A real parent/child adapter boundary with controllable external work. */
export class TestAgentToolLifecycleParent extends Agent {
  static options = {
    hibernate: true,
    agentToolReattachNoProgressTimeoutMs: 250
  };

  override maxConcurrentAgentTools = 1;
  private controllers = new Map<string, AbortController>();
  private results = new Map<string, RunAgentToolResult>();
  private heldRun: string | null = null;
  private releaseAdmission: (() => void) | undefined;
  private events: AgentToolEventMessage[] = [];
  private finishes: Array<{ runId: string; status: string }> = [];
  private changes: AgentToolRunSnapshot[] = [];

  setLimitForTest(limit: number): void {
    this.maxConcurrentAgentTools = limit;
  }

  holdAdmissionForTest(runId: string): void {
    this.heldRun = runId;
  }

  admissionHeldForTest(): boolean {
    return this.releaseAdmission !== undefined;
  }

  releaseAdmissionForTest(): void {
    this.releaseAdmission?.();
    this.releaseAdmission = undefined;
    this.heldRun = null;
  }

  override async onAgentToolStart(run: AgentToolRunInfo): Promise<void> {
    if (run.runId !== this.heldRun) return;
    await new Promise<void>((resolve) => {
      this.releaseAdmission = resolve;
    });
  }

  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.finishes.push({ runId: run.runId, status: result.status });
  }

  override async onAgentToolRunChanged(
    run: AgentToolRunSnapshot
  ): Promise<void> {
    this.changes.push(run);
  }

  override broadcast(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (typeof message === "string") {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === "agent-tool-event") {
        this.events.push(parsed as AgentToolEventMessage);
      }
    }
    super.broadcast(message, without);
  }

  startForTest(
    runId: string,
    observer: string,
    input: ChildInput = {},
    alreadyAborted = false
  ): void {
    const controller = new AbortController();
    this.controllers.set(observer, controller);
    if (alreadyAborted) controller.abort("stopped before dispatch");
    this.ctx.waitUntil(
      this.runAgentTool(TestAgentToolLifecycleChild, {
        runId,
        parentToolCallId: `call-${runId}`,
        input: childInput.parse(input),
        signal: controller.signal
      }).then((result) => {
        this.results.set(observer, result);
        this.controllers.delete(observer);
      })
    );
  }

  abortForTest(observer: string): void {
    this.controllers.get(observer)?.abort("parent stopped");
  }

  resultForTest(observer: string): RunAgentToolResult | null {
    return this.results.get(observer) ?? null;
  }

  observationsForTest(runId: string) {
    const run = this.inspectAgentTool(runId);
    return {
      status: run?.status ?? null,
      childStillRunning: run?.childStillRunning,
      events: this.events
        .filter((message) => message.event.runId === runId)
        .map(({ event }) => ({
          event: { kind: event.kind, runId: event.runId }
        })),
      finishes: this.finishes.filter((finish) => finish.runId === runId),
      changes: this.changes
        .filter((run) => run.runId === runId)
        .map(({ status, childStillRunning }) => ({ status, childStillRunning }))
    };
  }

  async childForTest(runId: string) {
    if (!this.hasSubAgent(TestAgentToolLifecycleChild.name, runId)) return null;
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    const result = await child.stateForTest();
    const dispose =
      Symbol.dispose in result ? result[Symbol.dispose] : undefined;
    if (typeof dispose !== "function") {
      throw new Error("Expected a disposable native child RPC result");
    }
    try {
      return {
        status: result.status,
        starts: result.starts,
        cancels: result.cancels,
        tails: result.tails,
        inspectionHeld: result.inspectionHeld,
        cancellationHeld: result.cancellationHeld,
        replayReadHeld: result.replayReadHeld
      };
    } finally {
      dispose.call(result);
    }
  }

  async finishChildForTest(runId: string): Promise<void> {
    if (!this.hasSubAgent(TestAgentToolLifecycleChild.name, runId)) return;
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    await child.finishForTest();
  }

  async releaseInspectionForTest(runId: string): Promise<void> {
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    await child.releaseInspectionForTest();
  }

  async releaseCancellationForTest(runId: string): Promise<void> {
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    await child.releaseCancellationForTest();
  }

  async releaseReplayReadForTest(runId: string): Promise<void> {
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    await child.releaseReplayReadForTest();
  }

  async failNextTailForTest(runId: string): Promise<void> {
    const child = await this.subAgent(TestAgentToolLifecycleChild, runId);
    await child.failNextTailForTest();
  }

  restartForTest(): void {
    this.ctx.abort("forced parent restart");
  }
}

export class TestAgentToolLifecycleWindowParent extends TestAgentToolLifecycleParent {
  static options = {
    ...TestAgentToolLifecycleParent.options,
    agentToolReattachNoProgressTimeoutMs: 2_000,
    agentToolReattachMaxWindowMs: 1_000
  };
}

/**
 * Child execution is deliberately independent of the parent's wait. Its SQL
 * and live tail exercise the same public adapter calls as a chat child.
 */
export class TestAgentToolLifecycleChild extends Agent {
  private tailers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private releaseInspection: (() => void) | undefined;
  private releaseCancellation: (() => void) | undefined;
  private releaseReplayRead: (() => void) | undefined;
  private holdInspection = false;
  private holdCancellation = false;
  private holdReplayAfterCancellation = false;
  private failNextTail = false;
  private cancellationError: string | undefined;
  private unconfirmedCancellation = false;

  private ensureTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS lifecycle_child (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        starts INTEGER NOT NULL DEFAULT 0,
        cancels INTEGER NOT NULL DEFAULT 0,
        tails INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
      )
    `;
  }

  async startAgentToolRun(
    rawInput: ChildInput,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    this.ensureTable();
    const input = childInput.parse(rawInput);
    this.holdInspection = input.holdInspection ?? false;
    this.holdCancellation = input.holdCancellation ?? false;
    this.holdReplayAfterCancellation =
      input.holdReplayAfterCancellation ?? false;
    this.cancellationError = input.cancellationError;
    this.unconfirmedCancellation = input.unconfirmedCancellation ?? false;
    this.sql`
      INSERT OR IGNORE INTO lifecycle_child (run_id, status, starts, started_at)
      VALUES (${options.runId}, ${input.complete ? "completed" : "running"}, 1, ${Date.now()})
    `;
    return this.inspection();
  }

  async cancelAgentToolRun(
    runId: string
  ): Promise<void | { childStillRunning: boolean }> {
    this.ensureTable();
    // Cancellation fences late starts even when the row has not been admitted.
    this.sql`
      INSERT OR IGNORE INTO lifecycle_child (run_id, status, started_at)
      VALUES (${runId}, 'aborted', ${Date.now()})
    `;
    this.sql`UPDATE lifecycle_child SET cancels = cancels + 1`;
    if (this.cancellationError !== undefined) {
      const message = this.cancellationError;
      this.cancellationError = undefined;
      throw new Error(message);
    }
    this.sql`
      UPDATE lifecycle_child SET status = 'aborted' WHERE status = 'running'
    `;
    this.closeTailers();
    if (this.holdCancellation) {
      await new Promise<void>((resolve) => {
        this.releaseCancellation = resolve;
      });
    }
    if (this.unconfirmedCancellation) {
      this.unconfirmedCancellation = false;
      return;
    }
    return { childStillRunning: false };
  }

  async inspectAgentToolRun(): Promise<AgentToolRunInspection | null> {
    const inspection = this.inspection();
    if (
      this.holdInspection &&
      (inspection.status === "completed" || inspection.status === "aborted")
    ) {
      await new Promise<void>((resolve) => {
        this.releaseInspection = resolve;
      });
    }
    return inspection;
  }

  async getAgentToolChunks(): Promise<AgentToolStoredChunk[]> {
    if (
      this.holdReplayAfterCancellation &&
      this.sql<{ cancels: number }>`SELECT cancels FROM lifecycle_child`[0]
        .cancels > 0
    ) {
      await new Promise<void>((resolve) => {
        this.releaseReplayRead = resolve;
      });
    }
    return [];
  }

  async tailAgentToolRun(): Promise<ReadableStream<AgentToolStoredChunk>> {
    this.sql`UPDATE lifecycle_child SET tails = tails + 1`;
    if (this.failNextTail) {
      this.failNextTail = false;
      throw new Error("child tail temporarily unavailable");
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.inspection().status !== "running") {
          controller.close();
        } else {
          this.tailers.add(controller);
        }
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  stateForTest() {
    this.ensureTable();
    return {
      ...this.sql<{
        status: string;
        starts: number;
        cancels: number;
        tails: number;
      }>`SELECT status, starts, cancels, tails FROM lifecycle_child`[0],
      inspectionHeld: this.releaseInspection !== undefined,
      cancellationHeld: this.releaseCancellation !== undefined,
      replayReadHeld: this.releaseReplayRead !== undefined
    };
  }

  finishForTest(): void {
    this.sql`
      UPDATE lifecycle_child SET status = 'completed' WHERE status = 'running'
    `;
    this.closeTailers();
  }

  releaseInspectionForTest(): void {
    this.holdInspection = false;
    this.releaseInspection?.();
    this.releaseInspection = undefined;
  }

  releaseCancellationForTest(): void {
    this.holdCancellation = false;
    this.releaseCancellation?.();
    this.releaseCancellation = undefined;
  }

  releaseReplayReadForTest(): void {
    this.holdReplayAfterCancellation = false;
    this.releaseReplayRead?.();
    this.releaseReplayRead = undefined;
  }

  failNextTailForTest(): void {
    this.failNextTail = true;
  }

  private inspection(): AgentToolRunInspection {
    const row = this.sql<{
      run_id: string;
      status: AgentToolRunInspection["status"];
      started_at: number;
    }>`SELECT run_id, status, started_at FROM lifecycle_child`[0];
    if (!row) throw new Error("child was not admitted");
    return {
      runId: row.run_id,
      status: row.status,
      startedAt: row.started_at,
      ...(row.status === "completed" ? { summary: "child finished" } : {})
    };
  }

  private closeTailers(): void {
    for (const controller of this.tailers) controller.close();
    this.tailers.clear();
  }
}
