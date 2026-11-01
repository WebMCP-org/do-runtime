// Vendor divergence (fork-diff.md "Early model preparation and media"): the
// `@cloudflare/computer` `read` tool captures an image or PDF at execute time
// and sends it to every model. This module gates that render on the model
// Think prepared for the request, renders a PDF as extracted page text for a
// model without PDF input, and re-reads results saved by Think 0.20's `read`,
// which stored a reference instead of the bytes.
import type { Tool, ToolResultPart, ToolSet } from "ai";
import {
  createAITools,
  type CreateAIToolsOptions
} from "@cloudflare/computer/tools/ai-sdk";
import type { ThinkWorkspace } from "./workspace-files";

/**
 * Whether the model reads a kind of media part. A thunk is consulted on every
 * render, for a host whose model can change between requests.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type WorkspaceMediaCapability =
  | boolean
  | (() => boolean | Promise<boolean>);

/**
 * Returns a PDF's text, one string per page.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type WorkspacePdfText = (
  bytes: Uint8Array
) => Promise<readonly string[]>;

/**
 * How the workspace `read` tool renders images and PDFs for the model.
 *
 * Every option is consulted when a result is rendered, not when the file is
 * read: `toModelOutput` renders a stored result again on every later request,
 * so a model swap changes what the next request carries without rewriting the
 * transcript behind it.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface WorkspaceReadMediaOptions {
  /**
   * Whether the model reads image parts. Default `true`. When `false`, an
   * image read renders as a note naming the file.
   */
  acceptsImages?: WorkspaceMediaCapability;
  /**
   * Whether the model reads PDF file parts. Default `true`. When `false`, a
   * PDF read renders as {@link pdfText}'s output, or as a note naming the
   * file when there is no extractor.
   */
  acceptsPdfs?: WorkspaceMediaCapability;
  /**
   * Extracts a PDF's text for a model without PDF input. The text renders
   * line-numbered, windowed by the read's `offset` and `limit` like a text
   * file. Results are cached by content, because every later request renders
   * the read again.
   */
  pdfText?: WorkspacePdfText;
  /**
   * Largest image or PDF re-read for a result saved by Think 0.20. Set it to
   * the `read` tool's `maxModelBytes`; where the two differ, the smaller one
   * decides. Default 3.5 MiB, Computer's default.
   */
  maxModelBytes?: number;
}

/** Options for {@link createWorkspaceReadTool}. */
export interface CreateWorkspaceReadToolOptions extends WorkspaceReadMediaOptions {
  /** The Workspace to read from. */
  workspace: ThinkWorkspace;
  /** Line, byte, and media caps for Computer's `read` tool. */
  read?: CreateAIToolsOptions["read"];
}

type ToolModelOutput = ToolResultPart["output"];
type ToModelOutput = NonNullable<Tool["toModelOutput"]>;
type ReadCall = Parameters<ToModelOutput>[0];
/** The limit error for a part of `sizeBytes`, if it is too large to send. */
type SizeLimit = (sizeBytes: number) => Promise<ToolModelOutput | undefined>;

type MediaReadResult = {
  kind: "image" | "file";
  path: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  data?: string;
};

/** Computer's default `maxModelBytes`. */
const DEFAULT_MAX_MODEL_BYTES = 3.5 * 1024 * 1024;
const MAX_PDF_TEXT_LINES = 2000;
const MAX_PDF_TEXT_LINE_LENGTH = 2000;
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PDF_HEADER_WINDOW = 1024;
// Base64 characters that decode to at least PDF_HEADER_WINDOW bytes.
const SNIFF_BASE64_CHARS = Math.ceil(PDF_HEADER_WINDOW / 3) * 4;
// The raster formats a model reads as an inline image. Computer classifies
// only these as images; a result saved by Think 0.20 may name another.
const MODEL_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

/**
 * Build a `read` tool for a Workspace whose image and PDF rendering follows
 * the model's capabilities. It is Computer's `read` tool with
 * {@link withWorkspaceReadMedia} applied, for a host that registers its own
 * `read` through `getTools()`.
 *
 * @param options - The Workspace, Computer's read caps, and media options.
 * @returns The AI SDK `read` tool.
 *
 * @experimental The API surface may change before stabilizing.
 */
