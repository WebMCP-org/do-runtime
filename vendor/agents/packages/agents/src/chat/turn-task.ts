/**
 * The chat-turn Task definition, shared by `AIChatAgent` and `Think`.
 *
 * Every chat turn runs as one journaled step on the `tasks` capability. A
 * live turn executes its closure under the fiber stash context (so
 * `this.stash()` keeps persisting the recovery snapshot into host storage);
 * a replay whose closure is gone — the producing isolate died — drives the
 * same recovery seam the legacy fiber scan used, so the ChatRecoveryEngine
 * and every hook behind it are unchanged. Hosts supply their protected
 * internals through {@link ChatTurnTaskHooks}; the turn logic, the snapshot
 * key vocabulary, and the settle plumbing live here once.
 */

import type { FiberRecoveryContext } from "agents";
import type { TaskStep } from "../tasks";
import { TaskStore } from "../tasks/store";

/**
 * Chat turns whose model step still needs execution or recovery. A Task run
 * can outlive its completed step while its final queue write is pending; that
 * cleanup is not another chat turn and must not suppress a terminal hook.
 * @internal Shared framework inspection; the Tasks store owns the journal.
 */
export function listUnfinishedChatTurnTasks(
  storage: DurableObjectStorage,
  definitionName: string
): Array<{ runId: string; requestId: string; createdAt: number }> {
  const rows = new TaskStore(storage).sql<{
    run_id: string;
    request_id: string | null;
    created_at: number;
  }>`
    SELECT task.run_id, json_extract(task.metadata, '$.requestId') AS request_id,
           task.created_at
    FROM cf_agents_task_runs AS task
    WHERE task.definition = ${definitionName}
      AND task.state IN ('pending', 'running', 'waiting')
      AND task.cancel_requested = 0
      AND NOT EXISTS (
        SELECT 1 FROM cf_agents_task_steps AS step
        WHERE step.run_id = task.run_id AND step.step_name = 'model-turn'
          AND step.state IN ('completed', 'failed')
      )
    ORDER BY task.created_at, task.run_id
  `;
  return rows.flatMap((row) =>
    row.request_id === null
      ? []
      : [
          {
            runId: row.run_id,
            requestId: row.request_id,
            createdAt: row.created_at
          }
        ]
  );
}

/** One live turn closure, registered under its nonce while this isolate runs it. */
export type ChatTurnClosureEntry = {
  /** The snapshot persisted at claim, before the turn produces anything. */
  readonly initial: unknown;
  /** Wrap user stash data into the durable snapshot envelope. */
  wrap(data: unknown): unknown;
  /** Execute the live turn. */
  run(): Promise<unknown>;
  /** Settles the caller awaiting the turn's outcome. */
  readonly settle: {
    resolve(value: unknown): void;
    reject(error: unknown): void;
  };
};

/** The host internals one chat-turn definition runs against. */
export type ChatTurnTaskHooks = {
  /** The registered definition name (the host's `CHAT_FIBER_NAME`). */
  readonly definitionName: string;
  readonly storage: DurableObjectStorage;
  /** The run row's creation time, for recovery staleness accounting. */
  getRunCreatedAt(runId: string): Promise<number | null>;
  getLiveClosure(nonce: string): ChatTurnClosureEntry | undefined;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** The host's fiber stash context, so `this.stash()` keeps working. */
  withStash<T>(
    context: {
      id: string;
      signal: AbortSignal;
      stash: (data: unknown) => void;
    },
    fn: () => Promise<T>
  ): Promise<T>;
  /** The unchanged recovery seam (ChatRecoveryEngine behind it). */
  handleRecovery(ctx: FiberRecoveryContext): Promise<unknown>;
};

/** Durable snapshot key for one chat turn's stash envelope. */
function turnSnapshotKey(runId: string): string {
  return `__cf_chat_turn_snapshot:${runId}`;
}

/** Read the canonical stash envelope used by interrupted chat Task replay. @internal */
export function readChatTurnTaskSnapshot(
  storage: DurableObjectStorage,
  runId: string
): Promise<unknown> {
  return storage.get(turnSnapshotKey(runId));
}

/**
 * Build the chat-turn Task handler for one host. Registered under the
 * host's `CHAT_FIBER_NAME` via `Tasks#register`.
 */
export function createChatTurnTaskDefinition(
  hooks: ChatTurnTaskHooks
): (input: unknown, step: TaskStep) => Promise<void> {
  return async (input, step) => {
    const { requestId, nonce } = input as {
      requestId: string;
      nonce: string;
    };
    await step.do(
      "model-turn",
      { retries: { limit: 1 }, timeout: "1 day" },
      async ({ signal }) => {
        const runId = `chat_${nonce}`;
        const snapshotKey = turnSnapshotKey(runId);
        const entry = hooks.getLiveClosure(nonce);
        if (!entry) {
          // Replay after an unclean interruption: the producing isolate is
          // gone. The durably persisted turn snapshot plus stream evidence
          // drive user-visible recovery.
          const persisted = await hooks.storage.get(snapshotKey);
          const createdAt = (await hooks.getRunCreatedAt(runId)) ?? Date.now();
          await hooks.handleRecovery({
            id: runId,
            name: `${hooks.definitionName}:${requestId}`,
            snapshot: (persisted ?? null) as unknown,
            createdAt,
            recoveryReason: "interrupted"
          });
          await hooks.storage.delete(snapshotKey);
          return undefined;
        }
        // SAFETY: chat fiber snapshots are the same JSON envelopes the
        // legacy stash wrapper persisted; storage round-trips them.
        //
        // The initial snapshot is awaited; every later stash write and the
        // final delete are fire-and-forget. That is safe because Durable
        // Object storage applies same-key operations in issuance order and
        // reads see unconfirmed writes, so the delete below can never be
        // overtaken by an earlier stash put — and the output gate holds
        // client-visible chunks until prior writes flush. A crash mid-turn
        // loses only the unflushed tail of stash writes, which recovery
        // tolerates by design: the snapshot is a hint, stream cursors are
        // the evidence.
        await hooks.storage.put(snapshotKey, entry.initial);
        try {
          const value = await hooks.keepAliveWhile(() =>
            hooks.withStash(
              {
                id: nonce,
                signal,
                stash: (data) =>
                  void hooks.storage
                    .put(snapshotKey, entry.wrap(data))
                    .catch(() => {})
              },
              () => entry.run()
            )
          );
          entry.settle.resolve(value);
        } catch (error) {
          entry.settle.reject(error);
          throw error;
        } finally {
          void hooks.storage.delete(snapshotKey).catch(() => {});
        }
        return undefined;
      }
    );
  };
}
