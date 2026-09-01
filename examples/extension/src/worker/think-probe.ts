import {
  Think,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type StreamCallback,
  type ThinkSubmissionInspection,
} from "@cloudflare/think";
import type { LanguageModel, UIMessage } from "ai";
import type { ThinkProbeStatus, ThinkProbeSubmission } from "../protocol";

type CounterEnv = { Counter: DurableObjectNamespace };

const CHUNKS = 12;
const CHUNK_DELAY_MS = 150;
const RECOVERY_COUNT = "probe:recovery-count";
const RECOVERY_PARTIAL = "probe:recovery-partial";
const INFERENCE_STARTS = "probe:inference-starts";
const INFERENCE_COMPLETIONS = "probe:inference-completions";
const EMITTED_CHUNKS = "probe:emitted-chunks";

function portHop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

function text(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

/** A provider-boundary stub: everything around it is the real Think and do-runtime stack. */
export class ThinkProbe extends Think<CounterEnv> {
  override includeMcpTools = false;
  override mediaEviction = false;
  override workspaceBash = false;
  override chatRecovery = { stableTimeoutMs: 2_000 };

  async #bump(key: string): Promise<number> {
    const next = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, next);
    return next;
  }

  override getModel(): LanguageModel {
    const probe = this;
    return {
      specificationVersion: "v3",
      provider: "do-runtime-e2e",
      modelId: "think-probe",
      supportedUrls: {},
      doGenerate() {
        throw new Error("The Think composition probe only supports streaming.");
      },
      async doStream({ abortSignal }) {
        await probe.#bump(INFERENCE_STARTS);
        let chunk = 0;
        let opened = false;
        let cancelled = false;
        const stream = new ReadableStream({
          async pull(controller) {
            if (!opened) {
              opened = true;
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "probe-text" });
              return;
            }

            if (cancelled || abortSignal?.aborted) {
              controller.error(abortSignal?.reason ?? new Error("Think probe stopped"));
              return;
            }

            if (chunk < CHUNKS) {
              await scheduler.wait(CHUNK_DELAY_MS);
              await portHop();
              if (cancelled || abortSignal?.aborted) {
                controller.error(abortSignal?.reason ?? new Error("Think probe stopped"));
                return;
              }
              chunk += 1;
              await probe.#bump(EMITTED_CHUNKS);
              controller.enqueue({
                type: "text-delta",
                id: "probe-text",
                delta: `chunk${chunk} `,
              });
              return;
            }

            await probe.#bump(INFERENCE_COMPLETIONS);
            controller.enqueue({ type: "text-end", id: "probe-text" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: CHUNKS },
            });
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        return { stream };
      },
    } satisfies LanguageModel;
  }

  override getSystemPrompt(): string {
    return "Reply using the deterministic composition-test model.";
  }

  override async onChatRecovery(context: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.#bump(RECOVERY_COUNT);
    await this.ctx.storage.put(RECOVERY_PARTIAL, context.partialText);
    return { continue: true };
  }

  async start(text: string): Promise<void> {
    this.ctx.waitUntil(
      this.runTurn({
        mode: "stream",
        input: text,
        callback: {
          onStart() {},
          onEvent() {},
          onDone() {},
          onError() {},
        } satisfies StreamCallback,
      }),
    );
  }

  async submit(text: string, idempotencyKey: string): Promise<ThinkProbeSubmission> {
    const result = await this.runTurn({ mode: "submit", input: text, idempotencyKey });
    return {
      accepted: result.accepted,
      error: result.error ?? null,
      status: result.status,
      submissionId: result.submissionId,
    };
  }

  async status(): Promise<ThinkProbeStatus> {
    const [messages, submissions] = await Promise.all([
      this.getMessages(),
      this.listSubmissions({ limit: 20 }),
    ]);
    const fiberTable = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_runs'
    `;
    const fiberRows =
      fiberTable.length === 0
        ? 0
        : this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM cf_agents_runs`[0].count;
    const assistant = messages.findLast((message) => message.role === "assistant");
    return {
      assistantMessages: messages.filter((message) => message.role === "assistant").length,
      assistantText: assistant === undefined ? "" : text(assistant),
      emittedChunks: (await this.ctx.storage.get<number>(EMITTED_CHUNKS)) ?? 0,
      fiberRows,
      inferenceCompletions: (await this.ctx.storage.get<number>(INFERENCE_COMPLETIONS)) ?? 0,
      inferenceStarts: (await this.ctx.storage.get<number>(INFERENCE_STARTS)) ?? 0,
      recoveryCount: (await this.ctx.storage.get<number>(RECOVERY_COUNT)) ?? 0,
      recoveryPartial: (await this.ctx.storage.get<string>(RECOVERY_PARTIAL)) ?? "",
      submissions: submissions.map((submission: ThinkSubmissionInspection) => ({
        error: submission.error ?? null,
        status: submission.status,
        submissionId: submission.submissionId,
      })),
      userMessages: messages.filter((message) => message.role === "user").length,
    };
  }

  async stop(): Promise<void> {
    await this.stopCurrentWork();
  }
}