export function createWorkspaceReadTool(
  options: CreateWorkspaceReadToolOptions
): Tool {
  const { workspace, read: readOptions, ...media } = options;
  const { read } = createAITools({
    workspace,
    readonly: true,
    read: readOptions
  });
  if (!read) throw new Error("@cloudflare/computer returned no read tool");
  return gateReadTool(read, workspace, {
    maxModelBytes: readOptions?.maxModelBytes,
    ...media
  });
}

/**
 * Replace the `read` tool in a Computer tool set with one whose image and
 * PDF rendering follows the model's capabilities. Other tools pass through.
 *
 * @param tools - A tool set from `createAITools`.
 * @param workspace - The Workspace the tool set reads from, used to re-read
 *   results saved by Think 0.20's `read`. Those re-reads use `workspace.fs`
 *   directly, so a `root` given to `createAITools` does not confine them.
 * @param options - Media options.
 * @returns The tool set with `read` replaced.
 *
 * @experimental The API surface may change before stabilizing.
 */
export function withWorkspaceReadMedia(
  tools: ToolSet,
  workspace: ThinkWorkspace,
  options: WorkspaceReadMediaOptions = {}
): ToolSet {
  const read = tools.read;
  if (!read) return tools;
  return { ...tools, read: gateReadTool(read, workspace, options) };
}

function gateReadTool(
  read: Tool,
  workspace: ThinkWorkspace,
  options: WorkspaceReadMediaOptions
): Tool {
  const render = read.toModelOutput;
  if (!render) return read;
  const {
    acceptsImages = true,
    acceptsPdfs = true,
    pdfText,
    maxModelBytes = DEFAULT_MAX_MODEL_BYTES
  } = options;

  // A tool set built elsewhere may give Computer a different `maxModelBytes`,
  // which its render enforces but does not expose, so the render is asked
  // with placeholder bytes. That does no I/O.
  const sizeLimit =
    (call: ReadCall, output: MediaReadResult): SizeLimit =>
    async (sizeBytes) => {
      if (sizeBytes > maxModelBytes) {
        return errorText(
          `Read ${output.path} (${output.mediaType}, ${sizeBytes} bytes), but it exceeds the ${maxModelBytes}-byte inline model output limit.`
        );
      }
      const probe = await render({
        ...call,
        output: { ...output, sizeBytes, data: "AA==" }
      });
      return probe.type === "error-text" ? probe : undefined;
    };

  const toModelOutput: ToModelOutput = async (call) => {
    const { input, output } = call;
    // Text, binary, and errors keep Computer's render.
    if (!isMediaReadResult(output)) return render(call);
    // A result with bytes is gated whatever its size, since those bytes are
    // what Computer sends. A result without them is Computer's oversize
    // result or one saved by Think 0.20, and the two share a shape. Over the
    // limit it stays an error even if the file later shrinks, because
    // re-reading would break captured semantics for every new result.
    // Reading the file again recovers it. Under the limit it is re-read.
    const limit = sizeLimit(call, output);
    if (output.data === undefined) {
      const tooLarge = await limit(output.sizeBytes);
      if (tooLarge) return tooLarge;
    }
    const reread = () => rereadLegacy(output, workspace, maxModelBytes, limit);
    const note = `Read ${output.path} (${output.mediaType}, ${output.sizeBytes} bytes).`;

    if (output.kind === "image") {
      // A model without image input does not refuse an image part: it bills
      // the base64 on every later request and answers from a picture it
      // invented. Naming the file is the honest render.
      if (!(await isAccepted(acceptsImages))) {
        return errorText(
          `${note} This model has no image input, so the picture was not sent.`
        );
      }
      if (!MODEL_IMAGE_MEDIA_TYPES.has(output.mediaType)) {
        return errorText(
          `${note} The model reads PNG, JPEG, WebP, and GIF images inline; ` +
            `re-render or convert this file to one of those to view it.`
        );
      }
      return renderWithBytes(render, call, output, reread);
    }
    // Computer 0.8 maps only PDFs to `kind: "file"`; any other file kind is
    // not ours to gate or extract.
    if (output.mediaType !== "application/pdf") return render(call);

    // A PDF part fares no better on an endpoint without PDF input: a gateway
    // that rejects the part fails every later request, and one that strips it
    // leaves the model a note naming a document it never received.
    if (await isAccepted(acceptsPdfs)) {
      return renderWithBytes(render, call, output, reread);
    }
    if (!pdfText) {
      return errorText(
        `${note} This model has no PDF input, so the document was not sent.`
      );
    }
    const bytes =
      output.data === undefined ? await reread() : base64ToBytes(output.data);
    if (!(bytes instanceof Uint8Array)) return bytes;
    if (bytes.byteLength === 0) {
      return errorText(`Cannot attach empty file: ${output.path}`);
    }
    // The extractor is not the validator: the same file renders the same way
    // for a model with PDF input and one without.
    if (sniffMediaType(bytes) !== "application/pdf") {
      return contentsMismatch(output, bytes.byteLength);
    }
    let pages: readonly string[];
    try {
      pages = await cachedPdfText(pdfText, bytes);
    } catch (error) {
      return errorText(
        `${note} This model has no PDF input, and the document's text could not be extracted: ${errorMessage(error)}`
      );
    }
    const pageCount = `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
    if (pages.every((page) => page.trim() === "")) {
      return errorText(
        `${note} This model has no PDF input, and none of the document's ${pageCount} has a text layer.`
      );
    }
    const text = pages
      .map((page, index) => `--- Page ${index + 1} ---\n${page.trimEnd()}`)
      .join("\n");
    const window = readWindow(input);
    return {
      type: "text",
      value:
        `${note} This model has no PDF input, so this is the text of its ${pageCount}, without layout or images.\n` +
        numberLines(text, window.offset, window.limit)
    };
  };

  return { ...read, toModelOutput };
}

