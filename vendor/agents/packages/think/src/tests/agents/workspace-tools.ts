/**
 * Test agent for Think's workspace tools: the `@cloudflare/computer` tool
 * set Think adds to every turn, shaped by the backends on `workspace`.
 * `beforeTurn` captures the assembled tools and
 * system prompt so tests can inspect them and call the tools directly.
 */
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forAISDKTools } from "@cloudflare/computer/tools/ai-sdk";
import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { StreamCallback, ThinkWorkspace, TurnContext } from "../../think";

function createTextModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-workspace-tools",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 5, text: 5, reasoning: 0 }
            }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const noopCallback: StreamCallback = {
  onStart() {},
  onEvent() {},
  onDone() {},
  onError() {}
};

export class ThinkWorkspaceToolsAgent extends Think {
  override maxSteps = 1;
  #tools: ToolSet = {};
  #system = "";
  #overrideRead = false;
  #hostPaths: string[] = [];

  override getModel(): LanguageModel {
    return createTextModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override getTools(): ToolSet {
    const tools: ToolSet = {
      shout: tool({
        description: "Upper-case some text.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => text.toUpperCase()
      })
    };
    if (this.#overrideRead) {
      tools.read = tool({
        description: "The agent's own read tool.",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => `custom read of ${path}`
      });
    }
    return tools;
  }

  override beforeTurn(ctx: TurnContext): void {
    this.#tools = ctx.tools;
    this.#system = ctx.system;
  }

  /** Add a `read` tool of the agent's own through `getTools()`. */
  async overrideRead(): Promise<void> {
    this.#overrideRead = true;
  }

  /** Give the Workspace a JavaScript backend so `exec` appears. */
  async addJavaScriptBackend(): Promise<void> {
    this.workspace = new Workspace({
      storage: this.ctx.storage,
      backends: [
        new WorkerJavaScriptBackend({
          id: "js",
          loader: this.env.LOADER,
          modules: {
            "ws:tools": createToolBindings(forAISDKTools(() => this.getTools()))
          }
        })
      ]
    });
  }

  /** Write bytes into the Workspace, creating parent directories. */
  async writeBytes(path: string, bytes: number[]): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.workspace.fs.mkdir(parent, { recursive: true });
    await this.workspace.fs.writeFile(path, Uint8Array.from(bytes));
  }

  /**
   * Swap in a Workspace rooted at `/`, the way a host's own filesystem is
   * (Rook's BrowserWorkspace), that records every path it is handed.
   */
  async useHostWorkspace(files: Record<string, string>): Promise<void> {
    this.#hostPaths = [];
    const contents = new Map<string, Uint8Array>(
      Object.entries(files).map(([path, text]) => [
        path,
        new TextEncoder().encode(text)
      ])
    );
    const paths = this.#hostPaths;
    const missing = (path: string) =>
      Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    const fs = {
      async readFile(path: string) {
        paths.push(path);
        const bytes = contents.get(path);
        if (!bytes) throw missing(path);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice());
            controller.close();
          }
        });
      },
      async writeFile(path: string, bytes: Uint8Array) {
        paths.push(path);
        contents.set(path, bytes);
      },
      async mkdir(path: string) {
        paths.push(path);
      }
    };
    // SAFETY: the host bridge reads, writes, and creates directories only.
    this.workspace = { fs } as unknown as ThinkWorkspace;
  }

  /** Paths the host Workspace from `useHostWorkspace()` was handed. */
  async hostPaths(): Promise<string[]> {
    return [...this.#hostPaths];
  }

  /** Read through the extension host bridge, as an extension would. */
  async hostReadFile(path: string): Promise<string | null> {
    return this._hostReadFile(path);
  }

  /** Write through the extension host bridge, as an extension would. */
  async hostWriteFile(path: string, content: string): Promise<void> {
    await this._hostWriteFile(path, content);
  }

  /**
   * Run one captured tool and render its result the way the model receives
   * it, as JSON so it crosses RPC.
   */
  async renderTool(name: string, input: unknown): Promise<string> {
    const captured = this.#tools[name];
    if (!captured?.execute || !captured.toModelOutput) {
      throw new Error(`No renderable tool named ${name}`);
    }
    const output: unknown = await captured.execute(
      input as never,
      { toolCallId: "test", messages: [], context: {} } as never
    );
    return JSON.stringify(
      await captured.toModelOutput({ toolCallId: "test", input, output })
    );
  }

  /**
   * Set the fork's media options (fork-diff.md "Early model preparation and
   * media"). `pdfs` is set as a thunk, the way a host whose model changes
   * between requests sets it.
   */
  async setMediaCapabilities(options: {
    images: boolean;
    pdfs: boolean;
    pdfPages?: string[];
  }): Promise<void> {
    this.workspaceAcceptsImages = options.images;
    this.workspaceAcceptsPdfs = () => options.pdfs;
    const pages = options.pdfPages;
    this.workspacePdfText = pages ? async () => pages : undefined;
  }

  /** Run one turn and report the assembled tool names and system prompt. */
  async captureTurn(): Promise<{ toolNames: string[]; system: string }> {
    await this.chat("hello", noopCallback);
    return { toolNames: Object.keys(this.#tools).sort(), system: this.#system };
  }

  /** The description the model sees for one captured tool. */
  async toolDescription(name: string): Promise<string | null> {
    const description = this.#tools[name]?.description;
    return typeof description === "string" ? description : null;
  }

  /**
   * Call one tool from the last captured turn. The result is returned as
   * JSON so it crosses RPC whatever its shape.
   */
  async callTool(name: string, input: unknown): Promise<string> {
    const execute = this.#tools[name]?.execute;
    if (!execute) throw new Error(`No tool named ${name}`);
    let output: unknown = await execute(
      input as never,
      {
        toolCallId: "test",
        messages: [],
        context: {}
      } as never
    );
    // A streaming tool yields progress; the last value is its result.
    if (
      typeof output === "object" &&
      output !== null &&
      Symbol.asyncIterator in output
    ) {
      let last: unknown;
      for await (const value of output as AsyncIterable<unknown>) last = value;
      output = last;
    }
    return JSON.stringify(output);
  }
}
