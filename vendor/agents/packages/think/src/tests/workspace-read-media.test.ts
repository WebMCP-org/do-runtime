// Vendor divergence (fork-diff.md "Early model preparation and media"): the
// model-gated workspace `read`. These are the fork's Think 0.20
// `assistant-tools.test.ts` media regressions, moved onto Computer's `read`
// tool and `workspace-read.ts`.
import { convertToModelMessages, type Tool, type UIMessage } from "ai";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceReadTool,
  withWorkspaceReadMedia
} from "../workspace-read";
import { resolveWorkspacePath, type ThinkWorkspace } from "../workspace-files";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0
]);
const PDF = new TextEncoder().encode("%PDF-1.4\n");
const LARGE = 389 * 1024 * 1024;
const INLINE_LIMIT = 3.5 * 1024 * 1024;

type MemoryFile = {
  bytes: Uint8Array;
  /** Reported size, when a test needs one larger than `bytes`. */
  size?: number;
  readError?: Error;
};

/**
 * A ThinkWorkspace over a map, rooted at `/` like a host's own filesystem
 * (Rook's BrowserWorkspace). It records every path and byte range asked for.
 */
function memoryWorkspace(files: Record<string, MemoryFile>) {
  const reads: Array<{ path: string; byteLength?: number }> = [];
  const stats: string[] = [];
  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: no such file: ${path}`), {
      code: "ENOENT"
    });
  const fs = {
    async stat(path: string) {
      stats.push(path);
      const file = files[path];
      if (!file) throw missing(path);
      return {
        type: "file",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: file.size ?? file.bytes.byteLength,
        mtime: 0,
        mode: 0o644
      };
    },
    async readFile(
      path: string,
      options?: { byteOffset?: number; byteLength?: number }
    ) {
      reads.push({ path, byteLength: options?.byteLength });
      const file = files[path];
      if (!file) throw missing(path);
      if (file.readError) throw file.readError;
      const start = options?.byteOffset ?? 0;
      const end =
        options?.byteLength === undefined
          ? file.bytes.byteLength
          : start + options.byteLength;
      const slice = file.bytes.slice(start, end);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (slice.byteLength > 0) controller.enqueue(slice);
          controller.close();
        }
      });
    }
  };
  // SAFETY: the read tool and its legacy re-read call only `stat` and
  // `readFile`; the other six ThinkWorkspace methods are never reached.
  const workspace = { fs } as unknown as ThinkWorkspace;
  return { workspace, reads, stats };
}

type ReadInput = { path: string; offset?: number; limit?: number };

async function execute(read: Tool, input: ReadInput): Promise<unknown> {
  // SAFETY: Computer's read tool ignores the execution options.
  return read.execute!(input, {
    toolCallId: "read-1",
    messages: [],
    context: {}
  } as never);
}

async function render(read: Tool, input: ReadInput, output: unknown) {
  return read.toModelOutput!({ toolCallId: "read-1", input, output });
}

async function readAndRender(read: Tool, input: ReadInput) {
  return render(read, input, await execute(read, input));
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("workspace read — model capability gates", () => {
  it("renders an image only for a model with image input, decided per render", async () => {
    const { workspace } = memoryWorkspace({ "/shots/a.png": { bytes: PNG } });
    let acceptsImages = false;
    const read = createWorkspaceReadTool({
      workspace,
      acceptsImages: () => acceptsImages
    });
    const input = { path: "/shots/a.png" };
    const output = await execute(read, input);

    await expect(render(read, input, output)).resolves.toEqual({
      type: "error-text",
      value:
        "Read /shots/a.png (image/png, 9 bytes). This model has no image input, so the picture was not sent."
    });
    // A model swap changes the next request without rewriting the transcript.
    acceptsImages = true;
    await expect(render(read, input, output)).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "Read /shots/a.png (image/png, 9 bytes)." },
        {
          type: "file",
          data: { type: "data", data: base64(PNG) },
          mediaType: "image/png",
          filename: "a.png"
        }
      ]
    });
  });

  it("sends a PDF as a file part to a PDF model without extracting it", async () => {
    const { workspace } = memoryWorkspace({ "/docs/a.pdf": { bytes: PDF } });
    let extracted = false;
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: () => true,
      pdfText: async () => {
        extracted = true;
        return ["unused"];
      }
    });
    const output = await readAndRender(read, { path: "/docs/a.pdf" });
    expect(output).toMatchObject({
      type: "content",
      value: [{ type: "text" }, { type: "file", mediaType: "application/pdf" }]
    });
    expect(extracted).toBe(false);
  });

  it("keeps the note for a model without PDF input when there is no extractor", async () => {
    const { workspace } = memoryWorkspace({ "/docs/a.pdf": { bytes: PDF } });
    const read = createWorkspaceReadTool({ workspace, acceptsPdfs: false });
    await expect(readAndRender(read, { path: "/docs/a.pdf" })).resolves.toEqual(
      {
        type: "error-text",
        value:
          "Read /docs/a.pdf (application/pdf, 9 bytes). This model has no PDF input, so the document was not sent."
      }
    );
  });

  it("replaces only `read` in a Computer tool set", () => {
    const { workspace } = memoryWorkspace({});
    const tools = createAITools({ workspace });
    const gated = withWorkspaceReadMedia(tools, workspace, {
      acceptsImages: false
    });
    expect(Object.keys(gated).sort()).toEqual(Object.keys(tools).sort());
    expect(gated.read).not.toBe(tools.read);
    expect(gated.read?.execute).toBe(tools.read?.execute);
    expect(gated.write).toBe(tools.write);
    expect(withWorkspaceReadMedia({}, workspace)).toEqual({});
  });
});

describe("workspace read — PDF text for a model without PDF input", () => {
  const path = "/documents/filing.pdf";

  it("renders the extracted text by page, windowed like a text file", async () => {
    const { workspace } = memoryWorkspace({ [path]: { bytes: PDF } });
    const calls: Uint8Array[] = [];
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: false,
      pdfText: async (data) => {
        calls.push(data);
        return ["Filed April 18, 2025\nClaim 7", "Appendix"];
      }
    });

    await expect(readAndRender(read, { path })).resolves.toEqual({
      type: "text",
      value:
        `Read ${path} (application/pdf, 9 bytes). This model has no PDF input, ` +
        "so this is the text of its 2 pages, without layout or images.\n" +
        "1\t--- Page 1 ---\n2\tFiled April 18, 2025\n3\tClaim 7\n" +
        "4\t--- Page 2 ---\n5\tAppendix"
    });
    await expect(
      readAndRender(read, { path, offset: 4, limit: 2 })
    ).resolves.toMatchObject({
      value: expect.stringMatching(/images\.\n4\t--- Page 2 ---\n5\tAppendix$/)
    });
    // Every later request renders the read again; the text is parsed once,
    // from a copy the extractor may keep.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(PDF);
  });

  it("says so when no page has a text layer", async () => {
    const { workspace } = memoryWorkspace({ [path]: { bytes: PDF } });
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: false,
      pdfText: async () => ["", " \n"]
    });
    await expect(readAndRender(read, { path })).resolves.toEqual({
      type: "error-text",
      value:
        `Read ${path} (application/pdf, 9 bytes). This model has no PDF input, ` +
        "and none of the document's 2 pages has a text layer."
    });
  });

  it("names the extraction failure and retries it on the next render", async () => {
    const { workspace } = memoryWorkspace({ [path]: { bytes: PDF } });
    let attempts = 0;
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: false,
      pdfText: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Invalid PDF structure.");
        return ["Recovered"];
      }
    });
    const input = { path };
    const output = await execute(read, input);
    await expect(render(read, input, output)).resolves.toEqual({
      type: "error-text",
      value:
        `Read ${path} (application/pdf, 9 bytes). This model has no PDF input, ` +
        "and the document's text could not be extracted: Invalid PDF structure."
    });
    await expect(render(read, input, output)).resolves.toMatchObject({
      type: "text",
      value: expect.stringContaining("1\t--- Page 1 ---\n2\tRecovered")
    });
  });
});

describe("workspace read — media size preflight", () => {
  it("does not load an oversized untyped file just to detect its format", async () => {
    const path = "/mounts/cookbooks/untyped";
    const { workspace, reads } = memoryWorkspace({
      [path]: { bytes: PDF, size: LARGE }
    });
    let extracted = false;
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: false,
      pdfText: async () => {
        extracted = true;
        return ["unused"];
      }
    });
    const input = { path };
    const output = await execute(read, input);
    expect(output).toEqual({
      kind: "file",
      path,
      name: "untyped",
      mediaType: "application/pdf",
      sizeBytes: LARGE
    });
    // Format sniffing reads a bounded prefix, never the whole file.
    expect(reads).toEqual([{ path, byteLength: 512 }]);
    await expect(render(read, input, output)).resolves.toEqual({
      type: "error-text",
      value: `Read ${path} (application/pdf, ${LARGE} bytes), but it exceeds the ${INLINE_LIMIT}-byte inline model output limit.`
    });
    expect(extracted).toBe(false);
    expect(reads).toHaveLength(1);
  });

  it.each([
    ["report.pdf", PDF],
    ["shot.png", PNG]
  ])("never reads the bytes of an oversized %s", async (name, bytes) => {
    const path = `/mounts/cookbooks/${name}`;
    const { workspace, reads } = memoryWorkspace({
      [path]: { bytes, size: LARGE }
    });
    const read = createWorkspaceReadTool({ workspace });
    await expect(readAndRender(read, { path })).resolves.toMatchObject({
      type: "error-text",
      value: expect.stringContaining("inline model output limit")
    });
    expect(reads).toEqual([]);
  });
});

describe("workspace read — history", () => {
  it.each([
    ["report.pdf", PDF],
    ["shot.png", PNG]
  ])(
    "renders a captured %s without touching the workspace again",
    async (name, bytes) => {
      const path = `/mounts/cookbooks/${name}`;
      const file: MemoryFile = { bytes };
      const { workspace, reads } = memoryWorkspace({ [path]: file });
      const read = createWorkspaceReadTool({ workspace });
      const input = { path };
      const output = await execute(read, input);
      const readsAtExecute = reads.length;
      file.readError = Object.assign(new Error("EACCES: reconnect"), {
        code: "EACCES"
      });
      await expect(render(read, input, output)).resolves.toMatchObject({
        type: "content"
      });
      expect(reads).toHaveLength(readsAtExecute);
    }
  );

  // Think 0.20's `read` saved a reference and read the bytes again on every
  // render. Results saved before the upgrade keep rendering from the file.
  it.each([
    ["report.pdf", "application/pdf", "file", PDF],
    ["shot.png", "image/png", "image", PNG]
  ] as const)(
    "re-reads a Think 0.20 %s result and keeps history usable when it becomes inaccessible",
    async (name, mediaType, kind, bytes) => {
      const path = `/mounts/cookbooks/${name}`;
      const file: MemoryFile = { bytes };
      const { workspace } = memoryWorkspace({ [path]: file });
      const read = createWorkspaceReadTool({ workspace });
      const reason =
        "EACCES: local folder mount /mounts/cookbooks needs to be reconnected in the sidepanel";
      const input = { path };
      const legacyOutput = {
        kind,
        path,
        name,
        mediaType,
        sizeBytes: bytes.byteLength
      };
      const history: UIMessage[] = [
        {
          id: "assistant-read",
          role: "assistant",
          parts: [
            {
              type: "tool-read",
              toolCallId: "read-file",
              state: "output-available",
              input,
              output: legacyOutput
            }
          ]
        },
        {
          id: "followup",
          role: "user",
          parts: [{ type: "text", text: "Continue." }]
        }
      ];
      const stored = JSON.stringify(history);
      const toModel = () =>
        convertToModelMessages(history, { tools: { read } });

      const original = await toModel();
      expect(original[1]).toMatchObject({
        role: "tool",
        content: [
          {
            output: {
              type: "content",
              value: [
                { type: "text" },
                { type: "file", data: { data: base64(bytes) }, mediaType }
              ]
            }
          }
        ]
      });

      file.readError = Object.assign(new Error(reason), { code: "EACCES" });
      await expect(toModel()).resolves.toContainEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-file",
            toolName: "read",
            output: {
              type: "error-text",
              value: `Could not read file bytes: ${path}: ${reason}`
            }
          }
        ]
      });
      expect(JSON.stringify(history)).toBe(stored);

      delete file.readError;
      await expect(toModel()).resolves.toEqual(original);
    }
  );

  it("checks the current size of a Think 0.20 result before loading it", async () => {
    const path = "/mounts/cookbooks/shot.png";
    const file: MemoryFile = { bytes: PNG, size: LARGE };
    const { workspace, reads } = memoryWorkspace({ [path]: file });
    const read = createWorkspaceReadTool({ workspace });
    const input = { path };
    // Saved metadata can be small while the current file has grown.
    const legacyOutput = {
      kind: "image",
      path,
      name: "shot.png",
      mediaType: "image/png",
      sizeBytes: PNG.byteLength
    };
    await expect(render(read, input, legacyOutput)).resolves.toEqual({
      type: "error-text",
      value: `Read ${path} (image/png, ${LARGE} bytes), but it exceeds the ${INLINE_LIMIT}-byte inline model output limit.`
    });
    expect(reads).toEqual([]);

    // Replacing the large file with a small one restores access.
    delete file.size;
    await expect(render(read, input, legacyOutput)).resolves.toMatchObject({
      type: "content"
    });
    expect(reads).toEqual([{ path, byteLength: INLINE_LIMIT + 1 }]);
  });

  it("names a Think 0.20 image the model has no inline form for", async () => {
    const path = "/art/logo.svg";
    const { workspace, reads } = memoryWorkspace({
      [path]: { bytes: new TextEncoder().encode("<svg/>") }
    });
    const read = createWorkspaceReadTool({ workspace });
    await expect(
      render(
        read,
        { path },
        {
          kind: "image",
          path,
          name: "logo.svg",
          mediaType: "image/svg+xml",
          sizeBytes: 6
        }
      )
    ).resolves.toEqual({
      type: "error-text",
      value:
        `Read ${path} (image/svg+xml, 6 bytes). The model reads PNG, JPEG, WebP, and GIF images inline; ` +
        "re-render or convert this file to one of those to view it."
    });
    expect(reads).toEqual([]);
  });
});

describe("workspace read — relative paths", () => {
  // Upstream semantics, recorded rather than changed: Computer's tools pass a
  // relative path to `workspace.fs` as given (a Computer `Workspace` resolves
  // it under `/workspace` itself), while Think's own file access, such as the
  // extension host bridge, resolves it under `/workspace` first. A workspace
  // rooted at `/` therefore sees `notes.md` from the model's `read`, and
  // `/workspace/notes.md` from Think.
  it("hands a relative path to a host workspace unchanged", async () => {
    const { workspace, stats } = memoryWorkspace({
      "notes.md": { bytes: new TextEncoder().encode("relative") }
    });
    const read = createWorkspaceReadTool({ workspace });
    await expect(readAndRender(read, { path: "notes.md" })).resolves.toEqual({
      type: "text",
      value: "relative"
    });
    expect(stats).toEqual(["notes.md"]);
  });

  it("resolves Think's own relative paths under /workspace", () => {
    expect(resolveWorkspacePath("notes.md")).toBe("/workspace/notes.md");
    expect(resolveWorkspacePath("./notes/today.md")).toBe(
      "/workspace/notes/today.md"
    );
    expect(resolveWorkspacePath(".")).toBe("/workspace");
    expect(resolveWorkspacePath("/skills/a/SKILL.md")).toBe(
      "/skills/a/SKILL.md"
    );
  });
});

describe("workspace read — declared type against the bytes", () => {
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const HTML = new TextEncoder().encode("<!doctype html><p>hi</p>");

  it("relabels an image whose bytes are another inline format", async () => {
    const path = "/shots/really-a.jpg.png";
    const { workspace } = memoryWorkspace({ [path]: { bytes: JPEG } });
    const read = createWorkspaceReadTool({ workspace });
    await expect(readAndRender(read, { path })).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: `Read ${path} (image/jpeg, 8 bytes).` },
        {
          type: "file",
          data: { type: "data", data: base64(JPEG) },
          mediaType: "image/jpeg",
          filename: "really-a.jpg.png"
        }
      ]
    });
  });

  it.each([
    ["/shots/page.png", "image/png", "image"],
    ["/docs/page.pdf", "application/pdf", "file"]
  ] as const)(
    "does not send %s when its bytes are not its type",
    async (path, mediaType, kind) => {
      const file: MemoryFile = { bytes: HTML };
      const { workspace } = memoryWorkspace({ [path]: file });
      const read = createWorkspaceReadTool({ workspace });
      const expected = {
        type: "error-text",
        value: `Read ${path} (${mediaType}, ${HTML.byteLength} bytes), but its contents are not ${mediaType}, so it was not sent. Convert or rename the file to view it.`
      };
      const output = await execute(read, { path });
      expect(output).toMatchObject({ kind, mediaType });
      await expect(render(read, { path }, output)).resolves.toEqual(expected);
      // A Think 0.20 result keeps the type the file had when it was read.
      const legacy = {
        kind,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        mediaType,
        sizeBytes: HTML.byteLength
      };
      await expect(render(read, { path }, legacy)).resolves.toEqual(expected);
    }
  );

  it("leaves a non-PDF file result to Computer instead of the PDF path", async () => {
    const path = "/data/archive.zip";
    const { workspace } = memoryWorkspace({ [path]: { bytes: PDF } });
    let extracted = false;
    const read = createWorkspaceReadTool({
      workspace,
      acceptsPdfs: false,
      pdfText: async () => {
        extracted = true;
        return ["never"];
      }
    });
    const output = {
      kind: "file",
      path,
      name: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: PDF.byteLength,
      data: base64(PDF)
    };
    const computerRead = createAITools({ workspace, readonly: true }).read!;
    await expect(render(read, { path }, output)).resolves.toEqual(
      await render(computerRead, { path }, output)
    );
    expect(extracted).toBe(false);
  });
});