/**
 * Render through Computer's `read`, supplying the bytes a result saved by
 * Think 0.20 does not carry.
 */
async function renderWithBytes(
  render: ToModelOutput,
  call: ReadCall,
  output: MediaReadResult,
  reread: () => Promise<Uint8Array | ToolModelOutput>
): Promise<ToolModelOutput> {
  let data = output.data;
  let sizeBytes = output.sizeBytes;
  let prefix: Uint8Array | ToolModelOutput;
  if (data === undefined) {
    const bytes = await reread();
    if (!(bytes instanceof Uint8Array)) return bytes;
    data = bytesToBase64(bytes);
    sizeBytes = bytes.byteLength;
    prefix = bytes;
  } else {
    // Enough base64 to decode the window the PDF header may sit in.
    prefix = base64ToBytes(data.slice(0, SNIFF_BASE64_CHARS));
    if (!(prefix instanceof Uint8Array)) return prefix;
  }
  // Computer types a file by its extension, and a Think 0.20 result keeps the
  // type the file had then. A provider rejects an image whose bytes do not
  // match its declared type, and since history renders again on every
  // request, that one part would fail the rest of the conversation.
  let mediaType = output.mediaType;
  const sniffed = sniffMediaType(prefix);
  if (sniffed !== mediaType) {
    if (output.kind !== "image" || !sniffed?.startsWith("image/")) {
      return contentsMismatch(output, sizeBytes);
    }
    mediaType = sniffed;
  }
  if (
    data === output.data &&
    sizeBytes === output.sizeBytes &&
    mediaType === output.mediaType
  ) {
    return render(call);
  }
  return render({
    ...call,
    output: { ...output, sizeBytes, mediaType, data }
  });
}

function contentsMismatch(
  output: MediaReadResult,
  sizeBytes: number
): ToolModelOutput {
  return errorText(
    `Read ${output.path} (${output.mediaType}, ${sizeBytes} bytes), but its contents are not ${output.mediaType}, so it was not sent. Convert or rename the file to view it.`
  );
}

/** The inline media type the first bytes declare, if any. */
function sniffMediaType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, signature: number[]) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  // PDF readers accept `%PDF-` anywhere in the first 1 KiB, after a
  // byte-order mark, a newline, or other junk, and Computer and Think 0.20
  // sent such files.
  const last =
    Math.min(bytes.byteLength, PDF_HEADER_WINDOW) - PDF_HEADER.length;
  for (let offset = 0; offset <= last; offset++) {
    if (at(offset, PDF_HEADER)) return "application/pdf";
  }
  return undefined;
}

/**
 * Think 0.20's `read` saved `{ kind, path, name, mediaType, sizeBytes }` and
 * read the bytes again on every render. Computer's `read` saves the bytes, so
 * a result without them comes from before the upgrade. Re-read it the way
 * 0.20 did, so old conversations keep their images and documents: current
 * size checked before any bytes load, and a file that became inaccessible
 * renders as an error without changing the saved history.
 */
async function rereadLegacy(
  output: MediaReadResult,
  workspace: ThinkWorkspace,
  maxModelBytes: number,
  limit: SizeLimit
): Promise<Uint8Array | ToolModelOutput> {
  const path = output.path;
  try {
    const stat = await workspace.fs.stat(path);
    const tooLarge = await limit(stat.size);
    if (tooLarge) return tooLarge;
    const bytes = await drain(
      await workspace.fs.readFile(path, {
        byteOffset: 0,
        byteLength: maxModelBytes + 1
      })
    );
    // The file can grow between `stat` and the read.
    const grown = await limit(bytes.byteLength);
    if (grown) return grown;
    if (bytes.byteLength === 0) {
      return errorText(`Cannot attach empty file: ${path}`);
    }
    return bytes;
  } catch (error) {
    return errorText(
      `Could not read file bytes: ${path}: ${errorMessage(error)}`
    );
  }
}

async function isAccepted(capability: WorkspaceMediaCapability) {
  return typeof capability === "function" ? capability() : capability;
}

function errorText(value: string): ToolModelOutput {
  return { type: "error-text", value };
}

function readWindow(input: unknown): { offset?: number; limit?: number } {
  if (input === null || typeof input !== "object") return {};
  const { offset, limit } = input as { offset?: unknown; limit?: unknown };
  return {
    offset: typeof offset === "number" ? offset : undefined,
    limit: typeof limit === "number" ? limit : undefined
  };
}

function numberLines(content: string, offset?: number, limit?: number) {
  const allLines = content.split("\n");
  const startLine = offset ? offset - 1 : 0;
  const endLine = limit ? startLine + limit : allLines.length;
  const numbered = allLines.slice(startLine, endLine).map((line, index) => {
    const truncated =
      line.length > MAX_PDF_TEXT_LINE_LENGTH
        ? `${line.slice(0, MAX_PDF_TEXT_LINE_LENGTH)}... (truncated)`
        : line;
    return `${startLine + index + 1}\t${truncated}`;
  });
  return numbered.length > MAX_PDF_TEXT_LINES
    ? `${numbered.slice(0, MAX_PDF_TEXT_LINES).join("\n")}\n... (${numbered.length - MAX_PDF_TEXT_LINES} more lines truncated)`
    : numbered.join("\n");
}

// Extraction parses the whole document and every later request renders the
// read again, so recent results are kept by content digest per extractor.
// History renders in order, so an LRU smaller than the PDFs in one transcript
// misses on every entry (8 did past 8 PDFs).
// ponytail: 64 entries of page text; decode and SHA-256 still run per render,
// memoise by toolCallId if that shows up in profiles.
const PDF_TEXT_CACHE_SIZE = 64;
const pdfTextCache = new WeakMap<
  WorkspacePdfText,
  Map<string, Promise<readonly string[]>>
>();

async function cachedPdfText(
  pdfText: WorkspacePdfText,
  bytes: Uint8Array
): Promise<readonly string[]> {
  // The extractor may take ownership of the buffer it is given.
  const copy = bytes.slice();
  const digest = bytesToBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy))
  );
  let cache = pdfTextCache.get(pdfText);
  if (!cache) {
    cache = new Map();
    pdfTextCache.set(pdfText, cache);
  }
  let pages = cache.get(digest);
  if (pages) {
    cache.delete(digest);
  } else {
    pages = pdfText(copy);
    const entries = cache;
    pages.catch(() => entries.delete(digest));
  }
  cache.set(digest, pages);
  while (cache.size > PDF_TEXT_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pages;
}

function isMediaReadResult(value: unknown): value is MediaReadResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "image" || record.kind === "file") &&
    typeof record.path === "string" &&
    typeof record.name === "string" &&
    typeof record.mediaType === "string" &&
    typeof record.sizeBytes === "number" &&
    (record.data === undefined || typeof record.data === "string")
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  // A reader, as Computer's file store uses: not every engine iterates a
  // ReadableStream with `for await`.
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array | ToolModelOutput {
  let binary: string;
  try {
    binary = atob(data);
  } catch (error) {
    return errorText(
      `Could not decode captured file bytes: ${errorMessage(error)}`
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
